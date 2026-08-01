import { defineConfig, configDefaults } from 'vitest/config'

// The Playwright smoke suite (tests/smoke/**) is driven by `npm run smoke`
// (playwright.config.ts), not by `vitest run`. Playwright's test() API throws
// when collected under vitest, which fails the unit gate. Keep all vitest
// defaults; only carve out the e2e directory.
//
// projects/** are independent deliverable workspaces (their own package.json /
// toolchain / test setup), not part of this codebase. Their test files resolve
// fixture paths relative to their OWN project root, so sweeping them into the
// root unit gate fails them with ENOENT regardless of their real state
// (observed 2026-07-30: 4 projects/ibanguardian test files). Running them is
// each project's own concern, from its own directory.
export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      'tests/smoke/**',
      'projects/**',
      // Claude plugin caches (user-level and per-agent CLAUDE_CONFIG_DIR)
      // carry third-party plugins' OWN test suites (bun:test-based, e.g.
      // slack-channel server.test.ts), which are not this codebase's tests
      // and cannot even load under vitest.
      '**/.claude-config/**',
      '**/.claude/plugins/**',
    ],
  },
})
