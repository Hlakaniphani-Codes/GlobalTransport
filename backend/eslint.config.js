const js = require('@eslint/js');
const globals = require('globals');
const promise = require('eslint-plugin-promise');

module.exports = [
  {
    ignores: ['node_modules/**'],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: globals.node,
    },
    plugins: { promise },
    rules: {
      ...js.configs.recommended.rules,
      'promise/catch-or-return': 'error',
      'promise/no-return-wrap': 'error',
    },
  },
];
