/**
 * rgstr — the terminal front door for rgstr (https://rgstr.org), the package
 * naming registry. Standalone: claim a name, prove it with the README badge,
 * route it, point your installs through it.
 */

import { Command, Option } from 'commander';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { PLATFORM_OAUTH_CLIENT_ID, deviceLogin } from './auth.js';
import { clearCredentials, loadConfig, saveConfig } from './config.js';
import {
  RgstrApiError,
  RgstrClient,
  RgstrCliError,
  assertHostAllowed,
  resolveAuth,
  resolveBaseUrl,
  toErrorEnvelope,
  type GlobalOptions,
} from './client.js';
import { fmtDownloads, kv, printJson, table } from './output.js';
import type { Ecosystem } from './project.js';
import { chooseTargets, detectPackages, gitCheckout, nextSteps, openBadgePr, planBadge, readmeFor, sameRepo, shortRepo, workspaceGlobs, type GitCheckout, type PackageTarget } from './readme.js';
import { formatRouteRow, parseRouteSpec, type RouteInput, type RouteRecord } from './routes.js';
import { applyUse, planUse, projectStatus, unifiedDiff, type UseChange } from './use.js';
import { confirm, isInteractive } from './prompt.js';
import { badgeMarkdown, buildClaimPlan, describeRepo, fetchRepoUrl, proofKindLabel, renderClaimPlan, repoDirectoryFrom, type ProofSightingLike } from './claim.js';
import { checkRow, checkTableRows, mapLimit, readDependencies, summaryLine, unansweredRow, type CheckRow, type Dependency } from './check.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

const program = new Command();
program
  .name('rgstr')
  .description('rgstr — claim, verify and route package names · https://rgstr.org')
  .version(version)
  .option('--base-url <url>', 'rgstr origin (default https://rgstr.org; RGSTR_URL)')
  .option('--allow-untrusted-host', 'allow a base URL that is not rgstr.org / computesdk.com / localhost')
  .option('--org <slug>', 'organization slug (RGSTR_ORG, or `rgstr org use`)')
  .option('--token <token>', 'organization API key (RGSTR_TOKEN) instead of a login')
  .option('--json', 'machine-readable output');

const globals = (): GlobalOptions => program.opts<GlobalOptions>();

function fail(err: unknown): never {
  const env = toErrorEnvelope(err);
  if (globals().json) printJson(env);
  else console.error(`Error: ${env.error}`);
  process.exit(err instanceof RgstrApiError && err.status === 401 ? 3 : 1);
}

async function client(optional = false): Promise<RgstrClient> {
  return new RgstrClient(await resolveAuth({ ...globals(), optional }));
}

// ── auth ──────────────────────────────────────────────────────────────────

async function loginFlow(): Promise<void> {
      const opts = globals();
      const baseUrl = await resolveBaseUrl(opts);
      assertHostAllowed(baseUrl, opts.allowUntrustedHost);
      const creds = await deviceLogin({
        baseUrl,
        onPrompt: (code, oauthClient) => {
          if (oauthClient.clientId === PLATFORM_OAUTH_CLIENT_ID) {
            console.log(`The registry-only client is not on this server yet; the approval page will ask for the platform scopes (${oauthClient.scope}).`);
          }
          // --json keeps stdout a single document; the prompt still has to reach the user.
          const out = opts.json ? console.error : console.log;
          out('To sign in, visit:');
          out(code.verification_uri_complete ?? code.verification_uri);
          out(`User code: ${code.user_code}`);
        },
      });
      const me = await new RgstrClient({ baseUrl, token: creds.token, kind: 'device', org: null }).get<MeResponse>('/api/v1/me');
      const cfg = await loadConfig();
      const slugs = me.organizations.map((o) => o.slug);
      // A remembered organization from a different account would make every write 403.
      const keep = cfg.org && slugs.includes(cfg.org) ? cfg.org : undefined;
      const next = keep ?? (slugs.length === 1 ? slugs[0] : undefined);
      if (next !== cfg.org) await saveConfig({ ...cfg, org: next });
      const org = opts.org || process.env.RGSTR_ORG || next || null;
      const platformClient = creds.clientId === PLATFORM_OAUTH_CLIENT_ID;
      if (opts.json) printJson({ ok: true, baseUrl, user: me.user, org, organizations: me.organizations, clientId: creds.clientId, scope: creds.scope ?? null });
      else {
        console.log(`Logged in as ${me.user.email} (${baseUrl})`);
        console.log(`Scopes: ${creds.scope ?? '(not reported)'}` + (platformClient ? ' — the platform-wide client; the registry-only client is not on this server yet' : ''));
        if (org) console.log(`Active organization: ${org}`);
        else if (me.organizations.length > 1) {
          console.log('Pick an organization: ' + me.organizations.map((o) => `rgstr org use ${o.slug}`).join(' | '));
        }
      }
}

program
  .command('login')
  .description('sign in with your ComputeSDK account (device code); asks only for registry access')
  .action(async () => {
    try {
      await loginFlow();
    } catch (err) {
      fail(err);
    }
  });

program
  .command('logout')
  .description('forget the stored login')
  .action(async () => {
    await clearCredentials();
    if (globals().json) printJson({ ok: true });
    else console.log('Logged out.');
  });

interface MeResponse {
  user: { id: string; email: string; name?: string | null };
  activeOrganizationId: string | null;
  organizations: Array<{ id: string; name: string; slug: string }>;
}

program
  .command('whoami')
  .description('who you are signed in as, and the active organization')
  .action(async () => {
    try {
      const c = await client();
      const base = { baseUrl: c.baseUrl, auth: c.auth.kind, org: c.auth.org };
      if (c.auth.kind === 'api_key') {
        // An organization key names its organization itself; confirm it works with a cheap authed read.
        const claims = await c.get<{ held: Array<{ name: string }> }>('/api/v1/registry/claims');
        if (globals().json) printJson({ ...base, held: claims.held.length });
        else console.log(kv([['auth', 'organization API key'], ['base', c.baseUrl], ['organization', c.auth.org ?? '(from key)'], ['names claimed', String(claims.held.length)]]));
        return;
      }
      const me = await c.get<MeResponse>('/api/v1/me');
      if (globals().json) printJson({ ...base, user: me.user, organizations: me.organizations });
      else {
        console.log(kv([['user', me.user.email], ['base', c.baseUrl], ['organization', c.auth.org ?? '(none — rgstr org use <slug>)']]));
        if (me.organizations.length) console.log('\norganizations: ' + me.organizations.map((o) => o.slug).join(', '));
      }
    } catch (err) {
      fail(err);
    }
  });

