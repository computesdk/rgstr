import { defineConfig } from 'tsup';

// The CLI's source is bundled in (relative imports from ../cli/src), so the
// published package needs only the MCP SDK at runtime.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  splitting: false,
  sourcemap: true,
  clean: true,
  shims: true,
  banner: { js: '#!/usr/bin/env node' },
});
