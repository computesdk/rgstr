/**
 * rgstr as MCP tools. Every tool wraps the CLI's own flow modules
 * (../../cli/src), so an agent without a shell gets exactly what `rgstr`
 * prints: reads need no account; a change is plan (free, read-only) then
 * apply (files and writes exactly what the plan said), and apply is only
 * called after the user has seen the plan and confirmed it.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { SearchObject, WhoisResponse } from '../../cli/src/api-types.js';
import { deviceLogin } from '../../cli/src/auth.js';
import { checkProject } from '../../cli/src/check-flow.js';
import {
  applyClaims,
  checkOne,
  outcomeJson,
  planClaims,
  previewJson,
  resolveClaimTargets,
  type ClaimOpts,
  type ClaimPlan,
  type Say,
} from '../../cli/src/claim-flow.js';
import {
  RgstrApiError,
  RgstrClient,
  RgstrCliError,
  assertHostAllowed,
  renderError,
  resolveAuth,
  resolveBaseUrl,
  toErrorEnvelope,
  type ErrorEnvelope,
  type GlobalOptions,
} from '../../cli/src/client.js';
import { applyRoutes, planRoutes, renderRoutePlan, type RoutePlan } from '../../cli/src/route-flow.js';
import { applyUse, planUse, type UseChange } from '../../cli/src/use.js';

export const LOGIN_HINT = 'Run `npx @rgstr/cli@latest login`';

/** The rule, as skills/rgstr/SKILL.md and https://rgstr.org/llms.txt say it. */
export const CONFIRM_FIRST =
  'Before anything that changes state — filing a claim, editing a README or opening a pull request, changing routes, or editing .npmrc / pip.conf — show the user the plan and get their confirmation first. Reading (whois, search, check) needs none.';

export const INSTRUCTIONS = [
  'rgstr (https://rgstr.org) is the package name registry over npm and PyPI: who claims a name, how much to trust it, and where installs of it are served from.',
  'Reading needs no account: rgstr_whois, rgstr_search, rgstr_check.',
  'Changing state is two tools. The *_plan tools are free: they read, show exactly what would be filed or written (the claim, the README diff, the routes as they would be, the .npmrc / pip.conf lines) and change nothing. The *_apply tools file and write exactly what the plan said.',
  CONFIRM_FIRST,
  'Never call a *_apply tool on a plan the user has not seen and confirmed. rgstr_claim_check records the proof and can complete the claim.',
  `Writes need a login. When a tool answers "no_credentials", tell the user: ${LOGIN_HINT} (or call rgstr_login and give them the URL and code).`,
  'Every error carries code + hint: follow the hint.',
].join('\n');

const APPLY_RULE = (plan: string) =>
  `Changes state. Call ${plan} first, show the user that plan, and only call this after they have confirmed it; it files and writes exactly what the plan said. ${CONFIRM_FIRST}`;

export interface ServerOptions extends GlobalOptions {
  /** Directory tools default to when a call names no cwd. */
  cwd?: string;
}

type StoredPlan =
  | { kind: 'claim'; plan: ClaimPlan; opts: ClaimOpts; text: string }
  | { kind: 'route'; plan: RoutePlan }
  | { kind: 'setup'; changes: UseChange[]; origin: string; off: boolean };

const text = (lines: string[] | string, data?: unknown): CallToolResult => {
  const body = Array.isArray(lines) ? lines.join('\n') : lines;
  return {
    content: [{ type: 'text', text: data === undefined ? body : `${body}${body ? '\n\n' : ''}${JSON.stringify(data, null, 2)}` }],
    ...(data !== undefined && data !== null && typeof data === 'object' ? { structuredContent: data as Record<string, unknown> } : {}),
  };
};

/** The same envelope the CLI's --json prints and the API answers with:
 *  error, code, hint, requestId — as an isError result. */
export function errorResult(err: unknown): CallToolResult {
  let env: ErrorEnvelope = toErrorEnvelope(err);
  if (err instanceof RgstrCliError && err.code === 'no_credentials') env = { error: 'Not logged in.', code: 'no_credentials', hint: LOGIN_HINT };
  else if (err instanceof RgstrApiError && err.status === 401) env = { ...env, hint: `${LOGIN_HINT}, then try again` };
  return { content: [{ type: 'text', text: `${renderError(env)}\n\n${JSON.stringify(env)}` }], isError: true };
}

