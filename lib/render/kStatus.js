'use strict';

const { reporter } = require('./reporter');

/**
 * Emit a build-status message.
 * In console mode: logged directly (blue background, as before).
 * In dashboard mode: suppressed — file names are shown in the status bar.
 * @param {string} string
 */
const kStatus = (string) => {
  reporter.log(`${string}`.bgBlue);
};

module.exports = kStatus;
