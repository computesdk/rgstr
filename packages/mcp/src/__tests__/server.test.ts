// The MCP server runs the CLI's flows: the same assertions as the CLI's
// cli.test.ts — plan tools file nothing and write nothing, apply tools post
// exactly the planned requests — against a mocked fetch.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, INSTRUCTIONS, LOGIN_HINT } from '../server.js';

const BASE = 'http://localhost:4100';
const TOKEN = 'rgstr_abcdefghijklmnopqrst';
type Hit = { method: string; path: string; body: unknown };
let hits: Hit[] = [];
let pending: Array<Record<string, unknown>> = [];

const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const method = init?.method ?? 'GET';
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  hits.push({ method, path: url.pathname + (url.search || ''), body });
  const p = url.pathname;
  if (method === 'GET' && p === '/api/v1/registry/whois/nope') {
    return json(404, { error: 'No package named "nope" on npm or PyPI', code: 'name_unknown', message: 'x', hint: 'No npm or PyPI package has this name; check the spelling at https://rgstr.org/registry/nope', requestId: 'req_t1' });
  }
  if (method === 'GET' && p.startsWith('/api/v1/registry/whois/')) {
    return json(200, { name: decodeURIComponent(p.split('/').pop()!), url: `${BASE}/registry/x`, trust: 'unclaimed', state: 'unclaimed', holder: null, routes: [], hiddenCopies: null });
  }
  if (method === 'GET' && p === '/api/v1/me') return json(200, { user: { id: 'u', email: 'a@b.c' }, activeOrganizationId: 'o', organizations: [{ id: 'o', name: 'Acme', slug: 'acme' }] });
  if (method === 'GET' && p === '/api/registry/-/v1/search') {
    return json(200, { objects: [{ package: { name: 'tsc-rs', version: '0.7.1' }, rgstr: { ecosystem: 'npm', trust: 'claimed', owner: 'Acme', tier: 'exact', demotion: null, weeklyDownloads: 12 } }], total: 1 });
  }
  if (method === 'GET' && p === '/api/v1/registry/claims') return json(200, { pending, held: [] });
  if (method === 'POST' && p === '/api/v1/registry/claims') {
    const name = (body as { name: string }).name;
    return json(201, { request: { id: 'req-0001-abcd', name, status: 'pending', verification: 'unverified' }, dispute: null, proof: { token: TOKEN }, url: `${BASE}/registry/${name}` });
  }
  if (method === 'GET' && p.startsWith('/api/registry/')) return json(404, { error: 'not found' });
  if (method === 'GET' && p === '/api/v1/packages') return json(200, { packages: [{ id: 'pkg-1', name: 'tsc-rs', status: 'verified' }] });
  if (p === '/api/v1/packages/pkg-1/routes') {
    if (method === 'GET') return json(200, { routes: [{ id: 'route-1', versionRange: '*', upstreamKind: 'npm', upstream: 'https://registry.npmjs.org', upstreamName: null, position: 0 }] });
    if (method === 'PUT') {
      const routes = (body as { routes: Array<Record<string, unknown>> }).routes.map((r, i) => ({ id: `route-${i + 1}`, upstream: 'https://registry.npmjs.org', position: i, ...r }));
      return json(200, { routes });
    }
  }
  return json(404, { error: `unmocked ${method} ${p}` });
});

async function connect(options: Parameters<typeof createServer>[0] = { baseUrl: BASE, token: 'x', org: 'acme' }) {
  const server = createServer(options, '0.0.1-test');
  const client = new Client({ name: 'test', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
type Result = { content: Array<{ type: string; text: string }>; isError?: boolean; structuredContent?: Record<string, unknown> };
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as Result;
const textOf = (r: Result) => r.content.map((c) => c.text).join('\n');
const writes = () => hits.filter((h) => h.method !== 'GET');

async function pkgDir(readme = '# tsc-rs\n\nHello.\n') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rgstr-mcp-'));
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'tsc-rs', version: '0.7.1' }));
  await fs.writeFile(path.join(dir, 'README.md'), readme);
  return dir;
}

