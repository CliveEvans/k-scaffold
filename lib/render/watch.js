const watch = require('node-watch');

const processSheet = require('./processSheet');
const { createDebouncer, createContentHashCache, shouldSkipFile } = require('./watchUtils');

// How long to coalesce rapid node-watch events per file. 300ms is short enough to feel responsive
// on real saves while still absorbing storms from editor atomic-write sequences and external processes
// (Windows Search / Defender) that can emit dozens of events for a single logical change.
const DEBOUNCE_MS = 300;

const kWatch = (argObj) => {
  const debounce = createDebouncer({ wait: DEBOUNCE_MS });
  const hashCache = createContentHashCache();

  watch(argObj.source,
    {
      recursive: true,
      filter(f, skip) {
        return shouldSkipFile(f) ? skip : true;
      }
    },
    (evt, name) => {
      const runSCSS = name.endsWith('.scss');
      const runPUG = /\.(?:js|pug|kscaf|json)$/i.test(name);
      if (!runSCSS && !runPUG) return;

      debounce(name, async () => {
        // Only reprocess when the file's content actually changed. External processes touching
        // metadata (antivirus/indexer/git) produce spurious node-watch events that pass our
        // debounce window; the hash check filters them out so processSheet is a true no-op.
        const changed = await hashCache.hasChanged(name);
        if (!changed) return;

        console.log('node-watch name', name);
        const toRun = argObj.sfc
          ? { runSCSS: true, runPUG: true }
          : { runSCSS, runPUG };
        await processSheet({ ...argObj, ...toRun });
      });
    });
};

module.exports = kWatch;
