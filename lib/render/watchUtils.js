const fs = require('fs/promises');
const crypto = require('crypto');

/**
 * Creates a per-key trailing debouncer. Use to collapse filesystem event storms into a single invocation per file.
 * @param {object} opts
 * @param {number} opts.wait - Milliseconds to wait after the last call before invoking fn.
 * @returns {(key: string, fn: Function) => void}
 */
const createDebouncer = ({ wait }) => {
  const timers = new Map();
  return (key, fn) => {
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      timers.delete(key);
      fn();
    }, wait);
    timers.set(key, timer);
  };
};

/**
 * In-memory cache of MD5 content hashes for watched source files.
 * Lets the watch loop short-circuit when filesystem events fire for files whose content did not actually change
 * (external processes like antivirus scans and indexers can emit events that only touch metadata, not bytes).
 * @returns {{ hasChanged: (filepath: string) => Promise<boolean> }}
 */
const createContentHashCache = () => {
  const hashes = new Map();
  const hashFor = async (filepath) => {
    const buf = await fs.readFile(filepath);
    return crypto.createHash('md5').update(buf).digest('hex');
  };
  return {
    async hasChanged(filepath) {
      let current;
      try {
        current = await hashFor(filepath);
      } catch {
        // File unreadable (deleted mid-event, permission flicker): treat as changed so the downstream build runs.
        hashes.delete(filepath);
        return true;
      }
      const prior = hashes.get(filepath);
      hashes.set(filepath, current);
      return prior !== current;
    }
  };
};

const NODE_MODULES_RX = /[\\/]node_modules[\\/]/;
const GIT_RX = /[\\/]\.git[\\/]/;
const TEST_ARTIFACT_RX = /testFramework\.js|\.(?:test|mock)\.js$/;
const SOURCE_EXT_RX = /\.(js|pug|scss|kscaf|json)$/i;

/**
 * Returns true when the given path should be ignored by the watcher.
 * Replaces the forward-slash-only regexes in the original watch.js filter so the check works on Windows paths.
 * @param {string} filepath
 * @returns {boolean}
 */
const shouldSkipFile = (filepath) => {
  if (NODE_MODULES_RX.test(filepath)) return true;
  if (GIT_RX.test(filepath)) return true;
  if (TEST_ARTIFACT_RX.test(filepath)) return true;
  if (!SOURCE_EXT_RX.test(filepath)) return true;
  return false;
};

module.exports = {
  createDebouncer,
  createContentHashCache,
  shouldSkipFile,
};
