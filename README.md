# rgstr

**One name, every ecosystem.** [rgstr](https://rgstr.org) is a package naming
registry: claim the name of a package you maintain, prove it from your next
publish, and the name resolves to you on npm and PyPI — look-alikes, hijacked
forks and squatted copies get folded under it or flagged.

`rgstr` is the CLI. The site is https://rgstr.org.

```bash
npx @rgstr/cli claim          # in your package's directory
npm i -g @rgstr/cli           # or install it: the command is `rgstr`
```

## The five commands

| | |
| --- | --- |
| `rgstr claim` | File the claim for the package in the current directory and write the publish-proof token into `package.json` / `pyproject.toml` (or the README badge with `--badge`). Publish a patch, then `rgstr claim --check` to verify. |
| `rgstr whois <name>` | Who holds a name, how much to trust it (unclaimed / claimed / verified), where it routes, and whether it is disputed. No login needed. |
| `rgstr search <query>` | Names in rgstr's order, with trust and weekly downloads. |
| `rgstr use` | Point this project's installs at rgstr: writes `.npmrc` (and yarn/bun/uv/poetry config when those are in use). `--off` removes exactly what it wrote. |
| `rgstr route <name> --to npm:other@^1` | Route a name you hold to the package that really ships it. |

Plus `rgstr login` / `logout` / `whoami` (device-code sign-in with a
ComputeSDK account) and `rgstr org use <slug>` to pick the organization that
holds your names.

## For CI

```bash
RGSTR_TOKEN=<org API key> RGSTR_ORG=<slug> rgstr claim --check --json
```

Every command takes `--json`.

## Development

```bash
pnpm install
pnpm build && node dist/index.js --help
pnpm test
```

The CLI talks to `https://rgstr.org` by default; `--base-url` with
`--allow-untrusted-host` points it at a dev deployment (plaintext `http://`
is only accepted for localhost). Releases go through
[changesets](./.changeset) — add one with `pnpm changeset`.

MIT © computesdk