beforeEach(async () => {
  hits = [];
  pending = [];
  vi.stubGlobal('fetch', mockFetch);
  delete process.env.RGSTR_TOKEN;
  delete process.env.RGSTR_ORG;
  delete process.env.RGSTR_URL;
  process.env.RGSTR_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'rgstr-home-'));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tools/list', () => {
  it('lists every tool; apply tools and the instructions carry the confirm-first rule', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['rgstr_check', 'rgstr_claim_apply', 'rgstr_claim_check', 'rgstr_claim_plan', 'rgstr_login', 'rgstr_route_apply', 'rgstr_route_plan', 'rgstr_search', 'rgstr_setup_apply', 'rgstr_setup_plan', 'rgstr_whois'],
    );
    for (const t of tools.filter((t) => t.name.endsWith('_apply'))) {
      expect(t.description).toContain('show the user that plan');
      expect(t.description).toContain('get their confirmation');
      expect(t.annotations?.readOnlyHint).toBe(false);
    }
    for (const t of tools.filter((t) => t.name.endsWith('_plan') || ['rgstr_whois', 'rgstr_search', 'rgstr_check'].includes(t.name))) expect(t.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'rgstr_claim_check')?.description).toContain('Records the proof on the application and can complete the claim');
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
    expect(INSTRUCTIONS).toContain('show the user the plan and get their confirmation first');
    expect(INSTRUCTIONS).toContain(LOGIN_HINT);
    expect(`${INSTRUCTIONS} ${tools.map((t) => t.description).join(' ')}`).not.toMatch(/\b(held|holds|disputed)\b|(^|\s)org\b/);
  });
});

describe('reads', () => {
  it('rgstr_whois asks the API once, anonymously, and returns its answer', async () => {
    const client = await connect({ baseUrl: BASE });
    const r = await call(client, 'rgstr_whois', { name: '@scope/pkg' });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(textOf(r))).toMatchObject({ name: '@scope/pkg', trust: 'unclaimed' });
    expect(hits).toEqual([{ method: 'GET', path: '/api/v1/registry/whois/%40scope%2Fpkg', body: null }]);
    expect((mockFetch.mock.calls[0][1] as RequestInit).headers).not.toHaveProperty('authorization');
  });
  it('rgstr_search passes text and size through', async () => {
    const client = await connect({ baseUrl: BASE });
    const r = await call(client, 'rgstr_search', { text: 'tsc rs', size: 5 });
    expect(JSON.parse(textOf(r)).objects[0].package.name).toBe('tsc-rs');
    expect(hits[0].path).toBe('/api/registry/-/v1/search?text=tsc%20rs&size=5');
  });
  it('an API error is an isError result with the same envelope: error, code, hint, requestId', async () => {
    const client = await connect({ baseUrl: BASE });
    const r = await call(client, 'rgstr_whois', { name: 'nope' });
    expect(r.isError).toBe(true);
    const lines = textOf(r).split('\n');
    // The hint is the last line, as in the CLI; the envelope comes first.
    expect(lines[lines.length - 2]).toBe('Error: No package named "nope" on npm or PyPI');
    expect(lines[lines.length - 1]).toBe('No npm or PyPI package has this name; check the spelling at https://rgstr.org/registry/nope');
    expect(JSON.parse(lines[0])).toEqual({
      error: 'No package named "nope" on npm or PyPI',
      status: 404,
      code: 'name_unknown',
      hint: 'No npm or PyPI package has this name; check the spelling at https://rgstr.org/registry/nope',
      requestId: 'req_t1',
    });
  });
});

