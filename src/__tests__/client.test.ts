import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RgstrClient, RgstrCliError, isSecureTransport, isTrustedHost, resolveAuth } from '../client.js';
import { deviceLogin, discoverAuthServer, oauthClients, requestDeviceCode } from '../auth.js';
import { parseRouteSpec, sameRoutes, type RouteRecord } from '../routes.js';

const ENV = ['RGSTR_TOKEN', 'RGSTR_ORG', 'RGSTR_URL', 'RGSTR_HOME'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.RGSTR_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'rgstr-home-'));
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const stored = {
  baseUrl: 'https://rgstr.org',
  token: 'device-token',
  clientId: 'benchsdk-cli',
  authBaseUrl: 'https://platform.computesdk.com/api/auth',
  resource: 'https://platform.computesdk.com/api/v1',
};

describe('host trust', () => {
  it('trusts rgstr.org, computesdk.com and loopback only', () => {
    expect(isTrustedHost('https://rgstr.org')).toBe(true);
    expect(isTrustedHost('https://platform.computesdk.com')).toBe(true);
    expect(isTrustedHost('http://rgstr.localhost:3000')).toBe(true);
    expect(isTrustedHost('https://evil.example')).toBe(false);
    expect(isTrustedHost('https://rgstr.org.evil.example')).toBe(false);
  });
  it('allows plaintext only for loopback', () => {
    expect(isSecureTransport('http://127.0.0.1:3000')).toBe(true);
    expect(isSecureTransport('http://rgstr.org')).toBe(false);
  });
});

describe('resolveAuth', () => {
  it('prefers RGSTR_TOKEN and picks the org from RGSTR_ORG', async () => {
    process.env.RGSTR_TOKEN = 'csdk_key';
    process.env.RGSTR_ORG = 'acme';
    const auth = await resolveAuth({}, { loadCredentials: async () => stored });
    expect(auth).toMatchObject({ baseUrl: 'https://rgstr.org', token: 'csdk_key', kind: 'api_key', org: 'acme' });
  });

  it('falls back to the stored device login for its own origin', async () => {
    const auth = await resolveAuth({ org: 'acme' }, { loadCredentials: async () => stored });
    expect(auth).toMatchObject({ token: 'device-token', kind: 'device', org: 'acme' });
    await expect(resolveAuth({ baseUrl: 'http://rgstr.localhost:3000' }, { loadCredentials: async () => stored })).rejects.toMatchObject({ code: 'no_credentials' });
  });

  it('refuses untrusted hosts, and never sends stored auth to one', async () => {
    await expect(resolveAuth({ baseUrl: 'https://evil.example' }, { loadCredentials: async () => stored })).rejects.toMatchObject({ code: 'untrusted_host' });
    const err = await resolveAuth(
      { baseUrl: 'https://evil.example', allowUntrustedHost: true },
      { loadCredentials: async () => ({ ...stored, baseUrl: 'https://evil.example' }) },
    ).catch((e: RgstrCliError) => e);
    expect(err).toMatchObject({ code: 'no_credentials' });
    await expect(resolveAuth({ baseUrl: 'http://rgstr.org', allowUntrustedHost: true })).rejects.toMatchObject({ code: 'insecure_transport' });
  });

  it('is optional for public commands, even when the stored login is dead', async () => {
    const auth = await resolveAuth({ optional: true }, { loadCredentials: async () => null });
    expect(auth).toMatchObject({ kind: 'none', token: null });
    const dead = { ...stored, refreshToken: 'r', tokenExpiresAt: Date.now() - 1 };
    const failing = (async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'expired' }), { status: 400 })) as unknown as typeof fetch;
    expect(await resolveAuth({ optional: true }, { loadCredentials: async () => dead, fetchImpl: failing })).toMatchObject({ kind: 'none' });
    await expect(resolveAuth({}, { loadCredentials: async () => dead, fetchImpl: failing })).rejects.toMatchObject({ code: 'no_credentials' });
  });
});

