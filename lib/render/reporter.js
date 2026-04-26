/**
 * @file reporter.js
 *
 * Terminal output layer for the k-scaffold build pipeline.
 *
 * In **console mode** (the default — used by one-shot `k-build` runs) every
 * call passes straight through to `console.log` / `console.error`, exactly as
 * before.
 *
 * In **dashboard mode** (activated by `watch.js`) the terminal is cleared on
 * each build cycle and redrawn as a three-zone layout:
 *
 *   ┌──────────────────────────────────────┐
 *   │  ─── <Project Name> Status ──────    │  header
 *   │                                      │
 *   │  Error messages (most recent build)  │  error section
 *   │                                      │
 *   │  | sheet.pug | sheet.scss | t.json | │  status bar
 *   │  -> src/components/_error.pug        │  source files (on error)
 *   └──────────────────────────────────────┘
 *
 * Dashboard mode is only entered when `process.stdout.isTTY` is true so that
 * piped / redirected output degrades cleanly to plain console output.
 *
 * ## Pure functions (exported for unit tests)
 *
 * - `reducerForCycle(state, event)` — immutable state reducer
 * - `formatStatusBar(state, width)` — produces the coloured bottom bar string
 * - `formatErrorSection(errors, maxLines)` — clips and formats error output
 * - `formatSourceFiles(sourceFiles)` — formats erroring source file list
 * - `extractSourceFile(err, projectRoot)` — extracts source path from an error
 *
 * ## Singleton reporter
 *
 * All render modules (`kStatus`, `errorHead`, `renderPug`, `renderSASS`,
 * `renderTemplates`) call `reporter.*` instead of `console.*` directly so that
 * watch mode can intercept and aggregate their output without changing their
 * public API or threading a logger parameter everywhere.
 */

'use strict';

const path = require('path');
const { fileURLToPath } = require('url');
const colors = require('colors');

// ---------------------------------------------------------------------------
// Pure state helpers
// ---------------------------------------------------------------------------

/**
 * Returns a fresh initial state object.
 * @param {string} [projectName]
 * @returns {object}
 */
const initialState = (projectName = path.basename(process.cwd())) => ({
  projectName,
  pug:         { files: [], hasError: false },
  scss:        { files: [], hasError: false },
  template:    { hasError: false },
  errors:      [],
  sourceFiles: [], // flat list of project-relative paths that caused errors this cycle
});

// ---------------------------------------------------------------------------
// Source file extraction
// ---------------------------------------------------------------------------

/**
 * Resolve a file path relative to projectRoot, or annotate node_modules paths
 * with a `[package-name]` prefix for display.
 * @param {string} filePath  — absolute path (may use any separator)
 * @param {string} projectRoot
 * @returns {string}
 */
