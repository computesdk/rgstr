import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, saveConfig } from '../config.js';
import { NO_ORGANIZATION_HINT, rememberOrganization } from '../login.js';
import { RgstrCliError } from '../client.js';

const BASE = 'https://rgstr.org';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('rememberOrganization', () => {
  let home: string;
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'rgstr-login-'));
    process.env.RGSTR_HOME = home;
    await saveConfig({ org: 'old-team' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.RGSTR_HOME;
  });

  it('makes the one organization the user has the active one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { user: { id: 'u', email: 'a@b.c' }, activeOrganizationId: 'o', organizations: [{ id: 'o', name: 'New', slug: 'new-team' }] })));
    const { org } = await rememberOrganization(BASE, 'tok');
    expect(org).toBe('new-team');
    expect((await loadConfig()).org).toBe('new-team');
  });

  it('forgets the previous organization and says so when /api/v1/me fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(503, { error: 'unavailable', code: 'unavailable', hint: 'Try again' })));
    const err = await rememberOrganization(BASE, 'tok').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RgstrCliError);
    expect((err as RgstrCliError).code).toBe('no_organization');
    expect((err as RgstrCliError).hint).toBe(NO_ORGANIZATION_HINT);
    expect((await loadConfig()).org).toBeUndefined();
  });
});
