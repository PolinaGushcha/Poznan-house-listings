// Runs on staged files before each commit (see .husky/pre-commit).
// ESLint runs per workspace so each app uses its own config; Prettier formats the staged files.
export default {
  'apps/web/**/*.{js,jsx,ts,tsx,mjs}': () => 'npm run lint --workspace apps/web',
  'apps/api/**/*.{ts,mjs}': () => 'npm run lint --workspace apps/api',
  '*.{js,jsx,ts,tsx,mjs,json,md,yml,yaml,css}': 'prettier --write --ignore-unknown'
};
