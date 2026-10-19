---
"@rgstr/cli": patch
---

`rgstr setup` works signed-out: it writes the project's `.npmrc` (and the yarn / bun / uv / poetry / pip equivalents it already handled) pointing at the public rgstr endpoint, says exactly what it wrote and that `rgstr setup --off` removes those lines, and only mentions `rgstr login` as an optional follow-up. A stored login still adds the "Signed in as …" line. `rgstr claim` in a package directory always shows the README diff it would make — in the README rgstr reads (the declared repository folder, else the root; `--here` for the package's own README), also outside a git checkout or without an `origin` remote — says when there is no README and shows the file it would create, and writes only with `--yes` (no more y/N prompt); the help text says the same. Prose in `--help` and output says "organization", never "org".
