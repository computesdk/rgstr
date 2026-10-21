---
"@rgstr/cli": patch
"@rgstr/mcp": patch
---

One story on every surface. `--help` says `claim, prove and route` (not "verify"); `claim --check` says it records the proof for the claim you filed and a person then approves; `--here` says rgstr reads the badge on the next publish. `claim --check` prints `proof found via …` instead of `verified via …`, and an already-claimed name prints `already claimed by your organization`. README, `packages/mcp/README.md` and `skills/rgstr/SKILL.md` agree: the README badge is the only proof, every claim is an application a person reviews, `claim --check` / `rgstr_claim_check` are not reads, "verified" is paid identity verification only.
