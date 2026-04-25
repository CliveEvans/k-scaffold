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
  pug:      { files: [], hasError: false },
  scss:     { files: [], hasError: false },
  template: { hasError: false },
  errors:   [],
});

/**
 * Immutable reducer that advances dashboard state in response to build events.
 *
 * Supported event types:
 *   START_CYCLE   — clears errors, resets all hasError flags
 *   REPORT_PUG    — { name: string, ok: boolean }
 *   REPORT_SCSS   — { name: string, ok: boolean }
 *   REPORT_TEMPLATE — { ok: boolean }
 *   ADD_ERROR     — { message: string }
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
        pug:      { ...state.pug,  hasError: false },
        scss:     { ...state.scss, hasError: false },
        template: { ...state.template, hasError: false },
        errors:   [],
      };

    case 'REPORT_PUG': {
      const files = state.pug.files.includes(event.name)
        ? state.pug.files
        : [...state.pug.files, event.name];
      return {
        ...state,
        pug: { files, hasError: state.pug.hasError || !event.ok },
      };
    }

    case 'REPORT_SCSS': {
      const files = state.scss.files.includes(event.name)
        ? state.scss.files
        : [...state.scss.files, event.name];
      return {
        ...state,
        scss: { files, hasError: state.scss.hasError || !event.ok },
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
 * @param {object} state     — current reporter state
 * @param {number} terminalWidth
 * @returns {string}
 */
const formatStatusBar = (state, terminalWidth) => {
  const separator = '|';

  // Build segments: one per monitored pug file, one per scss, one for templates.
  const pugSegs  = state.pug.files.length
    ? state.pug.files.map((f) => colourSegment(f, state.pug.hasError))
    : [colourSegment('(no pug)', state.pug.hasError)];

  const scssSegs = state.scss.files.length
    ? state.scss.files.map((f) => colourSegment(f, state.scss.hasError))
    : [colourSegment('(no scss)', state.scss.hasError)];

  const templateSeg = colourSegment('translation.json / sheet.json', state.template.hasError);

  const allSegs = [...pugSegs, ...scssSegs, templateSeg];

  // Join with pipe separators and wrap in outer pipes.
  const bar = separator + allSegs.join(separator) + separator;

  // Truncate to terminal width if needed (rare, but safe).
  const stripped = visibleLength(bar);
  if (stripped <= terminalWidth) return bar;

  // Simple truncation: build up from scratch with shortened labels.
  let line = separator;
  let used = 1;
  for (const seg of allSegs) {
    const raw = visibleLength(seg) + 1; // +1 for trailing separator
    if (used + raw > terminalWidth - 1) break;
    line += seg + separator;
    used += raw;
  }
  return line;
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

const HEADER_LINES = 3; // blank + title + blank
const STATUSBAR_LINES = 2; // separator + bar

/**
 * Render the complete dashboard to a string using `log-update`.
 * Only called in dashboard mode.
 */
const buildDashboardString = (state) => {
  const width = process.stdout.columns || 80;
  const height = process.stdout.rows    || 24;

  const title = `─── ${state.projectName} Status ${'─'.repeat(
    Math.max(0, width - state.projectName.length - 16),
  )}`;

  const errorLines = height - HEADER_LINES - STATUSBAR_LINES;
  const errorSection = formatErrorSection(state.errors, Math.max(1, errorLines));

  const divider = '─'.repeat(width);
  const bar = formatStatusBar(state, width);

  const lines = [
    '',
    title.cyan,
    '',
    errorSection,
    divider,
    bar,
  ];

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
    // log-update@4 is CJS-compatible.
    _logUpdate = require('log-update');
  }
  return _logUpdate;
};

const reporter = {
  /**
   * Switch output mode.
   * In dashboard mode, stdout TTY is required — falls back to console if not a TTY.
   * @param {'console'|'dashboard'} mode
   */
  setMode(mode) {
    if (mode === 'dashboard' && !process.stdout.isTTY) {
      // Graceful degradation: piped/CI output stays as plain console logs.
      _mode = 'console';
      return;
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
   * In dashboard mode: buffered (visible only via render()).
   */
  log(message) {
    if (_mode === 'console') {
      console.log(message);
    }
    // In dashboard mode, status messages are implicit (file names in bar).
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
   * @param {string}  name  — filename (e.g. 'sheet.pug')
   * @param {boolean} ok    — true if render succeeded
   */
  reportPug(name, ok) {
    _state = reducerForCycle(_state, { type: 'REPORT_PUG', name, ok });
    if (_mode === 'dashboard') {
      getLogUpdate()(buildDashboardString(_state));
    }
  },

  /**
   * Record the result of a SCSS render pass.
   * @param {string}  name  — filename (e.g. 'sheet.scss')
   * @param {boolean} ok    — true if render succeeded
   */
  reportSCSS(name, ok) {
    _state = reducerForCycle(_state, { type: 'REPORT_SCSS', name, ok });
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

  /**
   * Expose state for testing / introspection.
   * @returns {object}
   */
  getState() {
    return _state;
  },

  /**
   * Reset to initial state (used in tests).
   * @param {string} [projectName]
   */
  _reset(projectName) {
    _mode  = 'console';
    _state = initialState(projectName);
    _logUpdate = null;
  },
};

module.exports = {
  reporter,
  // Pure functions exported for unit testing
  reducerForCycle,
  formatStatusBar,
  formatErrorSection,
};
