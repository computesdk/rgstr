---
name: rgstr
description: Claims a package name on rgstr.org (npm or PyPI) with the README badge, checks which of a project's dependencies are claimed, and routes installs through rgstr. Use when the user maintains a package and wants its name claimed, asks who claims a name, or wants npm / pip installs to resolve claimed names to the real package.
---

# rgstr

rgstr.org is a package name registry over npm and PyPI. A maintainer claims a
name, proves it with the rgstr badge in a README, and a person reviews the
claim. Unclaimed names fall through to npm and PyPI unchanged.

Docs index: [llms.txt](https://rgstr.org/llms.txt). Every rgstr.org page is
Markdown with `Accept: text/markdown`.

Install this skill: `npx skills add computesdk/rgstr --skill rgstr`

## Rules

- Never file a claim, write a README, open a pull request, change routes, or
  edit `.npmrc` / `pip.conf` without the user's confirmation. Run the command
  without `--yes` first: it shows the plan and writes nothing. Show the user
  the plan and pass `--yes` only after they agree.
- Never claim a name the user does not maintain.
- Reading (whois, search, check, the Markdown pages) needs no confirmation and
  no account.
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

Reads: `rgstr_whois`, `rgstr_search`, `rgstr_check`. Changes are two tools:
`rgstr_claim_plan` / `rgstr_claim_apply`, `rgstr_setup_plan` /
`rgstr_setup_apply`, `rgstr_route_plan` / `rgstr_route_apply`. The `_plan`
tools are free — they show exactly what would be filed or written and change
nothing and return a `plan_id`; the `_apply` tools take only that `plan_id`
and file and write exactly that plan, once. Show the user the plan and call
`_apply` only after they confirm. If a README, config file or the login
changed since the plan, apply answers `plan_stale`: run the `_plan` tool again
and show the user the new plan.
`rgstr_claim_check` records the proof and can complete the claim. Writes need
the stored login: when a tool answers `no_credentials`, the user runs
`npx @rgstr/cli@latest login` (or `rgstr_login` returns the URL and code for
them). Errors come back as `isError` results with the same `code` + `hint`.

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
   records the proof for the claim the user already confirmed, which can
   complete that claim: `<name>: verified via …` means it is in; until then
   `<name>: no proof found yet (checked …)`.
5. A person reviews the claim. The name goes unclaimed → under review →
   claimed; `npx @rgstr/cli@latest whois <name>` shows where it is.

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
   are claimed on rgstr; the rest fall through to npm / PyPI unchanged.`
   `check <name…>` limits the rows to those names; it still needs the
   project `setup` configured (otherwise it exits `not_configured`). To look
   up a name with no project, use `whois` (section 3). Exit 0 whenever it
   ran.
3. `npx @rgstr/cli@latest setup --off --yes` removes exactly what `setup`
   wrote; installs go straight to npm / PyPI again.

## 3. Read without an account

- `GET https://rgstr.org/api/v1/registry/whois/<name>`: who claims a name,
  its trust (`unclaimed` / `claimed` / `verified`), where it routes, whether
  a claim is under review. Scoped names go as `@scope%2Fname`.
- `GET https://rgstr.org/api/registry/-/v1/search?text=<q>`: claimed names
  first.
- Any page with `Accept: text/markdown`: `https://rgstr.org/registry/<name>`,
  `/registry/-/api`, `/registry/-/why`.
- CLI: `npx @rgstr/cli@latest whois <name>` and `search <q>`.

## In CI

`RGSTR_TOKEN=<organization API key> RGSTR_ORG=<slug>` instead of `login`.
`--json` never asks a question and never files or writes without `--yes`.
