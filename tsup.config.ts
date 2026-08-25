import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    tedious: 'src/tedious.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
  skipNodeModulesBundle: true,
  noExternal: ['@toon-format/toon'],
  splitting: false,
});
