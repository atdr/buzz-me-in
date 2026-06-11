'use strict';

module.exports = {
  extends: ['@commitlint/config-conventional'],
  // Dependabot commit bodies embed release-note URLs that exceed
  // body-max-line-length and cannot be wrapped; skip linting its commits.
  ignores: [(message) => message.includes('Signed-off-by: dependabot[bot]')],
};
