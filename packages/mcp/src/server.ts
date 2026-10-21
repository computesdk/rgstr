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
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { SearchObject, WhoisResponse } from '../../cli/src/api-types.js';
import { DeviceFlowError, deviceLogin } from '../../cli/src/auth.js';
import { rememberOrganization } from '../../cli/src/login.js';
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
  `Changes state. Call ${plan} first, show the user that plan, and only call this after they have confirmed it; it takes that plan_id and does exactly what the plan said, once. If the files or the login changed since, it answers plan_stale: run ${plan} again and show the new plan. ${CONFIRM_FIRST}`;

export interface ServerOptions extends GlobalOptions {
  /** Directory tools default to when a call names no cwd. */
  cwd?: string;
  /** The device-code flow (tests inject one). */
  loginFlow?: typeof deviceLogin;
}

/** What became of the last rgstr_login, so a later no_credentials can say. */
export interface LoginOutcome {
  state: 'waiting' | 'approved' | 'rejected' | 'expired' | 'failed';
  url?: string;
  code?: string;
  /** The organization the login acts for (approved). */
  organization?: string | null;
  /** Why it failed (rejected / expired / failed). */
  detail?: string;
  /** The registry the login was for; a note about it is only shown for that host. */
  baseUrl: string;
  at: string;
}

type SetupArgs = { cwd?: string; npm?: boolean; pip?: boolean; off?: boolean };

type StoredPlan =
  | { kind: 'claim'; plan: ClaimPlan; opts: ClaimOpts; text: string; asWho: string | null; baseUrl: string; fingerprint: string }
  | { kind: 'route'; plan: RoutePlan; asWho: string | null; baseUrl: string }
  | { kind: 'setup'; changes: UseChange[]; origin: string; off: boolean; args: SetupArgs; fingerprint: string };

const text = (lines: string[] | string, data?: unknown): CallToolResult => {
  const body = Array.isArray(lines) ? lines.join('\n') : lines;
  return {
    content: [{ type: 'text', text: data === undefined ? body : `${body}${body ? '\n\n' : ''}${JSON.stringify(data, null, 2)}` }],
    ...(data !== undefined && data !== null && typeof data === 'object' ? { structuredContent: data as Record<string, unknown> } : {}),
  };
};

/** The same envelope the CLI's --json prints and the API answers with:
 *  error, code, hint, requestId — as an isError result. */
export function errorResult(err: unknown, loginNote?: string): CallToolResult {
  let env: ErrorEnvelope = toErrorEnvelope(err);
  if (err instanceof RgstrCliError && err.code === 'no_credentials') env = { error: 'Not logged in.', code: 'no_credentials', hint: loginNote ? `${LOGIN_HINT} — ${loginNote}` : LOGIN_HINT };
  else if (err instanceof RgstrApiError && err.status === 401) env = { ...env, hint: `${LOGIN_HINT}, then try again` };
  // The envelope first, the readable lines last: the hint is the last line, as in the CLI.
  return { content: [{ type: 'text', text: `${JSON.stringify(env)}\n\n${renderError(env)}` }], isError: true };
}

const collector = () => {
  const lines: string[] = [];
  const say: Say = (line) => lines.push(line);
  return { lines, say };
};

