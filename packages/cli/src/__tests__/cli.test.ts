// The built CLI against a local rgstr mock: what each `claim` / `route` path
// sends. The rule under test — nothing is filed or written until --yes (or a
// yes at the prompt; stdin is a pipe here, so every run is non-interactive).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CLI = path.resolve(__dirname, '../../dist/index.js');
const TOKEN = 'rgstr_abcdefghijklmnopqrst';

interface Hit {
  method: string;
  path: string;
  body: unknown;
}

let server: http.Server;
let base: string;
let hits: Hit[] = [];
let pending: Array<Record<string, unknown>> = [];
let declaredRepo: Record<string, string> = {};

beforeAll(async () => {
  await fs.access(CLI).catch(() => {
    throw new Error(`${CLI} is missing — run \`pnpm build\` first (CI builds before it tests)`);
  });
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const url = new URL(req.url!, 'http://localhost');
      const body = raw ? JSON.parse(raw) : null;
      hits.push({ method: req.method!, path: url.pathname, body });
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.method === 'GET' && url.pathname === '/api/v1/registry/claims') return json(200, { pending, held: [] });
      if (req.method === 'POST' && url.pathname === '/api/v1/registry/claims') {
        const name = (body as { name: string }).name;
        if (name === 'taken') {
          return json(409, { error: 'You already have a claim for "taken" under review', code: 'claim_pending', message: 'You already have a claim for "taken" under review', hint: 'Poll POST /api/v1/registry/claims/req-0009/check-proof or run `rgstr claim --check taken`', requestId: 'req_test0001' });
        }
        return json(201, { request: { id: 'req-0001-abcd', name, status: 'pending', verification: 'unverified' }, dispute: null, proof: { token: TOKEN }, url: `${base}/registry/${name}` });
      }
      if (req.method === 'POST' && /^\/api\/v1\/registry\/claims\/[^/]+\/check-proof$/.test(url.pathname)) {
        // The platform's answer when the badge is not there yet: 422 with the outcome in details and the next step in hint.
        return json(422, {
          error: 'No rgstr badge for tsc-rs in the README rgstr reads',
          code: 'proof_not_found',
          message: 'No rgstr badge for tsc-rs in the README rgstr reads',
          hint: 'Put the badge from the plan in the README rgstr reads (https://www.npmjs.com/package/tsc-rs) and check again',
          requestId: 'req_test0002',
          details: { outcome: { kind: 'not_found', checked: ['npm'], failed: [] }, request: pending[0] },
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/registry/-/v1/search') {
        // The shape rgstr.org answers with (owner is the organization's display name; state registered = won an offer).
        return json(200, {
          objects: [
            { package: { name: 'computesdk', version: '1.4.0', description: 'One SDK for every sandbox' }, rgstr: { ecosystem: 'npm', trust: 'claimed', owner: 'ComputeSDK', tier: 'exact', demotion: null, weeklyDownloads: 5765, deprecated: null } },
            { package: { name: 'fastcache', version: '0.0.1', description: 'reserved' }, rgstr: { ecosystem: 'npm', trust: 'unclaimed', state: 'registered', owner: 'Acme Labs', tier: 'exact', demotion: null, weeklyDownloads: 1200, deprecated: null } },
          ],
          total: 2,
        });
      }
      // Offers: the floor is the one read a plan needs; filing is the POST.
      if (req.method === 'GET' && url.pathname.startsWith('/api/v1/registry/offers/floor/')) {
        const name = decodeURIComponent(url.pathname.split('/').pop()!);
        if (name === 'computesdk') return json(409, { error: 'computesdk is claimed', code: 'name_claimed', message: 'computesdk is claimed', hint: 'This name is claimed; offers on claimed names are not open yet. See https://rgstr.org/registry/computesdk', requestId: 'req_test0010' });
        return json(200, { name, floorUsd: 10, weeklyDownloads: 1200, openOffer: name === 'contested' ? { amountUsd: 250, by: 'Other Co', windowClosesAt: '2026-11-20T00:00:00Z' } : null, windowClosesAt: name === 'contested' ? '2026-11-20T00:00:00Z' : null, url: `${base}/registry/${name}` });
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/registry/offers') {
        return json(200, { offers: [{ id: 'off-0001-abcd', name: 'fastcache', amountUsd: 400, why: 'resolve to @acme/fastcache', status: 'open', windowClosesAt: '2026-11-20T00:00:00Z', createdAt: '2026-10-21T00:00:00Z', url: `${base}/registry/fastcache` }, { id: 'off-0002-efgh', name: 'oldname', amountUsd: 10, why: null, status: 'refunded', windowClosesAt: '2026-09-01T00:00:00Z', createdAt: '2026-08-01T00:00:00Z' }] });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/registry/offers') {
        const { name, amountUsd, why } = body as { name: string; amountUsd: number; why: string | null };
        if (name === 'needs-identity') {
          return json(403, { error: 'Verify your organization\'s identity before offering', code: 'offer_identity_required', message: 'Verify your organization\'s identity before offering', hint: `Verify identity (once per organization, $10) at ${base}/manage/acme/identity, then file the offer again`, requestId: 'req_test0011' });
        }
        if (amountUsd < 10) return json(400, { error: 'Below the floor', code: 'offer_below_floor', message: 'Below the floor', hint: 'The floor for this name is $10', requestId: 'req_test0012' });
        return json(201, { offer: { id: 'off-0003-ijkl', name, amountUsd, why, status: 'open', windowClosesAt: '2026-11-20T00:00:00Z', createdAt: '2026-10-21T00:00:00Z' }, url: `${base}/registry/${name}` });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/registry/offers/off-0001-abcd/withdraw') {
        return json(200, { offer: { id: 'off-0001-abcd', name: 'fastcache', amountUsd: 400, why: 'resolve to @acme/fastcache', status: 'withdrawn', windowClosesAt: '2026-11-20T00:00:00Z', createdAt: '2026-10-21T00:00:00Z' } });
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/registry/whois/fastcache') {
        // A registered name: Acme Labs won an offer; no maintainer has claimed it.
        return json(200, { name: 'fastcache', url: `${base}/registry/fastcache`, trust: 'unclaimed', state: 'registered', holder: null, routes: [], hiddenCopies: null, registrant: { name: 'Acme Labs', slug: 'acme', url: `${base}/~acme`, identityVerified: true }, routesTo: '@acme/fastcache', openOffer: null });
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/registry/whois/contested') {
        return json(200, { name: 'contested', url: `${base}/registry/contested`, trust: 'unclaimed', state: 'unclaimed', holder: null, routes: [], hiddenCopies: null, registrant: null, routesTo: null, openOffer: { amountUsd: 400, by: 'Acme Labs', windowClosesAt: '2026-11-20T00:00:00Z' } });
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/registry/whois/nope') {
        return json(404, { error: 'No package named "nope" on npm or PyPI', code: 'name_unknown', message: 'No package named "nope" on npm or PyPI', hint: 'No npm or PyPI package has this name; check the spelling at https://rgstr.org/registry/nope', requestId: 'req_test0003' });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/v1/registry/whois/')) {
        return json(200, { name: decodeURIComponent(url.pathname.split('/').pop()!), url: `${base}/registry/x`, trust: 'unclaimed', state: 'unclaimed', holder: null, routes: [], hiddenCopies: null });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/registry/')) {
        const name = decodeURIComponent(url.pathname.slice('/api/registry/'.length));
        return declaredRepo[name] ? json(200, { repository: { url: declaredRepo[name] } }) : json(404, { error: 'not found' });
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/packages') return json(200, { packages: [{ id: 'pkg-1', name: 'tsc-rs', status: 'verified' }] });
      if (url.pathname === '/api/v1/packages/pkg-1/routes') {
        if (req.method === 'GET') return json(200, { routes: [{ id: 'route-1', versionRange: '*', upstreamKind: 'npm', upstream: 'https://registry.npmjs.org', upstreamName: null, position: 0 }] });
        if (req.method === 'PUT') {
          const routes = (body as { routes: Array<Record<string, unknown>> }).routes.map((r, i) => ({ id: `route-${i + 1}`, upstream: 'https://registry.npmjs.org', position: i, ...r }));
          return json(200, { routes });
        }
      }
      json(404, { error: `unmocked ${req.method} ${url.pathname}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://localhost:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  hits = [];
  pending = [];
  declaredRepo = {};
});

async function pkgDir(readme = '# tsc-rs\n\nHello.\n'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rgstr-cli-'));
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'tsc-rs', version: '1.0.0' }));
  await fs.writeFile(path.join(dir, 'README.md'), readme);
  return dir;
}

async function rgstr(args: string[], cwd: string) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rgstr-home-'));
  const env = { ...process.env, RGSTR_URL: base, RGSTR_TOKEN: 'x', RGSTR_ORG: 'acme', RGSTR_HOME: home };
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd, env });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

const claimPosts = () => hits.filter((h) => h.method === 'POST' && h.path === '/api/v1/registry/claims');
const offerPosts = () => hits.filter((h) => h.method === 'POST' && h.path.startsWith('/api/v1/registry/offers'));
const writes = () => hits.filter((h) => h.method !== 'GET');

describe('rgstr claim files nothing until --yes', () => {
  it('in a package directory without --yes: shows the diff, files no claim, writes no README', async () => {
    const dir = await pkgDir();
    const r = await rgstr(['claim'], dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Claiming tsc-rs as acme');
    expect(r.stdout).toContain('+[![rgstr](');
    expect(r.stdout).toContain('Re-run with --yes to file the claim for tsc-rs as acme and write README.md');
    expect(r.stdout).not.toContain('Filed:');
    expect(claimPosts()).toHaveLength(0);
    expect(writes()).toHaveLength(0);
    expect(await fs.readFile(path.join(dir, 'README.md'), 'utf8')).toBe('# tsc-rs\n\nHello.\n');
  });

  it('with --yes: one POST, the badge written with the real token', async () => {
    const dir = await pkgDir();
    const r = await rgstr(['claim', '--yes'], dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`Filed: tsc-rs (${base}/registry/tsc-rs)`);
    expect(r.stdout).toContain('README.md: written');
    expect(claimPosts()).toHaveLength(1);
    expect(claimPosts()[0].body).toMatchObject({ name: 'tsc-rs' });
    const readme = await fs.readFile(path.join(dir, 'README.md'), 'utf8');
    expect(readme).toContain(`badge.svg?proof=${TOKEN})`);
    expect(readme).not.toContain('rgstr_…');
  });

  it('a bare name outside a package: no POST without --yes, one with it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rgstr-empty-'));
    const preview = await rgstr(['claim', '@computesdk/cli'], dir);
    expect(preview.code).toBe(0);
    expect(preview.stdout).toContain('Re-run with --yes to file the claim for @computesdk/cli as acme');
    expect(claimPosts()).toHaveLength(0);
    const filed = await rgstr(['claim', '--yes', '@computesdk/cli'], dir);
    expect(filed.code).toBe(0);
    expect(filed.stdout).toContain('Filed: @computesdk/cli');
    expect(filed.stdout).toContain('1. Add this badge to the README of');
    expect(filed.stdout).toContain(`npx @rgstr/cli claim --yes --pr @computesdk/cli`);
    expect(claimPosts()).toHaveLength(1);
  });

  it('--json without --yes reports the plan and files nothing; --json --yes files', async () => {
    const dir = await pkgDir();
    const preview = await rgstr(['--json', 'claim'], dir);
    const doc = JSON.parse(preview.stdout);
    expect(doc).toMatchObject({ name: 'tsc-rs', org: 'acme', filed: false, applied: false, readme: { file: 'README.md', action: 'needs_yes' } });
    expect(doc.hint).toContain('pass --yes');
    expect(claimPosts()).toHaveLength(0);
    expect(writes()).toHaveLength(0);
    const applied = JSON.parse((await rgstr(['--json', 'claim', '--yes'], dir)).stdout);
    expect(applied).toMatchObject({ name: 'tsc-rs', filed: true, applied: true, readme: { action: 'written' }, request: { id: 'req-0001-abcd' } });
    expect(applied.badge).toContain(TOKEN);
    expect(claimPosts()).toHaveLength(1);
  });

  it('an application already under review: nothing to file, the real badge in the diff, still no write without --yes', async () => {
    pending = [{ id: 'req-0002-efgh', name: 'tsc-rs', status: 'pending', verification: 'unverified', createdAt: '2026-10-20T00:00:00Z', proof: { token: TOKEN } }];
    const dir = await pkgDir();
    const r = await rgstr(['claim'], dir);
    expect(r.stdout).toContain('tsc-rs: already under review (req-0002)');
    expect(r.stdout).toContain(`+[![rgstr](${base}/registry/tsc-rs/badge.svg?proof=${TOKEN})`);
    expect(r.stdout).toContain('Re-run with --yes to write README.md');
    expect(writes()).toHaveLength(0);
    const yes = await rgstr(['claim', '--yes'], dir);
    expect(yes.stdout).toContain('README.md: written');
    expect(claimPosts()).toHaveLength(0);
  });

  it('--all with packages that share the repository README: every badge ends up in it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rgstr-ws-'));
    await run('git', ['init', '-q'], { cwd: root });
    await run('git', ['remote', 'add', 'origin', 'https://github.com/acme/mono.git'], { cwd: root });
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*'] }));
    await fs.writeFile(path.join(root, 'README.md'), '# mono\n\nTwo packages.\n');
    for (const n of ['one', 'two']) {
      await fs.mkdir(path.join(root, 'packages', n), { recursive: true });
      await fs.writeFile(path.join(root, 'packages', n, 'package.json'), JSON.stringify({ name: n, version: '1.0.0' }));
      declaredRepo[n] = 'git+https://github.com/acme/mono.git';
    }
    const preview = await rgstr(['claim', '--all'], root);
    expect(preview.code).toBe(0);
    expect(claimPosts()).toHaveLength(0);
    expect(await fs.readFile(path.join(root, 'README.md'), 'utf8')).toBe('# mono\n\nTwo packages.\n');
    const r = await rgstr(['claim', '--all', '--yes'], root);
    expect(r.code).toBe(0);
    expect(claimPosts().map((h) => (h.body as { name: string }).name)).toEqual(['one', 'two']);
    const readme = await fs.readFile(path.join(root, 'README.md'), 'utf8');
    expect(readme).toContain('/registry/one/badge.svg?proof=');
    expect(readme).toContain('/registry/two/badge.svg?proof=');
    expect(readme).toContain('Two packages.');
  });

  it('a namespace (@scope) has no badge: the plan promises no README write', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rgstr-empty-'));
    const preview = await rgstr(['claim', '@acme'], dir);
    expect(preview.code).toBe(0);
    expect(preview.stdout).toContain('Files the claim: @acme is a namespace — reviewed on identity + evidence, there is no badge to publish.');
    expect(preview.stdout).toContain('Re-run with --yes to file the claim for @acme as acme.');
    expect(preview.stdout).not.toContain('badge.svg');
    expect(preview.stdout).not.toContain('will add');
    const doc = JSON.parse((await rgstr(['--json', 'claim', '@acme'], dir)).stdout);
    expect(doc).toMatchObject({ name: '@acme', applied: false, readme: { action: 'none', reason: 'namespace claim' } });
    expect(claimPosts()).toHaveLength(0);
  });

  it('a README that cannot be read stops the run; nothing is overwritten', async () => {
    if (process.getuid?.() === 0) return;
    const dir = await pkgDir();
    await fs.chmod(path.join(dir, 'README.md'), 0o200);
    try {
      const r = await rgstr(['claim', '--yes'], dir);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain('EACCES');
      await fs.chmod(path.join(dir, 'README.md'), 0o600);
      expect(await fs.readFile(path.join(dir, 'README.md'), 'utf8')).toBe('# tsc-rs\n\nHello.\n');
    } finally {
      await fs.chmod(path.join(dir, 'README.md'), 0o600);
    }
  });

  it('--check never POSTs a claim', async () => {
    const dir = await pkgDir();
    await rgstr(['claim', '--check'], dir);
    expect(claimPosts()).toHaveLength(0);
    pending = [{ id: 'req-0002-efgh', name: 'tsc-rs', status: 'pending', verification: 'unverified', createdAt: '2026-10-20T00:00:00Z', proof: { token: TOKEN } }];
    const r = await rgstr(['claim', '--check'], dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('tsc-rs: no proof found yet');
    // The 422's hint is the last line: the next step, as the API said it.
    expect(r.stdout.trim().split('\n').pop()).toBe('Put the badge from the plan in the README rgstr reads (https://www.npmjs.com/package/tsc-rs) and check again');
    expect(claimPosts()).toHaveLength(0);
    expect(writes().map((h) => h.path)).toEqual(['/api/v1/registry/claims/req-0002-efgh/check-proof']);
    const j = await rgstr(['--json', 'claim', '--check'], dir);
    expect(j.code).toBe(0);
    expect(JSON.parse(j.stdout).outcome.kind).toBe('not_found');
  });
});

describe('API errors print code + hint', () => {
  it('the hint is the last line a person sees', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rgstr-empty-'));
    const r = await rgstr(['claim', 'taken', '--yes'], dir);
    expect(r.code).toBe(1);
    const lines = r.stderr.trim().split('\n');
    expect(lines[0]).toBe('Error: You already have a claim for "taken" under review');
    expect(lines[lines.length - 1]).toBe('Poll POST /api/v1/registry/claims/req-0009/check-proof or run `rgstr claim --check taken`');
    const s = await rgstr(['search', 'computesdk'], dir);
    expect(s.stdout).toContain('claimed (ComputeSDK)');
    expect(s.stdout).toContain('registered (Acme Labs)');
    const w = await rgstr(['whois', 'nope'], dir);
    expect(w.code).toBe(1);
    expect(w.stderr.trim().split('\n').pop()).toBe('No npm or PyPI package has this name; check the spelling at https://rgstr.org/registry/nope');
  });

  it('--json carries code, hint, requestId and status', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rgstr-empty-'));
    const r = await rgstr(['--json', 'whois', 'nope'], dir);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({
      error: 'No package named "nope" on npm or PyPI',
      status: 404,
      code: 'name_unknown',
      hint: 'No npm or PyPI package has this name; check the spelling at https://rgstr.org/registry/nope',
      requestId: 'req_test0003',
    });
  });
});

describe('rgstr route changes nothing until --yes', () => {
  it('--to without --yes shows the routes as they would be and does not PUT', async () => {
    const dir = await pkgDir();
    const r = await rgstr(['route', 'tsc-rs', '--to', 'npm:tsc-rs-real@^0.7'], dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('tsc-rs: routes would become');
    expect(r.stdout).toContain('+ ^0.7 → npm:tsc-rs-real');
    expect(r.stdout).toContain('Re-run with --yes to apply it.');
    expect(writes()).toHaveLength(0);
    const json = JSON.parse((await rgstr(['--json', 'route', 'tsc-rs', '--rm', 'route-1'], dir)).stdout);
    expect(json).toMatchObject({ name: 'tsc-rs', applied: false, planned: [] });
    expect(writes()).toHaveLength(0);
  });

  it('--yes PUTs once; listing never writes', async () => {
    const dir = await pkgDir();
    await rgstr(['route', 'tsc-rs'], dir);
    expect(writes()).toHaveLength(0);
    const r = await rgstr(['route', 'tsc-rs', '--yes', '--to', 'npm:tsc-rs-real@^0.7'], dir);
    expect(r.code).toBe(0);
    const puts = writes();
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ method: 'PUT', path: '/api/v1/packages/pkg-1/routes' });
    expect((puts[0].body as { routes: unknown[] }).routes).toHaveLength(2);
    expect(r.stdout).toContain('npm:tsc-rs-real');
  });
});

describe('rgstr offer files nothing until --yes', () => {
  const RULE = 'The maintainer can claim this name for free at any time during the 30-day window, and that beats your offer; you are refunded in full if they do.';

  it('without --yes: shows the floor, the amount, the why and the rule; one read, no POST', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rgstr-empty-'));
    const r = await rgstr(['offer', 'fastcache', '--amount', '400', '--why', 'resolve to @acme/fastcache'], dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Offering $400 for fastcache as acme');
    expect(r.stdout).toContain('floor   $10 (1.2k/wk on the busiest index)');
    expect(r.stdout).toContain('amount  $400');
    expect(r.stdout).toContain('why     resolve to @acme/fastcache');
    expect(r.stdout).toContain(RULE);
    expect(r.stdout).toContain('Re-run with --yes to file the offer for fastcache as acme.');
    expect(r.stdout).not.toContain('Filed:');
    expect(hits.map((h) => `${h.method} ${h.path}`)).toEqual(['GET /api/v1/registry/offers/floor/fastcache']);
    expect(offerPosts()).toHaveLength(0);
  });

  it('with --yes: one POST with name, amount and why; the filed line and the window', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rgstr-empty-'));
    const r = await rgstr(['offer', 'fastcache', '--amount', '400', '--why', 'resolve to @acme/fastcache', '--yes'], dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(RULE);
    expect(r.stdout).toContain(`Filed: offer $400 for fastcache (${base}/registry/fastcache)`);
    expect(r.stdout).toContain('Window closes Nov 20, 2026.');
    expect(offerPosts()).toEqual([{ method: 'POST', path: '/api/v1/registry/offers', body: { name: 'fastcache', amountUsd: 400, why: 'resolve to @acme/fastcache' } }]);
  });

  it('--amount defaults to the floor; an open offer on the name is shown', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rgstr-empty-'));
    const r = await rgstr(['offer', 'contested'], dir);
    expect(r.stdout).toContain('amount      $10 (the floor; --amount to offer more)');
    expect(r.stdout).toContain('open offer  $250 by Other Co, window closes Nov 20, 2026');
    expect(r.stdout).toContain('window closes on Nov 20, 2026');
    expect(offerPosts()).toHaveLength(0);
  });

  it('--json without --yes reports the plan and files nothing; --json --yes files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rgstr-empty-'));
    const plan = JSON.parse((await rgstr(['--json', 'offer', 'fastcache', '--amount', '400'], dir)).stdout);
    expect(plan).toMatchObject({ name: 'fastcache', org: 'acme', amountUsd: 400, why: null, filed: false, applied: false, floor: { floorUsd: 10 }, rule: RULE });
    expect(plan.hint).toContain('pass --yes');
    expect(offerPosts()).toHaveLength(0);
    const filed = JSON.parse((await rgstr(['--json', 'offer', 'fastcache', '--amount', '400', '--yes'], dir)).stdout);
    expect(filed).toMatchObject({ name: 'fastcache', filed: true, applied: true, offer: { id: 'off-0003-ijkl', status: 'open' } });
    expect(offerPosts()).toHaveLength(1);
  });

  it('below the floor: refused before any POST, the floor in the hint', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rgstr-empty-'));
    const r = await rgstr(['offer', 'fastcache', '--amount', '5', '--yes'], dir);
    expect(r.code).toBe(1);
    const lines = r.stderr.trim().split('\n');
    expect(lines[0]).toBe('Error: $5 is below the floor for fastcache ($10).');
    expect(lines[lines.length - 1]).toBe('Re-run with --amount 10 or more');
    expect(offerPosts()).toHaveLength(0);
  });

  it('a claimed name: the API\'s name_claimed hint is the last line, nothing filed', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rgstr-empty-'));
    const r = await rgstr(['offer', 'computesdk', '--yes'], dir);
    expect(r.code).toBe(1);
    expect(r.stderr.trim().split('\n').pop()).toBe('This name is claimed; offers on claimed names are not open yet. See https://rgstr.org/registry/computesdk');
    expect(offerPosts()).toHaveLength(0);
  });

  it('offer_identity_required after filing: the identity URL is the last line', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rgstr-empty-'));
    const r = await rgstr(['offer', 'needs-identity', '--amount', '40', '--yes'], dir);
    expect(r.code).toBe(1);
    const lines = r.stderr.trim().split('\n');
    expect(lines[0]).toBe("Error: Verify your organization's identity before offering");
    expect(lines[lines.length - 1]).toBe(`Verify identity (once per organization, $10) at ${base}/manage/acme/identity, then file the offer again`);
    const j = await rgstr(['--json', 'offer', 'needs-identity', '--amount', '40', '--yes'], dir);
    expect(JSON.parse(j.stdout)).toMatchObject({ code: 'offer_identity_required', status: 403, requestId: 'req_test0011' });
  });

  it('offers lists mine: name, amount, state, window closes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rgstr-empty-'));
    const r = await rgstr(['offers'], dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('name       amount  state                                       window closes');
    expect(r.stdout).toContain('fastcache  $400    open                                        Nov 20, 2026');
    expect(r.stdout).toContain('oldname    $10     refunded — the maintainer claimed the name  —');
    expect(writes()).toHaveLength(0);
    expect(JSON.parse((await rgstr(['--json', 'offers'], dir)).stdout).offers).toHaveLength(2);
  });

  it('--withdraw: shows the offer, POSTs the withdrawal only with --yes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rgstr-empty-'));
    const plan = await rgstr(['offer', '--withdraw', 'fastcache'], dir);
    expect(plan.code).toBe(0);
    expect(plan.stdout).toContain('Withdraw the $400 offer on fastcache (open, window closes Nov 20, 2026)');
    expect(plan.stdout).toContain('Re-run with --yes to withdraw it.');
    expect(writes()).toHaveLength(0);
    const r = await rgstr(['offer', '--withdraw', 'fastcache', '--yes'], dir);
    expect(r.stdout).toContain('Withdrawn: the $400 offer on fastcache.');
    expect(writes()).toEqual([{ method: 'POST', path: '/api/v1/registry/offers/off-0001-abcd/withdraw', body: {} }]);
    const none = await rgstr(['offer', '--withdraw', 'oldname', '--yes'], dir);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('acme has no open offer on oldname.');
  });
});

describe('registered is a state the CLI prints', () => {
  it('whois: registered by, identity verified, routes to, no maintainer has claimed it; the free claim', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rgstr-empty-'));
    const r = await rgstr(['whois', 'fastcache'], dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('trust       registered by Acme Labs · identity verified · routes to @acme/fastcache · no maintainer has claimed this name');
    expect(r.stdout).toContain('claimed by  nobody — maintain this package? `rgstr claim fastcache`, free; a claim beats the registration');
    expect(r.stdout).toContain("routes      * → npm:@acme/fastcache (registrant's route)");
    expect(JSON.parse((await rgstr(['--json', 'whois', 'fastcache'], dir)).stdout)).toMatchObject({ state: 'registered', registrant: { name: 'Acme Labs' }, routesTo: '@acme/fastcache' });
  });

  it('whois: an open offer on an unclaimed name, and the free claim that beats it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rgstr-empty-'));
    const r = await rgstr(['whois', 'contested'], dir);
    expect(r.stdout).toContain('trust       unclaimed');
    expect(r.stdout).toContain('offer       $400 by Acme Labs, window closes Nov 20, 2026 — maintain this package? `rgstr claim contested`, free');
  });

  it('check: one line per dependency, registered (registrant → route), and the summary counts it apart from claimed', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rgstr-check-'));
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'app', dependencies: { fastcache: '^1', react: '^19' } }));
    await fs.writeFile(path.join(dir, '.npmrc'), `registry=${base}/api/registry\n`);
    const r = await rgstr(['check'], dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("fastcache  registered (Acme Labs → @acme/fastcache)  —           npm:@acme/fastcache (registrant's route)");
    expect(r.stdout).toContain('0 of 2 names are claimed on rgstr and 1 registered; the rest fall through to npm unchanged.');
    const j = JSON.parse((await rgstr(['--json', 'check'], dir)).stdout);
    expect(j).toMatchObject({ held: 0, registered: 1, total: 2 });
    expect(j.names[0]).toMatchObject({ name: 'fastcache', registered: true, registrant: 'Acme Labs', routesTo: '@acme/fastcache', held: false });
  });
});
