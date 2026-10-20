---
"@rgstr/cli": patch
---

API errors print their next step: `RgstrApiError` carries the API's `code`, `hint`, `requestId` and `details`; the CLI prints the hint as the last line of any failure and `--json` includes `code`, `hint` and `requestId`. `claim --check` reads the platform's 422 `proof_not_found` as "no proof yet" and prints its hint. The claim, route and check flows moved into importable modules (`claim-flow`, `route-flow`, `check-flow`) that `@rgstr/mcp` shares; the repository is now a pnpm workspace (`packages/cli`, `packages/mcp`).
