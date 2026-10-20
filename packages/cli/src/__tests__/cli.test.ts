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
          return json(409, { error: 'You already have a claim for "taken" under review', code: 'claim_pending', message: 'You already have a claim for "taken" under review', hint: 'Poll GET /api/v1/registry/claims/req-0009/check-proof or run `rgstr claim --check taken`', requestId: 'req_test0001' });
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
    expect(lines[lines.length - 1]).toBe('Poll GET /api/v1/registry/claims/req-0009/check-proof or run `rgstr claim --check taken`');
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