describe('claim: plan files nothing, apply posts exactly the plan', () => {
  it('rgstr_claim_plan shows the diff and the filing, posts nothing, writes nothing', async () => {
    const client = await connect();
    const dir = await pkgDir();
    const r = await call(client, 'rgstr_claim_plan', { cwd: dir });
    expect(r.isError).toBeFalsy();
    const out = textOf(r);
    expect(out).toContain('Claiming tsc-rs as acme');
    expect(out).toContain('Files the claim: tsc-rs goes under review');
    expect(out).toContain('+[![rgstr');
    expect(out).toContain('Nothing filed, nothing written');
    expect(r.structuredContent).toMatchObject({ applied: false, toFile: ['tsc-rs'], toWrite: ['README.md'], what: 'file the claim for tsc-rs as acme and write README.md' });
    expect(typeof r.structuredContent?.plan_id).toBe('string');
    expect(writes()).toEqual([]);
    expect(await fs.readFile(path.join(dir, 'README.md'), 'utf8')).toBe('# tsc-rs\n\nHello.\n');
  });

  it('rgstr_claim_apply with the plan_id: one POST, the badge written with the real token', async () => {
    const client = await connect();
    const dir = await pkgDir();
    const plan = await call(client, 'rgstr_claim_plan', { cwd: dir });
    const r = await call(client, 'rgstr_claim_apply', { plan_id: plan.structuredContent?.plan_id });
    expect(r.isError).toBeFalsy();
    expect(writes()).toEqual([{ method: 'POST', path: '/api/v1/registry/claims', body: { name: 'tsc-rs' } }]);
    const readme = await fs.readFile(path.join(dir, 'README.md'), 'utf8');
    expect(readme).toContain(TOKEN);
    expect(readme).not.toContain('rgstr_…');
    expect(textOf(r)).toContain('Filed: tsc-rs');
    expect(textOf(r)).toContain('README.md: written');
    expect(r.structuredContent).toMatchObject({ applied: true });
    expect((r.structuredContent?.packages as Array<Record<string, unknown>>)[0]).toMatchObject({ name: 'tsc-rs', filed: true });
    // A plan is applied once.
    const again = await call(client, 'rgstr_claim_apply', { plan_id: plan.structuredContent?.plan_id });
    expect(again.isError).toBe(true);
    expect(textOf(again)).toContain('Call rgstr_claim_plan first');
  });

  it('an application already under review: nothing to file, the badge still written only on apply', async () => {
    pending = [{ id: 'req-0002-efgh', name: 'tsc-rs', status: 'pending', verification: 'unverified', createdAt: '2026-10-20T00:00:00Z', proof: { token: TOKEN } }];
    const client = await connect();
    const dir = await pkgDir();
    const plan = await call(client, 'rgstr_claim_plan', { cwd: dir });
    expect(textOf(plan)).toContain('already under review');
    expect(textOf(plan)).toContain(TOKEN);
    expect(plan.structuredContent).toMatchObject({ toFile: [], toWrite: ['README.md'] });
    expect(await fs.readFile(path.join(dir, 'README.md'), 'utf8')).not.toContain(TOKEN);
    await call(client, 'rgstr_claim_apply', { plan_id: plan.structuredContent?.plan_id });
    expect(writes()).toEqual([]);
    expect(await fs.readFile(path.join(dir, 'README.md'), 'utf8')).toContain(TOKEN);
  });

  it('without a login, the error says how to get one', async () => {
    const client = await connect({ baseUrl: BASE });
    const r = await call(client, 'rgstr_claim_plan', { cwd: await pkgDir() });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain(LOGIN_HINT);
    expect(textOf(r).split('\n').pop()).toBe(LOGIN_HINT);
    expect(JSON.parse(textOf(r).split('\n')[0])).toEqual({ error: 'Not logged in.', code: 'no_credentials', hint: 'Run `npx @rgstr/cli@latest login`' });
    expect(writes()).toEqual([]);
  });
});

