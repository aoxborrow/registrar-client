import { defineConfig } from 'tsup';

export default defineConfig({
  // `utils` is its own entry so its pure helpers load without the providers
  entry: { index: 'src/index.ts', utils: 'src/utils-entry.ts' },
  // emit both modern ESM and CommonJS for broad consumer compatibility
  format: ['esm', 'cjs'],
  // .js for ESM, .cjs for CJS (matches the package.json exports map)
  outExtension({ format }) {
    return { js: format === 'esm' ? '.js' : '.cjs' };
  },
  target: 'es2022',
  // generate .d.ts + declaration maps
  dts: true,
  sourcemap: true,
  clean: true,
  // fully self-contained, browser/edge-safe output with no bundled deps (there are none)
  bundle: true,
  treeshake: true,
  // never leak Node built-ins into the bundle
  platform: 'neutral',
  tsconfig: 'tsconfig.build.json',
});
