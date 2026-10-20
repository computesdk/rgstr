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
        return json(201, { request: { id: 'req-0001-abcd', name, status: 'pending', verification: 'unverified' }, dispute: null, proof: { token: TOKEN }, url: `${base}/registry/${name}` });
      }
      if (req.method === 'POST' && /^\/api\/v1\/registry\/claims\/[^/]+\/check-proof$/.test(url.pathname)) {
        return json(200, { outcome: { kind: 'not_found', checked: ['npm'], failed: [] }, request: pending[0] });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/v1/registry/whois/')) {
        return json(200, { name: decodeURIComponent(url.pathname.split('/').pop()!), url: `${base}/registry/x`, trust: 'unclaimed', state: 'unclaimed', holder: null, routes: [], hiddenCopies: null });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/registry/')) return json(404, { error: 'not found' });
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

  it('--check never POSTs a claim', async () => {
    const dir = await pkgDir();
    await rgstr(['claim', '--check'], dir);
    expect(claimPosts()).toHaveLength(0);
    pending = [{ id: 'req-0002-efgh', name: 'tsc-rs', status: 'pending', verification: 'unverified', createdAt: '2026-10-20T00:00:00Z', proof: { token: TOKEN } }];
    const r = await rgstr(['claim', '--check'], dir);
    expect(r.stdout).toContain('tsc-rs: no proof found yet');
    expect(claimPosts()).toHaveLength(0);
    expect(writes().map((h) => h.path)).toEqual(['/api/v1/registry/claims/req-0002-efgh/check-proof']);
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
