import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores([
    'dist',
    'dist-*',
    'node_modules',
    'server/artifacts',
    'server/__pycache__',
    'tmp',
    'tmp-*',
    'tmp_chrome_*',
    'tmp-chrome-*',
    '.vite-cache/**',
    'tmp_wasm_req.log',
    'tmp_all_req.log',
    'tmp_diag.log',
    '*.config.*',
  ]),
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-unused-expressions': 'warn',
      '@typescript-eslint/no-this-alias': 'warn',
      'react-hooks/rules-of-hooks': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': 'warn',
      'no-constant-condition': 'warn',
      'no-extra-boolean-cast': 'warn',
      'no-useless-escape': 'warn',
      'prefer-const': 'warn',
    },
  },
])
