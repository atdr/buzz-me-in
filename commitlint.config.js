'use strict';

// The type list must match atdr/github-boilerplate's conventional.yml, which
// checks PR titles and commits in CI; the conventions check enforces that.
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [2, 'always', ['feat', 'fix', 'perf', 'refactor', 'test', 'docs', 'chore', 'ci']],
  },
  // Dependabot commit bodies embed release-note URLs that exceed
  // body-max-line-length and cannot be wrapped.
  ignores: [(message) => message.includes('Signed-off-by: dependabot[bot]')],
};
