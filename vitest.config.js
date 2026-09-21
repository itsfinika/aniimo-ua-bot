// Test-runner configuration (the Node analogue of pytest.ini).
//
// Tests live in tests/ and import project modules by their path from the repo
// root, which is the default resolution here — the `pythonpath = .` line in
// pytest.ini has no counterpart to write.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.js"],
    setupFiles: ["tests/setup.js"],
    environment: "node",
    // Collectors and schedulers install their own fake timers/clients per test;
    // isolating files keeps module-level caches (i18n, prompt templates) from
    // leaking between them.
    isolate: true,
    restoreMocks: true,
  },
});
