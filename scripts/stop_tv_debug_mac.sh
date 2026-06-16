#!/bin/bash
# Stop TradingView Desktop debug launcher/processes on macOS.
# Usage: ./scripts/stop_tv_debug_mac.sh [--keep-app]

set -u

KEEP_APP=0
if [ "${1:-}" = "--keep-app" ]; then
  KEEP_APP=1
elif [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  echo "Usage: ./scripts/stop_tv_debug_mac.sh [--keep-app]"
  echo ""
  echo "Stops launch_tv_debug_mac.sh. By default also stops TradingView."
  echo "Use --keep-app to leave TradingView running."
  exit 0
fi

echo "Stopping TradingView debug launcher..."
pkill -f "scripts/launch_tv_debug_mac.sh" 2>/dev/null || true
pkill -f "launch_tv_debug_mac.sh" 2>/dev/null || true

if [ "$KEEP_APP" -eq 1 ]; then
  echo "Leaving TradingView running (--keep-app)."
else
  echo "Stopping TradingView..."
  pkill -f "TradingView.*remote-debugging-port" 2>/dev/null || true
  pkill -f "TradingView" 2>/dev/null || true
fi

echo "Done."
