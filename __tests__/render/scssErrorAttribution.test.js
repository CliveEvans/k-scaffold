import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { pathToFileURL } from 'url';

import {
  findScssBlocks,
  countBraceDelta,
  attributeScssError,
} from '../../lib/render/scssErrorAttribution.js';

// ---------------------------------------------------------------------------
// countBraceDelta
// ---------------------------------------------------------------------------

describe('countBraceDelta', () => {
  it('returns 0 for empty string', () => {
    expect(countBraceDelta('')).toBe(0);
  });

  it('returns 0 for balanced braces', () => {
    expect(countBraceDelta('.foo { color: red; }')).toBe(0);
  });

  it('returns +1 for one extra open brace', () => {
    expect(countBraceDelta('.foo { color: red;')).toBe(1);
  });

  it('returns -1 for one extra close brace', () => {
    expect(countBraceDelta('.foo { color: red; } }')).toBe(-1);
  });

  it('ignores braces inside double-quoted strings', () => {
    expect(countBraceDelta('.foo { content: "{}{}{"; }')).toBe(0);
  });

  it('ignores braces inside single-quoted strings', () => {
    expect(countBraceDelta(`.foo { content: '{{{'; }`)).toBe(0);
  });

  it('ignores braces inside line comments', () => {
    expect(countBraceDelta('.foo { // unclosed { in comment\n  color: red;\n}')).toBe(0);
  });

  it('ignores braces inside block comments', () => {
    expect(countBraceDelta('.foo { /* { unclosed */ color: red; }')).toBe(0);
  });

  it('handles nested balanced braces', () => {
    expect(countBraceDelta('@mixin x { .a { color: red; } .b { color: blue; } }')).toBe(0);
  });

  it('handles escaped quotes inside strings', () => {
    expect(countBraceDelta('.foo { content: "a\\"{b"; }')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// findScssBlocks — fixture-based
// ---------------------------------------------------------------------------

describe('findScssBlocks', () => {
  let tmpDir;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'k-scaffold-scss-blocks-'));
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const writeFile = async (rel, content) => {
    const abs = path.join(tmpDir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
    return abs;
  };

  it('returns empty array for entry with no +scss blocks', async () => {
    const entry = await writeFile('a/no-scss.pug', `h1 Hello\np Some text\n`);
    expect(findScssBlocks(entry)).toEqual([]);
  });

  it('finds a single +scss block with its content', async () => {
    const entry = await writeFile('b/single.pug', `+scss.\n  .foo { color: red; }\n`);
    const blocks = findScssBlocks(entry);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toContain('.foo');
    expect(blocks[0].content).toContain('color: red;');
    expect(blocks[0].filename).toBe(path.resolve(entry));
  });

  it('reports the line number of the +scss mixin call', async () => {
    const entry = await writeFile('c/lines.pug', `h1 Header\np Some paragraph\n+scss.\n  .x { color: red; }\n`);
    const blocks = findScssBlocks(entry);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].line).toBe(3);
  });

  it('finds multiple +scss blocks in one file', async () => {
    const entry = await writeFile('d/multiple.pug', `+scss.\n  .a { color: red; }\n+scss.\n  .b { color: blue; }\n`);
    const blocks = findScssBlocks(entry);
    expect(blocks).toHaveLength(2);
  });

  it('recurses into included pug files', async () => {
    const included = await writeFile('e/views/_part.pug', `+scss.\n  .partial { color: green; }\n`);
    const entry = await writeFile('e/main.pug', `h1 Sheet\ninclude views/_part\n+scss.\n  .root { color: red; }\n`);
    const blocks = findScssBlocks(entry);
    expect(blocks).toHaveLength(2);
    const filenames = blocks.map((b) => path.resolve(b.filename)).sort();
    expect(filenames).toContain(path.resolve(included));
    expect(filenames).toContain(path.resolve(entry));
  });

  it('does not crash on circular includes', async () => {
    const a = await writeFile('f/a.pug', `include b\n+scss.\n  .x { color: red; }\n`);
    await writeFile('f/b.pug', `include a\n`);
    expect(() => findScssBlocks(a)).not.toThrow();
  });

  it('ignores +other.-style mixin calls that are not +scss', async () => {
    const entry = await writeFile('g/other.pug', `+other.\n  .foo { color: red; }\n+scss.\n  .real { color: blue; }\n`);
    const blocks = findScssBlocks(entry);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toContain('.real');
  });

  it('returns empty array when entry file does not exist', () => {
    expect(findScssBlocks(path.join(tmpDir, 'nope.pug'))).toEqual([]);
  });

  it('does not crash on unparseable pug files', async () => {
    const entry = await writeFile('h/bad.pug', `+scss.\n  .x { color: red; }\n!!! invalid <<< pug\n`);
    expect(() => findScssBlocks(entry)).not.toThrow();
  });

  it('captures scope arg when provided', async () => {
    const entry = await writeFile('i/scoped.pug', `+scss('sheet').\n  .x { color: red; }\n`);
    const blocks = findScssBlocks(entry);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].args).toContain('sheet');
  });
});

