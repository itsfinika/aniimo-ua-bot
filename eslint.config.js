// Lint configuration (the Node analogue of the Ruff setup the Python tree used).
//
// Deliberately narrow: this is a straight port of a working codebase, so the
// rules that matter are the ones that catch real breakage — undefined names,
// unreachable code, accidental globals — not style opinions. Formatting is not
// enforced here, exactly as `ruff format --check` was intentionally left out of CI.

import js from "@eslint/js";

export default [
  {
    // .venv is the leftover Python virtualenv; it ships vendored browser JS that
    // is neither ours nor lintable. It disappears with the Python tree.
    ignores: ["node_modules/**", "backups/**", "coverage/**", ".venv/**", "venv/**"],
  },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        // Node globals used across the project.
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        AbortSignal: "readonly",
        AbortController: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        TextDecoder: "readonly",
        TextEncoder: "readonly",
        structuredClone: "readonly",
      },
    },
    rules: {
      // An unused function argument is normal in ported handler signatures.
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-control-regex": "off",
    },
  },
  {
    files: ["tests/**/*.js"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        ReadableStream: "readonly",
      },
    },
  },
];