const relativizeOrMark = (filePath, projectRoot) => {
  const normalFile = filePath.replace(/\\/g, '/');

  if (normalFile.includes('/node_modules/')) {
    const nmIdx = normalFile.indexOf('/node_modules/');
    const afterNm = normalFile.slice(nmIdx + '/node_modules/'.length);
    const parts = afterNm.split('/');
    const isScoped = parts[0].startsWith('@');
    const pkgNameRaw = isScoped ? `${parts[0]}/${parts[1]}` : parts[0];
    // Drop @scope/ prefix for brevity: @kurohyou/k-scaffold → k-scaffold
    const pkgDisplay = pkgNameRaw.replace(/^@[^/]+\//, '');
    const restParts = parts.slice(isScoped ? 2 : 1);
    return `[${pkgDisplay}]/${restParts.join('/')}`;
  }

  try {
    const rel = path.relative(projectRoot, filePath);
    return rel.replace(/\\/g, '/');
  } catch (_) {
    return normalFile;
  }
};

/**
 * Extract the source file responsible for a build error.
 *
 * Checks (in priority order):
 *   1. `err.span.url`  — set by sass-embedded on SCSS errors
 *   2. `err.filename`  — set by pug on parse/syntax errors
 *   3. file path embedded in `err.message` — for runtime pug throws
 *
 * Node_modules paths are annotated with `[package-name]/...` instead of
 * absolute paths so the user knows it's a framework internal.
 *
 * @param {object} err         — the thrown error object
 * @param {string} projectRoot — absolute path to the project root (process.cwd())
 * @returns {string|null}      — display-friendly relative path, or null if not determinable
 */
const extractSourceFile = (err, projectRoot) => {
  if (!err) return null;

  // 1. SCSS errors from sass-embedded carry a structured span with a file URL.
  if (err.span?.url) {
    try {
      const filePath = fileURLToPath(err.span.url);
      return relativizeOrMark(filePath, projectRoot);
    } catch (_) { /* fall through */ }
  }

  // 2. Pug parse/syntax errors populate err.filename directly.
  if (err.filename) {
    return relativizeOrMark(err.filename, projectRoot);
  }

  // 3. Runtime pug throws embed the source path in err.message.
  //    Pattern: "... from /abs/path/to/file.pug" or bare absolute paths.
  if (err.message) {
    const patterns = [
      /(?:from |in |at )([^\s]+?\.(?:pug|scss|sass))/i,
      /(\/[^\s]+?\.(?:pug|scss|sass))/i,
      /([A-Za-z]:[\\\/][^\s]+?\.(?:pug|scss|sass))/i,
    ];
    for (const re of patterns) {
      const m = err.message.match(re);
      if (m) return relativizeOrMark(m[1], projectRoot);
    }
  }

  return null;
};

/**
 * Immutable reducer that advances dashboard state in response to build events.
 *
 * Supported event types:
 *   START_CYCLE     — clears errors, sourceFiles, resets all hasError flags
 *   REPORT_PUG      — { name: string, ok: boolean, sourceFile?: string|null }
 *   REPORT_SCSS     — { name: string, ok: boolean, sourceFile?: string|null }
 *   REPORT_TEMPLATE — { ok: boolean }
 *   ADD_ERROR       — { message: string }
 *
 * @param {object} state
 * @param {{ type: string } & object} event
 * @returns {object} new state (original is not mutated)
 */
const reducerForCycle = (state, event) => {
  switch (event.type) {
    case 'START_CYCLE':
      return {
        ...state,
        pug:         { ...state.pug,      hasError: false },
        scss:        { ...state.scss,     hasError: false },
        template:    { ...state.template, hasError: false },
        errors:      [],
        sourceFiles: [],
      };

    case 'REPORT_PUG': {
      const files = state.pug.files.includes(event.name)
        ? state.pug.files
        : [...state.pug.files, event.name];
      const sourceFiles = (event.sourceFile && !state.sourceFiles.includes(event.sourceFile))
        ? [...state.sourceFiles, event.sourceFile]
        : state.sourceFiles;
      return {
        ...state,
        pug: { files, hasError: state.pug.hasError || !event.ok },
        sourceFiles,
      };
    }

    case 'REPORT_SCSS': {
      const files = state.scss.files.includes(event.name)
        ? state.scss.files
        : [...state.scss.files, event.name];
      const sourceFiles = (event.sourceFile && !state.sourceFiles.includes(event.sourceFile))
        ? [...state.sourceFiles, event.sourceFile]
        : state.sourceFiles;
      return {
        ...state,
        scss: { files, hasError: state.scss.hasError || !event.ok },
        sourceFiles,
      };
    }

    case 'REPORT_TEMPLATE':
      return {
        ...state,
        template: { ...state.template, hasError: state.template.hasError || !event.ok },
      };

    case 'ADD_ERROR':
      return { ...state, errors: [...state.errors, event.message] };

    default:
      return state;
  }
};

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Strip ANSI codes to measure true display width. */
const visibleLength = (str) => str.replace(/\x1b\[[0-9;]*m/g, '').length;

/**
 * Colour a status-bar segment based on its error state.
 * @param {string} label
 * @param {boolean} hasError
 * @returns {string}
 */
const colourSegment = (label, hasError) =>
  hasError ? ` ${label} `.bgRed.white : ` ${label} `.bgGreen.black;

/**
 * Build the coloured status bar that sits at the bottom of the dashboard.
 *
 * @param {object} state         — current reporter state
 * @param {number} terminalWidth
 * @returns {string}
 */
const formatStatusBar = (state, terminalWidth) => {
  const separator = '|';

  const pugSegs  = state.pug.files.length
    ? state.pug.files.map((f) => colourSegment(f, state.pug.hasError))
    : [colourSegment('(no pug)', state.pug.hasError)];

  const scssSegs = state.scss.files.length
    ? state.scss.files.map((f) => colourSegment(f, state.scss.hasError))
    : [colourSegment('(no scss)', state.scss.hasError)];

  const templateSeg = colourSegment('translation.json / sheet.json', state.template.hasError);

  const allSegs = [...pugSegs, ...scssSegs, templateSeg];

  const bar = separator + allSegs.join(separator) + separator;

  if (visibleLength(bar) <= terminalWidth) return bar;

  // Build up from scratch, adding segments until we'd exceed the width.
  let line = separator;
  let used = 1;
  for (const seg of allSegs) {
    const cost = visibleLength(seg) + 1;
    if (used + cost > terminalWidth - 1) break;
    line += seg + separator;
    used += cost;
  }
  return line;
};

/**
 * Format the list of erroring source files into a `-> path` block displayed
 * below the status bar.
 *
 * @param {string[]} sourceFiles — project-relative paths
 * @returns {string}
 */
const formatSourceFiles = (sourceFiles) => {
  if (!sourceFiles.length) return '';
  return sourceFiles.map((f) => `-> ${f}`).join('\n');
};

/**
 * Format collected error messages into a printable block.
 *
 * @param {string[]} errors
 * @param {number}   maxLines  — maximum output lines (caller computes from tty height)
 * @returns {string}
 */
const formatErrorSection = (errors, maxLines) => {
  if (!errors.length) return '';
  const clipped = errors.slice(0, maxLines);
  return clipped.join('\n');
};

// ---------------------------------------------------------------------------
// Dashboard render
// ---------------------------------------------------------------------------

const HEADER_LINES    = 3; // blank + title + blank
const STATUSBAR_LINES = 2; // divider + bar

/**
 * Render the complete dashboard to a string using `log-update`.
 * Only called in dashboard mode.
 *
 * Layout:
 *   (blank)
 *   ─── <project> Status ──────────────────
 *   (blank)
 *   <error messages — most recent cycle>
 *   ────────────────────────────────────────
 *   | file.pug | file.scss |translation…  |
 *   -> src/components/_error.pug
 *   -> src/scss/_vars.scss
 */
const buildDashboardString = (state) => {
  const width  = process.stdout.columns || 80;
  const height = process.stdout.rows    || 24;

  const title = `─── ${state.projectName} Status ${'─'.repeat(
    Math.max(0, width - state.projectName.length - 16),
  )}`;

  const sourceFilesStr  = formatSourceFiles(state.sourceFiles);
  const sourceFileLines = state.sourceFiles.length;
  // Clamp to at least 1 so we always have room for one error line.
  const errorZoneLines  = Math.max(1, height - HEADER_LINES - STATUSBAR_LINES - sourceFileLines);
  const errorSection    = formatErrorSection(state.errors, errorZoneLines);

  // Pad the error zone to always occupy exactly errorZoneLines rows.
  // This keeps the total output height constant at `height` lines regardless
  // of how many errors are present, so log-update always moves the cursor
  // the same distance and the status bar stays locked at the bottom.
  const errorLineArr = errorSection.split('\n');
  const padCount     = Math.max(0, errorZoneLines - errorLineArr.length);
  const paddedError  = [...errorLineArr, ...new Array(padCount).fill('')].join('\n');

  const divider = '─'.repeat(width);
  const bar     = formatStatusBar(state, width);

  const lines = [
    '',
    title.cyan,
    '',
    paddedError,
    divider,
    bar,
  ];
  if (sourceFilesStr) lines.push(sourceFilesStr);

  return lines.join('\n');
};

// ---------------------------------------------------------------------------
// Singleton reporter
// ---------------------------------------------------------------------------

let _mode  = 'console'; // 'console' | 'dashboard'
let _state = initialState();
let _logUpdate = null; // loaded lazily to avoid requiring log-update in tests

/**
 * Load log-update lazily (only in dashboard mode).  The require happens once
 * and is cached from that point forward.
 */
const getLogUpdate = () => {
  if (!_logUpdate) {
    _logUpdate = require('log-update');
  }
  return _logUpdate;
};

/**
 * Redraws the dashboard when the terminal is resized.
 *
 * Called via process.stdout 'resize' while in dashboard mode.  We call
 * logUpdate.clear() before redrawing because a width change shifts how many
 * terminal rows the previous output occupied; if we skipped the clear,
 * log-update's stored line count would be stale and the cursor would land in
 * the wrong place, leaving ghost lines on screen.
 */
const _onResize = () => {
  if (_mode !== 'dashboard') return;
  const lu = getLogUpdate();
  lu.clear();
  lu(buildDashboardString(_state));
};

const reporter = {
  /**
   * Switch output mode.
   * In dashboard mode, stdout TTY is required — falls back to console if not a TTY.
   * @param {'console'|'dashboard'} mode
   */
  setMode(mode) {
    if (mode === 'dashboard' && !process.stdout.isTTY) {
      _mode = 'console';
      return;
    }
    // Attach / detach the resize listener as we enter / leave dashboard mode.
    if (mode === 'dashboard' && _mode !== 'dashboard') {
      process.stdout.on('resize', _onResize);
    } else if (mode !== 'dashboard' && _mode === 'dashboard') {
      process.stdout.off('resize', _onResize);
    }
    _mode = mode;
  },

  /** Override the project name shown in the dashboard header. */
  setProjectName(name) {
    _state = { ..._state, projectName: name };
  },

  /** Reset state at the start of each watch build cycle. */
  startCycle() {
    _state = reducerForCycle(_state, { type: 'START_CYCLE' });
    if (_mode === 'dashboard') {
      getLogUpdate()(buildDashboardString(_state));
    }
  },

  /**
   * Log an informational message.
   * In console mode: prints via console.log.
   * In dashboard mode: no-op (file names in status bar serve this purpose).
   */
  log(message) {
    if (_mode === 'console') {
      console.log(message);
    }
  },

  /**
   * Log an error message.
   * In console mode: prints via console.error.
   * In dashboard mode: stored in state and shown in the error section.
   */
  error(message) {
    if (_mode === 'console') {
      console.error(message);
      return;
    }
    _state = reducerForCycle(_state, { type: 'ADD_ERROR', message: `${message}` });
    getLogUpdate()(buildDashboardString(_state));
  },

  /**
   * Record the result of a pug render pass.
   * @param {string}       name         — filename (e.g. 'sheet.pug')
   * @param {boolean}      ok           — true if render succeeded
   * @param {string|null}  [sourceFile] — project-relative path of the erroring file
   */
  reportPug(name, ok, sourceFile = null) {
    _state = reducerForCycle(_state, { type: 'REPORT_PUG', name, ok, sourceFile });
    if (_mode === 'dashboard') {
      getLogUpdate()(buildDashboardString(_state));
    }
  },

  /**
   * Record the result of a SCSS render pass.
   * @param {string}       name         — filename (e.g. 'sheet.scss')
   * @param {boolean}      ok           — true if render succeeded
   * @param {string|null}  [sourceFile] — project-relative path of the erroring file
   */
  reportSCSS(name, ok, sourceFile = null) {
    _state = reducerForCycle(_state, { type: 'REPORT_SCSS', name, ok, sourceFile });
    if (_mode === 'dashboard') {
      getLogUpdate()(buildDashboardString(_state));
    }
  },

  /**
   * Record the result of template rendering (sheet.json / translation.json).
   * @param {boolean} ok
   */
  reportTemplate(ok) {
    _state = reducerForCycle(_state, { type: 'REPORT_TEMPLATE', ok });
    if (_mode === 'dashboard') {
      getLogUpdate()(buildDashboardString(_state));
    }
  },

  /**
   * Force a full redraw of the dashboard.
   * Called by watch.js after processSheet resolves.
   */
  render() {
    if (_mode !== 'dashboard') return;
    getLogUpdate()(buildDashboardString(_state));
  },

  /** Expose state for testing / introspection. */
  getState() {
    return _state;
  },

  /** Reset to initial state (used in tests). */
  _reset(projectName) {
    if (_mode === 'dashboard') {
      process.stdout.off('resize', _onResize);
    }
    _mode  = 'console';
    _state = initialState(projectName);
    _logUpdate = null;
  },
};

module.exports = {
  reporter,
  reducerForCycle,
  formatStatusBar,
  formatErrorSection,
  formatSourceFiles,
  extractSourceFile,
};
