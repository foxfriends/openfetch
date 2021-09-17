module.exports = {
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
  },
  extends: [
    'eslint:recommended',
    'plugin:ramda/recommended',
  ],
  env: {
    node: true,
    es6: true,
    browser: true,
  },
  plugins: ['ramda'],
  globals: { globalThis: false },
  rules: {},
};
