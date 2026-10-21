---
"@rgstr/mcp": patch
---

New: rgstr as MCP tools over stdio (`npx -y @rgstr/mcp`). `rgstr_whois`, `rgstr_search`, `rgstr_check` read; `rgstr_claim_plan` / `rgstr_claim_apply`, `rgstr_setup_plan` / `rgstr_setup_apply`, `rgstr_route_plan` / `rgstr_route_apply` are plan (free, changes nothing) then apply (exactly the plan, after the user confirms); `rgstr_claim_check` records the proof and can complete the claim; `rgstr_login` starts the device-code login. Wraps the CLI's own flows; errors are `isError` results with the API's `code` + `hint`.
