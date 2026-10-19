# @rgstr/cli

## 0.0.6

### Patch Changes

- 0bfd2dc: New `rgstr check`: the install-time signal. In a project `rgstr setup` pointed at rgstr, it reads the direct dependencies (package.json, pyproject.toml, requirements.txt — or the names you pass) and prints one line per name with its trust state, who holds it and where installs of it are served from, then how many of them rgstr actually decides: "N of M names are held on rgstr; the rest fall through to npm / PyPI unchanged." `--json` for machines. Exit 0 on a completed check; 1 when the project is not set up (it points at `npx @rgstr/cli setup`) or rgstr cannot be reached.

## 0.0.5

### Patch Changes

- 100f737: The README badge is the only proof `rgstr claim` offers: in the README of the repository the package declares on npm/PyPI (verifies on merge) or in the README that ships with the package (`rgstr claim --here`, verifies on the next publish). The manifest line (`"rgstr": "…"` in package.json, `rgstr = "…"` under `[project.urls]`) is gone from the output, the README and the agent prompt, and with it the `--write` / `--manifest` flags. `rgstr claim --check` names the README the badge was found in (`README badge on github.com/o/r`, `README badge in name@version on npm`) and renders placements it does not know without crashing.

## 0.0.4

### Patch Changes

- e831670: `rgstr claim` puts the badge where rgstr will read it; `--here` keeps it in the package's own README instead (verifies on the next publish). A monorepo package whose npm metadata has no `repository.directory` is read from the repository's root README, so the badge now goes there (with a note suggesting `repository.directory` for the next release) instead of the package folder's README, which `claim --check` would never see. A declared directory (`repository.directory` or a `/tree/<ref>/<dir>` URL) sends the badge to that folder's README.

## 0.0.3

### Patch Changes

- c5c5835: `rgstr claim` inside a git checkout now finds the package and its README (at a pnpm/npm/yarn/uv workspace root it lists the members and stops; `--all` claims every member), checks that `origin` is the repository the package declares on npm/PyPI (warns and writes nothing when it is not), shows the badge inserted under the first heading (replacing a stale rgstr badge, skipping a current one) and asks before writing; `--yes` skips the question, `--pr` branches, commits, pushes and opens the pull request with `gh`. The agent prompt points at `npx @rgstr/cli claim --yes --pr <name>`.

  `rgstr login` asks the `rgstr-cli` client for `packages:read packages:write org:read offline_access` — the set the platform registered for this CLI (there are no `registry:*` scopes) — and still falls back to the platform-wide client where `rgstr-cli` is not known yet.

## 0.0.2

### Patch Changes

- d99175c: `rgstr claim` prints the README badge first (the proof a coding agent can land with one PR), then an agent-pasteable prompt, then the manifest line for the next release — and writes nothing unless `--write` (diff shown first). `--check` names the proof that matched. `rgstr setup` / `use` show the diff and ask before writing (`--yes` to skip), then say what changed. New `rgstr status`. `rgstr login` asks for the registry-only client/scopes (`rgstr-cli`, `registry:read registry:write`) and falls back to the platform client until the server has them.
- caa4325: First release published from CI through npm trusted publishing (OIDC, provenance attestation); no registry token is stored anywhere.
- 4ab1529: `rgstr search` shows the relation column the website already shows: `sibling of x` (same repository), `namesake of x` (same name, different repository), `copy of x` (same published bytes), plus a count line.
- 021aad5: `rgstr setup`: one command that signs you in if needed, picks the org, and points the current project at rgstr. `rgstr use` stays as a hidden alias; `--off`, `--dry-run`, `--npm`, `--pip` unchanged.

## 0.0.1

### Patch Changes

- 06a1db5: The `rgstr` CLI: `login` / `logout` / `whoami` (device-code sign-in, `RGSTR_TOKEN` for CI), `use [--off]` (project `.npmrc` / pip config, byte-for-byte undo), `claim [--check] [--badge]` (file the claim and write the publish-proof token, then verify it from the published package), `whois`, `route`, and `search`.
- 656e30f: Placeholder release of the `rgstr` CLI (prints "coming soon · https://rgstr.org"); the CLI lands in the next version.
