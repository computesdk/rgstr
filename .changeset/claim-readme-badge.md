---
"@rgstr/cli": patch
---

`rgstr claim` inside a git checkout now finds the package(s) — including every pnpm/npm/yarn/uv workspace member — and their README, checks that `origin` is the repository the package declares on npm/PyPI (warns and writes nothing when it is not), shows the badge inserted under the first heading (replacing a stale rgstr badge, skipping a current one) and asks before writing; `--yes` skips the question, `--pr` branches, commits, pushes and opens the pull request with `gh`. The agent prompt points at `npx @rgstr/cli claim --yes --pr <name>`.

`rgstr login` asks the `rgstr-cli` client for `packages:read packages:write org:read offline_access` — the set the platform registered for this CLI (there are no `registry:*` scopes) — and still falls back to the platform-wide client where `rgstr-cli` is not known yet.
