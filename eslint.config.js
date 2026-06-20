import js from "@eslint/js";

/**
 * Flat ESLint config. Enforces the project's security invariants in CI:
 * no eval / implied-eval, and no undefined globals (so a stray identifier or a
 * removed API call is caught). Browser + WebExtension globals are declared
 * explicitly rather than via a preset to keep the dependency surface minimal.
 */
const browserGlobals = {
  window: "readonly",
  document: "readonly",
  location: "readonly",
  console: "readonly",
  URL: "readonly",
  MutationObserver: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  chrome: "readonly"
};

const nodeGlobals = {
  process: "readonly",
  console: "readonly"
};

export default [
  { ignores: ["icons/**", "docs/**"] },

  js.configs.recommended,

  // Extension runtime code (service worker, content scripts, popup).
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: browserGlobals
    },
    rules: {
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }]
    }
  },

  // Build / CI tooling (Node ESM).
  {
    files: ["scripts/**/*.mjs", "eslint.config.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: nodeGlobals
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }]
    }
  }
];
