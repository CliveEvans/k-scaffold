'use strict';

const sass = require('sass-embedded');
const path = require('path');
const fs = require('fs/promises');
const { pathToFileURL } = require('url');

const { reporter, extractSourceFile } = require('./reporter');
const { attributeScssError } = require('./scssErrorAttribution');

/**
 * The virtual SFC importer uses `pathToFileURL(path.resolve(dirname, '/sfc.scss'))`
 * as its canonical URL.  On all platforms the pathname ends in `/sfc.scss`.
 */
const isSfcUrl = (url) => url?.pathname?.endsWith('/sfc.scss');

/**
 * When a SASS error originates in the virtual SFC file, map the 0-indexed
 * error line back to the appropriate SFC content block (sheet or roll) and
 * return a human-readable error string with the pug file reference.
 *
 * Synthetic file layout (0-indexed lines):
 *   0: @use 'k-scaffold' as k;
 *   1: @mixin sheet {SHEET_LINE_0
 *   …: SHEET_LINE_N}
 *   N+1: @mixin roll {ROLL_LINE_0
 *   …: ROLL_LINE_M}
 *
 * Returns a message string, or null if mapping fails.
 */
const formatSfcError = (err, sfcStyles, scssSourcePath) => {
  if (!isSfcUrl(err.span?.url)) return null;

  const errLine    = err.span.start.line; // 0-indexed
  const sheetLines = (sfcStyles?.sheet || '').split('\n').length;

  let contentName, contentLine;
  if (errLine >= 1 && errLine <= sheetLines) {
    contentName = 'sheet';
    contentLine = errLine - 1; // 0-indexed within sheet content
  } else if (errLine > sheetLines) {
    contentName = 'roll';
    contentLine = errLine - sheetLines - 1; // 0-indexed within roll content
  } else {
    return null; // error in preamble — k-scaffold internal, not user code
  }

  const content      = (sfcStyles?.[contentName] || '').split('\n');
  const snippetLine  = (content[contentLine] || '').trimEnd();
  const pugSourceRel = path.relative(
    process.cwd(),
    scssSourcePath.replace(/\.scss$/, '.pug'),
  ).replace(/\\/g, '/');

  return `${pugSourceRel} (SFC +scss/${contentName}, line ~${contentLine + 1}): ${err.message}\n  ${snippetLine}`;
};

/**
 * Renders SCSS into CSS text
 * @memberof Render
 * @param {string} source - The path to the file you want to parse as SCSS.
 * @param {string} destination - The path to the file where you want to store the rendered CSS.
 * @param {object} [options = {}] - Options for how the k-scaffold should parse the SCSS and options that should be passed to SASS. Accepts all options specified at sass-lang.com.
 * @returns {Promise<string|null>} - The rendered css or null if an error occurred
 */
const renderSASS = async ({source, destination, options = {}, sfcStyles = {}, sfcFonts = []}) => {
  const name = path.basename(source);
  try {
    const dirname = path.dirname(process.argv[1] || '');
    const compileOptions = {
      charset: false,
      importers: [
        {
          findFileUrl(url) {
            if (!url.startsWith('k-scaffold')) return null;
            const fileURL = pathToFileURL(path.resolve(dirname, 'node_modules/@kurohyou/k-scaffold'), url.substring(10));
            const newURL = new URL(fileURL);
            return newURL;
          },
        },
        {
          canonicalize(url) {
            if (url !== 'sfc') return null;
            const fileURL = pathToFileURL(path.resolve(dirname, `/${url}.scss`), url.substring(10));
            return new URL(fileURL);
          },
          load(canonicalUrl) {
            return {
              contents:
`@use 'k-scaffold' as k;
@mixin sheet {${sfcStyles.sheet || '/*No sheet sfc used*/'}}
@mixin roll {${sfcStyles.roll || '/*No roll sfc used*/'}}`,
              syntax: 'scss',
            };
          },
        },
        {
          canonicalize(url) {
            if (url !== 'googleFont') return null;
            const fileURL = pathToFileURL(path.resolve(dirname, `/${url}.scss`), url.substring(10));
            return new URL(fileURL);
          },
          load(canonicalUrl) {
            return {
              contents:
`@import url("https://fonts.googleapis.com/css?family=Material+Icons|Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200${
  sfcFonts.length ? `|${sfcFonts.join('|')}` : ''
}&display=swap");`,
              syntax: 'scss',
            };
          },
        },
      ],
    };

    const currOptions = {...options};
    if (currOptions.importers) {
      compileOptions.importers.push(...currOptions.importers);
      delete currOptions.importers;
    }
    Object.assign(compileOptions, currOptions);

    const {css} = await sass.compileAsync(source, compileOptions);
    if (destination) {
      await fs.writeFile(destination, css);
    }

    reporter.reportSCSS(name, true);
    return css;
  } catch (err) {
    const sfcMsg = formatSfcError(err, sfcStyles, source);
    if (sfcMsg) {
      // Re-parse the pug source tree to attribute the error to a specific
      // `+scss.` block.  formatSfcError can only point at the synthetic SFC
      // because that's the URL sass reports — but the user's actual mistake
      // lives in a pug file (often a deeply-included partial), and brace
      // imbalances inside one block can mislocate the error far from its
      // root cause inside the SFC.
      const pugSourcePath = source.replace(/\.scss$/, '.pug');
      const attribution   = attributeScssError(err, pugSourcePath);

      if (attribution) {
        const pugRel = path.relative(process.cwd(), attribution.filename).replace(/\\/g, '/');
        let context = '+scss block';
        if (attribution.reason === 'brace-imbalance') {
          const n = Math.abs(attribution.delta);
          const which = attribution.delta > 0 ? "unclosed '{'" : "extra '}'";
          context += `, ${n} ${which}`;
        }
        reporter.error(`${pugRel}:${attribution.line} (${context}): ${err.message}`);
        reporter.reportSCSS(name, false, pugRel);
      } else {
        const pugRel = path.relative(process.cwd(), pugSourcePath).replace(/\\/g, '/');
        reporter.error(sfcMsg);
        reporter.reportSCSS(name, false, pugRel);
      }
    } else {
      const sourceFile = extractSourceFile(err, process.cwd());
      reporter.error(options.suppressStack ? err.message : `${err}`);
      reporter.reportSCSS(name, false, sourceFile);
    }
    return null;
  }
};

module.exports = renderSASS;
