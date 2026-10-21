---
name: rgstr
description: Claims a package name on rgstr.org (npm or PyPI) with the README badge, checks which of a project's dependencies are claimed, routes installs through rgstr, and files an offer on an unclaimed name the user cannot claim. Use when the user maintains a package and wants its name claimed, asks who claims a name, wants npm / pip installs to resolve claimed names to the real package, or wants a squatted name to resolve to their package.
---

# rgstr

rgstr.org is a package name registry over npm and PyPI. A maintainer claims a
name, proves it with the rgstr badge in a README, and a person reviews the
claim. Unclaimed names fall through to npm and PyPI unchanged. A name has one
of three public states: `unclaimed`, `claimed` (a maintainer proved it) or
`registered` (an identity-verified organization won an offer on it; no
maintainer has claimed it, and a claim still beats it — see flow 4).

Docs index: [llms.txt](https://rgstr.org/llms.txt). Every rgstr.org page is
Markdown with `Accept: text/markdown`.

Install this skill: `npx skills add computesdk/rgstr --skill rgstr`

## Rules

- Never file a claim, write a README, open a pull request, change routes, or
  edit `.npmrc` / `pip.conf` without the user's confirmation. Run the command
  without `--yes` first: it shows the plan and writes nothing. Show the user
  the plan and pass `--yes` only after they agree.
- Never claim a name the user does not maintain. For an unclaimed name they do
  not maintain, the only path is an offer (flow 4) — a side effect filed in
  their name against their card, so plan → confirm → `--yes` like everything
  else.
- Reading (whois, search, check, the Markdown pages) needs no confirmation and
  no account. `claim --check` is not a read: it records the proof for a claim
  the user already confirmed.
- Write "organization", never "org", when talking to the user.
- The login is the user's: hand them the URL and the code and wait. Never try
  to approve it yourself.
- Never print or commit a token. The proof token (`rgstr_…`) belongs in the
  badge URL only.
- Every API error is JSON with `code` and `hint`; the CLI prints the hint as
  its last line. The hint is the next step: follow it.

## Prerequisites

Node 18+. Every command below is `npx @rgstr/cli@latest <command>`;
`npm i -g @rgstr/cli` installs it as `rgstr`. Every command takes `--json`.

## Without a shell: MCP

`@rgstr/mcp` is the same CLI as MCP tools over stdio, for an agent that
cannot run commands. Configure it (Claude Desktop, Cursor, Devin and any
other MCP client take this shape):

```json
{ "mcpServers": { "rgstr": { "command": "npx", "args": ["-y", "@rgstr/mcp"] } } }
```

Reads: `rgstr_whois`, `rgstr_search`, `rgstr_check`, `rgstr_offers` (the
organization's own offers; needs the login). Changes are two tools:
`rgstr_claim_plan` / `rgstr_claim_apply`, `rgstr_setup_plan` /
`rgstr_setup_apply`, `rgstr_route_plan` / `rgstr_route_apply`,
`rgstr_offer_plan` / `rgstr_offer_apply`. The `_plan`
tools are free — they show exactly what would be filed or written and change
nothing and return a `plan_id`; the `_apply` tools take only that `plan_id`
and file and write exactly that plan, once. Show the user the plan and call
`_apply` only after they confirm. If a README, config file, the offer's
inputs, the login or the active organization changed since the plan, apply
answers `plan_stale`: run the `_plan` tool again and show the user the new
plan.
`rgstr_claim_check` is `claim --check`: it records the proof for a filed
claim, so it is not a read. Writes need
the stored login: when a tool answers `no_credentials`, the user runs
`npx @rgstr/cli@latest login` (or `rgstr_login` returns the URL and code for
them; call it again for the outcome — waiting, approved, rejected or
expired). Errors come back as `isError` results with the same `code` + `hint`.

## 1. Claim a name

Run in a checkout of the package's repository (package.json or
pyproject.toml). Without one, `claim <name>` files the claim (after
confirmation) and prints the badge for the user to add by hand.

1. `npx @rgstr/cli@latest login` prints `To sign in, visit:`, a URL and
   `User code: XXXX-XXXX`. Give both to the user; they authorize in a
   browser and the command returns.
2. `npx @rgstr/cli@latest claim <name>` shows the plan: `Files the claim:
   <name> goes under review until the badge is in a README rgstr reads.` and
   the diff of the README the badge goes in, with an `rgstr_…` placeholder
   for the proof token. Nothing is filed or written; without a terminal it
   ends with `Nothing filed, nothing written — that is the plan. Re-run with
   --yes to …`.
3. Show the user the plan. On yes, `npx @rgstr/cli@latest claim --yes <name>`
   files the claim (`Filed: <name> (<url>)`) and writes the badge. Add `--pr`
   to also branch from origin's default branch, commit the badge and open
   the pull request with `gh`: `Opened <url> (branch rgstr-badge-<name>).
   Merge it, then: rgstr claim --check <name>`.
4. Once the badge is on the default branch (pull request merged), or shipped
   in a publish with `--here`, `npx @rgstr/cli@latest claim --check <name>`
   looks for the proof. It files nothing new and writes no files, but it
   records the proof for the claim the user already confirmed: `<name>: proof
   found via …` means the badge is attached to the application; until then
   `<name>: no proof found yet (checked …)`.
5. A person reviews every claim; a found badge is evidence, not approval. The
   name goes unclaimed → under review → claimed; `npx @rgstr/cli@latest whois
   <name>` shows where it is.

At a workspace root `claim` only lists the member packages; `--all` claims
them all (confirm first). `--statement "<text>"` adds a sentence for the
reviewer.

## 2. Check a project's dependencies

No login needed.

1. After the user agrees, `npx @rgstr/cli@latest setup --npm --yes` (or
   `--pip`) writes the rgstr registry line to the project's `.npmrc` (and
   yarn / bun config) or the virtualenv's `pip.conf` (uv / poetry). Without
   `--yes` it shows the diff and ends with `Nothing written. Re-run with --yes
   to apply.` `--pip` with no active virtualenv, `.venv`, uv or poetry
   lockfile writes nothing: it prints a `pip config set global.index-url …`
   command for the user to run, and `check` stays `not_configured` until
   one of those exists.
