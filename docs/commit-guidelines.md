# Commit Naming Guidelines

## Format

```
<type>(<scope>): <short description>
```

- **type** — what kind of change (see below)
- **scope** — optional, the area of the codebase affected (e.g. `auth`, `ui`, `api`, `db`)
- **short description** — imperative, lowercase, no period, max 72 chars

## Types

| Type       | When to use                                             |
| ---------- | ------------------------------------------------------- |
| `feat`     | New feature or user-visible functionality               |
| `fix`      | Bug fix                                                 |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `style`    | Formatting, missing semicolons, etc. (no logic change)  |
| `test`     | Adding or updating tests                                |
| `docs`     | Documentation only                                      |
| `chore`    | Build process, dependencies, config files               |
| `perf`     | Performance improvement                                 |

## Examples

```
feat(auth): add JWT refresh token support
fix(feed): prevent duplicate posts on scroll
refactor(api): extract user validation into middleware
chore: upgrade React to 18.3
docs: add setup instructions to README
```

## Grouping Rules (for deciding what goes in one commit)

1. **One logical change per commit** — if you touched the login form AND the user profile page for unrelated reasons, those are two commits.
2. **Group by feature or fix** — all files that implement the same feature or fix the same bug belong together.
3. **Separate concerns** — don't mix a new feature with a config change or a dependency upgrade.
4. **Config/tooling changes go alone** — package.json, .env, webpack config, etc. deserve their own `chore` commit.
5. **Tests travel with the code they test** — if you wrote a test for a feature, include it in the same commit as the feature.
