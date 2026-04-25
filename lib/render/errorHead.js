'use strict';

const colors = require('colors');
const { reporter } = require('./reporter');

/**
 * Emit a prominent error-header message.
 * In console mode: printed directly (red background, as before).
 * In dashboard mode: routed into the error section of the dashboard.
 * @param {string} string
 */
const kErrorHead = (string) => {
  const borderForString = [...Array(string.length).keys()].map(() => '=').join('');
  const msg = `==========${borderForString}\n==== ${string} ====\n==========${borderForString}`.bgRed;
  reporter.error(msg);
};

module.exports = kErrorHead;
