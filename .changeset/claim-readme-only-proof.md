---
"@rgstr/cli": patch
---

The README badge is the only proof `rgstr claim` offers: in the README of the repository the package declares on npm/PyPI (verifies on merge) or in the README that ships with the package (`rgstr claim --here`, verifies on the next publish). The manifest line (`"rgstr": "…"` in package.json, `rgstr = "…"` under `[project.urls]`) is gone from the output, the README and the agent prompt, and with it the `--write` / `--manifest` flags. `rgstr claim --check` names the README the badge was found in (`README badge on github.com/o/r`, `README badge in name@version on npm`) and renders placements it does not know without crashing.
