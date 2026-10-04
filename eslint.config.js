import js from '@eslint/js';
import globals from 'globals';

// no-undef is the guard that catches "X is not defined" crashes (e.g. a
// helper used but never imported) before they ever reach a user.
export default [
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
        chrome: 'readonly'
      }
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-undef': 'error',
      'no-unused-vars': 'error',
      // check.mjs owns style/security policy; these are intentional patterns:
      'no-useless-assignment': 'off',     // try/catch sentinel reassignments
      'preserve-caught-error': 'off',
      'no-control-regex': 'off',          // sanitizers deliberately strip control chars
      'no-empty': 'off',                  // deliberate best-effort catches
      'no-constant-condition': 'off'
    }
  },
  {
    // AudioWorklet modules run in a dedicated scope with their own globals.
    files: ['src/worklets/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.audioWorklet
      }
    },
    rules: {
      'no-undef': 'error'
    }
  }
];
