import js from '@eslint/js';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import prettierRecommended from 'eslint-plugin-prettier/recommended';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import ignores from './eslint.ignores.mjs';

const eslintConfig = defineConfig([
  ignores,

  // extends
  js.configs.recommended, // eslint:recommended
  tseslint.configs.recommended, // plugin:@typescript-eslint/recommended
  react.configs.flat.recommended, // plugin:react/recommended
  reactHooks.configs.flat.recommended, // plugin:react-hooks/recommended
  ...nextVitals,
  ...nextTs,

  {
    languageOptions: {
      // env: browser, es2021
      globals: {
        ...globals.browser,
        ...globals.es2021
      },
      ecmaVersion: 2022, // ecmaVersion: 13
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: {
          jsx: true
        }
      }
    },
    settings: {
      react: {
        version: 'detect'
      }
    }
  },

  // plugin:prettier/recommended — must stay after other configs so it can
  // disable stylistic rules that conflict with Prettier.
  prettierRecommended,

  {
    rules: {
      'prettier/prettier': 'error',
      'react/react-in-jsx-scope': 'off'
    }
  }
]);

export default eslintConfig;
