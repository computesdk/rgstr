/**
 * rgstr — the terminal front door for rgstr (https://rgstr.org), the package
 * naming registry. Standalone: claim a name, prove it from your next publish,
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
import { withNpmProof, withPypiProof, type Ecosystem } from './project.js';
import { detectPackages, gitCheckout, nextSteps, openBadgePr, planBadge, readmeFor, sameRepo, shortRepo, type GitCheckout, type PackageTarget } from './readme.js';
import { formatRouteRow, parseRouteSpec, type RouteInput, type RouteRecord } from './routes.js';
import { applyUse, planUse, projectStatus, unifiedDiff, type UseChange } from './use.js';
import { buildClaimPlan, fetchRepoUrl, proofKindLabel, renderClaimPlan, type ProofSightingLike } from './claim.js';
import { confirm, isInteractive } from './prompt.js';

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
  .option('--token <token>', 'org API key (RGSTR_TOKEN) instead of a login')
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
      // A remembered org from a different account would make every write 403.
      const keep = cfg.org && slugs.includes(cfg.org) ? cfg.org : undefined;
      const next = keep ?? (slugs.length === 1 ? slugs[0] : undefined);
      if (next !== cfg.org) await saveConfig({ ...cfg, org: next });
      const org = opts.org || process.env.RGSTR_ORG || next || null;
      const platformClient = creds.clientId === PLATFORM_OAUTH_CLIENT_ID;
      if (opts.json) printJson({ ok: true, baseUrl, user: me.user, org, organizations: me.organizations, clientId: creds.clientId, scope: creds.scope ?? null });
      else {
        console.log(`Logged in as ${me.user.email} (${baseUrl})`);
        console.log(`Scopes: ${creds.scope ?? '(not reported)'}` + (platformClient ? ' — the platform-wide client; the registry-only client is not on this server yet' : ''));
        if (org) console.log(`Active org: ${org}`);
        else if (me.organizations.length > 1) {
          console.log('Pick an org: ' + me.organizations.map((o) => `rgstr org use ${o.slug}`).join(' | '));
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
  .description('who you are signed in as, and the active org')
  .action(async () => {
    try {
      const c = await client();
      const base = { baseUrl: c.baseUrl, auth: c.auth.kind, org: c.auth.org };
      if (c.auth.kind === 'api_key') {
        // An org key names its org itself; confirm it works with a cheap authed read.
        const claims = await c.get<{ held: Array<{ name: string }> }>('/api/v1/registry/claims');
        if (globals().json) printJson({ ...base, held: claims.held.length });
        else console.log(kv([['auth', 'org API key'], ['base', c.baseUrl], ['org', c.auth.org ?? '(from key)'], ['names held', String(claims.held.length)]]));
        return;
      }
      const me = await c.get<MeResponse>('/api/v1/me');
      if (globals().json) printJson({ ...base, user: me.user, organizations: me.organizations });
      else {
        console.log(kv([['user', me.user.email], ['base', c.baseUrl], ['org', c.auth.org ?? '(none — rgstr org use <slug>)']]));
        if (me.organizations.length) console.log('\norgs: ' + me.organizations.map((o) => o.slug).join(', '));
      }
    } catch (err) {
      fail(err);
    }
  });

const org = program.command('org').description('active organization');
org
  .command('use <slug>')
  .description('remember the org to claim and route as')
  .action(async (slug: string) => {
    const cfg = await loadConfig();
    await saveConfig({ ...cfg, org: slug });
    if (globals().json) printJson({ ok: true, org: slug });
    else console.log(`Active org: ${slug}`);
  });
org
  .command('list')
  .description('orgs you belong to')
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

/** Show the diff, ask (unless --yes / --dry-run), write, say what changed. */
async function useFlow(opts: UseOpts): Promise<void> {
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
  console.log(`\n${pending.map((c) => `${c.file}: ${c.action}`).join(', ')}.`);
  if (opts.off) console.log('Installs go straight to npm / PyPI again.');
  else {
    console.log(`Installs now resolve through ${origin}: names someone holds → the holder's routes; everything else → npm / PyPI, unchanged.`);
    console.log('Undo with `rgstr setup --off`.');
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
    .description('point this project\'s installs at rgstr (.npmrc / pip config): shows the diff, asks, writes; signs you in first if needed'),
).action(async (opts: UseOpts) => {
  try {
    // Signing in is only to pick the org for the hint below; --json callers
    // want the plan, not a device-code prompt in the middle of their output.
    if (!opts.off && !opts.dryRun && !globals().json) {
      let signedIn = false;
      try {
        const c = await client();
        const me = await c.get<MeResponse>('/api/v1/me');
        signedIn = true;
        console.log(`Signed in as ${me.user.email}` + (c.auth.org ? ` · org ${c.auth.org}` : ''));
        if (!c.auth.org && me.organizations.length > 1) {
          console.log('Pick an org: ' + me.organizations.map((o) => `rgstr org use ${o.slug}`).join(' | '));
        }
      } catch {
        signedIn = false;
      }
      if (!signedIn) await loginFlow();
    }
    await useFlow(opts);
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
  .description('is this project pointed at rgstr — through which files, and as which org')
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
            ? 'org API key (RGSTR_TOKEN)'
            : auth.kind === 'stale'
              ? `signed in, but the login could not be refreshed (${auth.error}) — try again online or \`rgstr login\``
              : 'not signed in — `rgstr login`';
      console.log(kv([['project', dir], ['rgstr', rgstr], ['org', auth.org ?? '(none — rgstr org use <slug>)'], ['auth', who]]));
    } catch (err) {
      fail(err);
    }
  });

// ── claim ─────────────────────────────────────────────────────────────────

interface ClaimResponse {
  request: { id: string; name: string; status: string; verification: string };
  dispute: { holder: string; via: string } | null;
  proof: { token: string; packageJson: string; pyproject: string; badge: string } | null;
  url: string;
  // Sent by newer servers (the GitHub README-badge proof); rendered when present.
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
  write?: boolean;
  manifest?: boolean;
  badge?: boolean;
  yes?: boolean;
  pr?: boolean;
  all?: boolean;
  npm?: boolean;
  pip?: boolean;
  statement?: string;
};

/** A package to claim: detected here, or just a name typed on the command line. */
type ClaimTarget = Omit<PackageTarget, 'manifest'> & { manifest: string | null };

/** Print the diff, then write. The only way `claim` touches a file. */
async function writeShown(dir: string, file: string, current: string | null, next: string): Promise<string> {
  const rel = path.relative(dir, file) || file;
  console.log(unifiedDiff(rel, current, next));
  await fs.writeFile(file, next);
  return rel;
}

async function checkOne(c: Awaited<ReturnType<typeof client>>, g: ReturnType<typeof globals>, t: ClaimTarget): Promise<void> {
  const { name } = t;
  const list = await c.get<ClaimsList>('/api/v1/registry/claims');
  const pending = list.pending.find((p) => p.name === name);
  if (!pending) {
    const held = list.held.find((h) => h.name === name);
    const whois = await c.get<WhoisResponse>(`/api/v1/registry/whois/${encodeURIComponent(name)}`);
    if (g.json) printJson({ name, checked: false, held: held ?? null, whois });
    else if (held?.status === 'verified') console.log(`${name}: verified — your org holds it. ${whois.url}`);
    else if (whois.holder) console.log(`${name}: held by ${whois.holder.name} (${whois.holder.slug}) — file a claim with \`rgstr claim\` to dispute it.`);
    else console.log(`${name}: no application from your org yet — run \`rgstr claim ${name}\` first.`);
    return;
  }
  const res = await c.post<{ outcome: ProofOutcome; request: ClaimsList['pending'][number] }>(`/api/v1/registry/claims/${pending.id}/check-proof`);
  if (g.json) {
    printJson({ name, ...res, ...(res.outcome.kind === 'verified' ? { proofKind: proofKindLabel(res.outcome) } : {}) });
    return;
  }
  const o = res.outcome;
  if (o.kind === 'verified') {
    console.log(`${name}: verified via ${proofKindLabel(o)} — ${o.detail}`);
    console.log(o.autoApproved ? `Approved: your org now holds ${name}.` : `Proof recorded; ${o.reviewReason ?? 'held by someone else'} → a reviewer decides.`);
  } else if (o.kind === 'not_found') {
    const repo = o.repoUrl ?? pending.repoUrl ?? null;
    const where = [o.checked.length ? o.checked.join(', ') : 'npm, PyPI', repo ? `the README of ${repo}` : null].filter(Boolean).join(' and ');
    console.log(`${name}: no proof found yet (checked ${where}${t.version ? `; local version ${t.version}` : ''}).`);
    if (o.failed.length) console.log(`Could not reach: ${o.failed.join(', ')}.`);
    console.log(`Add the badge to the repository README and merge it (\`rgstr claim ${name}\` prints it), or publish a release carrying the token, then run \`rgstr claim --check ${name}\` again.`);
  } else console.log(`${name}: check failed — ${o.message}`);
}

interface ReadmeOutcome {
  file: string;
  action: 'written' | 'replaced' | 'present' | 'declined' | 'needs_yes' | 'wrong_repo' | 'none';
  line?: string;
  reason?: string;
}

interface ClaimOutcome {
  name: string;
  ecosystem: Ecosystem;
  claim: ClaimResponse;
  alreadyPending: boolean;
  repoUrl: string | null;
  plan: ReturnType<typeof buildClaimPlan> | null;
  wrote: { file: string; line: string } | null;
  readme: ReadmeOutcome | null;
}

/** File the claim for one package and, inside a git checkout, offer to put the
 *  badge in its README. Writes only after a diff and a yes. */
async function claimOne(
  c: Awaited<ReturnType<typeof client>>,
  g: ReturnType<typeof globals>,
  opts: ClaimOpts,
  t: ClaimTarget,
  ctx: { dir: string; checkout: GitCheckout | null; single: boolean },
): Promise<ClaimOutcome> {
  const { name, ecosystem } = t;
  const say = (line: string) => {
    if (!g.json) console.log(line);
  };
  let claim: ClaimResponse;
  let alreadyPending = false;
  try {
    claim = await c.post<ClaimResponse>('/api/v1/registry/claims', { name, statement: opts.statement });
  } catch (err) {
    if (!(err instanceof RgstrApiError && err.status === 409)) throw err;
    // Already applied: carry on with that application's proof so a retry
    // prints the same badge and token.
    const list = await c.get<ClaimsList>('/api/v1/registry/claims');
    const pending = list.pending.find((p) => p.name === name);
    if (!pending) throw err;
    alreadyPending = true;
    const { proof, badgeMarkdown, agentPrompt, repoUrl, proofKinds, ...request } = pending;
    claim = { request, dispute: null, proof, url: `${c.baseUrl}/registry/${name}`, badgeMarkdown, agentPrompt, repoUrl, proofKinds };
  }

  // The badge links to the public origin the server names; a dev base URL
  // still gets a badge it can serve.
  const origin = (() => {
    try {
      return new URL(claim.url).origin;
    } catch {
      return c.baseUrl;
    }
  })();
  const repoUrl = claim.repoUrl ?? (claim.proof ? await fetchRepoUrl(origin, name, ecosystem) : null);
  const plan = claim.proof
    ? buildClaimPlan({ name, ecosystem, origin, token: claim.proof.token, repoUrl, badge: claim.badgeMarkdown ?? claim.proof.badge, agentPrompt: claim.agentPrompt })
    : null;

  say(alreadyPending ? `${name}: already under review for ${c.auth.org ?? 'your org'} (${claim.request.id.slice(0, 8)}).` : `Filed: ${name} for ${c.auth.org ?? 'your org'} (${claim.url})`);
  if (claim.dispute) say(`Held by ${claim.dispute.holder} via ${claim.dispute.via} — this is a dispute; a reviewer decides.`);

  let wrote: { file: string; line: string } | null = null;
  if (plan && claim.proof && (opts.write || opts.manifest)) {
    if (t.manifest && t.ecosystem === ecosystem) {
      const source = await fs.readFile(t.manifest, 'utf8');
      const { next, changed } = ecosystem === 'npm' ? withNpmProof(source, claim.proof.token) : withPypiProof(source, plan.manifest);
      const rel = path.relative(ctx.dir, t.manifest) || path.basename(t.manifest);
      wrote = { file: changed && !g.json ? await writeShown(ctx.dir, t.manifest, source, next) : rel, line: plan.manifest };
      if (changed && g.json) await fs.writeFile(t.manifest, next);
      say(`${wrote.file}: ${wrote.line}`);
      say(`Publish a release that carries it, then: rgstr claim --check ${name}`);
    } else {
      throw new RgstrCliError('invalid_argument', `--write needs the ${ecosystem === 'npm' ? 'package.json' : 'pyproject.toml'} of ${name} in the current directory; without it, \`rgstr claim ${name}\` prints the token to add.`);
    }
  }

  const out: ClaimOutcome = { name, ecosystem, claim, alreadyPending, repoUrl, plan, wrote, readme: null };
  if (!plan) {
    say('Namespace claims are reviewed on identity + evidence; nothing to publish.');
    return out;
  }

  const printPlan = () => {
    if (g.json) return;
    console.log('');
    console.log(renderClaimPlan(plan));
    if (claim.proofKinds?.length) console.log(`\nAccepted proofs: ${claim.proofKinds.join(', ')}.`);
  };

  if (!ctx.checkout) {
    printPlan();
    say('\nNo files were changed.');
    return out;
  }

  // Inside a git checkout: the README is where the badge goes — if this is
  // the repository the package declares.
  const { file, exists } = await readmeFor({ ...t, manifest: t.manifest ?? '' }, ctx.checkout.root, ctx.single);
  const rel = path.relative(ctx.dir, file) || path.basename(file);
  const declared = plan.repoUrl;
  const here = ctx.checkout.remote;
  if (declared && here && !sameRepo(declared, here)) {
    const registry = ecosystem === 'npm' ? 'npm' : 'PyPI';
    say(`\n${registry} says ${shortRepo(declared)}, this checkout is ${shortRepo(here)} — the badge must land in ${shortRepo(declared)}'s README, so nothing was written here.`);
    printPlan();
    out.readme = { file: rel, action: 'wrong_repo', reason: `declared ${declared}, checkout ${here}` };
    return out;
  }
  if (declared && !here) say(`\n(no \`origin\` remote here; ${name} declares ${shortRepo(declared)} — that is where the badge must end up.)`);
  if (!declared) {
    say(`\n(${name} declares no repository on ${ecosystem === 'npm' ? 'npm' : 'PyPI'}${here ? `; this checkout is ${shortRepo(here)}` : ''}. Add \`repository\` to the manifest in your next release so rgstr knows where to look.)`);
  }

  const source = exists ? await fs.readFile(file, 'utf8') : null;
  const bp = planBadge(source, name, plan.badge);
  if (bp.kind === 'present') {
    say(`\n${rel} already has the badge for ${name} (token matches). Commit and push it if you have not, then: rgstr claim --check ${name}`);
    out.readme = { file: rel, action: 'present', line: bp.old.line };
    return out;
  }
  say(
    `\n${rel}: ${
      bp.kind === 'replace' ? `has a badge for ${name} with a different token — will replace it` : exists ? 'will add the badge under the first heading' : 'does not exist — will create it with the badge'
    }`,
  );
  if (!g.json) console.log(unifiedDiff(rel, source, bp.next));
  const auto = !!(opts.yes || opts.badge);
  const go: boolean | null = auto ? true : g.json || !isInteractive() ? null : await confirm(`Write ${rel}?`);
  if (go === null) {
    say(`\nNothing written — re-run with --yes to write it (add --pr to open the pull request too), or add the line yourself:`);
    printPlan();
    out.readme = { file: rel, action: 'needs_yes', reason: 'pass --yes to write' };
    return out;
  }
  if (!go) {
    say('Nothing written.');
    printPlan();
    out.readme = { file: rel, action: 'declined' };
    return out;
  }
  await fs.writeFile(file, bp.next);
  say(`${rel}: ${plan.badge}`);
  out.readme = { file: rel, action: bp.kind === 'replace' ? 'replaced' : 'written', line: plan.badge };
  return out;
}

program
  .command('claim [name]')
  .description('claim a name for your org and put the README badge that proves it under the first heading (shows the diff, asks; writes nothing else)')
  .option('--check', 'look for the proof: the badge in the repo README on GitHub, or the token in a published release')
  .option('-y, --yes', 'write the badge without asking (the diff is still shown)')
  .option('--pr', 'after writing: branch rgstr-badge-<name>, commit, push, open the pull request with gh')
  .option('--all', 'every package in this workspace (pnpm/npm/yarn workspaces, uv), not just the one here')
  .option('--write', 'also write the publish-proof token into package.json / pyproject.toml here (shows the diff first)')
  .addOption(new Option('--manifest', 'same as --write').hideHelp())
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
      let targets: ClaimTarget[];
      if (nameArg) {
        targets = [found.find((t) => t.name === nameArg) ?? { name: nameArg, ecosystem: prefer ?? 'npm', dir, manifest: null }];
      } else if (found.length === 0) {
        throw new RgstrCliError('invalid_argument', 'No package.json / pyproject.toml / setup.cfg here — pass the name: rgstr claim <name>');
      } else {
        targets = found;
      }
      const c = await client();

      if (opts.check) {
        for (const t of targets) await checkOne(c, g, t);
        return;
      }

      const checkout = await gitCheckout(dir);
      if (!g.json && targets.length > 1) {
        console.log(`${targets.length} packages in this workspace: ${targets.map((t) => t.name).join(', ')}`);
        console.log('');
      }
      const results: ClaimOutcome[] = [];
      for (const t of targets) {
        if (results.length && !g.json) console.log('');
        results.push(await claimOne(c, g, opts, t, { dir, checkout, single: targets.length === 1 }));
      }

      const written = results.filter((r) => r.readme && (r.readme.action === 'written' || r.readme.action === 'replaced'));
      let pr: Awaited<ReturnType<typeof openBadgePr>> | null = null;
      if (written.length && checkout) {
        const files = written.map((r) => path.resolve(dir, r.readme!.file));
        const names = written.map((r) => r.name);
        if (opts.pr) {
          pr = await openBadgePr(checkout, files, names);
          if (!g.json) {
            if (pr.url) console.log(`\nOpened ${pr.url} (branch ${pr.branch}). Merge it, then: ${names.map((n) => `rgstr claim --check ${n}`).join('; ')}`);
            else {
              console.log(`\nCould not open the pull request: ${pr.reason}. By hand:`);
              for (const step of nextSteps(written.map((r) => r.readme!.file), names)) console.log(`  ${step}`);
            }
          }
        } else if (!g.json) {
          console.log('\nNext:');
          for (const step of nextSteps(written.map((r) => r.readme!.file), names)) console.log(`  ${step}`);
        }
      }

      if (g.json) {
        const toJson = (r: ClaimOutcome) => ({
          name: r.name,
          ecosystem: r.ecosystem,
          ...r.claim,
          alreadyPending: r.alreadyPending,
          repoUrl: r.repoUrl,
          badge: r.plan?.badge ?? null,
          agentPrompt: r.plan?.agentPrompt ?? null,
          manifest: r.plan?.manifest ?? null,
          wrote: r.wrote,
          readme: r.readme,
        });
        printJson(results.length === 1 ? { ...toJson(results[0]), pr } : { packages: results.map(toJson), pr });
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
  .description('who holds a name, how much to trust it, and where it routes')
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
          ['holder', w.holder ? `${w.holder.name} (${w.holder.slug}) ${w.holder.url}${w.holder.via !== w.name ? ` via ${w.holder.via}` : ''}` : 'nobody'],
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
  if (!pkg) throw new RgstrCliError('not_holder', `${c.auth.org ?? 'Your org'} does not hold ${name} — see \`rgstr whois ${name}\`.`);
  return pkg;
}

program
  .command('route <name>')
  .description('list, add (--to) or remove (--rm) upstream routes for a name you hold')
  .option('--to <spec>', 'add a route, e.g. npm:tsc-rs@^0.7 or jsr:@scope/pkg@^1')
  .option('--rm <id>', 'remove a route by id (prefix ok)')
  .action(async (name: string, opts: { to?: string; rm?: string }) => {
    try {
      const c = await client();
      const pkg = await heldPackage(c, name);
      const path = `/api/v1/packages/${pkg.id}/routes`;
      const current = (await c.get<{ routes: RouteRecord[] }>(path)).routes;
      let routes = current;
      if (opts.to || opts.rm) {
        let next: RouteInput[] = current.map(({ versionRange, upstreamKind, upstream, upstreamName }) => ({ versionRange, upstreamKind, upstream, upstreamName }));
        if (opts.rm) {
          const rm = opts.rm;
          const matches = current.filter((r) => r.id === rm || r.id.startsWith(rm));
          if (matches.length === 0) throw new RgstrCliError('not_found', `No route ${rm} on ${name}`);
          if (matches.length > 1) {
            throw new RgstrCliError('invalid_argument', `${rm} matches ${matches.length} routes (${matches.map((r) => r.id.slice(0, 12)).join(', ')}) — give more of the id.`);
          }
          const victim = matches[0];
          next = next.filter((_, i) => current[i].id !== victim.id);
        }
        if (opts.to) {
          const parsed = parseRouteSpec(opts.to, name);
          next.push(parsed);
        }
        routes = (await c.put<{ routes: RouteRecord[] }>(path, { routes: next })).routes;
      }
      if (globals().json) {
        printJson({ name, packageId: pkg.id, routes });
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
