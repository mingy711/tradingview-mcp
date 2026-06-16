/**
 * TradingView screener scan — flexible multi-market scan via TV's public
 * scanner endpoint (`scanner.tradingview.com/<screener>/scan`).
 * Complements `getHotlist` (which is fixed-slug US presets) by exposing
 * arbitrary column queries, ticker hydration, exchange filters, and
 * numeric range filters across all major asset classes.
 *
 * Ported from QuantAgentLabs fork (commit e15e8a5, May 2026). Adapted to
 * our _deps DI pattern; symbolSearch sourced from src/core/chart.js.
 */
import { symbolSearch as _symbolSearch } from './chart.js';

const DEFAULT_COLUMNS = [
  'name', 'close', 'change', 'change_abs', 'volume',
  'market_cap_basic', 'type', 'subtype', 'description',
];

const SORT_FIELD_MAP = {
  symbol: 'name',
  price: 'close',
  change_pct: 'change',
  change_abs: 'change_abs',
  volume: 'volume',
  market_cap: 'market_cap_basic',
};

// `screener` is the TV API path segment; `queryTypes` filters results
// at the symbol-search level; `searchType` is the parameter for our
// symbolSearch wrapper. `filters` are appended verbatim to the scan
// request — useful for ETF/Index disambiguation.
const MARKET_PRESETS = {
  stock:   { screener: 'america', queryTypes: ['stock'], searchType: 'stock' },
  etf:     { screener: 'america', queryTypes: ['fund'], searchType: '', filters: [{ left: 'subtype', operation: 'equal', right: 'etf' }] },
  crypto:  { screener: 'crypto',  queryTypes: [], searchType: 'crypto' },
  forex:   { screener: 'forex',   queryTypes: ['forex'], searchType: 'forex' },
  futures: { screener: 'futures', queryTypes: ['futures'], searchType: 'futures' },
  index:   { screener: 'cfd',     queryTypes: ['index'], searchType: 'index', filters: [{ left: 'type', operation: 'equal', right: 'index' }] },
  america: { screener: 'america', queryTypes: [], searchType: 'stock' },
  global:  { screener: 'global',  queryTypes: [], searchType: 'stock' },
  cfd:     { screener: 'cfd',     queryTypes: [], searchType: 'index' },
};

// ── Helpers (exported under `_test` for unit testing) ────────────────────

function parseList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      let arr;
      try { arr = JSON.parse(trimmed); }
      catch { throw new Error(`tickers: malformed JSON array (${trimmed.slice(0, 60)}). Use CSV "A,B,C" or valid JSON.`); }
      if (!Array.isArray(arr)) throw new Error(`tickers: JSON value is not an array (${trimmed.slice(0, 60)}).`);
      return arr.map(v => String(v).trim()).filter(Boolean);
    }
    return trimmed.split(',').map(v => v.trim()).filter(Boolean);
  }
  return [String(value).trim()].filter(Boolean);
}

function normalizeMarket(market, assetType) {
  if (assetType && MARKET_PRESETS[assetType]) return { key: assetType, ...MARKET_PRESETS[assetType] };
  if (market && MARKET_PRESETS[market]) return { key: market, ...MARKET_PRESETS[market] };
  return { key: 'stock', ...MARKET_PRESETS.stock };
}

function maybeAddRangeFilter(filters, left, operation, value) {
  if (value === undefined || value === null || value === '') return;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`${left} range filter: "${value}" is not a finite number`);
  }
  filters.push({ left, operation, right: n });
}

function matchesPreset(result, preset) {
  if (!preset.queryTypes || preset.queryTypes.length === 0) return true;
  const type = String(result.type || '').toLowerCase();
  return preset.queryTypes.some(c => String(c).toLowerCase() === type);
}

function formatRow(row, columns) {
  const values = Object.fromEntries(columns.map((col, i) => [col, row.d?.[i] ?? null]));
  return {
    ticker: row.s,
    symbol: values.name,
    price: values.close,
    change_pct: values.change,
    change_abs: values.change_abs,
    volume: values.volume,
    market_cap: values.market_cap_basic,
    type: values.type,
    subtype: values.subtype,
    description: values.description,
    raw: values,
  };
}

// TV's symbol search returns 400 for some preset+type combinations
// (e.g. funds with `type=fund` are unreliable). Fall back to no-type.
async function searchWithFallback({ query, preset, searchSymbols }) {
  try { return await searchSymbols({ query, type: preset.searchType }); }
  catch (error) {
    if (preset.searchType && /returned 400/i.test(String(error?.message || ''))) {
      return searchSymbols({ query, type: '' });
    }
    throw error;
  }
}