describe('routes and setup: plan then apply', () => {
  it('rgstr_route_plan shows the list as it would be and does not PUT; rgstr_route_apply PUTs it once', async () => {
    const client = await connect();
    const plan = await call(client, 'rgstr_route_plan', { name: 'tsc-rs', to: 'npm:tsc-rs@^0.7' });
    expect(textOf(plan)).toContain('tsc-rs: routes would become');
    expect(textOf(plan)).toContain('+ ^0.7 → npm:tsc-rs');
    expect(writes()).toEqual([]);
    const r = await call(client, 'rgstr_route_apply', { plan_id: plan.structuredContent?.plan_id });
    expect(r.isError).toBeFalsy();
    expect(writes()).toEqual([
      {
        method: 'PUT',
        path: '/api/v1/packages/pkg-1/routes',
        body: {
          routes: [
            { versionRange: '*', upstreamKind: 'npm', upstream: 'https://registry.npmjs.org', upstreamName: null },
            { versionRange: '^0.7', upstreamKind: 'npm', upstreamName: null },
          ],
        },
      },
    ]);
  });

  it('rgstr_setup_plan writes nothing; rgstr_setup_apply writes the planned .npmrc', async () => {
    const client = await connect({ baseUrl: BASE });
    const dir = await pkgDir();
    const plan = await call(client, 'rgstr_setup_plan', { cwd: dir });
    expect(textOf(plan)).toContain('.npmrc: will write');
    expect(await fs.readdir(dir)).not.toContain('.npmrc');
    const r = await call(client, 'rgstr_setup_apply', { plan_id: plan.structuredContent?.plan_id });
    expect(textOf(r)).toContain('.npmrc: written');
    expect(await fs.readFile(path.join(dir, '.npmrc'), 'utf8')).toContain(`registry=${BASE}/api/registry`);
  });

  it('pr: true is part of the claim plan, so apply can open the pull request', async () => {
    const client = await connect();
    const dir = await pkgDir();
    // A temp dir is no git checkout: the plan says so instead of promising a pull request.
    const plan = await call(client, 'rgstr_claim_plan', { cwd: dir, pr: true });
    expect(plan.structuredContent?.pr).toBe(false);
    expect(textOf(plan)).toContain('not a git checkout with an `origin` remote');
    expect(textOf(plan)).not.toContain('open the badge pull request with gh');
    const stored = await call(client, 'rgstr_claim_apply', { plan_id: plan.structuredContent?.plan_id });
    expect(stored.isError).toBeFalsy();
    expect(stored.structuredContent?.pr ?? null).toBeNull();
  });

  it('rgstr_claim_apply takes only a plan_id, and refuses when the README changed since the plan', async () => {
    const client = await connect();
    const dir = await pkgDir();
    const noPlan = await call(client, 'rgstr_claim_apply', {});
    expect(noPlan.isError).toBe(true);
    const plan = await call(client, 'rgstr_claim_plan', { cwd: dir });
    await fs.appendFile(path.join(dir, 'README.md'), '\nEdited after the plan.\n');
    const r = await call(client, 'rgstr_claim_apply', { plan_id: plan.structuredContent?.plan_id });
    expect(r.isError).toBe(true);
    expect(JSON.parse(textOf(r).split('\n')[0]).code).toBe('plan_stale');
    expect(textOf(r).split('\n').pop()).toBe('Run rgstr_claim_plan again and show the user the new plan');
    expect(writes()).toEqual([]);
    expect(await fs.readFile(path.join(dir, 'README.md'), 'utf8')).not.toContain(TOKEN);
  });

  it('rgstr_setup_apply refuses a plan whose files changed in the meantime', async () => {
    const client = await connect({ baseUrl: BASE });
    const dir = await pkgDir();
    const plan = await call(client, 'rgstr_setup_plan', { cwd: dir });
    await fs.writeFile(path.join(dir, '.npmrc'), 'registry=https://example.com/\n');
    const r = await call(client, 'rgstr_setup_apply', { plan_id: plan.structuredContent?.plan_id });
    expect(r.isError).toBe(true);
    expect(JSON.parse(textOf(r).split('\n')[0]).code).toBe('plan_stale');
    expect(textOf(r)).toContain('Run rgstr_setup_plan again and show the user the new plan');
    expect(await fs.readFile(path.join(dir, '.npmrc'), 'utf8')).toBe('registry=https://example.com/\n');
  });

  it('a claim plan made for one organization is not applied as another', async () => {
    const dir = await pkgDir();
    process.env.RGSTR_ORG = 'acme';
    const client = await connect({ baseUrl: BASE, token: 'x' });
    const plan = await call(client, 'rgstr_claim_plan', { cwd: dir });
    process.env.RGSTR_ORG = 'other';
    const r = await call(client, 'rgstr_claim_apply', { plan_id: plan.structuredContent?.plan_id });
    expect(r.isError).toBe(true);
    expect(JSON.parse(textOf(r).split('\n')[0]).code).toBe('plan_stale');
    expect(writes()).toEqual([]);
    expect(await fs.readFile(path.join(dir, 'README.md'), 'utf8')).not.toContain(TOKEN);
  });

  it('a route plan made for one organization is not applied as another', async () => {
    process.env.RGSTR_ORG = 'acme';
    const client = await connect({ baseUrl: BASE, token: 'x' });
    const plan = await call(client, 'rgstr_route_plan', { name: 'tsc-rs', to: 'npm:tsc-rs@^0.7' });
    process.env.RGSTR_ORG = 'other';
    const r = await call(client, 'rgstr_route_apply', { plan_id: plan.structuredContent?.plan_id });
    expect(r.isError).toBe(true);
    expect(JSON.parse(textOf(r).split('\n')[0]).code).toBe('plan_stale');
    expect(hits.filter((h) => h.method === 'PUT')).toEqual([]);
  });

  it('rgstr_login reports how the login went, and no_credentials mentions it', async () => {
    const { DeviceFlowError } = await import('../../../cli/src/auth.js');
    let reject!: (e: Error) => void;
    const flow = vi.fn(async (o: { onPrompt: (c: { verification_uri: string; user_code: string }) => void }) => {
      o.onPrompt({ verification_uri: 'https://rgstr.org/device', user_code: 'ABCD-EFGH' });
      return new Promise<never>((_, rej) => {
        reject = rej;
      });
    });
    // No explicit baseUrl: the registry comes from RGSTR_URL, so a change of host is visible.
    process.env.RGSTR_URL = BASE;
    const client = await connect({ loginFlow: flow as never });
    const first = await call(client, 'rgstr_login', {});
    expect(first.structuredContent).toMatchObject({ state: 'waiting', url: 'https://rgstr.org/device', code: 'ABCD-EFGH' });
    expect((await call(client, 'rgstr_login', {})).structuredContent?.state).toBe('waiting');
    const dir = await pkgDir();
    const waiting = await call(client, 'rgstr_claim_plan', { cwd: dir });
    expect(waiting.isError).toBe(true);
    expect(textOf(waiting).split('\n').pop()).toContain('a login is waiting for approval at https://rgstr.org/device (code ABCD-EFGH)');
    // A login for another registry says nothing about this one.
    process.env.RGSTR_URL = 'https://other.example';
    expect(textOf(await call(client, 'rgstr_claim_plan', { cwd: dir })).split('\n').pop()).not.toContain('waiting for approval');
    process.env.RGSTR_URL = BASE;
    reject(new DeviceFlowError('access_denied', 'The user denied the request.'));
    await new Promise((r) => setTimeout(r, 10));
    const after = await call(client, 'rgstr_claim_plan', { cwd: dir });
    expect(textOf(after).split('\n').pop()).toContain('the last login was rejected: The user denied the request.; call rgstr_login again');
    // Another registry starts fresh: its first call mints a code, not the old registry's result.
    process.env.RGSTR_URL = 'https://other.example';
    expect((await call(client, 'rgstr_login', {})).structuredContent).toMatchObject({ state: 'waiting', baseUrl: 'https://other.example' });
    expect(flow).toHaveBeenCalledTimes(2);
    process.env.RGSTR_URL = BASE;
    const report = await call(client, 'rgstr_login', {});
    expect(report.structuredContent?.state).toBe('rejected');
    expect(textOf(report)).toContain('Call rgstr_login again to start a new one.');
    // Reported once; the next call starts a new login.
    expect((await call(client, 'rgstr_login', {})).structuredContent?.state).toBe('waiting');
    delete process.env.RGSTR_URL;
  });
});