// ---------------------------------------------------------------------------
// attributeScssError — high-level error attribution
// ---------------------------------------------------------------------------

describe('attributeScssError', () => {
  let tmpDir;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'k-scaffold-scss-attr-'));
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const writeFile = async (rel, content) => {
    const abs = path.join(tmpDir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
    return abs;
  };

  it('returns null when there are no +scss blocks', async () => {
    const entry = await writeFile('a/empty.pug', `h1 Hello\n`);
    const err = { message: 'something broke', span: { text: 'foo' } };
    expect(attributeScssError(err, entry)).toBeNull();
  });

  it('attributes a brace imbalance to the offending block', async () => {
    const broken = await writeFile('b/views/_edit.pug', `+scss.\n  .error{\n  .other { color: blue; }\n`);
    const entry = await writeFile('b/main.pug', `include views/_edit\n`);
    const err = { message: 'Mixins may not contain mixin declarations.', span: {} };
    const result = attributeScssError(err, entry);
    expect(result).not.toBeNull();
    expect(result.reason).toBe('brace-imbalance');
    expect(path.resolve(result.filename)).toBe(path.resolve(broken));
    expect(result.delta).toBeGreaterThan(0);
  });

  it('attributes brace imbalance even when err.span is missing', async () => {
    const broken = await writeFile('c/_broken.pug', `+scss.\n  .error{\n`);
    const result = attributeScssError({ message: 'expected `}`' }, broken);
    expect(result).not.toBeNull();
    expect(result.reason).toBe('brace-imbalance');
  });

  it('attributes a non-imbalance error via err.span.context match', async () => {
    const a = await writeFile('d/views/_a.pug', `+scss.\n  .a { color: red; }\n`);
    const b = await writeFile('d/views/_b.pug', `+scss.\n  .b { color: $undefined-var; }\n`);
    const entry = await writeFile('d/main.pug', `include views/_a\ninclude views/_b\n`);
    const err = {
      message: 'Undefined variable.',
      span: { context: '.b { color: $undefined-var; }', text: '$undefined-var' },
    };
    const result = attributeScssError(err, entry);
    expect(result).not.toBeNull();
    expect(result.reason).toBe('snippet-match');
    expect(path.resolve(result.filename)).toBe(path.resolve(b));
  });

  it('falls back to err.span.text when context does not match any block', async () => {
    const file = await writeFile('e/_x.pug', `+scss.\n  .x { color: $missing-var; }\n`);
    const err = {
      message: 'Undefined variable.',
      span: { context: 'something completely different', text: '$missing-var' },
    };
    const result = attributeScssError(err, file);
    expect(result).not.toBeNull();
    expect(result.reason).toBe('snippet-match');
    expect(path.resolve(result.filename)).toBe(path.resolve(file));
  });

  it('returns null when no attribution can be made', async () => {
    const file = await writeFile('f/_balanced.pug', `+scss.\n  .a { color: red; }\n`);
    const err = {
      message: 'Some unrelated error.',
      span: { context: 'completely unrelated content', text: 'unrelated' },
    };
    expect(attributeScssError(err, file)).toBeNull();
  });

  it('reports the +scss mixin line not the inner content line', async () => {
    const file = await writeFile('g/_lines.pug', `h1 Header\np Some text\n+scss.\n  .x { color: $undef; }\n`);
    const err = {
      message: 'Undefined variable.',
      span: { context: '.x { color: $undef; }', text: '$undef' },
    };
    const result = attributeScssError(err, file);
    expect(result).not.toBeNull();
    expect(result.line).toBe(3);
  });

  it('prefers brace-imbalance over snippet-match when both apply', async () => {
    const file = await writeFile('h/_both.pug', `+scss.\n  .x { color: $undef;\n`);
    const err = {
      message: 'Mixins may not contain mixin declarations.',
      span: { context: '$undef', text: '$undef' },
    };
    const result = attributeScssError(err, file);
    expect(result).not.toBeNull();
    expect(result.reason).toBe('brace-imbalance');
  });

  it('ignores empty/whitespace span text to avoid false matches', async () => {
    const file = await writeFile('i/_x.pug', `+scss.\n  .x { color: red; }\n`);
    const err = { message: 'something', span: { context: '   ', text: ' ' } };
    expect(attributeScssError(err, file)).toBeNull();
  });

  it('finds the broken block among many balanced ones', async () => {
    const broken = await writeFile('j/views/_broken.pug', `+scss.\n  .broken{\n`);
    const ok1 = await writeFile('j/views/_ok1.pug', `+scss.\n  .ok1 { color: red; }\n`);
    const ok2 = await writeFile('j/views/_ok2.pug', `+scss.\n  .ok2 { color: blue; }\n`);
    const entry = await writeFile('j/main.pug', `include views/_ok1\ninclude views/_broken\ninclude views/_ok2\n`);
    const result = attributeScssError({ message: 'expected `}`', span: {} }, entry);
    expect(result).not.toBeNull();
    expect(path.resolve(result.filename)).toBe(path.resolve(broken));
  });
});
