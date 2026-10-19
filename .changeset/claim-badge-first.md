---
"@rgstr/cli": patch
---

`rgstr claim` prints the README badge first (the proof a coding agent can land with one PR), then an agent-pasteable prompt, then the manifest line for the next release — and writes nothing unless `--write` (diff shown first). `--check` names the proof that matched. `rgstr setup` / `use` show the diff and ask before writing (`--yes` to skip), then say what changed. New `rgstr status`. `rgstr login` asks for the registry-only client/scopes (`rgstr-cli`, `registry:read registry:write`) and falls back to the platform client until the server has them.
