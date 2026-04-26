'use strict';

const path = require('path');
const watch = require('node-watch');

const processSheet = require('./processSheet');
const { reporter } = require('./reporter');
const { createDebouncer, createContentHashCache, shouldSkipFile } = require('./watchUtils');

// How long to coalesce rapid node-watch events per file. 300ms is short enough
// to feel responsive on real saves while still absorbing storms from editor
// atomic-write sequences and external processes (Windows Search / Defender)
// that can emit dozens of events for a single logical change.
const DEBOUNCE_MS = 300;

const kWatch = (argObj) => {
  // Activate the dashboard — falls back to console mode if stdout is not a TTY
  // (e.g. piped to a log file or running in CI).
  reporter.setMode('dashboard');

  // Default project name = the name of the current working directory.
  // Sheet authors can override via k.config.mjs: `export default { projectName: 'My Sheet' }`.
  const projectName = argObj.projectName || path.basename(process.cwd());
  reporter.setProjectName(projectName);

  const debounce  = createDebouncer({ wait: DEBOUNCE_MS });
  const hashCache = createContentHashCache();

  // Draw the initial empty dashboard so the layout is visible immediately.
  reporter.render();

  watch(argObj.source,
    {
      recursive: true,
      filter(f, skip) {
        return shouldSkipFile(f) ? skip : true;
      },
    },
    (evt, name) => {
      const runSCSS = name.endsWith('.scss');
      const runPUG  = /\.(?:js|pug|kscaf|json)$/i.test(name);
      if (!runSCSS && !runPUG) return;

      debounce(name, async () => {
        // Only reprocess when the file's content actually changed. External
        // processes touching metadata (antivirus/indexer/git) produce spurious
        // node-watch events that pass our debounce window; the hash check
        // filters them out so processSheet is a true no-op.
        const changed = await hashCache.hasChanged(name);
        if (!changed) return;

        const toRun = argObj.sfc
          ? { runSCSS: true, runPUG: true }
          : { runSCSS, runPUG };

        await processSheet({ ...argObj, ...toRun });

        // Final full redraw after the cycle completes so the status bar always
        // reflects the settled state (individual reportPug/reportSCSS calls
        // already do incremental redraws during the cycle).
        reporter.render();
      });
    });
};

module.exports = kWatch;
