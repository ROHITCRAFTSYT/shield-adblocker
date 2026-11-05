import js from "@eslint/js";

/**
 * Flat ESLint config. Enforces the project's security invariants in CI:
 * no eval / implied-eval / Function constructor, no undefined globals (so a
 * stray identifier or a removed API call is caught), and no innerHTML-style
 * sinks. Browser + WebExtension globals are declared explicitly rather than via
 * a preset to keep the dependency surface minimal.
 */
const browserGlobals = {
  window: "readonly",
  document: "readonly",
  location: "readonly",
  console: "readonly",
  URL: "readonly",
  fetch: "readonly",
  MutationObserver: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  chrome: "readonly"
};

const nodeGlobals = {
  process: "readonly",
  console: "readonly",
  URL: "readonly",
  Buffer: "readonly"
};

const securityRules = {
  "no-eval": "error",
  "no-implied-eval": "error",
  "no-new-func": "error",
  "no-restricted-properties": [
    "error",
    { property: "innerHTML", message: "Build DOM with createElement/textContent." },
    { property: "outerHTML", message: "Build DOM with createElement/textContent." },
    { property: "insertAdjacentHTML", message: "Build DOM with createElement/textContent." }
  ],
  "no-restricted-syntax": [
    "error",
    { selector: "CallExpression[callee.object.name='document'][callee.property.name='write']", message: "document.write is forbidden." }
  ],
  "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }]
};

export default [
  { ignores: ["icons/**", "docs/**", "dist/**", "node_modules/**"] },

  js.configs.recommended,

  // Extension pages and the service worker: ES modules.
  {
    files: ["src/**/*.js"],
    ignores: ["src/content/**"],
    languageOptions: { ecmaVersion: 2022, sourceType: "module", globals: browserGlobals },
    rules: securityRules
  },

  // Content scripts: manifest content_scripts cannot be modules.
  {
    files: ["src/content/**/*.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "script", globals: browserGlobals },
    rules: securityRules
  },

  // Build / CI tooling and tests (Node ESM).
  {
    files: ["scripts/**/*.mjs", "test/**/*.mjs", "eslint.config.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "module", globals: nodeGlobals },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }]
    }
  },

  // Browser end-to-end checks: Node script whose page.evaluate() callbacks
  // run inside Chromium, so both global sets apply.
  {
    files: ["e2e/**/*.mjs", "scripts/store-assets.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...nodeGlobals, ...browserGlobals, getComputedStyle: "readonly", setTimeout: "readonly" }
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }]
    }
  }
];
