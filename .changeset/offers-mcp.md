---
"@rgstr/mcp": patch
---

New: `rgstr_offer_plan(name, amount?, why?)` / `rgstr_offer_apply(plan_id)` — an offer on an unclaimed name under the same confirm-first rule (the plan is fingerprinted on name, amount, why, the active organization and the registry URL; a change answers `plan_stale`), and `rgstr_offers` (read). The server instructions say an offer is a side effect: show the plan and confirm first. `rgstr_whois`, `rgstr_search` and `rgstr_check` carry the `registered` state.
