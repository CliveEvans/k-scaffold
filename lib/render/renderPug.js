'use strict';

const pug = require('pug');
const path = require('path');

const getTemplate = require('./getTemplate');
const outputPug = require('./outputPug');
const { reporter, extractSourceFile } = require('./reporter');

/**
 * Walk the pug AST (depth-first) and return the first Code node whose `val`
 * fails @babel/parser validation — the same parser the `with` package uses.
 * Recursively follows Include nodes so errors in included files are found.
 *
 * Returns { line, val, filename, errorMsg } or null.
 */
const findBadCodeExpression = (templateContent, sourceFilePath) => {
  try {
    const fs    = require('fs');
    const lex   = require('pug-lexer');
    const parse = require('pug-parser');
    const { parse: babelParse } = require('@babel/parser');
    const babelOpts = { allowReturnOutsideFunction: true, allowImportExportEverywhere: true };

    // Collect all Code nodes from one file, then recurse into includes.
    // `visited` prevents infinite loops from circular includes.
    const collectNodes = (content, filePath, visited = new Set()) => {
      const abs = path.resolve(filePath);
      if (visited.has(abs)) return [];
      visited.add(abs);

      try {
        const tokens = lex(content, { filename: abs });
        const ast    = parse(tokens, { filename: abs, src: content });
        const nodes  = [];

        const walk = (node) => {
          if (!node || typeof node !== 'object') return;

          if (node.type === 'Code' && node.val) {
            nodes.push({
              line:           node.line,
              val:            node.val,
              filename:       node.filename || abs,
              hasBlockNodes:  (node.block?.nodes?.length ?? 0) > 0,
            });
          }

          // Recursively scan included files (skip node_modules — always valid).
          if (node.type === 'Include' && node.file?.path) {
            const inclPath = path.isAbsolute(node.file.path)
              ? node.file.path
              : path.resolve(path.dirname(abs), node.file.path);
            const normIncl = inclPath.replace(/\\/g, '/');
            if (!normIncl.includes('/node_modules/') && !visited.has(path.resolve(inclPath))) {
              try {
                const inclContent = fs.readFileSync(inclPath, 'utf8');
                nodes.push(...collectNodes(inclContent, inclPath, visited));
              } catch (_) {}
            }
          }

          for (const key of ['block', 'consequent', 'alternate']) {
            if (node[key]) walk(node[key]);
          }
          if (Array.isArray(node.nodes)) node.nodes.forEach(walk);
        };

        walk(ast);
        return nodes;
      } catch (_) {
        return [];
      }
    };

    for (const node of collectNodes(templateContent, sourceFilePath)) {
      // Control-flow Code nodes (for/while/if headers) store only the statement
      // header in `val` — the body lives in `node.block`.  Validating just the
      // header fails because it has no body, producing a false positive.  Append
      // a dummy `{}` so Babel sees a syntactically complete statement and only
      // flags nodes whose `val` itself contains the real error.
      const testVal = node.hasBlockNodes ? `${node.val} {}` : node.val;
      try {
        babelParse(testVal, babelOpts);
      } catch (e) {
        return {
          line:     node.line,
          val:      node.val,
          filename: node.filename,
          errorMsg: e.message.replace(/\s*\(\d+:\d+\)\s*$/, ''),
        };
      }
    }

    return null;
  } catch (_) {
    return null;
  }
};

/**
 * Renders pug into html text
 * @memberof Render
 * @param {string} source - The path to the file you want to parse as pug.
 * @param {string} destination - The path to the file where you want to store the rendered HTML.
 * @param {object} [options] - Options for how the k-scaffold should parse the pug and options that should be passed to pugjs. Accepts all options specified at pugjs.org as well as:
 * @param {boolean} [options.suppressStack = true] - Whether the K-scaffold should suppress the full error stack from pug and only display the message portion of the error. The stack traces provided by pug do not refer to the actual chain of included pug files, and so are usually useless in troubleshooting an issue.
 * @returns {Promise<string|null>} - The rendered HTML or null if an error occurred
 */
const renderPug = async ({source, destination, testDestination, options = {suppressStack: true}, templates}) => {
  const name = path.basename(source);
  const template = await getTemplate(source);
  try {
    const k = require('./locals');
    k.resetObjs();
    const html = pug.render(template, {
      pretty: true,
      ...options,
      ...k,
      filename: source,
      basedir: path.dirname(process.argv[1]),
    });
    const sfcStyles = await outputPug(html, destination, testDestination, templates);
    reporter.reportPug(name, true);
    return [html, sfcStyles, k.k.fonts];
  } catch (err) {
    let sourceFile = extractSourceFile(err, process.cwd());
    if (err.message.endsWith('kScript mixin already used. Kscript should be the final mixin used in the sheet code.')) {
      reporter.error('kScript mixin already used. Kscript should be the final mixin used in the sheet code.');
    } else {
      if (err.babylonError) {
        // The `with` package wraps the pug-generated JS in a scope analysis pass.
        // When that pass finds invalid JS, it discards all location context and
        // throws "Error parsing body of the with expression". Walk the pug AST
        // ourselves to recover the exact source line and a useful error message.
        const bad = findBadCodeExpression(template, source);
        if (bad) {
          const rel = path.relative(process.cwd(), bad.filename).replace(/\\/g, '/');
          reporter.error(`${rel}:${bad.line}: ${bad.errorMsg}\n  - ${bad.val}`);
          if (!sourceFile) sourceFile = rel;
        } else {
          const msg = err.babylonError.message.replace(/\s*\(\d+:\d+\)\s*$/, '');
          reporter.error(`JS expression error: ${msg}`);
        }
      } else {
        reporter.error(options.suppressStack ? err.message : `${err}`);
      }
    }
    reporter.reportPug(name, false, sourceFile);
    return [null, null, []];
  }
};

module.exports = renderPug;
