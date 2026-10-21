# rgstr

The terminal and agent front door for [rgstr](https://rgstr.org), the package
name registry over npm and PyPI: claim a name, prove it with the README
badge, route it, point your installs through it.

| Package | What | Install |
| --- | --- | --- |
| [`@rgstr/cli`](./packages/cli/README.md) | the `rgstr` command | `npx @rgstr/cli@latest` |
| [`@rgstr/mcp`](./packages/mcp/README.md) | the same flows as MCP tools over stdio | `npx -y @rgstr/mcp` |

The agent skill is [`skills/rgstr/SKILL.md`](./skills/rgstr/SKILL.md):
`npx skills add computesdk/rgstr --skill rgstr`.

## Development

pnpm workspace. `pnpm install`, then `pnpm build`, `pnpm test`,
`pnpm typecheck`, `pnpm lint` run in every package (the CLI's tests run the
built `dist/index.js`, so build first). Releases go through
[Changesets](./.changeset): `pnpm changeset` for every package a change touches.
