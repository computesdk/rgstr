---
"@rgstr/cli": patch
---

`rgstr claim` no longer files a claim until you confirm or pass --yes: it shows what it will file and the README diff, asks y/N, and files + writes only on yes (`--yes` skips the question; `--json` and non-interactive runs report the plan and do nothing without `--yes`). `rgstr route --to/--rm` shows the routes as they would be and asks the same way (`--yes` to skip).
