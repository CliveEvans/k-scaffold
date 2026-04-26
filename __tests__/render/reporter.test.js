import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import { pathToFileURL } from 'url';
import {
  reducerForCycle,
  formatStatusBar,
  formatErrorSection,
  formatSourceFiles,
  extractSourceFile,
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
  sourceFiles: [],
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

// ---------------------------------------------------------------------------
// reducerForCycle — sourceFiles accumulation
// ---------------------------------------------------------------------------

describe('reducerForCycle sourceFiles handling', () => {
  it('REPORT_PUG with sourceFile appends to state.sourceFiles', () => {
    const next = reducerForCycle(baseState(), {
      type: 'REPORT_PUG', name: 'my-sheet.pug', ok: false, sourceFile: 'src/_error.pug',
    });
    expect(next.sourceFiles).toContain('src/_error.pug');
  });

  it('REPORT_PUG without sourceFile leaves sourceFiles unchanged', () => {
    const next = reducerForCycle(baseState(), {
      type: 'REPORT_PUG', name: 'my-sheet.pug', ok: true,
    });
    expect(next.sourceFiles).toEqual([]);
  });

  it('REPORT_SCSS with sourceFile appends to state.sourceFiles', () => {
    const next = reducerForCycle(baseState(), {
      type: 'REPORT_SCSS', name: 'my-sheet.scss', ok: false, sourceFile: 'src/_styles.scss',
    });
    expect(next.sourceFiles).toContain('src/_styles.scss');
  });

  it('multiple errors from different files accumulate in sourceFiles', () => {
    let s = reducerForCycle(baseState(), {
      type: 'REPORT_PUG', name: 'sheet.pug', ok: false, sourceFile: 'src/_pug_err.pug',
    });
    s = reducerForCycle(s, {
      type: 'REPORT_SCSS', name: 'sheet.scss', ok: false, sourceFile: 'src/_scss_err.scss',
    });
    expect(s.sourceFiles).toEqual(['src/_pug_err.pug', 'src/_scss_err.scss']);
  });

  it('duplicate sourceFile is not added twice', () => {
    let s = reducerForCycle(baseState(), {
      type: 'REPORT_PUG', name: 'sheet.pug', ok: false, sourceFile: 'src/_error.pug',
    });
    s = reducerForCycle(s, {
      type: 'REPORT_PUG', name: 'sheet.pug', ok: false, sourceFile: 'src/_error.pug',
    });
    expect(s.sourceFiles.filter(f => f === 'src/_error.pug').length).toBe(1);
  });

  it('START_CYCLE clears sourceFiles', () => {
    const s = { ...baseState(), sourceFiles: ['src/_error.pug', 'src/_styles.scss'] };
    const next = reducerForCycle(s, { type: 'START_CYCLE' });
    expect(next.sourceFiles).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// formatSourceFiles
// ---------------------------------------------------------------------------

describe('formatSourceFiles', () => {
  it('returns empty string for an empty array', () => {
    expect(formatSourceFiles([])).toBe('');
  });

  it('formats a single source file with -> prefix', () => {
    const out = formatSourceFiles(['src/_error.pug']);
    expect(out).toBe('-> src/_error.pug');
  });

  it('formats multiple source files on separate lines', () => {
    const out = formatSourceFiles(['src/_err.pug', 'src/_styles.scss']);
    const lines = out.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('-> src/_err.pug');
    expect(lines[1]).toBe('-> src/_styles.scss');
  });
});

// ---------------------------------------------------------------------------
// extractSourceFile
// ---------------------------------------------------------------------------

describe('extractSourceFile', () => {
  // Use a consistent project root for all tests
  const projectRoot = path.resolve('C:\\projects\\my-sheet');

  it('returns null when err has no file info', () => {
    expect(extractSourceFile({}, projectRoot)).toBeNull();
  });

  it('returns null when err.message has no file path', () => {
    const err = { message: 'Something broke in a completely generic way' };
    expect(extractSourceFile(err, projectRoot)).toBeNull();
  });

  it('relativizes err.filename within project root', () => {
    const filePath = path.join(projectRoot, 'src', 'components', 'sheet.pug');
    const err = { filename: filePath };
    expect(extractSourceFile(err, projectRoot)).toBe('src/components/sheet.pug');
  });

  it('marks err.filename in node_modules with [k-scaffold] prefix', () => {
    const filePath = path.join(
      projectRoot, 'node_modules', '@kurohyou', 'k-scaffold', 'lib', 'inputs', '_inputs.pug',
    );
    const err = { filename: filePath };
    const result = extractSourceFile(err, projectRoot);
    expect(result).toContain('[k-scaffold]');
    expect(result).toContain('_inputs.pug');
  });

  it('extracts and relativizes path from err.span.url (SCSS errors)', () => {
    const filePath = path.join(projectRoot, 'src', 'sheet.scss');
    const err = { span: { url: pathToFileURL(filePath) } };
    expect(extractSourceFile(err, projectRoot)).toBe('src/sheet.scss');
  });

  it('parses file path from err.message for runtime pug throws', () => {
    const filePath = path.join(projectRoot, 'src', 'sheet.pug');
    // Normalize to forward slashes as pug uses them in messages
    const msgPath = filePath.replace(/\\/g, '/');
    const err = { message: `+input() mixin called without type - could not read from ${msgPath}` };
    expect(extractSourceFile(err, projectRoot)).toBe('src/sheet.pug');
  });

  it('prefers err.filename over err.message when both present', () => {
    const filenamePath = path.join(projectRoot, 'src', 'real.pug');
    const messagePath = path.join(projectRoot, 'src', 'other.pug').replace(/\\/g, '/');
    const err = {
      filename: filenamePath,
      message: `error in ${messagePath}`,
    };
    expect(extractSourceFile(err, projectRoot)).toBe('src/real.pug');
  });

  it('prefers err.span.url over err.message for SCSS when both present', () => {
    const scssFile = path.join(projectRoot, 'src', 'real.scss');
    const messagePath = path.join(projectRoot, 'src', 'other.scss').replace(/\\/g, '/');
    const err = {
      span: { url: pathToFileURL(scssFile) },
      message: `error in ${messagePath}`,
    };
    expect(extractSourceFile(err, projectRoot)).toBe('src/real.scss');
  });
});
