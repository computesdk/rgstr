# @rgstr/cli

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