const org = program.command('org').description('active organization');
org
  .command('use <slug>')
  .description('remember the organization to claim and route as')
  .action(async (slug: string) => {
    const cfg = await loadConfig();
    await saveConfig({ ...cfg, org: slug });
    if (globals().json) printJson({ ok: true, org: slug });
    else console.log(`Active organization: ${slug}`);
  });
org
  .command('list')
  .description('organizations you belong to')
  .action(async () => {
    try {
      const c = await client();
      const me = await c.get<MeResponse>('/api/v1/me');
      if (globals().json) printJson(me.organizations);
      else console.log(table(me.organizations.map((o) => [o.slug === c.auth.org ? '*' : ' ', o.slug, o.name])));
    } catch (err) {
      fail(err);
    }
  });

// ── setup / use / status ──────────────────────────────────────────────────

type UseOpts = { npm?: boolean; pip?: boolean; off?: boolean; dryRun?: boolean; yes?: boolean };

const planned = (changes: UseChange[]) => changes.filter((c) => c.action === 'written' || c.action === 'removed');

/** Show the diff, ask (unless --yes / --dry-run), write, say what changed and how to undo it. */
async function useFlow(opts: UseOpts, ctx: { signedIn?: boolean } = {}): Promise<void> {
  const g = globals();
  const origin = await resolveBaseUrl(g);
  assertHostAllowed(origin, g.allowUntrustedHost);
  const changes = await planUse({ dir: process.cwd(), origin, off: opts.off, npm: opts.npm, pip: opts.pip });
  const pending = planned(changes);
  const wantsWrite = !opts.dryRun && pending.length > 0;
  if (g.json) {
    // --json never prompts: it writes with --yes and otherwise reports the plan.
    const applied = wantsWrite && !!opts.yes;
    if (applied) await applyUse(changes);
    printJson({
      origin,
      changes: changes.map(({ path: _path, after: _after, ...c }) => c),
      applied,
      ...(wantsWrite && !applied ? { hint: 'pass --yes to write' } : {}),
    });
    return;
  }
  if (changes.length === 0) {
    console.log('No package.json or pyproject.toml here — pass --npm or --pip to choose.');
    return;
  }
  for (const ch of changes) {
    const who = ch.clients.join(', ');
    if (ch.action === 'unchanged') console.log(`${ch.file}: already set (${who})`);
    else if (ch.action === 'absent') console.log(`${ch.file}: nothing to remove`);
    else if (ch.action === 'manual') console.log(`pip: no virtualenv here (pip reads no project file) — run: ${ch.command}`);
    else {
      console.log(`${ch.file}: ${ch.action === 'removed' ? 'will remove the rgstr block' : 'will write'} (${who})${opts.dryRun ? ' — dry run' : ''}`);
      if (ch.diff) console.log(ch.diff);
    }
  }
  if (!wantsWrite) {
    if (opts.dryRun && pending.length) console.log('\nDry run — nothing written.');
    return;
  }
  if (!opts.yes) {
    if (!isInteractive()) {
      console.log('\nNothing written. Re-run with --yes to apply.');
      process.exitCode = 1;
      return;
    }
    if (!(await confirm(`\n${opts.off ? 'Remove' : 'Write'} the lines above?`))) {
      console.log('Nothing written.');
      return;
    }
  }
  await applyUse(changes);
  console.log('');
  for (const c of pending) console.log(`${c.file}: ${c.action === 'removed' ? 'removed the rgstr block' : 'written'} (${c.clients.join(', ')})`);
  if (opts.off) console.log('Installs go straight to npm / PyPI again.');
  else {
    console.log(`Installs now resolve through ${origin}: names someone claims → that organization's routes; everything else → npm / PyPI, unchanged.`);
    console.log(`Undo with \`rgstr setup --off\` — it removes exactly the lines above and leaves ${pending.map((c) => c.file).join(', ')} as ${pending.length === 1 ? 'it was' : 'they were'}.`);
    if (!ctx.signedIn) console.log('Optional: `rgstr login` to sign in and apply your organization\'s rules; installs work without it.');
  }
}

function withUseOptions(cmd: Command): Command {
  return cmd
    .option('--npm', 'JavaScript clients only')
    .option('--pip', 'Python clients only')
    .option('--off', 'remove exactly what setup wrote to this project')
    .option('--dry-run', 'show the diff without writing')
    .option('-y, --yes', 'write without asking (the diff is still shown)');
}

withUseOptions(
  program
    .command('setup')
    .description('point this project\'s installs at rgstr (.npmrc / pip config): shows the diff, asks, writes, says how to undo it; no sign-in needed'),
).action(async (opts: UseOpts) => {
  try {
    // A stored login only adds the greeting; nobody is asked to sign in to
    // write one .npmrc line. --json callers want the plan, nothing else.
    let signedIn = false;
    if (!opts.off && !opts.dryRun && !globals().json) {
      try {
        const auth = await resolveAuth({ ...globals(), optional: true });
        if (auth.kind !== 'none') {
          const c = new RgstrClient(auth);
          const me = await c.get<MeResponse>('/api/v1/me');
          signedIn = true;
          console.log(`Signed in as ${me.user.email}` + (c.auth.org ? ` · organization ${c.auth.org}` : ''));
          if (!c.auth.org && me.organizations.length > 1) {
            console.log('Pick an organization: ' + me.organizations.map((o) => `rgstr org use ${o.slug}`).join(' | '));
          }
        }
      } catch {
        // Offline or a stale login: setup is local, carry on signed-out.
        signedIn = false;
      }
    }
    await useFlow(opts, { signedIn });
  } catch (err) {
    fail(err);
  }
});

// `rgstr use` is what 0.0.1 shipped; kept as a hidden alias of `setup`.
withUseOptions(program.command('use', { hidden: true })).action(async (opts: UseOpts) => {
  try {
    await useFlow(opts);
  } catch (err) {
    fail(err);
  }
});

