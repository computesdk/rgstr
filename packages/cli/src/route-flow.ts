/**
 * The `rgstr route` flow, importable: plan the list as it would be, apply it
 * with one PUT — only after the user said yes. The CLI and @rgstr/mcp both
 * run exactly this.
 */
import { RgstrClient, RgstrCliError } from './client.js';
import { parseRouteSpec, sameRoutes, type RouteInput, type RouteRecord } from './routes.js';

export interface OrgPackage {
  id: string;
  name: string;
  status: string;
}

export async function heldPackage(c: RgstrClient, name: string): Promise<OrgPackage> {
  const res = await c.get<{ packages: OrgPackage[] }>('/api/v1/packages');
  const pkg = res.packages.find((p) => p.name === name);
  if (!pkg) throw new RgstrCliError('not_holder', `${c.auth.org ?? 'Your organization'} has not claimed ${name} — see \`rgstr whois ${name}\`.`);
  return pkg;
}

export interface RoutePlan {
  name: string;
  packageId: string;
  path: string;
  /** The routes as they are now. */
  current: RouteRecord[];
  /** Those of `current` that stay. */
  keep: RouteRecord[];
  added: RouteInput[];
  /** The whole list as it would be after apply. */
  next: RouteInput[];
  /** False when nothing was asked to change (a plain listing). */
  changed: boolean;
}

/** Reads only: the package, its routes, and the list as it would be. */
export async function planRoutes(c: RgstrClient, name: string, opts: { to?: string; rm?: string }): Promise<RoutePlan> {
  const pkg = await heldPackage(c, name);
  const path = `/api/v1/packages/${pkg.id}/routes`;
  const current = (await c.get<{ routes: RouteRecord[] }>(path)).routes;
  let keep = current;
  if (opts.rm) {
    const rm = opts.rm;
    const matches = current.filter((r) => r.id === rm || r.id.startsWith(rm));
    if (matches.length === 0) throw new RgstrCliError('not_found', `No route ${rm} on ${name}`);
    if (matches.length > 1) {
      throw new RgstrCliError('invalid_argument', `${rm} matches ${matches.length} routes (${matches.map((r) => r.id.slice(0, 12)).join(', ')}) — give more of the id.`);
    }
    const victim = matches[0];
    keep = current.filter((r) => r.id !== victim.id);
  }
  const added: RouteInput[] = opts.to ? [parseRouteSpec(opts.to, name)] : [];
  const next: RouteInput[] = [...keep.map(({ versionRange, upstreamKind, upstream, upstreamName }) => ({ versionRange, upstreamKind, upstream, upstreamName })), ...added];
  return { name, packageId: pkg.id, path, current, keep, added, next, changed: !!(opts.to || opts.rm) };
}

/** "routes would become", one line per route: ` ` kept, `-` removed, `+` added. */
export function renderRoutePlan(plan: RoutePlan): string[] {
  const target = (r: RouteInput) => `${r.versionRange} → ${r.upstreamKind}:${r.upstreamName ?? plan.name}`;
  const lines = [`${plan.name}: routes would become`];
  for (const r of plan.current) lines.push(`  ${plan.keep.includes(r) ? ' ' : '-'} ${target(r)}`);
  for (const r of plan.added) lines.push(`  + ${target(r)}`);
  if (plan.next.length === 0) lines.push(`  (none — installs fall back to npm:${plan.name})`);
  return lines;
}

/** One PUT of the planned list. The PUT replaces the whole list, and someone
 *  else may have changed it since the plan was shown — apply only to the list
 *  the plan was made for. */
export async function applyRoutes(c: RgstrClient, plan: RoutePlan): Promise<RouteRecord[]> {
  const now = (await c.get<{ routes: RouteRecord[] }>(plan.path)).routes;
  if (!sameRoutes(now, plan.current)) {
    throw new RgstrCliError('conflict', `${plan.name}'s routes changed while the question was open — nothing changed here. Re-run to see the current list.`);
  }
  return (await c.put<{ routes: RouteRecord[] }>(plan.path, { routes: plan.next })).routes;
}
