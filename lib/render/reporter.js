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
 * each build cycle and redrawn as a compact top-anchored layout:
 *
 *   ┌──────────────────────────────────────┐
 *   │  | sheet.pug | sheet.scss | t.json | │  status bar  (always shown)
 *   │  -> src/components/_error.pug        │  source files (only on error)
 *   │  Error messages (most recent build)  │  errors       (only on error)
 *   └──────────────────────────────────────┘
 *
 * Content after the last line is erased with `\x1b[J` so stale content from a
 * previous taller render is always cleared — no terminal-height arithmetic needed.
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
 * All render modules (`kStatus`, `renderPug`, `renderSASS`,
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

/**
 * Render the complete dashboard to a string.
 * Only called in dashboard mode.
 *
 * Layout (compact, top-anchored):
 *   | file.pug | file.scss | translation.json / sheet.json |
 *   -> src/components/_error.pug          (only when sourceFiles present)
 *   <error messages — most recent cycle>  (only when errors present)
 *
 * The caller appends \x1b[J to erase any stale content below.
 */
const buildDashboardString = (state) => {
  const width = process.stdout.columns || 80;
  const bar   = formatStatusBar(state, width);

  const hasErrors = state.errors.length > 0 || state.sourceFiles.length > 0;
  if (!hasErrors) return bar;

  const parts = [bar];
  if (state.sourceFiles.length > 0) parts.push(formatSourceFiles(state.sourceFiles));
  if (state.errors.length > 0)      parts.push(state.errors.join('\n'));
  return parts.join('\n');
};

// ---------------------------------------------------------------------------
// Singleton reporter
// ---------------------------------------------------------------------------

let _mode              = 'console'; // 'console' | 'dashboard'
let _state             = initialState();
let _firstRender       = true;  // cleared on first dashboard write; reset when leaving dashboard mode
let _consoleBanner     = false; // true once the non-TTY watch banner has been printed

let _resizeTimer  = null;
let _resizePoller = null;
let _lastCols     = 0;
let _lastRows     = 0;

/**
 * Write dashboard content to the terminal.
 * On the first call after entering dashboard mode: clear the screen and move
 * to home position so any previous console output is wiped.
 * On subsequent calls: move to home, write content, then erase to end of screen
 * so any stale lines from a previous taller render are cleared.
 */
const _writeDashboard = (content) => {
  if (_firstRender) {
    process.stdout.write('\x1b[?25l\x1b[2J\x1b[H'); // hide cursor, clear screen, home
    _firstRender = false;
  } else {
    process.stdout.write('\x1b[H'); // cursor to home
  }
  process.stdout.write(content + '\x1b[J'); // write content, erase to end of screen
};

/**
 * Debounced resize handler.
 * Coalesces rapid duplicate signals (poll + stdin + stdout + SIGWINCH may all
 * fire within the same tick) into a single redraw.
 */
const _onResize = () => {
  if (_mode !== 'dashboard') return;
  if (_resizeTimer) clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    _resizeTimer = null;
    _writeDashboard(buildDashboardString(_state));
  }, 32);
};

/**
 * Poll process.stdout dimensions every 250 ms.
 *
 * VS Code's integrated terminal (ConPTY on Windows) updates
 * process.stdout.columns / .rows when the panel is resized but does not
 * reliably emit the 'resize' event or SIGWINCH through the PTY layer.
 * process.stdout.getWindowSize() reads from GetConsoleScreenBufferInfo which
 * can be stale in ConPTY mid-session; process.stdout.rows is the value Node.js
 * maintains from the PTY resize signal and is always current.
 * Polling process.stdout.rows is the only approach guaranteed to work there.
 */
const _pollResize = () => {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows    || 24;
  if (cols !== _lastCols || rows !== _lastRows) {
    _lastCols = cols;
    _lastRows = rows;
    _onResize();
  }
};

// Named wrappers stored at module level so _detachResizeListeners can pass the
// exact same function references to .off() that were passed to .on().
const _stdoutResizeHandler = () => _onResize();
const _stdinResizeHandler  = () => _onResize();
const _sigwinchHandler     = () => _onResize();