program
  .command('status')
  .description('is this project pointed at rgstr — through which files, and as which organization')
  .action(async () => {
    try {
      const g = globals();
      const dir = process.cwd();
      const files = await projectStatus(dir);
      const baseUrl = await resolveBaseUrl(g);
      assertHostAllowed(baseUrl, g.allowUntrustedHost);
      // Past the host check, the only thing left to fail is refreshing a stored
      // login (offline, server down); that must not hide the local answer.
      const auth = await resolveAuth({ ...g, optional: true }).catch(async (err: unknown) => ({
        baseUrl,
        token: null,
        kind: 'stale' as const,
        org: g.org || process.env.RGSTR_ORG || (await loadConfig()).org || null,
        error: err instanceof Error ? err.message : String(err),
      }));
      if (g.json) {
        printJson({ dir, pointed: files.length > 0, files, baseUrl: auth.baseUrl, auth: auth.kind, org: auth.org });
        return;
      }
      const rgstr = files.length
        ? files.map((f) => `${f.file} (${f.clients.join(', ') || '?'}) → ${f.origin}${f.managed ? '' : ' — not written by rgstr setup'}`).join('\n' + ' '.repeat(9))
        : 'off — installs go straight to npm / PyPI (`rgstr setup` to point them at rgstr)';
      const who =
        auth.kind === 'device'
          ? `signed in (device login, ${auth.baseUrl})`
          : auth.kind === 'api_key'
            ? 'organization API key (RGSTR_TOKEN)'
            : auth.kind === 'stale'
              ? `signed in, but the login could not be refreshed (${auth.error}) — try again online or \`rgstr login\``
              : 'not signed in — `rgstr login`';
      console.log(kv([['project', dir], ['rgstr', rgstr], ['organization', auth.org ?? '(none — rgstr org use <slug>)'], ['auth', who]]));
    } catch (err) {
      fail(err);
    }
  });

// ── check ─────────────────────────────────────────────────────────────────

program
  .command('check [names...]')
  .description('what resolving this project\'s dependencies through rgstr does: per name, who claims it and where it is served from')
  .action(async (names: string[]) => {
    try {
      const g = globals();
      const dir = process.cwd();
      const files = await projectStatus(dir);
      if (files.length === 0) {
        throw new RgstrCliError('not_configured', 'This project is not pointed at rgstr (no .npmrc / pip config written for it) — run `npx @rgstr/cli setup` first.');
      }
      const read = await readDependencies(dir);
      // Which ecosystems this project actually sends through rgstr, and to which
      // origin: a `.npmrc` alone says nothing about pip, and npm and pip may be
      // pointed at different hosts. Ask the origin each install really goes to.
      const ecosystemOf = (id: string): Ecosystem => (id === 'pip' || id === 'uv' || id === 'poetry' ? 'pypi' : 'npm');
      const originFor = new Map<Ecosystem, string>();
      for (const f of files) for (const id of f.clients) if (!originFor.has(ecosystemOf(id))) originFor.set(ecosystemOf(id), f.origin);
      const override = g.baseUrl || process.env.RGSTR_URL;
      const origins = [...new Set(override ? [override] : [...originFor.values()])];
      const clients = new Map(await Promise.all(origins.map(async (o) => [o, new RgstrClient(await resolveAuth({ ...g, baseUrl: o, optional: true }))] as const)));
      const clientFor = (d: Dependency) => clients.get(override || originFor.get(d.ecosystem) || origins[0])!;
      const pointed = read.deps.filter((d) => originFor.has(d.ecosystem));
      let notPointed = read.deps.filter((d) => !originFor.has(d.ecosystem));
      let deps: Dependency[];
      if (names.length) {
        const only = new Set(names);
        const known = pointed.filter((d) => only.has(d.name));
        notPointed = notPointed.filter((d) => only.has(d.name));
        const guess: Ecosystem = originFor.size === 1 ? [...originFor.keys()][0] : read.files.length > 0 && !read.files.includes('package.json') ? 'pypi' : 'npm';
        const missing = names
          .filter((n) => !known.some((d) => d.name === n) && !notPointed.some((d) => d.name === n))
          .map((n) => ({ name: n, ecosystem: guess, source: '(argument)', section: 'argument' }));
        deps = [...known, ...missing];
      } else deps = pointed;

      const rows: CheckRow[] = await mapLimit(deps, 8, async (d) => {
        const c = clientFor(d);
        try {
          return checkRow(d, await c.get<WhoisResponse>(`/api/v1/registry/whois/${encodeURIComponent(d.name)}`));
        } catch (err) {
          // A bad name is that name's problem; anything else means the check could not run.
          if (err instanceof RgstrApiError && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 403) return unansweredRow(d, err.message);
          if (err instanceof RgstrApiError) throw err;
          const cause = (err as { cause?: { code?: string; message?: string } }).cause;
          throw new Error(`Could not reach ${c.baseUrl} (${cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err))}) — nothing was checked.`);
        }
      });
      const summary = summaryLine(rows);
      if (g.json) {
        printJson({
          dir,
          origin: origins.length === 1 ? origins[0] : null,
          origins: Object.fromEntries([...originFor].map(([eco, o]) => [eco, override || o])),
          files: files.map((f) => f.file),
          manifests: read.files,
          names: rows,
          skipped: names.length ? [] : read.skipped,
          notPointed,
          held: rows.filter((r) => r.held).length,
          total: rows.length,
          summary,
        });
        return;
      }
      const notes: string[] = [];
      if (!names.length && read.skipped.length) {
        notes.push(`(${read.skipped.length} not checked: ${read.skipped.map((s) => `${s.name} is ${s.spec}`).join(', ')} — not fetched from a registry.)`);
      }
      if (notPointed.length) {
        const py = notPointed[0].ecosystem === 'pypi';
        notes.push(`(${notPointed.length} ${py ? 'PyPI' : 'npm'} name${notPointed.length === 1 ? '' : 's'} not checked: ${py ? 'pip' : 'npm'} installs here do not go through rgstr — \`rgstr setup ${py ? '--pip' : '--npm'}\` to point them at it.)`);
      }
      console.log(
        origins.length === 1
          ? `Installs here resolve through ${origins[0]} (${files.map((f) => f.file).join(', ')}).`
          : `Installs here resolve through ${files.map((f) => `${f.origin} (${f.file})`).join(' and ')}.`,
      );
      if (rows.length === 0) {
        console.log(read.files.length ? `No dependencies to check in ${read.files.join(' / ')}.` : 'No package.json, pyproject.toml or requirements.txt here — pass the names: rgstr check <name…>');
        for (const n of notes) console.log(n);
        return;
      }
      console.log('');
      console.log(table(checkTableRows(rows), ['name', 'trust', 'claimed by', 'served from']));
      console.log('');
      console.log(summary);
      for (const n of notes) console.log(n);
    } catch (err) {
      fail(err);
    }
  });

// ── claim ─────────────────────────────────────────────────────────────────