async function resolveTickers({ query, tickers, preset, exchange, limit, searchSymbols }) {
  const explicit = parseList(tickers);
  if (explicit.length > 0) {
    // Each explicit ticker either already has EXCHANGE:SYM form (pass-through)
    // or needs hydration via symbolSearch to fully-qualify it.
    const normalized = await Promise.all(explicit.map(async (ticker) => {
      if (ticker.includes(':')) return ticker;
      const results = await searchWithFallback({ query: ticker, preset, searchSymbols });
      const exact = (results.results || []).find((item) => {
        if (exchange && String(item.exchange || '').toLowerCase() !== String(exchange).toLowerCase()) return false;
        return String(item.symbol || '').toLowerCase() === String(ticker).toLowerCase() && matchesPreset(item, preset);
      });
      return exact?.full_name || ticker;
    }));
    return normalized;
  }
  if (!query) return [];
  // No tickers, just a query — hydrate up to 3× the requested limit
  // (capped at 60) so the screener has enough candidates to filter.
  const results = await searchWithFallback({ query, preset, searchSymbols });
  return (results.results || [])
    .filter((item) => {
      if (exchange && (item.exchange || '').toLowerCase() !== String(exchange).toLowerCase()) return false;
      return matchesPreset(item, preset);
    })
    .slice(0, Math.min(limit * 3, 60))
    .map(item => item.full_name || item.symbol);
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Scan TradingView screener endpoint.
 *
 *  market         one of MARKET_PRESETS keys (default 'stock')
 *  asset_type     override for `market` (same key set)
 *  query          search keyword to narrow the ticker universe
 *  tickers        explicit list (CSV string, JSON array, or array) — when
 *                 set, query is ignored; tickers are hydrated to full names
 *  exchange       exchange filter (NASDAQ / NYSE / BINANCE / ...)
 *  sort_by        one of SORT_FIELD_MAP keys
 *  sort_order     'asc' | 'desc' (default 'desc')
 *  limit          1–100 rows (default 20)
 *  min/max_price, min_volume, min/max_change_pct  numeric range filters
 *
 * Returns `{ success, screener, market, asset_type, query, exchange,
 *           requested_tickers, row_count, total_count, sort_by, sort_order,
 *           rows[{ticker,symbol,price,change_pct,change_abs,volume,...}] }`
 */
export async function screenerScan({
  market, asset_type, query, tickers, exchange,
  sort_by, sort_order, limit,
  min_price, max_price, min_volume, min_change_pct, max_change_pct,
  _deps,
} = {}) {
  const fetchImpl = _deps?.fetch || fetch;
  const searchSymbols = _deps?.symbolSearch || _symbolSearch;
  const maxRows = Math.min(Math.max(Number(limit || 20), 1), 100);
  const preset = normalizeMarket(market, asset_type);
  const screener = preset.screener;
  const screenerTickers = await resolveTickers({ query, tickers, preset, exchange, limit: maxRows, searchSymbols });

  const filters = [...(preset.filters || [])];
  maybeAddRangeFilter(filters, 'close', 'egreater', min_price);
  maybeAddRangeFilter(filters, 'close', 'eless', max_price);
  maybeAddRangeFilter(filters, 'volume', 'egreater', min_volume);
  maybeAddRangeFilter(filters, 'change', 'egreater', min_change_pct);
  maybeAddRangeFilter(filters, 'change', 'eless', max_change_pct);

  const columns = [...DEFAULT_COLUMNS];
  const sortField = SORT_FIELD_MAP[sort_by] || SORT_FIELD_MAP.change_pct;
  const sort = { sortBy: sortField, sortOrder: sort_order === 'asc' ? 'asc' : 'desc' };

  const payload = {
    symbols: {
      query: { types: preset.queryTypes || [] },
      tickers: screenerTickers,
    },
    columns,
    sort,
    range: [0, maxRows - 1],
  };
  if (filters.length > 0) payload.filter = filters;

  const response = await fetchImpl(`https://scanner.tradingview.com/${screener}/scan`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': 'https://www.tradingview.com',
      'Referer': 'https://www.tradingview.com/',
      'User-Agent': 'tradingview-mcp/1.0',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`TradingView screener API returned ${response.status}`);
  }

  const data = await response.json();
  // Guard the response shape: data.data should be an array of rows. A
  // non-array (object/null on a soft error) would make `|| []` pass an object
  // straight into .map and throw, or silently misread.
  const rows = (Array.isArray(data.data) ? data.data : []).map(row => formatRow(row, columns));

  return {
    success: true,
    screener,
    market: market || preset.key,
    asset_type: asset_type || preset.key,
    query: query || null,
    exchange: exchange || null,
    requested_tickers: screenerTickers,
    row_count: rows.length,
    total_count: data.totalCount ?? rows.length,
    sort_by: sortField,
    sort_order: sort.sortOrder,
    rows,
  };
}

// Exposed for unit tests; not part of public API.
export const _test = { parseList, normalizeMarket, formatRow, matchesPreset };
