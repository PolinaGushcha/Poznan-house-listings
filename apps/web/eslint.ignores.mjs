import { globalIgnores } from 'eslint/config';

// Files and directories ESLint must skip (flat-config replacement for .eslintignore).
// ESLint does not read .gitignore, so generated and build directories are listed here explicitly.
export default globalIgnores([
  // Default ignores of eslint-config-next:
  '.next/**',
  'out/**',
  'build/**',
  'next-env.d.ts',

  // Tests
  '**/*.test.{js,ts,tsx}',
  '**/*.spec.{js,ts,tsx}',
  'tests/**',
  '__tests__/**',

  // Build output, coverage and static assets
  'dist/**',
  'coverage/**',
  '.vercel/**',
  '**/public/**',

  // Dependencies
  '**/node_modules/**',
  '.yarn/**',
  '.pnp.*',

  // Tooling and local files
  '.env',
  '.eslintrc.js',
  '.github/**',
  '.husky/**',
  '.history/**',

  // Lock files
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml'
]);