interface ClaimResponse {
  request: { id: string; name: string; status: string; verification: string };
  dispute: { holder: string; via: string } | null;
  // The badge is the only proof; older servers also sent manifest lines
  // here, which are ignored.
  proof: { token: string; badge?: string | null } | null;
  url: string;
  // Sent by newer servers; rendered when present.
  badgeMarkdown?: string | null;
  agentPrompt?: string | null;
  repoUrl?: string | null;
  proofKinds?: string[] | null;
}
interface ClaimsList {
  pending: Array<{ id: string; name: string; status: string; verification: string; createdAt: string; proof: ClaimResponse['proof'] } & Partial<Pick<ClaimResponse, 'badgeMarkdown' | 'agentPrompt' | 'repoUrl' | 'proofKinds'>>>;
  held: Array<{ id: string; name: string; kind: string; status: string }>;
}
type ProofOutcome =
  | { kind: 'verified'; detail: string; autoApproved: boolean; reviewReason?: string; sighting: ProofSightingLike; repoUrl?: string | null }
  | { kind: 'not_found'; checked: string[]; failed: string[]; repoUrl?: string | null }
  | { kind: 'error'; message: string };

type ClaimOpts = {
  check?: boolean;
  badge?: boolean;
  yes?: boolean;
  pr?: boolean;
  all?: boolean;
  here?: boolean;
  npm?: boolean;
  pip?: boolean;
  statement?: string;
};

/** A package to claim: detected here, or just a name typed on the command line. */
type ClaimTarget = Omit<PackageTarget, 'manifest'> & { manifest: string | null };

/** One package's `--check`. Prints the human lines; returns the JSON shape
 *  so a workspace run can emit a single document. */
async function checkOne(c: Awaited<ReturnType<typeof client>>, g: ReturnType<typeof globals>, t: ClaimTarget): Promise<Record<string, unknown>> {
  const { name } = t;
  const list = await c.get<ClaimsList>('/api/v1/registry/claims');
  const pending = list.pending.find((p) => p.name === name);
  if (!pending) {
    const held = list.held.find((h) => h.name === name);
    const whois = await c.get<WhoisResponse>(`/api/v1/registry/whois/${encodeURIComponent(name)}`);
    if (g.json) return { name, checked: false, held: held ?? null, whois };
    if (held?.status === 'verified') console.log(`${name}: verified — your organization claims it. ${whois.url}`);
    else if (whois.holder) console.log(`${name}: claimed by ${whois.holder.name} (${whois.holder.slug}) — file a claim with \`rgstr claim\` to dispute it.`);
    else console.log(`${name}: no application from your organization yet — run \`rgstr claim ${name}\` first.`);
    return { name, checked: false, held: held ?? null, whois };
  }
  const res = await c.post<{ outcome: ProofOutcome; request: ClaimsList['pending'][number] }>(`/api/v1/registry/claims/${pending.id}/check-proof`);
  const result = { name, ...res, ...(res.outcome.kind === 'verified' ? { proofKind: proofKindLabel({ name, ...res.outcome }) } : {}) };
  if (g.json) return result;
  const o = res.outcome;
  if (o.kind === 'verified') {
    console.log(`${name}: verified via ${proofKindLabel({ name, ...o })} — ${o.detail}`);
    console.log(o.autoApproved ? `Approved: your organization now claims ${name}.` : `Proof verified and attached to your application; ${o.reviewReason ?? 'an rgstr reviewer decides'}.`);
  } else if (o.kind === 'not_found') {
    const repo = o.repoUrl ?? pending.repoUrl ?? null;
    const where = [o.checked.length ? o.checked.join(', ') : 'npm, PyPI', repo ? `the README of ${repo}` : null].filter(Boolean).join(' and ');
    console.log(`${name}: no proof found yet (checked ${where}${t.version ? `; local version ${t.version}` : ''}).`);
    if (o.failed.length) console.log(`Could not reach: ${o.failed.join(', ')}.`);
    console.log(`Add the badge to the repository README and merge it (\`rgstr claim ${name}\` prints it), or ship it in the package README (\`rgstr claim --here\`) and publish, then run \`rgstr claim --check ${name}\` again.`);
  } else console.log(`${name}: check failed — ${o.message}`);
  return result;
}

interface ReadmeOutcome {
  file: string;
  action: 'written' | 'replaced' | 'present' | 'needs_yes' | 'wrong_repo' | 'none';
  line?: string;
  reason?: string;
}

/** Stands in for the proof token until the claim is filed: the preview diff
 *  shows the line, the write uses the real one. */
const PROOF_PLACEHOLDER = 'rgstr_…';

/** One package, planned and shown. Nothing is filed or written from here. */
interface ClaimPreview {
  t: ClaimTarget;
  /** Already verified for this organization: nothing to file, nothing to write. */
  verified: boolean;
  /** An application already under review: nothing to file; its proof is the badge. */
  pending: ClaimResponse | null;
  repoUrl: string | null;
  /** The README the badge goes in, as it is now; `write` when the badge is not in it yet. */
  readme: { file: string; rel: string; exists: boolean; source: string | null; write: boolean } | null;
  outcome: ReadmeOutcome | null;
}

interface ClaimOutcome {
  name: string;
  ecosystem: Ecosystem;
  claim: ClaimResponse | null;
  alreadyPending: boolean;
  repoUrl: string | null;
  plan: ReturnType<typeof buildClaimPlan> | null;
  readme: ReadmeOutcome | null;
}

function claimFromPending(c: RgstrClient, pending: ClaimsList['pending'][number]): ClaimResponse {
  const { proof, badgeMarkdown: badge, agentPrompt, repoUrl, proofKinds, ...request } = pending;
  return { request, dispute: null, proof, url: `${c.baseUrl}/registry/${pending.name}`, badgeMarkdown: badge, agentPrompt, repoUrl, proofKinds };
}

/** The badge links to the public origin the server names; a dev base URL
 *  still gets a badge it can serve. */
function originOf(c: RgstrClient, claim: ClaimResponse | null): string {
  try {
    return claim ? new URL(claim.url).origin : c.baseUrl;
  } catch {
    return c.baseUrl;
  }
}

function planFor(c: RgstrClient, claim: ClaimResponse, t: ClaimTarget, repoUrl: string | null) {
  if (!claim.proof) return null;
  const origin = originOf(c, claim);
  return buildClaimPlan({ name: t.name, ecosystem: t.ecosystem, origin, token: claim.proof.token, repoUrl: claim.repoUrl ?? repoUrl, badge: claim.badgeMarkdown ?? claim.proof.badge, agentPrompt: claim.agentPrompt });
}

function printPlan(g: ReturnType<typeof globals>, plan: NonNullable<ReturnType<typeof planFor>>, claim: ClaimResponse): void {
  if (g.json) return;
  console.log('');
  console.log(renderClaimPlan(plan));
  if (claim.proofKinds?.length) console.log(`\nAccepted proofs: ${claim.proofKinds.join(', ')}.`);
}

