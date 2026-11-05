import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist/**', 'extension/background.js', 'extension/panel.js', 'node_modules/**', 'test-artifacts/**', 'artifacts/**', '.impeccable/**'] },
  js.configs.recommended,
  { files: ['**/*.mjs'], languageOptions: { globals: { ...globals.node, ...globals.browser, browser: 'readonly' } }, rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }], 'no-empty': ['error', { allowEmptyCatch: true }] } }
];