2. In that project, `npx @rgstr/cli@latest check` prints one row per direct
   dependency (`name | trust | claimed by | served from`), then `N of M names
   are claimed on rgstr; the rest fall through to npm / PyPI unchanged.` A
   registered name's row reads `registered (Acme Labs → @acme/fastcache)` and
   is served from the registrant's route; the summary adds `and K registered`
   when there are any — registered is not counted as claimed.
   `check <name…>` limits the rows to those names; it still needs the
   project `setup` configured (otherwise it exits `not_configured`). To look
   up a name with no project, use `whois` (section 3). Exit 0 whenever it
   ran.
3. `npx @rgstr/cli@latest setup --off --yes` removes exactly what `setup`
   wrote; installs go straight to npm / PyPI again.

## 3. Read without an account

- `GET https://rgstr.org/api/v1/registry/whois/<name>`: who claims a name,
  its trust (`unclaimed` / `claimed` / `verified` — claimed plus paid identity
  verification), its state (`unclaimed` / `pending` / `held` / `disputed` /
  `registered` — with `registrant`, `routesTo` and, while a window is open,
  `openOffer`), where it routes, whether a claim is under review. Scoped names
  go as `@scope%2Fname`. The CLI prints a registered name as `registered by
  Acme Labs · identity verified · routes to @acme/fastcache · no maintainer
  has claimed this name`, and an open offer as ``offer $400 by Acme Labs,
  window closes Nov 20, 2026 — maintain this package? `rgstr claim <name>`,
  free``.
- `GET https://rgstr.org/api/registry/-/v1/search?text=<q>`: claimed names
  first; a registered name shows as `registered (Acme Labs)`.
