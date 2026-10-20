/** After a device-code login: who the user is, and which organization the
 *  CLI acts for from now on. Shared by `rgstr login` and @rgstr/mcp's
 *  rgstr_login so both leave the same config behind. */
import { RgstrClient, RgstrCliError } from './client.js';
import { loadConfig, saveConfig } from './config.js';

export interface MeResponse {
  user: { id: string; email: string; name?: string | null };
  activeOrganizationId: string | null;
  organizations: Array<{ id: string; name: string; slug: string }>;
}

export const NO_ORGANIZATION_HINT = 'Signed in, but no organization was selected; run `rgstr org use <slug>`';

export async function rememberOrganization(baseUrl: string, token: string, opts: { org?: string } = {}): Promise<{ me: MeResponse; org: string | null }> {
  const cfg = await loadConfig();
  let me: MeResponse;
  try {
    me = await new RgstrClient({ baseUrl, token, kind: 'device', org: null }).get<MeResponse>('/api/v1/me');
  } catch (err) {
    // The credentials are saved, but we could not learn whose they are: an
    // organization remembered from before may belong to another account, so
    // forget it rather than send every write as the wrong organization.
    if (cfg.org) await saveConfig({ ...cfg, org: undefined });
    throw new RgstrCliError('no_organization', `Signed in, but ${err instanceof Error ? err.message : String(err)}`, NO_ORGANIZATION_HINT);
  }
  const slugs = me.organizations.map((o) => o.slug);
  // A remembered organization from a different account would make every write 403.
  const keep = cfg.org && slugs.includes(cfg.org) ? cfg.org : undefined;
  const next = keep ?? (slugs.length === 1 ? slugs[0] : undefined);
  if (next !== cfg.org) await saveConfig({ ...cfg, org: next });
  return { me, org: opts.org || process.env.RGSTR_ORG || next || null };
}
