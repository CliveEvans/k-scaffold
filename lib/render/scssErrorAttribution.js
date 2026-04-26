/**
 * @file scssErrorAttribution.js
 *
 * SCSS error source attribution for the K-scaffold build pipeline.
 *
 * The K-scaffold's `+scss.` mixin lets users embed SCSS directly in their pug
 * files.  At render time, every `+scss.` block's text is concatenated into a
 * single virtual `sfc.scss` file (one `@mixin sheet { ... }` and one
 * `@mixin roll { ... }` block).  When `sass-embedded` reports an error in that
 * virtual file, the only file path it knows is the top-level `.scss` entry —
 * so build output incorrectly attributes the error to e.g. `MyProject.pug`,
 * not the actual pug file (often a deeply-included partial) where the bad
 * SCSS lives.
 *
 * This module re-parses the pug source tree, collects every `+scss.` block's
 * raw text, and maps an SCSS error back to the originating pug file via two
 * complementary strategies:
 *
 * 1. **Brace-imbalance scan.**  An unclosed `{` (or extra `}`) inside a
 *    `+scss.` block makes the SFC's `@mixin sheet { ... }` wrapper close in
 *    the wrong place, which causes SASS to report the error on a synthetic
 *    line far from the user's actual mistake.  We scan each block's text
 *    independently and report the first one whose `{`/`}` count doesn't
 *    balance.
 *
 * 2. **Snippet-match scan.**  For non-imbalance errors (undefined variables,
 *    invalid syntax, etc.) the SASS error's `span.context` / `span.text`
 *    contains the actual offending substring.  We search the collected
 *    `+scss.` blocks for that substring.
 *
 * @typedef {Object} ScssBlock
 * @property {string} filename       - Absolute path of the pug file containing the block.
 * @property {number} line           - Line number of the `+scss` mixin call in the pug file.
 * @property {string|null} args      - Mixin args (raw, unquoted), or null.
 * @property {string} content        - Concatenated raw text of the block.
 *
 * @typedef {Object} Attribution
 * @property {string} filename       - Pug file path (absolute) of the offending block.
 * @property {number} line           - `+scss` mixin call line in that file.
 * @property {string} reason         - 'brace-imbalance' or 'snippet-match'.
 * @property {number} [delta]        - Net open-brace minus close-brace (brace-imbalance only).
 * @property {string} [snippet]      - The matched substring (snippet-match only).
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const lex   = require('pug-lexer');
const parse = require('pug-parser');

// ---------------------------------------------------------------------------
// countBraceDelta
// ---------------------------------------------------------------------------

/**
 * Count net open-brace minus close-brace in `text`, ignoring braces inside
 * string literals and comments (line and block).
 *
 * @param {string} text
 * @returns {number} positive = unclosed open; negative = extra close; 0 = balanced.
 */
const countBraceDelta = (text) => {
  let delta = 0;
  let i = 0;
  const len = text.length;
  while (i < len) {
    const ch = text[i];

    // Line comment: skip to end of line.
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? len : nl + 1;
      continue;
    }

    // Block comment: skip to closing */
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? len : end + 2;
      continue;
    }

    // String literal: skip to matching unescaped quote.
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < len && text[i] !== quote) {
        if (text[i] === '\\') i++; // skip escaped char
        i++;
      }
      i++;
      continue;
    }

    if (ch === '{') delta++;
    else if (ch === '}') delta--;
    i++;
  }
  return delta;
};

// ---------------------------------------------------------------------------
// AST scanning
// ---------------------------------------------------------------------------

/**
 * Concatenate all Text-node values inside a Mixin block AST.
 * Whitespace/newlines between Text nodes are preserved because the lexer
 * emits them as their own Text nodes with `val: '\n'`.
 *
 * @param {object} block - Pug AST Block node.
 * @returns {string}
 */
const concatBlockText = (block) => {
  if (!block?.nodes) return '';
  return block.nodes
    .filter((n) => n.type === 'Text')
    .map((n) => n.val)
    .join('');
};

/**
 * Resolve a pug `include` path against the including file's directory.
 * Pug allows the `.pug` extension to be omitted, so try both.
 *
 * @param {string} inclPath - Raw path from the AST node.
 * @param {string} fromFile - Absolute path of the including pug file.
 * @returns {string|null}   - Resolved absolute path, or null if no file matches.
 */
