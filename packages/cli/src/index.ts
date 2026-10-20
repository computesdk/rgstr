/**
 * rgstr — the terminal front door for rgstr (https://rgstr.org), the package
 * naming registry. Standalone: claim a name, prove it with the README badge,
 * route it, point your installs through it.
 */

import { Command, Option } from 'commander';
import { createRequire } from 'node:module';
import { PLATFORM_OAUTH_CLIENT_ID, deviceLogin } from './auth.js';
import { clearCredentials, loadConfig, saveConfig } from './config.js';
import {
  RgstrApiError,
  RgstrClient,
  assertHostAllowed,
  resolveAuth,
  resolveBaseUrl,
  renderError,
  toErrorEnvelope,
  type GlobalOptions,
} from './client.js';
import { fmtDownloads, kv, printJson, table } from './output.js';
import { formatRouteRow } from './routes.js';
import { applyUse, planUse, projectStatus, type UseChange } from './use.js';
import { confirm, isInteractive } from './prompt.js';
import { checkProject } from './check-flow.js';
import { applyClaims, checkOne, outcomeJson, planClaims, previewJson, resolveClaimTargets, silent, type ClaimOpts, type ClaimOutcome, type Say } from './claim-flow.js';
import { applyRoutes, planRoutes, renderRoutePlan } from './route-flow.js';
import type { SearchObject, WhoisResponse } from './api-types.js';

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
  else console.error(renderError(env));
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
      const { result, text } = await checkProject(g, process.cwd(), names);
      if (g.json) printJson(result);
      else console.log(text);
    } catch (err) {
      fail(err);
    }
  });

// ── claim ─────────────────────────────────────────────────────────────────

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
      const say: Say = g.json ? silent : (line) => console.log(line);
      const choice = await resolveClaimTargets(dir, nameArg, opts);
      if (choice.kind === 'workspace') {
        const list = choice.names.join(', ');
        if (g.json) printJson({ workspace: true, packages: choice.names, hint: 'pass --all to claim them all, or a name' });
        else if (choice.names.length === 0) console.log('This is a workspace root with no publishable packages — cd into a package, or pass the name: rgstr claim <name>');
        else console.log(`${choice.names.length} package${choice.names.length === 1 ? '' : 's'} in this workspace: ${list} — re-run with --all to claim them all, or cd into one. Nothing filed, nothing written.`);
        return;
      }
      const { targets } = choice;
      const c = await client();

      if (opts.check) {
        const checks: Record<string, unknown>[] = [];
        for (const t of targets) checks.push(await checkOne(c, say, t));
        if (g.json) printJson(checks.length === 1 ? checks[0] : { packages: checks });
        return;
      }

      // Plan → confirm → apply. Everything up to the question is a read: the
      // organization's applications, public package metadata, local files.
      const plan = await planClaims(c, say, opts, { dir, targets });
      const { previews, toWrite, what } = plan;
      const planned = () => (previews.length === 1 ? previewJson(c, previews[0]) : { packages: previews.map((p) => previewJson(c, p)) });
      if (!what) {
        // Already under review or verified, badge already in place: nothing to do.
        if (g.json) printJson({ ...planned(), pr: null, applied: false });
        return;
      }
      if (!(opts.yes || opts.badge)) {
        const prHint = toWrite.length && !opts.pr ? ' (add --pr to open the pull request too)' : '';
        if (g.json) {
          // --json never asks: it applies with --yes and otherwise reports the plan.
          printJson({ ...planned(), pr: null, applied: false, hint: `pass --yes to ${what}` });
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

      const { results, pr } = await applyClaims(c, say, opts, plan);
      if (g.json) {
        const toJson = (r: ClaimOutcome) => outcomeJson(c, r);
        printJson(results.length === 1 ? { ...toJson(results[0]), pr, applied: true } : { packages: results.map(toJson), pr, applied: true });
      }
    } catch (err) {
      fail(err);
    }
  });

// ── whois ─────────────────────────────────────────────────────────────────

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
      const plan = await planRoutes(c, name, opts);
      let routes = plan.current;
      if (plan.changed) {
        // Plan → confirm → apply: the PUT replaces the whole list, so the
        // list as it would be is the thing to look at.
        if (!opts.yes) {
          if (g.json) {
            // --json never asks: it applies with --yes and otherwise reports the plan.
            printJson({ name, packageId: plan.packageId, routes: plan.current, planned: plan.next, applied: false, hint: 'pass --yes to apply' });
            return;
          }
          for (const line of renderRoutePlan(plan)) console.log(line);
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
        routes = await applyRoutes(c, plan);
      }
      if (g.json) {
        printJson({ name, packageId: plan.packageId, routes, ...(plan.changed ? { applied: true } : {}) });
        return;
      }
      if (routes.length === 0) console.log(`${name}: no routes (default: npm:${name})`);
      else console.log(table(routes.map((r) => formatRouteRow(r, name)), ['id', 'range', 'target', 'upstream']));
    } catch (err) {
      fail(err);
    }
  });

// ── search ────────────────────────────────────────────────────────────────

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
