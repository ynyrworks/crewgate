'use strict';

// CrewError carries an i18n key so the CLI can print it in the user's language.
// err.message is always the English text.
class CrewError extends Error {
  constructor(key, vars) {
    super(require('./i18n').t('en', key, vars));
    this.name = 'CrewError';
    this.key = key;
    this.vars = vars || {};
  }
}

// Bad command-line usage (CLI exit code 2).
class UsageError extends CrewError {
  constructor(key, vars) {
    super(key, vars);
    this.name = 'UsageError';
  }
}

module.exports = { CrewError, UsageError };
