/**
 * Smoke tests — src/tools/_validation.js::boolish.
 *
 * Guards the z.coerce.boolean() footgun: Boolean("false") === true, which on a
 * default-true flag (e.g. tv_launch kill_existing) silently flips an opt-out
 * into the destructive default. boolish must read string spellings literally.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { boolish } from '../../src/tools/_validation.js';

describe('_validation.js — boolish', () => {
  const opt = boolish.optional();

  it('coerces falsey string spellings to false', () => {
    for (const s of ['false', 'False', 'FALSE', '0', 'no', 'off', '']) {
      assert.equal(opt.parse(s), false, `${JSON.stringify(s)} should be false`);
    }
  });

  it('coerces truthy string spellings to true', () => {
    for (const s of ['true', 'True', '1', 'yes', 'on']) {
      assert.equal(opt.parse(s), true, `${JSON.stringify(s)} should be true`);
    }
  });

  it('passes real booleans through unchanged', () => {
    assert.equal(opt.parse(true), true);
    assert.equal(opt.parse(false), false);
  });

  it('leaves undefined undefined when optional', () => {
    assert.equal(opt.parse(undefined), undefined);
  });

  it('rejects unrecognized strings rather than silently coercing', () => {
    assert.equal(opt.safeParse('maybe').success, false);
    assert.equal(boolish.safeParse('garbage').success, false);
  });
});