describe('RgstrClient', () => {
  it('sends Bearer + X-Org-Slug and surfaces API errors', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return url.endsWith('/boom')
        ? new Response(JSON.stringify({ error: 'Name already claimed' }), { status: 409 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = new RgstrClient({ baseUrl: 'https://rgstr.org', token: 't', kind: 'api_key', org: 'acme' }, fetchImpl);
    await c.post('/api/v1/registry/claims', { name: 'x' });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer t');
    expect(headers['x-org-slug']).toBe('acme');
    await expect(c.get('/boom')).rejects.toMatchObject({ status: 409, message: 'Name already claimed' });
    expect((calls[0].init as { redirect?: string }).redirect).toBe('manual');
  });

  it('refuses to follow redirects with the bearer token', async () => {
    const fetchImpl = (async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } })) as unknown as typeof fetch;
    const c = new RgstrClient({ baseUrl: 'https://rgstr.org', token: 't', kind: 'api_key', org: null }, fetchImpl);
    await expect(c.get('/api/v1/me')).rejects.toMatchObject({ status: 302 });
  });
});

describe('device flow discovery', () => {
  it('finds the issuer and resource from the protected-resource metadata and posts the device code request', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://rgstr.org/.well-known/oauth-protected-resource/api/v1') {
        return new Response(JSON.stringify({ resource: 'https://platform.computesdk.com/api/v1', authorization_servers: ['https://platform.computesdk.com/api/auth'] }));
      }
      expect(url).toBe('https://platform.computesdk.com/api/auth/device/code');
      const body = init?.body as URLSearchParams;
      expect(body.get('client_id')).toBe('benchsdk-cli');
      expect(body.get('resource')).toBe('https://platform.computesdk.com/api/v1');
      expect(body.get('scope')).toContain('packages:write');
      return new Response(JSON.stringify({ device_code: 'd', user_code: 'ABCD-EFGH', verification_uri: 'https://platform.computesdk.com/device', expires_in: 900, interval: 5 }));
    }) as unknown as typeof fetch;
    const server = await discoverAuthServer('https://rgstr.org', fetchImpl);
    const code = await requestDeviceCode(server, 'benchsdk-cli', 'packages:read packages:write org:read org:admin offline_access', fetchImpl);
    expect(code.user_code).toBe('ABCD-EFGH');
  });
});

describe('route specs', () => {
  it('parses kind, name and range', () => {
    expect(parseRouteSpec('npm:tsc-rs@^0.7', 'tsc-rs')).toEqual({ versionRange: '^0.7', upstreamKind: 'npm', upstreamName: null });
    expect(parseRouteSpec('npm:tsc-rs-real@^0.7', 'tsc-rs')).toEqual({ versionRange: '^0.7', upstreamKind: 'npm', upstreamName: 'tsc-rs-real' });
    expect(parseRouteSpec('jsr:@scope/pkg@^1', 'tsc-rs')).toEqual({ versionRange: '^1', upstreamKind: 'jsr', upstreamName: '@scope/pkg' });
    expect(parseRouteSpec('pypi:tsc-rs', 'tsc-rs')).toEqual({ versionRange: '*', upstreamKind: 'pypi', upstreamName: null });
    expect(() => parseRouteSpec('github:owner/repo@v1.2.3', 'tsc-rs')).toThrow(/github: routes are not supported yet/);
    expect(() => parseRouteSpec('tsc-rs', 'tsc-rs')).toThrow(/npm:<name>@<range>/);
  });
});