const cwdSchema = z.string().optional().describe('Project directory (absolute). Defaults to the directory the server runs in.');
const planIdSchema = z.string().describe('The plan_id the matching *_plan call returned, after the user has seen that plan and confirmed it. Apply does exactly what that plan said; a plan whose files or target changed since answers plan_stale.');

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
  /** A plan made for one organization and host is applied to that one only. */
  const stale = (plan: string, why: string) => new RgstrCliError('plan_stale', `${why} Nothing applied.`, `Run ${plan} again and show the user the new plan`);
  const sameTarget = (c: RgstrClient, stored: { asWho: string | null; baseUrl: string }, plan: string) => {
    if (c.auth.org !== stored.asWho || c.baseUrl !== stored.baseUrl) {
      throw stale(plan, `The plan was made for ${stored.asWho ?? 'no organization'} at ${stored.baseUrl}; the login now acts for ${c.auth.org ?? 'no organization'} at ${c.baseUrl}.`);
    }
  };
  /** The manifests the plan's names came from and the READMEs it would edit,
   *  byte for byte: a renamed package or an edited README means a new plan. */
  const bytes = (file: string | null | undefined) => (file ? fs.readFile(file, 'utf8').catch(() => null) : Promise.resolve(null));
  const claimFingerprint = async (plan: ClaimPlan) =>
    JSON.stringify(await Promise.all(plan.previews.map(async (p) => [p.t.name, p.t.manifest ?? null, await bytes(p.t.manifest), p.readme?.file ?? null, await bytes(p.readme?.file)])));
  const dirOf = (cwd?: string, manifest?: string) => path.resolve(cwd ?? (manifest ? path.dirname(manifest) : options.cwd ?? process.cwd()));
  const client = async (optional = false) => new RgstrClient(await resolveAuth({ ...options, optional }));
  // What became of the last rgstr_login, for no_credentials to mention.
  let lastLogin: LoginOutcome | null = null;
  const loginNote = async () => {
    if (!lastLogin) return undefined;
    // Resolve the registry first, then read the outcome once: nothing can
    // change it between the read and the text.
    const base = await resolveBaseUrl(options).catch(() => null);
    const o = lastLogin;
    // A login for another registry (RGSTR_URL changed since) says nothing about this one.
    if (!o || o.baseUrl !== base) return undefined;
    if (o.state === 'waiting') return `a login is waiting for approval at ${o.url} (code ${o.code})`;
    if (o.state === 'approved') return `the last login was approved${o.organization ? ` for ${o.organization}` : ''}; if this server still has no credentials, call rgstr_login again`;
    return `the last login was ${o.state}: ${o.detail}; call rgstr_login again`;
  };
  const run = async (fn: () => Promise<CallToolResult>): Promise<CallToolResult> => {
    try {
      return await fn();
    } catch (err) {
      return errorResult(err, await loginNote().catch(() => undefined));
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
    pr: z.boolean().optional().describe('Part of the plan: after writing the badge, branch, commit, push and open the pull request with gh. Shown in the plan; rgstr_claim_apply does it.'),
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
        const prPossible = !!(opts.pr && plan.toWrite.length && plan.checkout?.remote);
        if (opts.pr && plan.toWrite.length && !prPossible) body.push('', 'pr: true, but this is not a git checkout with an `origin` remote, so no pull request can be opened: apply writes the badge and lists the steps to push it by hand.');
        if (plan.what) body.push('', `Nothing filed, nothing written — that is the plan. After the user confirms, call rgstr_claim_apply with plan_id to ${plan.what}${prPossible ? ' and open the badge pull request with gh' : ''}.`);

        const plan_id = plan.what ? remember({ kind: 'claim', plan, opts, text: lines.join('\n'), asWho: c.auth.org, baseUrl: c.baseUrl, fingerprint: await claimFingerprint(plan) }) : null;
        return text(body, {
          plan_id,
          what: plan.what || null,
          toFile: plan.toFile,
          toWrite: plan.toWrite,
          pr: prPossible,
          applied: false,
          packages: plan.previews.map((p) => previewJson(c, p)),
        });
      }),
  );

  server.registerTool(
    'rgstr_claim_apply',
    {
      title: 'File the claim and write the badge',
      description: `Files the claim and writes the proof badge into the README — exactly what rgstr_claim_plan showed, nothing else. ${APPLY_RULE('rgstr_claim_plan')} Takes only the plan_id; the plan's own options (pr: true opens the badge pull request with gh) are what gets applied.`,
      inputSchema: { plan_id: planIdSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ plan_id }) =>
      run(async () => {
        const stored = take(plan_id, 'claim');
        const c = await client();
        sameTarget(c, stored, 'rgstr_claim_plan');
        if ((await claimFingerprint(stored.plan)) !== stored.fingerprint) throw stale('rgstr_claim_plan', 'A README changed since the plan was made.');
        const { plan, opts } = stored;
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
  const planSetup = async (args: SetupArgs) => {
    const origin = await resolveBaseUrl(options);
    assertHostAllowed(origin, options.allowUntrustedHost);
    const changes = await planUse({ dir: dirOf(args.cwd), origin, off: args.off, npm: args.npm, pip: args.pip });
    return { origin, changes, pending: changes.filter((c) => c.action === 'written' || c.action === 'removed') };
  };
  const useJson = (changes: UseChange[]) => changes.map(({ path: _path, after: _after, ...c }) => c);
  // What the plan would write and what the file holds right now: an edit to
  // the file since the plan (even inside the managed block) means a new plan.
  const useFingerprint = async (changes: UseChange[]) =>
    JSON.stringify(await Promise.all(changes.map(async (c) => [c.file, c.action, c.after ?? null, c.path ? await fs.readFile(c.path, 'utf8').catch(() => null) : null])));

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
        const plan_id = pending.length ? remember({ kind: 'setup', changes, origin, off: !!args.off, args, fingerprint: await useFingerprint(changes) }) : null;
        if (pending.length) lines.push('', 'Nothing written — that is the plan. After the user confirms, call rgstr_setup_apply with plan_id.');
        return text(lines, { plan_id, origin, changes: useJson(changes), applied: false });
      }),
  );

  server.registerTool(
    'rgstr_setup_apply',
    {
      title: 'Write the rgstr lines',
      description: `Writes (or removes) the .npmrc / pip.conf lines rgstr_setup_plan showed — exactly those lines, nothing else (a plan made with off: true removes them). ${APPLY_RULE('rgstr_setup_plan')}`,
      inputSchema: { plan_id: planIdSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ plan_id }) =>
      run(async () => {
        const stored = take(plan_id, 'setup');
        // The files may have moved since the plan was shown: plan again and
        // write only if it is still the same plan, byte for byte.
        const now = await planSetup(stored.args);
        if (now.origin !== stored.origin || (await useFingerprint(now.changes)) !== stored.fingerprint) throw stale('rgstr_setup_plan', 'The project changed since the plan was made.');
        const { origin, changes, off } = stored;
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
        const plan_id = remember({ kind: 'route', plan, asWho: c.auth.org, baseUrl: c.baseUrl });
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
      inputSchema: { plan_id: planIdSchema },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ plan_id }) =>
      run(async () => {
        const c = await client();
        const stored = take(plan_id, 'route');
        sameTarget(c, stored, 'rgstr_route_plan');
        const { plan } = stored;
        if (!plan.changed) return text(`${plan.name}: nothing to change.`, { name: plan.name, packageId: plan.packageId, routes: plan.current, applied: false });
        // applyRoutes reads the routes again and refuses when they moved since the plan.
        const routes = await applyRoutes(c, plan);
        return text(`${plan.name}: routes applied (${routes.length}).`, { name: plan.name, packageId: plan.packageId, routes, applied: true });
      }),
  );

  // ── login ───────────────────────────────────────────────────────────────

  let login: { url: string; code: string; done: Promise<void> } | null = null;
  const describeOutcome = (o: LoginOutcome) => {
    switch (o.state) {
      case 'waiting':
        return `Still waiting for approval: ask the user to open ${o.url} and enter the code ${o.code}. Call the tool you wanted once they have.`;
      case 'approved':
        return `Approved${o.organization ? `; acting for ${o.organization}` : ''}. The login is stored: call the tool you wanted.`;
      case 'rejected':
        return `The user rejected the login (${o.detail}). Call rgstr_login again to start a new one.`;
      case 'expired':
        return `The code expired before it was approved (${o.detail}). Call rgstr_login again for a new code.`;
      default:
        return `The login failed: ${o.detail}. Call rgstr_login again, or tell the user: ${LOGIN_HINT}.`;
    }
  };
  server.registerTool(
    'rgstr_login',
    {
      title: 'Sign in (device code)',
      description:
        `Starts the device-code login the CLI uses (the same as \`npx @rgstr/cli@latest login\`) and returns the URL and code for the user to approve in a browser. The login completes in the background and is stored for the CLI and this server alike. Call again to learn how it went — still waiting, approved (and for which organization), rejected, expired or failed — and the next step; a failed or finished login is reported once, then a new call starts a new login. Asks only for registry access.`,
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () =>
      run(async () => {
        if (login) return text(describeOutcome(lastLogin!), { ...lastLogin });
        if (lastLogin && lastLogin.state !== 'waiting') {
          // Report the finished login once; the next call starts over.
          const outcome = lastLogin;
          lastLogin = null;
          return text(describeOutcome(outcome), { ...outcome });
        }
        const baseUrl = await resolveBaseUrl(options);
        assertHostAllowed(baseUrl, options.allowUntrustedHost);
        let promptArrived!: (p: { url: string; code: string }) => void;
        const prompted = new Promise<{ url: string; code: string }>((resolve) => {
          promptArrived = resolve;
        });
        const flow = options.loginFlow ?? deviceLogin;
        const done = flow({
          baseUrl,
          onPrompt: (code) => promptArrived({ url: code.verification_uri_complete ?? code.verification_uri, code: code.user_code }),
        })
          // The same as `rgstr login`: the one organization the user has becomes the active one.
          .then((creds) => rememberOrganization(baseUrl, creds.token, options))
          .then(({ org }) => {
            lastLogin = { state: 'approved', organization: org, baseUrl, at: new Date().toISOString() };
          })
          .catch((err: unknown) => {
            const code = err instanceof DeviceFlowError ? err.code : null;
            const state: LoginOutcome['state'] = code === 'access_denied' ? 'rejected' : code === 'expired_token' ? 'expired' : 'failed';
            const detail = err instanceof RgstrCliError && err.hint ? `${err.message} — ${err.hint}` : err instanceof Error ? err.message : String(err);
            lastLogin = { state, detail, baseUrl, at: new Date().toISOString() };
            throw err;
          })
          .finally(() => {
            login = null;
          });
        done.catch(() => undefined);
        // The prompt arrives before the first poll; wait for it (or for the
        // login to fail before issuing one), not for the user.
        const prompt = await Promise.race([prompted, done.then(() => null, () => null)]);
        if (!prompt) {
          const failed = lastLogin;
          lastLogin = null;
          throw new RgstrCliError('invalid_argument', `The login ended before a code was issued${failed?.detail ? `: ${failed.detail}` : '.'}`, 'Call rgstr_login again');
        }
        login = { ...prompt, done };
        lastLogin = { state: 'waiting', ...prompt, baseUrl, at: new Date().toISOString() };
        return text(`Ask the user to open ${prompt.url} and enter the code ${prompt.code}. Once they approve, the login is stored; call the tool you wanted again (or rgstr_login to see how it went).`, { ...lastLogin });
      }),
  );

  return server;
}