- Any page with `Accept: text/markdown`: `https://rgstr.org/registry/<name>`,
  `/registry/-/api`, `/registry/-/why`.
- CLI: `npx @rgstr/cli@latest whois <name>` and `search <q>`.

## 4. Offer for a name you cannot claim

When to use it: the name is unclaimed (`whois` says so) and the user does not
maintain the package published under it — a placeholder, a squat, an
abandoned 0.0.1 — and they want installs through rgstr to resolve it to a
package their organization already claims. If the user maintains the package,
this is the wrong flow: they claim it, free (flow 1).

The rule, say it to the user before anything is filed: the maintainer can
claim the name for free at any time during the 30-day window, and that beats
the offer. Nothing is charged when the offer is filed — the user's card is
saved and charged only if the offer wins — so a maintainer's claim costs them
nothing; there is nothing to refund. Money never beats proof; rgstr tells the
maintainer about the offer. Offers are not open on claimed names or on
scopes.

1. `npx @rgstr/cli@latest offer <name> --amount <usd> --why "<one line>"`
   shows the plan: the floor for the name (the least an offer can be; `$10`,
   higher for busy names — `--amount` defaults to it; whole dollars), the amount, the why
   (shown to the maintainer and the reviewer), any offer already open on the
   name, and the rule. One read, nothing filed; without a terminal it ends
   with `Nothing filed — that is the plan. Re-run with --yes to file the offer
   for <name> as <organization>.` An amount below the floor is refused here,
   before any request: `Re-run with --amount <floor> or more`.
2. Show the user the plan. On yes, `npx @rgstr/cli@latest offer --yes <name>
   --amount <usd> --why "<text>"` files it: `Filed: offer $<usd> for <name>
   (<url>)`, then `Save the card (charged $<usd> only if your offer wins):
   <checkout URL>` — a Stripe Checkout page that saves the card; nothing is
   charged there. The URL is the user's: hand it over, never open it for
   them.
3. Identity: the window opens only once the organization's identity is
   verified (the paid step, once per organization). If it is not, the filed
   lines include the identity page URL (`Verify identity first: …`); hand
   that to the user too. The CLI then says `The window opens once the card is
   saved and the identity is verified`; an offer still waiting after 7 days
   lapses and is never shown to the maintainer. No command needs re-running.
4. `npx @rgstr/cli@latest offers` lists the organization's offers: name,
   amount, state (`waiting for the card` / `waiting for the card and identity verification`, `open`,
   `won — name registered`, `closed — the maintainer claimed the name; nothing
   was charged`, `lapsed`, `withdrawn`) and when the window closes. `npx
   @rgstr/cli@latest offer --withdraw <name>` ends an open offer, after
   confirmation (`--yes`); nothing was charged, so nothing is refunded.
5. What happens next needs no command: if nobody who maintains the package
   claims it by the close, the highest offer's card is charged and the name
   is `registered` to that organization, routed to a name it claims (`whois`
   shows `registered by …`); if the maintainer claims it, every offer closes
   with nothing charged. A later claim with proof is a dispute a reviewer
   decides.

MCP: `rgstr_offer_plan(name, amount?, why?)` is the plan (free; returns a
`plan_id`), `rgstr_offer_apply(plan_id)` files exactly that plan after the
user confirms and returns `checkoutUrl` and `identity` (`verified`, or the
`url` to verify at) for the user, `rgstr_offers` lists the organization's
offers. Errors to expect, each with a `hint` to follow: `offer_below_floor`,
`offer_identity_required` (the host has no identity verification),
`offer_limit_reached` (five open offers per organization), `name_claimed`
(offers on claimed names are not open yet),
`route_target_not_claimed` (a registered name routes only to a name the
registrant claims).

## In CI

`RGSTR_TOKEN=<organization API key> RGSTR_ORG=<slug>` instead of `login`.
`--json` never asks a question and never files or writes without `--yes`.
