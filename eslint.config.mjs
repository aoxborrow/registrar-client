import path from 'path';
import { fileURLToPath } from 'url';
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import typescriptEslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import importPlugin from 'eslint-plugin-import';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'out/**', 'build/**', 'dist/**', 'coverage/**'],
  },
  {
    files: ['**/*.{ts,mjs,cjs}'],
    extends: [eslint.configs.recommended, tseslint.configs.recommendedTypeChecked],
    plugins: {
      '@typescript-eslint': typescriptEslint,
      'import': importPlugin,
    },
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        moduleResolution: 'bundler',
        tsconfigRootDir: __dirname,
        project: ['./tsconfig.json'],
        EXPERIMENTAL_useProjectService: true,
      },
      globals: {
        // browser- and edge-safe: web globals plus Node for tooling/config files
        ...globals.node,
        ...globals.browser,
        ...globals.es2021,
      },
    },
    settings: {
      'import/parsers': {
        '@typescript-eslint/parser': ['.ts'],
      },
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: './tsconfig.json',
        },
        node: true,
      },
    },
    rules: {
      // allow intentionally-unused args/vars prefixed with an underscore
      // (used for NotImplemented stub signatures that must match the interface)
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // no file extension on relative imports; tsup/esbuild bundles the output,
      // and TS uses "bundler" module resolution, so extensions aren't needed
      'import/extensions': [
        'error',
        'ignorePackages',
        {
          js: 'never',
          ts: 'never',
        },
      ],
    },
  },
  // config/build files are plain Node scripts, not part of the typed program
  {
    files: ['*.config.ts', '*.config.mjs', 'eslint.config.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier
);