describe('login scopes', () => {
  const server = { authBaseUrl: 'https://platform.computesdk.com/api/auth', resource: 'https://platform.computesdk.com/api/v1' };

  it('asks for the registry-only client first and falls back to the platform client when the server rejects it', async () => {
    expect(oauthClients({})).toEqual([
      { clientId: 'rgstr-cli', scope: 'packages:read packages:write org:read offline_access' },
      { clientId: 'benchsdk-cli', scope: 'packages:read packages:write org:read org:admin offline_access' },
    ]);
    expect(oauthClients({ RGSTR_OAUTH_CLIENT_ID: 'dev-cli' })).toEqual([{ clientId: 'dev-cli', scope: 'packages:read packages:write org:read offline_access' }]);

    const asked: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/.well-known/oauth-protected-resource/api/v1')) {
        return new Response(JSON.stringify({ resource: server.resource, authorization_servers: [server.authBaseUrl] }));
      }
      const body = init?.body as URLSearchParams;
      if (url.endsWith('/device/code')) {
        asked.push(`${body.get('client_id')} ${body.get('scope')}`);
        if (body.get('client_id') === 'rgstr-cli') return new Response(JSON.stringify({ error: 'invalid_client', error_description: 'unknown client' }), { status: 400 });
        return new Response(JSON.stringify({ device_code: 'd', user_code: 'ABCD', verification_uri: 'https://platform.computesdk.com/device', expires_in: 1, interval: 0 }));
      }
      expect(body.get('client_id')).toBe('benchsdk-cli');
      return new Response(JSON.stringify({ access_token: 'at', token_type: 'Bearer', expires_in: 3600, scope: 'packages:read packages:write org:read org:admin offline_access' }));
    }) as unknown as typeof fetch;
    const creds = await deviceLogin({ baseUrl: 'https://rgstr.org', fetchImpl });
    expect(asked).toEqual(['rgstr-cli packages:read packages:write org:read offline_access', 'benchsdk-cli packages:read packages:write org:read org:admin offline_access']);
    expect(creds).toMatchObject({ clientId: 'benchsdk-cli', scope: 'packages:read packages:write org:read org:admin offline_access', token: 'at' });
  });

  it('keeps the registry client when the server accepts it, and surfaces a rejection of the last client', async () => {
    const accepting = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/.well-known/oauth-protected-resource/api/v1')) {
        return new Response(JSON.stringify({ resource: server.resource, authorization_servers: [server.authBaseUrl] }));
      }
      if (url.endsWith('/device/code')) return new Response(JSON.stringify({ device_code: 'd', user_code: 'ABCD', verification_uri: 'https://x', expires_in: 1, interval: 0 }));
      expect((init?.body as URLSearchParams).get('client_id')).toBe('rgstr-cli');
      return new Response(JSON.stringify({ access_token: 'at', token_type: 'Bearer', expires_in: 3600, scope: 'packages:read packages:write org:read offline_access' }));
    }) as unknown as typeof fetch;
    expect(await deviceLogin({ baseUrl: 'https://rgstr.org', fetchImpl: accepting })).toMatchObject({ clientId: 'rgstr-cli', scope: 'packages:read packages:write org:read offline_access' });

    const rejecting = (async (url: string) => {
      if (url.endsWith('/.well-known/oauth-protected-resource/api/v1')) {
        return new Response(JSON.stringify({ resource: server.resource, authorization_servers: [server.authBaseUrl] }));
      }
      return new Response(JSON.stringify({ error: 'invalid_scope', error_description: 'nope' }), { status: 400 });
    }) as unknown as typeof fetch;
    await expect(deviceLogin({ baseUrl: 'https://rgstr.org', fetchImpl: rejecting })).rejects.toThrow(/nope/);
  });

  it('does not fall back to the platform client on errors other than an unknown client or scope', async () => {
    const asked: string[] = [];
    const flaky = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/.well-known/oauth-protected-resource/api/v1')) {
        return new Response(JSON.stringify({ resource: server.resource, authorization_servers: [server.authBaseUrl] }));
      }
      asked.push((init?.body as URLSearchParams).get('client_id')!);
      return new Response(JSON.stringify({ error: 'server_error', error_description: 'db down' }), { status: 500 });
    }) as unknown as typeof fetch;
    await expect(deviceLogin({ baseUrl: 'https://rgstr.org', fetchImpl: flaky })).rejects.toThrow(/db down/);
    expect(asked).toEqual(['rgstr-cli']);
  });
});

describe('sameRoutes', () => {
  const a: RouteRecord = { id: 'r1', versionRange: '*', upstreamKind: 'npm', upstream: 'https://registry.npmjs.org', upstreamName: null, position: 0 };
  const b: RouteRecord = { ...a, id: 'r2', versionRange: '^1', upstreamName: 'other', position: 1 };
  it('is true for the same list and false once anything differs', () => {
    expect(sameRoutes([a, b], [{ ...a }, { ...b }])).toBe(true);
    expect(sameRoutes([a, b], [a])).toBe(false);
    expect(sameRoutes([a, b], [b, a])).toBe(false);
    expect(sameRoutes([a], [{ ...a, upstreamName: 'x' }])).toBe(false);
    expect(sameRoutes([a], [{ ...a, id: 'r9' }])).toBe(false);
    expect(sameRoutes([], [])).toBe(true);
  });
});