const collector = () => {
  const lines: string[] = [];
  const say: Say = (line) => lines.push(line);
  return { lines, say };
};

const cwdSchema = z.string().optional().describe('Project directory (absolute). Defaults to the directory the server runs in.');
const planIdSchema = z.string().optional().describe('The plan_id a *_plan call returned; applies exactly that plan. Without it the plan is recomputed from the other arguments.');

export function createServer(options: ServerOptions = {}, version = '0.0.0'): McpServer {
  const server = new McpServer({ name: 'rgstr', version }, { instructions: INSTRUCTIONS });
  const plans = new Map<string, StoredPlan>();
  const remember = (plan: StoredPlan) => {
    const id = randomUUID();
    plans.set(id, plan);
    return id;
  };
  const take = <K extends StoredPlan['kind']>(id: string, kind: K): Extract<StoredPlan, { kind: K }> => {
    const stored = plans.get(id);
    if (!stored || stored.kind !== kind) {
      throw new RgstrCliError('invalid_argument', `Unknown plan_id ${id}`, `Call rgstr_${kind}_plan first and pass the plan_id it returns`);
    }
    plans.delete(id);
    return stored as Extract<StoredPlan, { kind: K }>;
  };
  const dirOf = (cwd?: string, manifest?: string) => path.resolve(cwd ?? (manifest ? path.dirname(manifest) : options.cwd ?? process.cwd()));
  const client = async (optional = false) => new RgstrClient(await resolveAuth({ ...options, optional }));
  const run = async (fn: () => Promise<CallToolResult>): Promise<CallToolResult> => {
    try {
      return await fn();
    } catch (err) {
      return errorResult(err);
    }
  };

  // ── reads ───────────────────────────────────────────────────────────────

  server.registerTool(
    'rgstr_whois',
    {
      title: 'Who claims a name',
      description: 'Who claims a package name on rgstr, how much to trust it (unclaimed, claimed, verified), and where installs of it are served from. Reads only; no account needed.',
      inputSchema: { name: z.string().describe('Package name (`left-pad`, `@scope/pkg`) or scope (`@scope`).') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ name }) =>
      run(async () => {
        const c = await client(true);
        return text('', await c.get<WhoisResponse>(`/api/v1/registry/whois/${encodeURIComponent(name)}`));
      }),
  );

  server.registerTool(
    'rgstr_search',
    {
      title: 'Search names',
      description: "Search package names in rgstr's order — claimed names first — with trust, weekly downloads and whether a result is a sibling, namesake or copy of a bigger package. Reads only; no account needed.",
      inputSchema: { text: z.string().describe('Search text.'), size: z.number().int().min(1).max(50).optional().describe('Rows (default 10).') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ text: query, size }) =>
      run(async () => {
        const c = await client(true);
        return text('', await c.get<{ objects: SearchObject[]; total: number }>(`/api/registry/-/v1/search?text=${encodeURIComponent(query)}&size=${size ?? 10}`));
      }),
  );

  server.registerTool(
    'rgstr_check',
    {
      title: "Check a project's dependencies",
      description: "What resolving this project's dependencies through rgstr does: per name, who claims it and where it is served from. Reads the project's manifests and .npmrc / pip config; the project must already be pointed at rgstr (rgstr_setup_plan / rgstr_setup_apply). Reads only.",
      inputSchema: {
        cwd: cwdSchema,
        manifest: z.string().optional().describe('A package.json / pyproject.toml / requirements.txt path; its directory is the project.'),
        names: z.array(z.string()).optional().describe('Only these names (default: every dependency).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ cwd, manifest, names }) =>
      run(async () => {
        const { result, text: body } = await checkProject(options, dirOf(cwd, manifest), names ?? []);
        return text(body, result);
      }),
  );

  // ── claim ───────────────────────────────────────────────────────────────

  const claimOptsSchema = {
    cwd: cwdSchema,
    name: z.string().optional().describe('The name to claim. Defaults to the package in cwd.'),
    all: z.boolean().optional().describe('At a workspace root: every member package.'),
    here: z.boolean().optional().describe("Keep the badge in this package's own README even when the registry points at the repository root."),
    npm: z.boolean().optional().describe('Treat the package as npm.'),
    pip: z.boolean().optional().describe('Treat the package as PyPI.'),
    statement: z.string().optional().describe('A sentence for the reviewer (when the name is claimed by another organization).'),
  };
  type ClaimArgs = { cwd?: string; name?: string; all?: boolean; here?: boolean; npm?: boolean; pip?: boolean; statement?: string; pr?: boolean };
  const claimOpts = (a: ClaimArgs): ClaimOpts => ({ all: a.all, here: a.here, npm: a.npm, pip: a.pip, statement: a.statement, pr: a.pr });

  const planClaim = async (args: ClaimArgs) => {
    const dir = dirOf(args.cwd);
    const opts = claimOpts(args);
    const choice = await resolveClaimTargets(dir, args.name, opts);
    if (choice.kind === 'workspace') return { kind: 'workspace' as const, dir, names: choice.names };
    const c = await client();
    const { lines, say } = collector();
    const plan = await planClaims(c, say, opts, { dir, targets: choice.targets });
    return { kind: 'plan' as const, c, dir, opts, plan, lines };
  };

  server.registerTool(
    'rgstr_claim_plan',
    {
      title: 'Plan a claim',
      description:
        'The plan for claiming a name for your organization — exactly what `rgstr claim` shows before it asks: whether a claim gets filed, and the diff of the README the proof badge goes into. Free: reads the organization\'s applications, public package metadata and local files; nothing is filed, nothing is written. Show the user this plan; rgstr_claim_apply files and writes it after they confirm. Needs a login (rgstr_login).',
      inputSchema: claimOptsSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      run(async () => {
        const r = await planClaim(args);
        if (r.kind === 'workspace') {
          return text(
            r.names.length === 0
              ? 'This is a workspace root with no publishable packages — pass cwd of a package, or a name.'
              : `${r.names.length} package${r.names.length === 1 ? '' : 's'} in this workspace: ${r.names.join(', ')} — pass all: true to claim them all, or the cwd of one. Nothing filed, nothing written.`,
            { workspace: true, packages: r.names },
          );
        }
        const { c, plan, lines, opts } = r;
        const body = [...lines];
        if (!plan.what) body.push('', 'Nothing to file, nothing to write: already under review or verified, and the badge is in place.');
        else body.push('', `Nothing filed, nothing written — that is the plan. After the user confirms, call rgstr_claim_apply with plan_id to ${plan.what}.`);
        const plan_id = plan.what ? remember({ kind: 'claim', plan, opts, text: lines.join('\n') }) : null;
        return text(body, {
          plan_id,
          what: plan.what || null,
          toFile: plan.toFile,
          toWrite: plan.toWrite,
          applied: false,
          packages: plan.previews.map((p) => previewJson(c, p)),
        });
      }),
  );

  server.registerTool(
    'rgstr_claim_apply',
    {
      title: 'File the claim and write the badge',
      description: `Files the claim and writes the proof badge into the README — exactly what rgstr_claim_plan showed, nothing else. ${APPLY_RULE('rgstr_claim_plan')} Optionally opens the badge pull request (pr: true, needs gh).`,
      inputSchema: { plan_id: planIdSchema, ...claimOptsSchema, pr: z.boolean().optional().describe('After writing: branch, commit, push and open the pull request with gh.') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ plan_id, ...args }) =>
      run(async () => {
        let c: RgstrClient;
        let plan: ClaimPlan;
        let opts: ClaimOpts;
        if (plan_id) {
          const stored = take(plan_id, 'claim');
          c = await client();
          plan = stored.plan;
          opts = { ...stored.opts, pr: args.pr ?? stored.opts.pr };
        } else {
          const r = await planClaim(args);
          if (r.kind === 'workspace') throw new RgstrCliError('invalid_argument', 'A workspace root: nothing applied.', 'Pass all: true, or the cwd of one package');
          ({ c, plan, opts } = r);
        }
        if (!plan.what) return text('Nothing to file, nothing to write.', { applied: false, packages: plan.previews.map((p) => previewJson(c, p)) });
        const { lines, say } = collector();
        const { results, pr } = await applyClaims(c, say, opts, plan);
        return text(lines, { applied: true, packages: results.map((r) => outcomeJson(c, r)), pr });
      }),
  );

  server.registerTool(
    'rgstr_claim_check',
    {
      title: 'Check the proof',
      description:
        'Looks for the proof of a claim under review: the badge in the repository README on GitHub, or in the README of the published package. Records the proof on the application and can complete the claim (the name becomes claimed by your organization when nobody else has claimed it). Files no claim and writes no file. Needs a login.',
      inputSchema: { cwd: cwdSchema, name: z.string().optional().describe('The name. Defaults to the package in cwd.'), npm: z.boolean().optional(), pip: z.boolean().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ cwd, name, npm, pip }) =>
      run(async () => {
        const opts: ClaimOpts = { check: true, npm, pip };
        const choice = await resolveClaimTargets(dirOf(cwd), name, opts);
        if (choice.kind === 'workspace') return text('A workspace root with no publishable packages — pass a name.', { workspace: true, packages: choice.names });
        const c = await client();
        const { lines, say } = collector();
        const checks: Record<string, unknown>[] = [];
        for (const t of choice.targets) checks.push(await checkOne(c, say, t));
        return text(lines, checks.length === 1 ? checks[0] : { packages: checks });
      }),
  );

  // ── setup ───────────────────────────────────────────────────────────────

  const setupSchema = {
    cwd: cwdSchema,
    npm: z.boolean().optional().describe('Point npm (.npmrc) at rgstr.'),
    pip: z.boolean().optional().describe('Point pip / uv / poetry at rgstr.'),
    off: z.boolean().optional().describe('Remove the rgstr lines instead.'),
  };
  const describeUse = (changes: UseChange[]): string[] => {
    if (changes.length === 0) return ['No package.json or pyproject.toml here — pass npm or pip to choose.'];
    const lines: string[] = [];
    for (const ch of changes) {
      const who = ch.clients.join(', ');
      if (ch.action === 'unchanged') lines.push(`${ch.file}: already set (${who})`);
      else if (ch.action === 'absent') lines.push(`${ch.file}: nothing to remove`);
      else if (ch.action === 'manual') lines.push(`pip: no virtualenv here (pip reads no project file) — run: ${ch.command}`);
      else {
        lines.push(`${ch.file}: ${ch.action === 'removed' ? 'will remove the rgstr block' : 'will write'} (${who})`);
        if (ch.diff) lines.push(ch.diff);
      }
    }
    return lines;
  };
  const planSetup = async (args: { cwd?: string; npm?: boolean; pip?: boolean; off?: boolean }) => {
    const origin = await resolveBaseUrl(options);
    assertHostAllowed(origin, options.allowUntrustedHost);
    const changes = await planUse({ dir: dirOf(args.cwd), origin, off: args.off, npm: args.npm, pip: args.pip });
    return { origin, changes, pending: changes.filter((c) => c.action === 'written' || c.action === 'removed') };
  };
  const useJson = (changes: UseChange[]) => changes.map(({ path: _path, after: _after, ...c }) => c);

  server.registerTool(
    'rgstr_setup_plan',
    {
      title: 'Plan pointing installs through rgstr',
      description:
        'The lines `rgstr setup` would write to .npmrc / pip.conf (or remove with off) so installs resolve through rgstr, shown as a diff. Free: reads the project, writes nothing. Show the user; rgstr_setup_apply writes it after they confirm. No account needed.',
      inputSchema: setupSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      run(async () => {
        const { origin, changes, pending } = await planSetup(args);
        const lines = describeUse(changes);
        const plan_id = pending.length ? remember({ kind: 'setup', changes, origin, off: !!args.off }) : null;
        if (pending.length) lines.push('', 'Nothing written — that is the plan. After the user confirms, call rgstr_setup_apply with plan_id.');
        return text(lines, { plan_id, origin, changes: useJson(changes), applied: false });
      }),
  );

  server.registerTool(
    'rgstr_setup_apply',
    {
      title: 'Write the rgstr lines',
      description: `Writes (or removes) the .npmrc / pip.conf lines rgstr_setup_plan showed — exactly those lines, nothing else; \`off\` undoes it. ${APPLY_RULE('rgstr_setup_plan')}`,
      inputSchema: { plan_id: planIdSchema, ...setupSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ plan_id, ...args }) =>
      run(async () => {
        const { origin, changes, off } = plan_id ? take(plan_id, 'setup') : { ...(await planSetup(args)), off: !!args.off };
        const pending = changes.filter((c) => c.action === 'written' || c.action === 'removed');
        if (pending.length === 0) return text(describeUse(changes), { origin, changes: useJson(changes), applied: false });
        await applyUse(changes);
        const lines = pending.map((c) => `${c.file}: ${c.action === 'removed' ? 'removed the rgstr block' : 'written'} (${c.clients.join(', ')})`);
        lines.push(
          off
            ? 'Installs go straight to npm / PyPI again.'
            : `Installs now resolve through ${origin}: names someone claims → that organization's routes; everything else → npm / PyPI, unchanged. Undo with rgstr_setup_apply off: true.`,
        );
        return text(lines, { origin, changes: useJson(changes), applied: true });
      }),
  );

  // ── routes ──────────────────────────────────────────────────────────────

  const routeSchema = {
    name: z.string().describe('A name your organization claims.'),
    to: z.string().optional().describe('Add a route, e.g. `npm:tsc-rs@^0.7` or `jsr:@scope/pkg@^1`.'),
    rm: z.string().optional().describe('Remove a route by id (prefix ok).'),
  };

  server.registerTool(
    'rgstr_route_plan',
    {
      title: 'Plan a route change',
      description:
        "A name's upstream routes as they are, and — with to / rm — as they would be after the change. Free: reads only, nothing is changed. Show the user; rgstr_route_apply applies it after they confirm. Needs a login.",
      inputSchema: routeSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ name, to, rm }) =>
      run(async () => {
        const c = await client();
        const plan = await planRoutes(c, name, { to, rm });
        if (!plan.changed) return text(plan.current.length ? `${name}: ${plan.current.length} route${plan.current.length === 1 ? '' : 's'}` : `${name}: no routes (default: npm:${name})`, { name, packageId: plan.packageId, routes: plan.current });
        const plan_id = remember({ kind: 'route', plan });
        return text([...renderRoutePlan(plan), '', 'Nothing changed — that is the plan. After the user confirms, call rgstr_route_apply with plan_id.'], {
          plan_id,
          name,
          packageId: plan.packageId,
          routes: plan.current,
          planned: plan.next,
          applied: false,
        });
      }),
  );

  server.registerTool(
    'rgstr_route_apply',
    {
      title: 'Apply the route change',
      description: `Replaces the name's route list with the one rgstr_route_plan showed (one PUT; refuses if the routes changed in the meantime). ${APPLY_RULE('rgstr_route_plan')}`,
      inputSchema: { plan_id: planIdSchema, ...routeSchema, name: routeSchema.name.optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ plan_id, name, to, rm }) =>
      run(async () => {
        const c = await client();
        let plan: RoutePlan;
        if (plan_id) plan = take(plan_id, 'route').plan;
        else {
          if (!name) throw new RgstrCliError('invalid_argument', 'Pass plan_id or name.', 'Call rgstr_route_plan first');
          plan = await planRoutes(c, name, { to, rm });
          if (!plan.changed) return text(`${name}: nothing to change.`, { name, packageId: plan.packageId, routes: plan.current, applied: false });
        }
        const routes = await applyRoutes(c, plan);
        return text(`${plan.name}: routes applied (${routes.length}).`, { name: plan.name, packageId: plan.packageId, routes, applied: true });
      }),
  );

  // ── login ───────────────────────────────────────────────────────────────

  let login: { url: string; code: string; done: Promise<void> } | null = null;
  server.registerTool(
    'rgstr_login',
    {
      title: 'Sign in (device code)',
      description:
        `Starts the device-code login the CLI uses (the same as \`npx @rgstr/cli@latest login\`) and returns the URL and code for the user to approve in a browser. The login completes in the background and is stored for the CLI and this server alike; call the tool you wanted again afterwards. Asks only for registry access.`,
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () =>
      run(async () => {
        if (!login) {
          const baseUrl = await resolveBaseUrl(options);
          assertHostAllowed(baseUrl, options.allowUntrustedHost);
          let prompt: { url: string; code: string } | null = null;
          const done = deviceLogin({
            baseUrl,
            onPrompt: (code) => {
              prompt = { url: code.verification_uri_complete ?? code.verification_uri, code: code.user_code };
            },
          })
            .then(() => undefined)
            .finally(() => {
              login = null;
            });
          done.catch(() => undefined);
          // The prompt arrives before the first poll; wait for it, not for the user.
          while (!prompt) await new Promise((r) => setTimeout(r, 20));
          login = { ...(prompt as { url: string; code: string }), done };
        }
        const { url, code } = login;
        return text(`Ask the user to open ${url} and enter the code ${code}. Once they approve, the login is stored; call the tool you wanted again.`, { url, code });
      }),
  );

  return server;
}
