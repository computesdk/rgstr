# rgstr

[rgstr](https://rgstr.org) is a package name registry over npm and PyPI: claim
the name of a package you maintain, prove it with the rgstr badge in your
README, and a person reviews the claim. Installs that go through rgstr resolve
claimed names to the real package; unclaimed names fall through unchanged. An
unclaimed name you cannot claim — a squat, a placeholder — can be offered for:
if no maintainer claims it during the window, it is *registered* to your
organization and routed to a name you claim (a claim always beats an offer).

`rgstr` is the CLI. The site is https://rgstr.org.

```bash
npx @rgstr/cli@latest claim   # in your package's directory
npm i -g @rgstr/cli           # or install it: the command is `rgstr`
```

Nothing is filed or edited unless you say so: `claim` shows what it will file
and the README diff, asks, and files + writes only on yes. `offer` shows the
floor, the amount, the why and the rule, then asks. `setup` shows the
diff and asks the same way. `--yes` skips the question; `--json` never asks and
does nothing without `--yes`. `setup` needs no sign-in.

## The commands

| | |
| --- | --- |
| `rgstr claim [name]` | File the claim and put the proof in — after you confirm. In a package directory (package.json / pyproject.toml) it finds the package(s) and shows the plan: the claim it will file for your organization and the diff of the README rgstr reads — the folder the package declares on npm/PyPI, else the repository root — with the badge under the first heading; no README there means it says so and shows the file it would create. Then it asks `y/N`; on yes it files the claim and writes the badge (`--pr` then fetches, branches from `origin`'s default branch as it is now — never your local branch — puts the badge into that README, below any badge already there, commits, pushes and opens the PR with `gh`; your checkout is left where it was). `--yes` skips the question; without a terminal (CI, an agent) nothing happens until `--yes`. When `origin` is not the repository the package declares, nothing is written. At a workspace root it only lists the member packages; `--all` claims them all. `--here` puts the badge in the package's own README instead; rgstr reads it from the published package on the next publish. Without a package here (`rgstr claim <name>`) it files the claim once you confirm and prints the badge and an agent prompt. `rgstr claim --check` looks for the badge in the README rgstr reads and records it for the claim you filed — it files nothing new and writes no files, but it is not a read. A person then approves the claim. |
| `rgstr offer <name>` | For an unclaimed name you cannot claim (you do not maintain it): shows the floor for the name, the amount (`--amount <usd>`, whole dollars, default the floor), the why (`--why "<one line>"`, shown to the maintainer and the reviewer), any offer already open, and the rule — the maintainer can claim the name for free at any time during the 30-day window, and that beats your offer; your card is charged only if your offer wins, so their claim costs you nothing. Then it asks `y/N`; on yes it files the offer and prints the checkout URL where you save the card (charged only if the offer wins) and, if your organization's identity is not yet verified, the identity page; the 30-day window opens once both are done. `--yes` skips the question; without a terminal nothing is filed until `--yes`. `--withdraw` ends your open offer on the name, after the same question. |
| `rgstr offers` | Your organization's offers: name, amount, state (waiting for the card and identity verification / open / won — name registered / closed — the maintainer claimed the name; nothing was charged / lapsed / withdrawn) and when the window closes. |
| `rgstr whois <name>` | Who claims a name, how much to trust it (unclaimed / claimed / verified — claimed plus paid identity verification), where it routes, and whether a claim is under review. A registered name prints `registered by Acme Labs · identity verified · routes to @acme/fastcache · no maintainer has claimed this name`; an open offer prints ``offer $400 by Acme Labs, window closes Nov 20, 2026 — maintain this package? `rgstr claim <name>`, free``. No login needed. |
| `rgstr search <query>` | Names in rgstr's order, with trust (`registered (Acme Labs)` for a registered name), the claiming organization and weekly downloads. |
| `rgstr setup` | Point this project's installs at rgstr: shows the `.npmrc` (and yarn/bun/uv/poetry/pip) diff, asks, writes, then says what changed and how to undo it. No sign-in needed; signing in (`rgstr login`) is an optional follow-up to apply your organization's rules. `--yes` to skip the question, `--dry-run` to only look, `--off` removes exactly what it wrote. |
| `rgstr status` | Is this project pointed at rgstr, through which files, as which organization and login. |
| `rgstr check [name…]` | After `setup`: what resolving this project's dependencies through rgstr does. One line per direct dependency (package.json, pyproject.toml, requirements.txt) with its trust state, claimant and where it is served from — a registered name reads `registered (Acme Labs → @acme/fastcache)` and is served from the registrant's route — then `N of M names are claimed on rgstr; the rest fall through to npm / PyPI unchanged` (`and K registered` when there are any). Informational — exit 0 whenever the check ran. |
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

## Offers: a name you cannot claim

A name on npm can be a 0.0.1 placeholder while the project people mean by it
lives under another string. `rgstr offer <name>` (plan → `y/N` → file) puts an
amount on an unclaimed name; rgstr tells the maintainer, who can claim it for
free at any time in the 30-day window — and that beats the offer. Your card is
saved when you file and charged only if your offer wins, so a maintainer's
claim costs you nothing (there is nothing to refund). If nobody who maintains
the package claims it, the highest offer is
charged and the name is **registered** to the offering organization: public
(`whois`, `search`, `check` all say `registered`), routed only to a name that
organization already claims, kept with an annual fee, and still open to a
maintainer's claim as a dispute a reviewer decides. Offers need the
organization's identity verified, are capped at five open per organization,
and are not open on claimed names or scopes. Rules in full:
https://rgstr.org/registry/-/offers.

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
rgstr offer <name> --amount 400 --yes --json   # files the offer; without --yes it only reports the plan
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
