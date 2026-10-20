/** After a device-code login: who the user is, and which organization the
 *  CLI acts for from now on. Shared by `rgstr login` and @rgstr/mcp's
 *  rgstr_login so both leave the same config behind. */
import { RgstrClient } from './client.js';
import { loadConfig, saveConfig } from './config.js';

export interface MeResponse {
  user: { id: string; email: string; name?: string | null };
  activeOrganizationId: string | null;
  organizations: Array<{ id: string; name: string; slug: string }>;
}

export async function rememberOrganization(baseUrl: string, token: string, opts: { org?: string } = {}): Promise<{ me: MeResponse; org: string | null }> {
  const me = await new RgstrClient({ baseUrl, token, kind: 'device', org: null }).get<MeResponse>('/api/v1/me');
  const cfg = await loadConfig();
  const slugs = me.organizations.map((o) => o.slug);
  // A remembered organization from a different account would make every write 403.
  const keep = cfg.org && slugs.includes(cfg.org) ? cfg.org : undefined;
  const next = keep ?? (slugs.length === 1 ? slugs[0] : undefined);
  if (next !== cfg.org) await saveConfig({ ...cfg, org: next });
  return { me, org: opts.org || process.env.RGSTR_ORG || next || null };
}
