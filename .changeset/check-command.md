---
"@rgstr/cli": patch
---

New `rgstr check`: the install-time signal. In a project `rgstr setup` pointed at rgstr, it reads the direct dependencies (package.json, pyproject.toml, requirements.txt — or the names you pass) and prints one line per name with its trust state, who holds it and where installs of it are served from, then how many of them rgstr actually decides: "N of M names are held on rgstr; the rest fall through to npm / PyPI unchanged." `--json` for machines. Exit 0 on a completed check; 1 when the project is not set up (it points at `npx @rgstr/cli setup`) or rgstr cannot be reached.