/** Show what `rgstr claim` would do for one package: whether a claim gets
 *  filed, and the diff of the README the badge goes in. Reads only — the
 *  organization's applications, public package metadata, local files. */
async function previewOne(
  c: Awaited<ReturnType<typeof client>>,
  g: ReturnType<typeof globals>,
  opts: ClaimOpts,
  t: ClaimTarget,
  list: ClaimsList,
  ctx: { dir: string; checkout: GitCheckout | null; single: boolean; asWho: string },
): Promise<ClaimPreview> {
  const { name, ecosystem } = t;
  const say = (line: string) => {
    if (!g.json) console.log(line);
  };
  say(`Claiming ${name} as ${ctx.asWho}`);
  const held = list.held.find((h) => h.name === name);
  if (held?.status === 'verified') {
    say(`${name}: verified — your organization already claims it. ${c.baseUrl}/registry/${name}`);
    return { t, verified: true, pending: null, repoUrl: null, readme: null, outcome: { file: 'README.md', action: 'none', reason: 'already verified' } };
  }
  const pendingRecord = list.pending.find((p) => p.name === name);
  const pending = pendingRecord ? claimFromPending(c, pendingRecord) : null;
  if (pending) say(`${name}: already under review (${pending.request.id.slice(0, 8)}) — nothing to file.`);
  else say(`Files the claim: ${name} goes under review until the badge is in a README rgstr reads.`);

  const repoUrl = pending?.repoUrl ?? (await fetchRepoUrl(originOf(c, pending), name, ecosystem));
  const plan = pending ? planFor(c, pending, t, repoUrl) : null;
  if (pending && !plan) {
    say('Namespace claims are reviewed on identity + evidence; nothing to publish.');
    return { t, verified: false, pending, repoUrl, readme: null, outcome: null };
  }
  const badge = plan?.badge ?? badgeMarkdown(c.baseUrl, name, PROOF_PLACEHOLDER);
  const preview: ClaimPreview = { t, verified: false, pending, repoUrl, readme: null, outcome: null };

  if (t.manifest === null) {
    // `rgstr claim <name>` with no package here: there is no README of ours
    // to edit, so the badge and the agent prompt are the deliverable.
    if (plan && pending) printPlan(g, plan, pending);
    else say(`No package here: once filed, it prints the badge for the README of ${describeRepo(name, ecosystem, repoUrl)} and a prompt for your coding agent.`);
    preview.outcome = { file: 'README.md', action: 'none', reason: 'no package here' };
    return preview;
  }

  // The README rgstr reads is where the badge goes: the folder the package
  // declares (else the repository root) when this checkout is that
  // repository; the package's own README with --here. Outside a checkout, or
  // when the two cannot be matched, the diff is still shown — writing always
  // takes a yes, so looking costs nothing.
  const declared = repoUrl;
  const here = ctx.checkout?.remote ?? null;
  const root = ctx.checkout?.root ?? t.dir;
  const matched = !!(declared && here && sameRepo(declared, here));
  // No `origin` to compare: the checkout is taken to be the declared
  // repository, so the badge still goes where rgstr reads it.
  const assumed = !!declared && !!ctx.checkout && !here;
  const declaredDir = !opts.here && (matched || assumed) ? repoDirectoryFrom(declared!) : undefined;
  const { file, exists, where } = await readmeFor({ ...t, manifest: t.manifest ?? '' }, root, opts.here ? false : ctx.single, declaredDir);
  const rel = path.relative(ctx.dir, file) || path.basename(file);
  const registry = ecosystem === 'npm' ? 'npm' : 'PyPI';
  const mismatch = !opts.here && declared && here && !matched;
  if (mismatch) {
    say(`\n${registry} says ${shortRepo(declared!)}, this checkout is ${shortRepo(here!)} — rgstr reads the badge off ${shortRepo(declared!)}'s README, so it will not be written here. Run this in a checkout of ${shortRepo(declared!)}, or keep it in this package's README with --here (verifies on the next publish).`);
    if (plan && pending) printPlan(g, plan, pending);
    preview.outcome = { file: rel, action: 'wrong_repo', reason: `declared ${declared}, checkout ${here}` };
    return preview;
  }
  if (!opts.here && declared && !ctx.checkout) {
    say(`\nNot a git checkout, so this folder cannot be matched to ${shortRepo(declared!)}, where rgstr reads the badge (its ${repoDirectoryFrom(declared!) ? `${repoDirectoryFrom(declared!)}/` : 'root '}README). The diff below is for ${rel} here; it counts once that line is in ${shortRepo(declared!)}'s README, or ships in the package README.`);
  } else if (!opts.here && declared && !here) {
    say(`\nNo \`origin\` remote here, so this checkout cannot be matched to ${shortRepo(declared!)}, where rgstr reads the badge. The diff below is for its ${repoDirectoryFrom(declared!) ? `${repoDirectoryFrom(declared!)}/` : 'root '}README, ${rel}; make sure this checkout is that repository before pushing it.`);
  }
  if (!declared) {
    say(`\n(${name} declares no repository on ${registry}${here ? `; this checkout is ${shortRepo(here)}` : ''}. Declare \`repository\` in your next release so rgstr knows where to look, or keep the badge in the package README with --here.)`);
  }

  if (opts.here && declared && repoDirectoryFrom(declared) === null && path.resolve(root) !== path.resolve(t.dir)) {
    say(`\n--here: the badge stays in ${rel}. rgstr reads the repository's root README on GitHub, not this one, so the claim verifies when this README ships in your next ${registry} release (rgstr claim --check ${name} after publishing).`);
  } else if (where === 'root') {
    const manifestRel = path.relative(root, t.manifest ?? t.dir).split(path.sep).join('/');
    const pkgDir = path.relative(root, t.dir).split(path.sep).join('/');
    say(
      `\n${registry} says ${shortRepo(declared!)} with no directory, so rgstr reads the repository's root README — the badge goes in ${rel}, not next to ${manifestRel}. To keep it with the package, declare ${ecosystem === 'npm' ? `"repository": { "url": ..., "directory": "${pkgDir}" }` : `the /tree/HEAD/${pkgDir} URL`} in your next release.`,
    );
  } else if (where === 'declared') {
    say(`\n${registry} says ${shortRepo(declared!)}, so the badge goes in that folder's README (${rel}).`);
  }

  const source = exists ? await fs.readFile(file, 'utf8') : null;
  const bp = planBadge(source, name, badge);
  if (bp.kind === 'present') {
    say(`\n${rel} already has the badge for ${name} (token matches). Commit and push it if you have not, then: rgstr claim --check ${name}`);
    preview.readme = { file, rel, exists, source, write: false };
    preview.outcome = { file: rel, action: 'present', line: bp.old.line };
    return preview;
  }
  say(
    `\n${rel}: ${
      bp.kind === 'replace' ? `has a badge for ${name} with a different token — will replace it` : exists ? 'will add the badge under the first heading' : `no README in ${path.dirname(rel) === '.' ? 'this directory' : path.dirname(rel)} — will create it with the badge`
    }`,
  );
  if (!g.json) console.log(unifiedDiff(rel, source, bp.next));
  if (!pending) say(`(${PROOF_PLACEHOLDER} is the proof token; it is issued when the claim is filed and written in its place.)`);
  preview.readme = { file, rel, exists, source, write: true };
  preview.outcome = { file: rel, action: 'needs_yes', reason: 'pass --yes to write' };
  return preview;
}

