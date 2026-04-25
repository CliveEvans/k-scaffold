import { describe, it, expect, beforeEach } from 'vitest';
import {
  reducerForCycle,
  formatStatusBar,
  formatErrorSection,
} from '../../lib/render/reporter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip ANSI escape codes from a string so we can measure/compare content. */
const stripAnsi = (str) => str.replace(/\x1b\[[0-9;]*m/g, '');

const baseState = () => ({
  projectName: 'my-sheet',
  pug:      { files: ['my-sheet.pug'],  hasError: false },
  scss:     { files: ['my-sheet.scss'], hasError: false },
  template: { hasError: false },
  errors:   [],
});

// ---------------------------------------------------------------------------
// reducerForCycle
// ---------------------------------------------------------------------------

describe('reducerForCycle', () => {
  let state;
  beforeEach(() => {
    state = {
      ...baseState(),
      scss:   { files: ['my-sheet.scss'], hasError: true },
      errors: ['old error'],
    };
  });

  it('START_CYCLE clears errors array', () => {
    const next = reducerForCycle(state, { type: 'START_CYCLE' });
    expect(next.errors).toEqual([]);
  });

  it('START_CYCLE resets pug hasError to false', () => {
    const s = { ...baseState(), pug: { files: [], hasError: true } };
    const next = reducerForCycle(s, { type: 'START_CYCLE' });
    expect(next.pug.hasError).toBe(false);
  });

  it('START_CYCLE resets scss hasError to false', () => {
    const next = reducerForCycle(state, { type: 'START_CYCLE' });
    expect(next.scss.hasError).toBe(false);
  });

  it('START_CYCLE resets template hasError to false', () => {
    const s = { ...baseState(), template: { hasError: true } };
    const next = reducerForCycle(s, { type: 'START_CYCLE' });
    expect(next.template.hasError).toBe(false);
  });

  it('REPORT_PUG ok=true leaves hasError false', () => {
    const next = reducerForCycle(baseState(), { type: 'REPORT_PUG', name: 'my-sheet.pug', ok: true });
    expect(next.pug.hasError).toBe(false);
  });

  it('REPORT_PUG ok=false sets hasError true', () => {
    const next = reducerForCycle(baseState(), { type: 'REPORT_PUG', name: 'my-sheet.pug', ok: false });
    expect(next.pug.hasError).toBe(true);
  });

  it('REPORT_PUG records the filename', () => {
    const next = reducerForCycle(
      { ...baseState(), pug: { files: [], hasError: false } },
      { type: 'REPORT_PUG', name: 'new-sheet.pug', ok: true },
    );
    expect(next.pug.files).toContain('new-sheet.pug');
  });

  it('REPORT_SCSS ok=false sets hasError true', () => {
    const next = reducerForCycle(baseState(), { type: 'REPORT_SCSS', name: 'my-sheet.scss', ok: false });
    expect(next.scss.hasError).toBe(true);
  });

  it('REPORT_SCSS ok=true leaves hasError false', () => {
    const next = reducerForCycle(baseState(), { type: 'REPORT_SCSS', name: 'my-sheet.scss', ok: true });
    expect(next.scss.hasError).toBe(false);
  });

  it('REPORT_TEMPLATE ok=false sets hasError true', () => {
    const next = reducerForCycle(baseState(), { type: 'REPORT_TEMPLATE', ok: false });
    expect(next.template.hasError).toBe(true);
  });

  it('REPORT_TEMPLATE ok=true leaves hasError false', () => {
    const next = reducerForCycle(baseState(), { type: 'REPORT_TEMPLATE', ok: true });
    expect(next.template.hasError).toBe(false);
  });

  it('ADD_ERROR appends a message to the errors array', () => {
    const next = reducerForCycle(
      { ...baseState(), errors: [] },
      { type: 'ADD_ERROR', message: 'Something broke' },
    );
    expect(next.errors).toContain('Something broke');
  });

  it('multiple ADD_ERROR events accumulate in order', () => {
    let s = { ...baseState(), errors: [] };
    s = reducerForCycle(s, { type: 'ADD_ERROR', message: 'first' });
    s = reducerForCycle(s, { type: 'ADD_ERROR', message: 'second' });
    expect(s.errors).toEqual(['first', 'second']);
  });

  it('does not mutate the original state object', () => {
    const original = { ...baseState(), errors: ['keep me'] };
    reducerForCycle(original, { type: 'START_CYCLE' });
    expect(original.errors).toEqual(['keep me']);
  });

  it('does not mutate nested pug object', () => {
    const original = baseState();
    reducerForCycle(original, { type: 'REPORT_PUG', name: 'sheet.pug', ok: false });
    expect(original.pug.hasError).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatStatusBar
// ---------------------------------------------------------------------------

describe('formatStatusBar', () => {
  it('returns a string', () => {
    expect(typeof formatStatusBar(baseState(), 80)).toBe('string');
  });

  it('contains the pug filename', () => {
    const bar = stripAnsi(formatStatusBar(baseState(), 80));
    expect(bar).toContain('my-sheet.pug');
  });

  it('contains the scss filename', () => {
    const bar = stripAnsi(formatStatusBar(baseState(), 80));
    expect(bar).toContain('my-sheet.scss');
  });

  it('contains a template label', () => {
    const bar = stripAnsi(formatStatusBar(baseState(), 80));
    expect(bar).toMatch(/translation\.json|sheet\.json/);
  });

  it('stripped length does not exceed terminalWidth', () => {
    const bar = stripAnsi(formatStatusBar(baseState(), 40));
    // Each segment on the bar is a single line; check the longest line
    const longest = bar.split('\n').reduce((max, l) => Math.max(max, l.length), 0);
    expect(longest).toBeLessThanOrEqual(40);
  });

  it('uses different color codes for pug error vs ok states', () => {
    const ok = formatStatusBar(baseState(), 80);
    const errState = reducerForCycle(baseState(), { type: 'REPORT_PUG', name: 'my-sheet.pug', ok: false });
    const err = formatStatusBar(errState, 80);
    // The raw strings (with ANSI) should differ because error = red, ok = green
    expect(ok).not.toBe(err);
  });

  it('uses different color codes for scss error vs ok states', () => {
    const ok = formatStatusBar(baseState(), 80);
    const errState = reducerForCycle(baseState(), { type: 'REPORT_SCSS', name: 'my-sheet.scss', ok: false });
    const err = formatStatusBar(errState, 80);
    expect(ok).not.toBe(err);
  });

  it('uses different color codes for template error vs ok states', () => {
    const ok = formatStatusBar(baseState(), 80);
    const errState = reducerForCycle(baseState(), { type: 'REPORT_TEMPLATE', ok: false });
    const err = formatStatusBar(errState, 80);
    expect(ok).not.toBe(err);
  });
});

// ---------------------------------------------------------------------------
// formatErrorSection
// ---------------------------------------------------------------------------

describe('formatErrorSection', () => {
  it('returns empty string when errors array is empty', () => {
    expect(formatErrorSection([], 10)).toBe('');
  });

  it('includes the error message text', () => {
    const out = formatErrorSection(['Error: file not found'], 10);
    expect(out).toContain('Error: file not found');
  });

  it('includes all errors when count is within maxLines', () => {
    const errors = ['alpha', 'beta', 'gamma'];
    const out = formatErrorSection(errors, 10);
    expect(out).toContain('alpha');
    expect(out).toContain('beta');
    expect(out).toContain('gamma');
  });

  it('clips output to maxLines', () => {
    const errors = ['a', 'b', 'c', 'd', 'e'];
    const out = formatErrorSection(errors, 3);
    const lines = out.split('\n').filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(3);
  });

  it('returns a string', () => {
    expect(typeof formatErrorSection(['err'], 5)).toBe('string');
  });
});
