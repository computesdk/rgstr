# @rgstr/mcp

## 0.0.2

### Patch Changes

- c7bbff7: One story on every surface. `--help` says `claim, prove and route` (not "verify"); `claim --check` says it records the proof for the claim you filed and a person then approves; `--here` says rgstr reads the badge on the next publish. `claim --check` prints `proof found via …` instead of `verified via …`, and an already-claimed name prints `already claimed by your organization`. README, `packages/mcp/README.md` and `skills/rgstr/SKILL.md` agree: the README badge is the only proof, every claim is an application a person reviews, `claim --check` / `rgstr_claim_check` are not reads, "verified" is paid identity verification only.
- b866ae3: New: rgstr as MCP tools over stdio (`npx -y @rgstr/mcp`). `rgstr_whois`, `rgstr_search`, `rgstr_check` read; `rgstr_claim_plan` / `rgstr_claim_apply`, `rgstr_setup_plan` / `rgstr_setup_apply`, `rgstr_route_plan` / `rgstr_route_apply` are plan (free, changes nothing) then apply (exactly the plan, after the user confirms); `rgstr_claim_check` records the proof and can complete the claim; `rgstr_login` starts the device-code login. Wraps the CLI's own flows; errors are `isError` results with the API's `code` + `hint`.
