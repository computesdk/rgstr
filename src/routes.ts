// `rgstr route`: claimant routing over /api/v1/packages/:id/routes (GET + PUT
// of the full list). Specs read like install specs: `npm:tsc-rs@^0.7`,
// `jsr:@scope/pkg@^1`, `pypi:name@>=1`.

import { RgstrCliError } from './client.js';

export type UpstreamKind = 'npm' | 'jsr' | 'vsr' | 'pypi' | 'native';

export interface RouteInput {
  versionRange: string;
  upstreamKind: UpstreamKind;
  upstream?: string;
  upstreamName: string | null;
}

export interface RouteRecord extends RouteInput {
  id: string;
  upstream: string;
  position: number;
}

/** The same list, route for route — what a plan was built from must still be
 *  on the server when it is applied, since the PUT replaces the whole list. */
export function sameRoutes(a: RouteRecord[], b: RouteRecord[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((r, i) => {
    const o = b[i];
    return r.id === o.id && r.position === o.position && r.versionRange === o.versionRange && r.upstreamKind === o.upstreamKind && r.upstream === o.upstream && r.upstreamName === o.upstreamName;
  });
}

const KINDS = new Set<UpstreamKind>(['npm', 'jsr', 'vsr', 'pypi', 'native']);

/** `<kind>:<name>[@<range>]`; `@scope/pkg@^1` keeps the leading scope `@`. */
export function parseRouteSpec(spec: string, claimedName: string): RouteInput {
  const colon = spec.indexOf(':');
  if (colon === -1) {
    throw new RgstrCliError('invalid_argument', `Route spec must look like npm:<name>@<range> or jsr:@scope/pkg@<range>, got "${spec}"`);
  }
  const kind = spec.slice(0, colon);
  if (kind === 'github') {
    throw new RgstrCliError('invalid_argument', 'github: routes are not supported yet — route to the npm/jsr/pypi name the repo publishes instead.');
  }
  if (!KINDS.has(kind as UpstreamKind)) {
    throw new RgstrCliError('invalid_argument', `Unknown upstream "${kind}" — use one of ${[...KINDS].join(', ')}`);
  }
  const rest = spec.slice(colon + 1);
  const at = rest.indexOf('@', rest.startsWith('@') ? 1 : 0);
  const name = at === -1 ? rest : rest.slice(0, at);
  const range = at === -1 ? '*' : rest.slice(at + 1) || '*';
  return {
    versionRange: range,
    upstreamKind: kind as UpstreamKind,
    upstreamName: name && name !== claimedName ? name : null,
  };
}

export function formatRouteRow(r: RouteRecord, claimedName: string): string[] {
  const target = `${r.upstreamKind}:${r.upstreamName ?? claimedName}`;
  const host = r.upstreamKind === 'npm' && r.upstream === 'https://registry.npmjs.org' ? '' : r.upstream;
  return [r.id.slice(0, 8), r.versionRange, target, host];
}