const resolveInclude = (inclPath, fromFile) => {
  const base = path.isAbsolute(inclPath)
    ? inclPath
    : path.resolve(path.dirname(fromFile), inclPath);
  const candidates = base.endsWith('.pug') ? [base] : [base, `${base}.pug`];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch (_) { /* not found */ }
  }
  return null;
};

/**
 * Walk a pug AST node, collecting `+scss` mixin-call info into `out` and
 * recursing into RawInclude/Include children to follow the include graph.
 *
 * @param {object} node       - Current AST node.
 * @param {string} currentFile - Absolute path of the file this node was parsed from.
 * @param {Set<string>} visited - Files already visited (cycle guard).
 * @param {ScssBlock[]} out    - Accumulator.
 */
const walkAst = (node, currentFile, visited, out) => {
  if (!node || typeof node !== 'object') return;

  if (node.type === 'Mixin' && node.name === 'scss' && node.call && node.block) {
    out.push({
      filename: node.filename || currentFile,
      line:     node.line,
      args:     node.args || null,
      content:  concatBlockText(node.block),
    });
  }

  if ((node.type === 'RawInclude' || node.type === 'Include') && node.file?.path) {
    const resolved = resolveInclude(node.file.path, currentFile);
    if (resolved) walkFile(resolved, visited, out);
  }

  for (const key of ['block', 'consequent', 'alternate']) {
    if (node[key]) walkAst(node[key], currentFile, visited, out);
  }
  if (Array.isArray(node.nodes)) {
    for (const child of node.nodes) walkAst(child, currentFile, visited, out);
  }
};

/**
 * Read, lex, parse, and walk a single pug file.  Errors are swallowed so that
 * malformed pug never breaks the build's error reporting.
 */
const walkFile = (filePath, visited, out) => {
  const abs = path.resolve(filePath);
  if (visited.has(abs)) return;
  visited.add(abs);

  let content;
  try { content = fs.readFileSync(abs, 'utf8'); } catch (_) { return; }

  let ast;
  try {
    const tokens = lex(content, { filename: abs });
    ast = parse(tokens, { filename: abs, src: content });
  } catch (_) { return; }

  walkAst(ast, abs, visited, out);
};

/**
 * Collect every `+scss` mixin call reachable from `entryPath` via includes.
 *
 * @param {string} entryPath - Absolute or cwd-relative pug file path.
 * @returns {ScssBlock[]}
 */
const findScssBlocks = (entryPath) => {
  const out = [];
  walkFile(entryPath, new Set(), out);
  return out;
};

// ---------------------------------------------------------------------------
// Error attribution
// ---------------------------------------------------------------------------

/**
 * Trim `s` and discard if too short to be a useful match-needle (avoids false
 * positives like a stray `;` matching dozens of blocks).
 */
const usableSnippet = (s) => {
  if (typeof s !== 'string') return null;
  const trimmed = s.trim();
  return trimmed.length >= 3 ? trimmed : null;
};

/**
 * Map a SASS error to the `+scss.` block it most likely originated from.
 *
 * Strategy order:
 *   1. Brace imbalance — any block with non-zero `{`-`}` count is the prime
 *      suspect, regardless of what SASS reported.  This case is checked first
 *      because brace-imbalance errors mislocate inside the synthetic SFC.
 *   2. Snippet match on `err.span.context` (the source line containing the
 *      error) — preferred over the bare span text because it's more specific.
 *   3. Snippet match on `err.span.text` (the offending substring) — fallback.
 *
 * @param {object} err          - SASS error object.
 * @param {string} entryPugPath - Path of the pug file that produced the SCSS.
 * @returns {Attribution|null}
 */
const attributeScssError = (err, entryPugPath) => {
  const blocks = findScssBlocks(entryPugPath);
  if (!blocks.length) return null;

  for (const block of blocks) {
    const delta = countBraceDelta(block.content);
    if (delta !== 0) {
      return {
        filename: block.filename,
        line:     block.line,
        reason:   'brace-imbalance',
        delta,
      };
    }
  }

  const candidates = [
    usableSnippet(err?.span?.context),
    usableSnippet(err?.span?.text),
  ].filter(Boolean);

  for (const snippet of candidates) {
    const hit = blocks.find((b) => b.content.includes(snippet));
    if (hit) {
      return {
        filename: hit.filename,
        line:     hit.line,
        reason:   'snippet-match',
        snippet,
      };
    }
  }

  return null;
};

module.exports = {
  countBraceDelta,
  findScssBlocks,
  attributeScssError,
};
