import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

import { createDebouncer, createContentHashCache, shouldSkipFile } from '../../lib/render/watchUtils';

describe('createDebouncer()', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces rapid calls for the same key into one invocation', () => {
    const debounce = createDebouncer({ wait: 100 });
    const fn = vi.fn();
    debounce('a.pug', () => fn('call-1'));
    debounce('a.pug', () => fn('call-2'));
    debounce('a.pug', () => fn('call-3'));
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('call-3');
  });

  it('invokes per-key independently', () => {
    const debounce = createDebouncer({ wait: 100 });
    const fn = vi.fn();
    debounce('a.pug', () => fn('a'));
    debounce('b.pug', () => fn('b'));
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn.mock.calls.map(c => c[0]).sort()).toEqual(['a', 'b']);
  });

  it('does not invoke before wait elapses', () => {
    const debounce = createDebouncer({ wait: 500 });
    const fn = vi.fn();
    debounce('x', fn);
    vi.advanceTimersByTime(499);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('createContentHashCache()', () => {
  let tmpDir;
  let tmpFile;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'watchutil-'));
    tmpFile = path.join(tmpDir, 'sample.pug');
    await fs.writeFile(tmpFile, 'original contents');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('reports change on first read for a path (no prior hash)', async () => {
    const cache = createContentHashCache();
    const changed = await cache.hasChanged(tmpFile);
    expect(changed).toBe(true);
  });

  it('reports no change when content is unchanged', async () => {
    const cache = createContentHashCache();
    await cache.hasChanged(tmpFile);
    const changedAgain = await cache.hasChanged(tmpFile);
    expect(changedAgain).toBe(false);
  });

  it('reports change when content differs from cached hash', async () => {
    const cache = createContentHashCache();
    await cache.hasChanged(tmpFile);
    await fs.writeFile(tmpFile, 'modified contents');
    const changed = await cache.hasChanged(tmpFile);
    expect(changed).toBe(true);
  });

  it('reports change (true) when file cannot be read (e.g. deleted)', async () => {
    const cache = createContentHashCache();
    await cache.hasChanged(tmpFile);
    await fs.rm(tmpFile);
    const changed = await cache.hasChanged(tmpFile);
    expect(changed).toBe(true);
  });
});

describe('shouldSkipFile()', () => {
  it('skips node_modules paths on Unix-style separators', () => {
    expect(shouldSkipFile('/project/source/node_modules/foo.js')).toBe(true);
  });

  it('skips node_modules paths on Windows-style separators', () => {
    expect(shouldSkipFile('E:\\project\\source\\node_modules\\foo.js')).toBe(true);
  });

  it('skips .git paths on both separators', () => {
    expect(shouldSkipFile('/project/.git/index')).toBe(true);
    expect(shouldSkipFile('E:\\project\\.git\\index')).toBe(true);
  });

  it('skips generated test framework', () => {
    expect(shouldSkipFile('__tests__/testFramework.js')).toBe(true);
    expect(shouldSkipFile('E:\\project\\__tests__\\anything.test.js')).toBe(true);
    expect(shouldSkipFile('__tests__/foo.mock.js')).toBe(true);
  });

  it('allows normal source files', () => {
    expect(shouldSkipFile('/project/source/main.pug')).toBe(false);
    expect(shouldSkipFile('E:\\project\\source\\main.pug')).toBe(false);
    expect(shouldSkipFile('E:\\project\\source\\main.scss')).toBe(false);
    expect(shouldSkipFile('E:\\project\\source\\translation.json')).toBe(false);
  });
});