/** File the claim and write the badge for one package — only ever after
 *  `--yes` or a yes at the prompt. */
async function applyOne(c: Awaited<ReturnType<typeof client>>, g: ReturnType<typeof globals>, opts: ClaimOpts, p: ClaimPreview): Promise<ClaimOutcome> {
  const { t } = p;
  const { name, ecosystem } = t;
  const say = (line: string) => {
    if (!g.json) console.log(line);
  };
  const out: ClaimOutcome = { name, ecosystem, claim: p.pending, alreadyPending: !!p.pending, repoUrl: p.repoUrl, plan: null, readme: p.outcome };
  if (p.verified) return out;

  let claim = p.pending;
  if (!claim) {
    try {
      claim = await c.post<ClaimResponse>('/api/v1/registry/claims', { name, statement: opts.statement });
    } catch (err) {
      if (!(err instanceof RgstrApiError && err.status === 409)) throw err;
      // Filed in the meantime: carry on with that application's proof so the
      // badge written is the one that verifies.
      const list = await c.get<ClaimsList>('/api/v1/registry/claims');
      const pending = list.pending.find((r) => r.name === name);
      if (!pending) throw err;
      out.alreadyPending = true;
      claim = claimFromPending(c, pending);
    }
    say(out.alreadyPending ? `${name}: already under review (${claim.request.id.slice(0, 8)}).` : `Filed: ${name} (${claim.url})`);
    if (claim.dispute) say(`Claimed by ${claim.dispute.holder} via ${claim.dispute.via} — this is a dispute; a reviewer decides.`);
  }
  out.claim = claim;
  const plan = planFor(c, claim, t, p.repoUrl);
  out.plan = plan;
  out.repoUrl = plan?.repoUrl ?? p.repoUrl;
  if (!plan) {
    if (!p.pending) say('Namespace claims are reviewed on identity + evidence; nothing to publish.');
    return out;
  }
  // No README of ours to write (no package here, or the wrong checkout): the
  // badge and the agent prompt are the deliverable — shown now that the proof
  // token exists; a pending application showed them in the preview.
  if (!p.readme) {
    if (!p.pending) printPlan(g, plan, claim);
    return out;
  }
  if (!p.readme.write) return out;
  const { file, rel, exists, source } = p.readme;
  const bp = planBadge(source, name, plan.badge);
  if (bp.kind === 'present') {
    out.readme = { file: rel, action: 'present', line: bp.old.line };
    return out;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bp.next);
  say(`\n${rel}: ${bp.kind === 'replace' ? 'replaced the badge' : exists ? 'written' : 'created'}`);
  out.readme = { file: rel, action: bp.kind === 'replace' ? 'replaced' : 'written', line: plan.badge };
  return out;
}

/** "file the claim for x as acme and write README.md" — the sentence the
 *  prompt, the --yes hint and the --json hint all use. */
function describeApply(file: string[], write: string[], asWho: string): string {
  const parts: string[] = [];
  if (file.length === 1) parts.push(`file the claim for ${file[0]} as ${asWho}`);
  else if (file.length) parts.push(`file ${file.length} claims (${file.join(', ')}) as ${asWho}`);
  if (write.length === 1) parts.push(`write ${write[0]}`);
  else if (write.length) parts.push(`write ${write.length} READMEs (${write.join(', ')})`);
  return parts.join(' and ');
}