/**
 * Attach all available resize signal sources in dashboard mode.
 *
 * On Windows (ConPTY / VS Code integrated terminal), process.stdout.rows is
 * only updated by Node.js/libuv when it is actively reading from the console
 * input queue — specifically the WINDOW_BUFFER_SIZE_EVENT ConPTY posts on
 * resize.  process.stdin.resume() starts that read loop without changing echo
 * or signal handling (no setRawMode needed), which is all we need.
 *
 * On non-Windows, SIGWINCH handles resize so stdin reading is not needed.
 */
const _attachResizeListeners = () => {
  _lastCols = process.stdout.columns || 80;
  _lastRows = process.stdout.rows    || 24;
  process.stdout.on('resize', _stdoutResizeHandler);
  if (process.stdin.isTTY) {
    process.stdin.on('resize', _stdinResizeHandler);
    if (process.platform === 'win32') {
      // Resume stdin so libuv processes WINDOW_BUFFER_SIZE_EVENT and updates
      // process.stdout.rows when the terminal is resized.
      process.stdin.resume();
    }
  }
  if (process.platform !== 'win32') {
    process.on('SIGWINCH', _sigwinchHandler);
  }
  _resizePoller = setInterval(_pollResize, 250);
};

const _detachResizeListeners = () => {
  process.stdout.off('resize', _stdoutResizeHandler);
  if (process.stdin.isTTY) {
    process.stdin.off('resize', _stdinResizeHandler);
    if (process.platform === 'win32') {
      process.stdin.pause();
    }
  }
  if (process.platform !== 'win32') {
    process.off('SIGWINCH', _sigwinchHandler);
  }
  if (_resizePoller) {
    clearInterval(_resizePoller);
    _resizePoller = null;
  }
  if (_resizeTimer) {
    clearTimeout(_resizeTimer);
    _resizeTimer = null;
  }
};

// Restore cursor visibility if the process exits while the dashboard is active.
process.on('exit', () => {
  if (_mode === 'dashboard') {
    process.stdout.write('\x1b[?25h');
  }
});

const reporter = {
  /**
   * Switch output mode.
   * In dashboard mode, stdout TTY is required — falls back to console if not a TTY.
   * @param {'console'|'dashboard'} mode
   */
  setMode(mode) {
    if (mode === 'dashboard' && !process.stdout.isTTY) {
      // Non-TTY environments (Git Bash pipes, CI, redirected output): stay in
      // console mode and print a one-time banner so the user knows the watcher
      // is active even though the full dashboard cannot be rendered.
      if (!_consoleBanner) {
        _consoleBanner = true;
        console.log('[k-watch] Watching for changes (no TTY — dashboard unavailable)');
      }
      return;
    }
    // Attach / detach resize listeners as we enter / leave dashboard mode.
    if (mode === 'dashboard' && _mode !== 'dashboard') {
      _firstRender = true;
      _attachResizeListeners();
    } else if (mode !== 'dashboard' && _mode === 'dashboard') {
      _detachResizeListeners();
      process.stdout.write('\x1b[?25h'); // restore cursor
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
      _writeDashboard(buildDashboardString(_state));
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
    _writeDashboard(buildDashboardString(_state));
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
      _writeDashboard(buildDashboardString(_state));
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
      _writeDashboard(buildDashboardString(_state));
    }
  },

  /**
   * Record the result of template rendering (sheet.json / translation.json).
   * @param {boolean} ok
   */
  reportTemplate(ok) {
    _state = reducerForCycle(_state, { type: 'REPORT_TEMPLATE', ok });
    if (_mode === 'dashboard') {
      _writeDashboard(buildDashboardString(_state));
    }
  },

  /**
   * Force a full redraw of the dashboard.
   * Called by watch.js after processSheet resolves.
   */
  render() {
    if (_mode !== 'dashboard') return;
    _writeDashboard(buildDashboardString(_state));
  },

  /** Expose state for testing / introspection. */
  getState() {
    return _state;
  },

  /** Reset to initial state (used in tests). */
  _reset(projectName) {
    if (_mode === 'dashboard') {
      _detachResizeListeners();
      process.stdout.write('\x1b[?25h'); // restore cursor
    }
    _mode          = 'console';
    _state         = initialState(projectName);
    _firstRender   = true;
    _consoleBanner = false;
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
