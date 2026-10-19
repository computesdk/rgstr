# rgstr

**One name, every ecosystem.** [rgstr](https://rgstr.org) is a package naming
registry: claim the name of a package you maintain, prove it with a badge in
your README, and the name resolves to you on npm and PyPI — look-alikes,
hijacked forks and squatted copies get folded under it or flagged.

`rgstr` is the CLI. The site is https://rgstr.org.

```bash
npx @rgstr/cli claim          # in your package's directory
npm i -g @rgstr/cli           # or install it: the command is `rgstr`
```

Nothing edits your files unless you ask: `claim` shows the diff and asks
(`--yes` skips the question); outside a checkout it only prints.
`setup` shows the diff and asks, `--yes` skips the question.

## The commands

| | |
| --- | --- |
| `rgstr claim [name]` | File the claim and put the proof in: inside a git checkout it finds the package(s) and their README, checks `origin` is the repository the package declares on npm/PyPI, shows the badge inserted under the first heading and asks (`--yes` to skip; `--pr` to branch, commit, push and open the PR with `gh`). At a workspace root it only lists the member packages; `--all` claims them all. `--here` keeps the badge in the package's own README, which verifies on the next publish instead. Outside a checkout it prints the badge and an agent prompt. `rgstr claim --check` tells you which README the badge was found in. |
| `rgstr whois <name>` | Who holds a name, how much to trust it (unclaimed / claimed / verified), where it routes, and whether it is disputed. No login needed. |
| `rgstr search <query>` | Names in rgstr's order, with trust and weekly downloads. |
| `rgstr setup` | Point this project's installs at rgstr: shows the `.npmrc` (and yarn/bun/uv/poetry/pip) diff, asks, writes, then says what changed. `--yes` to skip the question, `--dry-run` to only look, `--off` removes exactly what it wrote. Signs you in first if needed. |
| `rgstr status` | Is this project pointed at rgstr, through which files, as which org and login. |
| `rgstr check [name…]` | After `setup`: what resolving this project's dependencies through rgstr does. One line per direct dependency (package.json, pyproject.toml, requirements.txt) with its trust state, holder and where it is served from, then `N of M names are held on rgstr; the rest fall through to npm / PyPI unchanged`. Informational — exit 0 whenever the check ran. |
| `rgstr route <name> --to npm:other@^1` | Route a name you hold to the package that really ships it. |

Plus `rgstr login` / `logout` / `whoami` (device-code sign-in as the `rgstr-cli`
client: packages and org read, nothing else on the platform) and
`rgstr org use <slug>` to pick the organization that holds your names.

## The proof: a badge in a README

The only proof that you own a name is the rgstr badge,
`[![rgstr](https://rgstr.org/registry/<name>/badge.svg?proof=rgstr_…)](https://rgstr.org/registry/<name>)`,
in one of two READMEs:

| Where the badge goes | How rgstr reads it | When it verifies |
| --- | --- | --- |
| The README of the GitHub repository the package declares on npm/PyPI (`rgstr claim`) | Off GitHub's public API — no release, no OAuth scopes | When the PR is merged |
| The README that ships with the package (`rgstr claim --here`) | From the published package on npm/PyPI | On the next publish |

## Claim your name with an agent

In a checkout of the package's repository, `npx @rgstr/cli claim --yes --pr <name>`
puts `[![rgstr](https://rgstr.org/registry/<name>/badge.svg?proof=rgstr_…)](https://rgstr.org/registry/<name>)`
under the README's first heading and opens the pull request. Merge it, then
`rgstr claim --check <name>` — rgstr reads the badge off GitHub and the name is
yours. No release, no OAuth scopes. `rgstr claim <name>` anywhere else prints
the badge and a one-paragraph prompt your coding agent can take verbatim.

## For CI

```bash
RGSTR_TOKEN=<org API key> RGSTR_ORG=<slug> rgstr claim --check --json
rgstr setup --yes --json      # --json never prompts: without --yes it reports the plan
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