program
  .command('claim [name]')
  .description('claim a name for your organization and put the README badge that proves it under the first heading: shows what it will file and the README diff, asks, then files and writes — --yes skips the question (nothing else is touched)')
  .option('--check', 'look for the proof: the badge in the repo README on GitHub, or in the README of the published package')
  .option('-y, --yes', 'file the claim and write the badge without asking (the plan is still shown)')
  .option('--pr', 'after writing: branch rgstr-badge-<name>, commit, push, open the pull request with gh')
  .option('--all', 'at a workspace root (pnpm/npm/yarn workspaces, uv): claim every member package; without it the root only lists them')
  .option('--here', "keep the badge in this package's own README even when the registry points at the repository root — it then verifies on the next publish (the badge ships in the package README) rather than on merge")
  .addOption(new Option('--badge', 'same as --yes').hideHelp())
  .option('--npm', 'treat the package as npm')
  .option('--pip', 'treat the package as PyPI')
  .option('--statement <text>', 'a sentence for the reviewer (disputes)')
  .action(async (nameArg: string | undefined, opts: ClaimOpts) => {
    try {
      const g = globals();
      const dir = process.cwd();
      const prefer: Ecosystem | undefined = opts.pip ? 'pypi' : opts.npm ? 'npm' : undefined;
      const found = await detectPackages(dir, { prefer, all: opts.all });
      const workspaceRoot = (await workspaceGlobs(dir)).length > 0;
      // --check files nothing and writes nothing, so at a workspace root it
      // covers every member without --all.
      const choice = chooseTargets(found, workspaceRoot, { name: nameArg, all: opts.all || opts.check });
      if (choice.kind === 'workspace') {
        const list = choice.names.join(', ');
        if (g.json) printJson({ workspace: true, packages: choice.names, hint: 'pass --all to claim them all, or a name' });
        else if (choice.names.length === 0) console.log('This is a workspace root with no publishable packages — cd into a package, or pass the name: rgstr claim <name>');
        else console.log(`${choice.names.length} package${choice.names.length === 1 ? '' : 's'} in this workspace: ${list} — re-run with --all to claim them all, or cd into one. Nothing filed, nothing written.`);
        return;
      }
      let targets: ClaimTarget[] = choice.targets;
      if (nameArg && targets.length === 0) targets = [{ name: nameArg, ecosystem: prefer ?? 'npm', dir, manifest: null }];
      if (targets.length === 0) {
        throw new RgstrCliError('invalid_argument', 'No package.json / pyproject.toml / setup.cfg here — pass the name: rgstr claim <name>');
      }
      const c = await client();

      if (opts.check) {
        const checks: Record<string, unknown>[] = [];
        for (const t of targets) checks.push(await checkOne(c, g, t));
        if (g.json) printJson(checks.length === 1 ? checks[0] : { packages: checks });
        return;
      }

      // Plan → confirm → apply. Everything up to the question is a read: the
      // organization's applications, public package metadata, local files.
      const checkout = await gitCheckout(dir);
      const asWho = c.auth.org ?? (c.auth.kind === 'api_key' ? 'the organization your API key belongs to' : 'your organization (pick one with `rgstr org use <slug>`)');
      const list = await c.get<ClaimsList>('/api/v1/registry/claims');
      if (!g.json && targets.length > 1) {
        console.log(`${targets.length} packages in this workspace: ${targets.map((t) => t.name).join(', ')}`);
        console.log('');
      }
      const previews: ClaimPreview[] = [];
      for (const t of targets) {
        if (previews.length && !g.json) console.log('');
        previews.push(await previewOne(c, g, opts, t, list, { dir, checkout, single: targets.length === 1, asWho }));
      }

      const toFile = previews.filter((p) => !p.verified && !p.pending).map((p) => p.t.name);
      const toWrite = previews.filter((p) => p.readme?.write).map((p) => p.readme!.rel);
      const what = describeApply(toFile, toWrite, asWho);
      const previewJson = (p: ClaimPreview) => ({
        name: p.t.name,
        ecosystem: p.t.ecosystem,
        org: c.auth.org,
        filed: false,
        ...(p.pending ?? {}),
        alreadyPending: !!p.pending,
        repoUrl: p.repoUrl,
        badge: p.pending ? planFor(c, p.pending, p.t, p.repoUrl)?.badge ?? null : null,
        agentPrompt: p.pending ? planFor(c, p.pending, p.t, p.repoUrl)?.agentPrompt ?? null : null,
        readme: p.outcome,
      });
      if (!what) {
        // Already under review or verified, badge already in place: nothing to do.
        if (g.json) printJson({ ...(previews.length === 1 ? previewJson(previews[0]) : { packages: previews.map(previewJson) }), pr: null, applied: false });
        return;
      }
      if (!(opts.yes || opts.badge)) {
        const prHint = toWrite.length && !opts.pr ? ' (add --pr to open the pull request too)' : '';
        if (g.json) {
          // --json never asks: it applies with --yes and otherwise reports the plan.
          printJson({ ...(previews.length === 1 ? previewJson(previews[0]) : { packages: previews.map(previewJson) }), pr: null, applied: false, hint: `pass --yes to ${what}` });
          return;
        }
        if (!isInteractive()) {
          console.log(`\nNothing filed, nothing written — that is the plan. Re-run with --yes to ${what}${prHint}.`);
          return;
        }
        if (!(await confirm(`\n${what[0].toUpperCase()}${what.slice(1)}?`))) {
          console.log('Nothing filed, nothing written.');
          return;
        }
        console.log('');
      }

      const results: ClaimOutcome[] = [];
      for (const p of previews) {
        if (results.length && !g.json) console.log('');
        results.push(await applyOne(c, g, opts, p));
      }

      const written = results.filter((r) => r.readme && (r.readme.action === 'written' || r.readme.action === 'replaced'));
      let pr: Awaited<ReturnType<typeof openBadgePr>> | null = null;
      if (written.length && checkout) {
        const files = written.map((r) => path.resolve(dir, r.readme!.file));
        const names = written.map((r) => r.name);
        if (opts.pr && checkout.remote) {
          pr = await openBadgePr(checkout, files, names);
          if (!g.json) {
            if (pr.url) console.log(`\nOpened ${pr.url} (branch ${pr.branch}). Merge it, then: ${names.map((n) => `rgstr claim --check ${n}`).join('; ')}`);
            else {
              console.log(`\nCould not open the pull request: ${pr.reason}. By hand:`);
              for (const step of nextSteps(written.map((r) => r.readme!.file), names)) console.log(`  ${step}`);
            }
          }
        } else if (!g.json) {
          console.log(opts.pr ? '\nNo `origin` remote here, so --pr cannot push or open the pull request. By hand:' : '\nNext:');
          for (const step of nextSteps(written.map((r) => r.readme!.file), names)) console.log(`  ${step}`);
        }
      } else if (written.length && !g.json) {
        console.log('\nNext: get that README into the repository the package declares (or publish it with the package), then:');
        for (const r of written) console.log(`  rgstr claim --check ${r.name}`);
      }

      if (g.json) {
        const toJson = (r: ClaimOutcome) => ({
          name: r.name,
          ecosystem: r.ecosystem,
          org: c.auth.org,
          filed: !!r.claim && !r.alreadyPending,
          ...(r.claim ?? {}),
          alreadyPending: r.alreadyPending,
          repoUrl: r.repoUrl,
          badge: r.plan?.badge ?? null,
          agentPrompt: r.plan?.agentPrompt ?? null,
          readme: r.readme,
        });
        printJson(results.length === 1 ? { ...toJson(results[0]), pr, applied: true } : { packages: results.map(toJson), pr, applied: true });
      }
    } catch (err) {
      fail(err);
    }
  });

// ── whois ─────────────────────────────────────────────────────────────────

interface WhoisResponse {
  name: string;
  url: string;
  trust: 'unclaimed' | 'claimed' | 'verified';
  state: 'unclaimed' | 'pending' | 'held' | 'disputed';
  holder: { name: string; slug: string; url: string; via: string; kind: string; status: string } | null;
  routes: RouteRecord[];
  hiddenCopies: number | null;
}

program
  .command('whois <name>')
  .description('who claims a name, how much to trust it, and where it routes')
  .action(async (name: string) => {
    try {
      const c = await client(true);
      const w = await c.get<WhoisResponse>(`/api/v1/registry/whois/${encodeURIComponent(name)}`);
      if (globals().json) {
        printJson(w);
        return;
      }
      const routes = w.routes.length
        ? w.routes.map((r) => `${r.versionRange} → ${r.upstreamKind}:${r.upstreamName ?? w.name}${r.upstreamKind === 'npm' && r.upstream === 'https://registry.npmjs.org' ? '' : ` (${r.upstream})`}`).join('\n' + ' '.repeat(9))
        : w.holder
          ? `* → npm:${w.name} (default)`
          : 'upstream passthrough (npm, then PyPI)';
      console.log(
        kv([
          ['name', w.name],
          ['trust', w.trust + (w.state === 'disputed' ? ' (disputed — an application is under review)' : w.state === 'pending' ? ' (application pending)' : '')],
          ['claimed by', w.holder ? `${w.holder.name} (${w.holder.slug}) ${w.holder.url}${w.holder.via !== w.name ? ` via ${w.holder.via}` : ''}` : 'nobody'],
          ['routes', routes],
          ['hidden', w.hiddenCopies ? `${w.hiddenCopies} copies hidden under this name` : null],
          ['page', w.url],
        ]),
      );
    } catch (err) {
      fail(err);
    }
  });

