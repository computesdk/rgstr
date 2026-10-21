# rgstr

[rgstr](https://rgstr.org) is a package name registry over npm and PyPI: claim
the name of a package you maintain, prove it with the rgstr badge in your
README, and a person reviews the claim. Installs that go through rgstr resolve
claimed names to the real package; unclaimed names fall through unchanged.

`rgstr` is the CLI. The site is https://rgstr.org.

```bash
npx @rgstr/cli@latest claim   # in your package's directory
npm i -g @rgstr/cli           # or install it: the command is `rgstr`
```

Nothing is filed or edited unless you say so: `claim` shows what it will file
and the README diff, asks, and files + writes only on yes. `setup` shows the
diff and asks the same way. `--yes` skips the question; `--json` never asks and
does nothing without `--yes`. `setup` needs no sign-in.

## The commands

| | |
| --- | --- |
| `rgstr claim [name]` | File the claim and put the proof in — after you confirm. In a package directory (package.json / pyproject.toml) it finds the package(s) and shows the plan: the claim it will file for your organization and the diff of the README rgstr reads — the folder the package declares on npm/PyPI, else the repository root — with the badge under the first heading; no README there means it says so and shows the file it would create. Then it asks `y/N`; on yes it files the claim and writes the badge (`--pr` then fetches, branches from `origin`'s default branch as it is now — never your local branch — puts the badge into that README, below any badge already there, commits, pushes and opens the PR with `gh`; your checkout is left where it was). `--yes` skips the question; without a terminal (CI, an agent) nothing happens until `--yes`. When `origin` is not the repository the package declares, nothing is written. At a workspace root it only lists the member packages; `--all` claims them all. `--here` puts the badge in the package's own README instead; rgstr reads it from the published package on the next publish. Without a package here (`rgstr claim <name>`) it files the claim once you confirm and prints the badge and an agent prompt. `rgstr claim --check` looks for the badge in the README rgstr reads and records it for the claim you filed — it files nothing new and writes no files, but it is not a read. A person then approves the claim. |
| `rgstr whois <name>` | Who claims a name, how much to trust it (unclaimed / claimed / verified — claimed plus paid identity verification), where it routes, and whether a claim is under review. No login needed. |
| `rgstr search <query>` | Names in rgstr's order, with trust, the claiming organization and weekly downloads. |
| `rgstr setup` | Point this project's installs at rgstr: shows the `.npmrc` (and yarn/bun/uv/poetry/pip) diff, asks, writes, then says what changed and how to undo it. No sign-in needed; signing in (`rgstr login`) is an optional follow-up to apply your organization's rules. `--yes` to skip the question, `--dry-run` to only look, `--off` removes exactly what it wrote. |
| `rgstr status` | Is this project pointed at rgstr, through which files, as which organization and login. |
| `rgstr check [name…]` | After `setup`: what resolving this project's dependencies through rgstr does. One line per direct dependency (package.json, pyproject.toml, requirements.txt) with its trust state, claimant and where it is served from, then `N of M names are claimed on rgstr; the rest fall through to npm / PyPI unchanged`. Informational — exit 0 whenever the check ran. |
| `rgstr route <name> --to npm:other@^1` | Route a name you claim to the package that really ships it: shows the routes as they would be, asks, applies on yes (`--yes` to skip; `--rm <id>` removes one). Without `--to` / `--rm` it only lists them. |

Plus `rgstr login` / `logout` / `whoami` (device-code sign-in as the `rgstr-cli`
client: packages read and write, organization read, nothing else on the platform) and
`rgstr org use <slug>` to pick the organization that claims your names.

## The proof: a badge in a README

The only proof that you maintain a name is the rgstr badge,
`[![rgstr](https://rgstr.org/registry/<name>/badge.svg?proof=rgstr_…)](https://rgstr.org/registry/<name>)`,
in one of two READMEs:

| Where the badge goes | How rgstr reads it | When rgstr reads it |
| --- | --- | --- |
| The README of the GitHub repository the package declares on npm/PyPI (`rgstr claim`) | Off GitHub's public API — no release, no OAuth scopes | After the pull request merges (`rgstr claim --check`) |
| The README that ships with the package (`rgstr claim --here`) | From the published package on npm/PyPI | On the next publish |

A found badge is evidence, not approval: every claim is an application a
person at rgstr reviews. The name goes unclaimed → under review → claimed;
`rgstr whois <name>` shows where it is. "Verified" is something else: paid
identity verification of the organization, on top of a claim.

## Claim your name with an agent

In a checkout of the package's repository, `npx @rgstr/cli claim --yes --pr <name>`
puts `[![rgstr](https://rgstr.org/registry/<name>/badge.svg?proof=rgstr_…)](https://rgstr.org/registry/<name>)`
under the README's first heading and opens the pull request. Merge it, then
`rgstr claim --check <name>` — rgstr reads the badge off GitHub and attaches it
to your application; a person approves the claim. No release, no OAuth scopes. `rgstr claim <name>` anywhere else prints
the badge and a one-paragraph prompt your coding agent can take verbatim (after
you confirm the filing, or with `--yes`).

## Agents

rgstr ships as an agent skill — the same plan → confirm → `--yes` rules, written
for a coding agent:

```bash
npx skills add computesdk/rgstr --skill rgstr
```

The file is [`skills/rgstr/SKILL.md`](../../skills/rgstr/SKILL.md) (where the
[skills CLI](https://skills.sh/docs/cli) looks for it); rgstr.org serves the
same file at https://rgstr.org/skills/rgstr/SKILL.md and links it from
https://rgstr.org/llms.txt.

An agent without a shell gets the same commands as MCP tools from
[`@rgstr/mcp`](../mcp/README.md) (`npx -y @rgstr/mcp`): plan tools that
change nothing, apply tools called only after the user confirms the plan.

Every API error carries a `code` and a `hint` — the next step, often with a
URL. The CLI prints the hint as the last line; `--json` carries `code`,
`hint` and `requestId`.

## For CI

```bash
RGSTR_TOKEN=<organization API key> RGSTR_ORG=<slug> rgstr claim --check --json
rgstr claim --yes --json      # files the claim and writes the badge; without --yes it only reports the plan
rgstr setup --yes --json      # --json never prompts: without --yes it reports the plan
```

`--json` never asks a question, and never files or writes without `--yes`.

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
