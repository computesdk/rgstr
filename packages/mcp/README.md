# @rgstr/mcp

[rgstr](https://rgstr.org) — the package name registry over npm and PyPI — as
MCP tools, for a coding agent that cannot run a shell. It is the
[`@rgstr/cli`](../cli/README.md) flows behind a stdio server: reads need no
account; a change is **plan** (free, shows exactly what would be filed or
written, changes nothing) then **apply** (files and writes exactly that),
and apply is only called after the user has seen the plan and confirmed it.

## Configure

Claude Desktop (`claude_desktop_config.json`), Cursor (`.cursor/mcp.json`),
Devin (Settings → MCP) and any other MCP client take the same shape:

```json
{
  "mcpServers": {
    "rgstr": {
      "command": "npx",
      "args": ["-y", "@rgstr/mcp"]
    }
  }
}
```

The server reads the CLI's environment: `RGSTR_TOKEN` + `RGSTR_ORG` for CI
(an organization API key), `RGSTR_URL` for another host, `RGSTR_HOME` for
where the login is stored, `RGSTR_CWD` for the project tools default to.

## Login

Writes use the login the CLI stores: run `npx @rgstr/cli@latest login` once
in a terminal. Without it, a write answers `no_credentials` with the hint
``Run `npx @rgstr/cli@latest login` ``. `rgstr_login` starts the same
device-code login from inside the agent and returns the URL and code for the
user to approve; the login is the user's — the agent hands it over and waits.

## Tools

| Tool | Does | Changes state |
| --- | --- | --- |
| `rgstr_whois` | who claims a name, its trust, where installs go | no |
| `rgstr_search` | names in rgstr's order, claimed first | no |
| `rgstr_check` | a project's dependencies: who claims each, served from where | no |
| `rgstr_claim_plan` | what `rgstr claim` would file and the README diff | no |
| `rgstr_claim_apply` | files the claim, writes the badge — exactly the plan | **yes** |
| `rgstr_claim_check` | looks for the badge; records the proof, can complete the claim | yes |
| `rgstr_setup_plan` | the `.npmrc` / `pip.conf` lines `rgstr setup` would write | no |
| `rgstr_setup_apply` | writes (or removes) exactly those lines | **yes** |
| `rgstr_route_plan` | a name's routes as they would be | no |
| `rgstr_route_apply` | one PUT of that list | **yes** |
| `rgstr_login` | device-code login: returns the URL and code; call again for the outcome (waiting / approved / rejected / expired) | no |

Each `_plan` tool returns the plan as text (what the CLI prints) and as JSON
with a `plan_id`; the matching `_apply` tool takes only that `plan_id` and
applies exactly that plan, once. There is no apply without a plan. If a README,
config file or the login changed since the plan was shown, apply answers
`isError` with code `plan_stale` and the hint "Run rgstr_claim_plan again and
show the user the new plan" (or the matching `_plan` tool) — nothing is written. The rule, in every apply tool's description and in
the server's instructions: **show the user the plan and get their
confirmation before calling apply.** This mirrors
[`skills/rgstr/SKILL.md`](../../skills/rgstr/SKILL.md) and
[rgstr.org/llms.txt](https://rgstr.org/llms.txt).

## Errors

Every failure is an `isError` result carrying the same envelope the API and
the CLI's `--json` use — `error`, `code`, `hint`, `requestId` — as a readable
message with the hint last, then the JSON. The hint is the next step; follow
it.

## Development

```bash
pnpm install
pnpm -r build
pnpm --filter @rgstr/mcp test
node packages/mcp/scripts/stdio-smoke.mjs computesdk   # initialize, tools/list, rgstr_whois over stdio
```

The server imports the CLI's source (`../cli/src`) and bundles it; nothing is
copied.