// ── route ─────────────────────────────────────────────────────────────────

interface OrgPackage {
  id: string;
  name: string;
  status: string;
}

async function heldPackage(c: RgstrClient, name: string): Promise<OrgPackage> {
  const res = await c.get<{ packages: OrgPackage[] }>('/api/v1/packages');
  const pkg = res.packages.find((p) => p.name === name);
  if (!pkg) throw new RgstrCliError('not_holder', `${c.auth.org ?? 'Your organization'} has not claimed ${name} — see \`rgstr whois ${name}\`.`);
  return pkg;
}

program
  .command('route <name>')
  .description('list, add (--to) or remove (--rm) upstream routes for a name you claim: a change shows the routes as they would be, asks, then applies — --yes skips the question')
  .option('--to <spec>', 'add a route, e.g. npm:tsc-rs@^0.7 or jsr:@scope/pkg@^1')
  .option('--rm <id>', 'remove a route by id (prefix ok)')
  .option('-y, --yes', 'apply without asking (the change is still shown)')
  .action(async (name: string, opts: { to?: string; rm?: string; yes?: boolean }) => {
    try {
      const g = globals();
      const c = await client();
      const pkg = await heldPackage(c, name);
      const path = `/api/v1/packages/${pkg.id}/routes`;
      const current = (await c.get<{ routes: RouteRecord[] }>(path)).routes;
      let routes = current;
      if (opts.to || opts.rm) {
        let keep = current;
        if (opts.rm) {
          const rm = opts.rm;
          const matches = current.filter((r) => r.id === rm || r.id.startsWith(rm));
          if (matches.length === 0) throw new RgstrCliError('not_found', `No route ${rm} on ${name}`);
          if (matches.length > 1) {
            throw new RgstrCliError('invalid_argument', `${rm} matches ${matches.length} routes (${matches.map((r) => r.id.slice(0, 12)).join(', ')}) — give more of the id.`);
          }
          const victim = matches[0];
          keep = current.filter((r) => r.id !== victim.id);
        }
        const added: RouteInput[] = opts.to ? [parseRouteSpec(opts.to, name)] : [];
        const next: RouteInput[] = [...keep.map(({ versionRange, upstreamKind, upstream, upstreamName }) => ({ versionRange, upstreamKind, upstream, upstreamName })), ...added];
        // Plan → confirm → apply: the PUT replaces the whole list, so the
        // list as it would be is the thing to look at.
        if (!opts.yes) {
          if (g.json) {
            // --json never asks: it applies with --yes and otherwise reports the plan.
            printJson({ name, packageId: pkg.id, routes: current, planned: next, applied: false, hint: 'pass --yes to apply' });
            return;
          }
          const target = (r: RouteInput) => `${r.versionRange} → ${r.upstreamKind}:${r.upstreamName ?? name}`;
          console.log(`${name}: routes would become`);
          for (const r of current) console.log(`  ${keep.includes(r) ? ' ' : '-'} ${target(r)}`);
          for (const r of added) console.log(`  + ${target(r)}`);
          if (next.length === 0) console.log(`  (none — installs fall back to npm:${name})`);
          if (!isInteractive()) {
            console.log('\nNothing changed — that is the plan. Re-run with --yes to apply it.');
            return;
          }
          if (!(await confirm(`\nApply these routes to ${name}?`))) {
            console.log('Nothing changed.');
            return;
          }
          console.log('');
        }
        routes = (await c.put<{ routes: RouteRecord[] }>(path, { routes: next })).routes;
      }
      if (g.json) {
        printJson({ name, packageId: pkg.id, routes, ...(opts.to || opts.rm ? { applied: true } : {}) });
        return;
      }
      if (routes.length === 0) console.log(`${name}: no routes (default: npm:${name})`);
      else console.log(table(routes.map((r) => formatRouteRow(r, name)), ['id', 'range', 'target', 'upstream']));
    } catch (err) {
      fail(err);
    }
  });

// ── search ────────────────────────────────────────────────────────────────

interface SearchObject {
  package: { name: string; version?: string; description?: string };
  rgstr: {
    trust: string;
    owner?: { name?: string; slug?: string } | null;
    tier: string;
    demotion?: { kind: 'sibling' | 'namesake' | 'copy'; of: string } | null;
    weeklyDownloads?: number | null;
  };
}

/** Mirrors the website's labels: siblings share the repository, namesakes share the name, copies share the bytes. */
function relation(d: SearchObject['rgstr']['demotion']): string {
  if (!d) return '';
  return `${d.kind} of ${d.of}`;
}

program
  .command('search <query>')
  .description('search names in rgstr\'s order, with trust and weekly downloads')
  .option('--size <n>', 'rows', '10')
  .action(async (query: string, opts: { size: string }) => {
    try {
      const c = await client(true);
      const res = await c.get<{ objects: SearchObject[]; total: number }>(`/api/registry/-/v1/search?text=${encodeURIComponent(query)}&size=${Number(opts.size) || 10}`);
      if (globals().json) {
        printJson(res);
        return;
      }
      if (res.objects.length === 0) {
        console.log(`No results for "${query}".`);
        return;
      }
      console.log(
        table(
          res.objects.map((o) => [
            o.package.name,
            o.package.version ?? '',
            o.rgstr.trust + (o.rgstr.owner?.slug ? ` (${o.rgstr.owner.slug})` : ''),
            fmtDownloads(o.rgstr.weeklyDownloads),
            relation(o.rgstr.demotion),
            (o.package.description ?? '').slice(0, 60),
          ]),
          ['name', 'version', 'trust', 'downloads', 'relation', 'description'],
        ),
      );
      const demoted = res.objects.filter((o) => o.rgstr.demotion).length;
      if (demoted > 0) console.log(`\n${demoted} marked as siblings, namesakes or copies of a bigger package (see relation).`);
    } catch (err) {
      fail(err);
    }
  });

program.parseAsync(process.argv).catch(fail);
