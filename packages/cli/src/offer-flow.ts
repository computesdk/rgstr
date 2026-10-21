/**
 * The `rgstr offer` flow, importable: plan (reads the floor for the name and
 * any offer already open on it; prints what would be filed and the rule) and
 * apply (files the offer). For a name the user cannot claim — unclaimed, and
 * not theirs to maintain. A claim always wins: the maintainer can claim the
 * name for free at any time during the window, and every offer is refunded in
 * full when they do. The CLI and @rgstr/mcp both run exactly this.
 */
import { RgstrClient, RgstrCliError } from './client.js';
import { fmtDate, fmtDownloads, fmtUsd, kv, table } from './output.js';
import type { OpenOffer } from './api-types.js';

/** The rule, in the words the plan prints and skills/rgstr/SKILL.md repeats. */
export const OFFER_RULE = 'The maintainer can claim this name for free at any time during the 30-day window, and that beats your offer; you are refunded in full if they do.';

/** GET /api/v1/registry/offers/floor/<name>: the least an offer on this name can be, and the window as it stands. */
export interface OfferFloor {
  name: string;
  floorUsd: number;
  weeklyDownloads: number | null;
  openOffer: OpenOffer | null;
  /** Set once a verified offer opened the window; a new offer joins it. */
  windowClosesAt: string | null;
  url?: string;
}

export type OfferStatus = 'unverified' | 'open' | 'won' | 'refunded' | 'lapsed' | 'withdrawn';

export interface OfferRecord {
  id: string;
  name: string;
  amountUsd: number;
  why: string | null;
  status: OfferStatus;
  windowClosesAt: string | null;
  createdAt: string;
  url?: string;
}

export interface OfferResponse {
  offer: OfferRecord;
  url: string;
}

export interface OfferOpts {
  amount?: string;
  why?: string;
  yes?: boolean;
  withdraw?: boolean;
}

export interface OfferPlan {
  name: string;
  amountUsd: number;
  why: string | null;
  floor: OfferFloor;
  /** The organization the offer is filed for, in words. */
  asWho: string;
}

/** `400`, `$400`, `400.50` → dollars. Anything else is a usage error. */
export function parseAmount(raw: string): number {
  const n = Number(raw.trim().replace(/^\$/, '').replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) throw new RgstrCliError('invalid_argument', `--amount must be a dollar amount, not "${raw}"`, 'Pass whole dollars, e.g. --amount 400');
  return Math.round(n * 100) / 100;
}

export const asWhoFor = (c: RgstrClient) => c.auth.org ?? (c.auth.kind === 'api_key' ? 'the organization your API key belongs to' : 'your organization (pick one with `rgstr org use <slug>`)');

/** Everything up to the question. One read: the floor (the API answers
 *  `name_claimed` here for a claimed name, so nothing is filed to find out). */
export async function planOffer(c: RgstrClient, name: string, opts: OfferOpts): Promise<OfferPlan> {
  const floor = await c.get<OfferFloor>(`/api/v1/registry/offers/floor/${encodeURIComponent(name)}`);
  const amountUsd = opts.amount === undefined ? floor.floorUsd : parseAmount(opts.amount);
  if (amountUsd < floor.floorUsd) {
    throw new RgstrCliError('invalid_argument', `${fmtUsd(amountUsd)} is below the floor for ${name} (${fmtUsd(floor.floorUsd)}).`, `Re-run with --amount ${floor.floorUsd} or more`);
  }
  const why = opts.why?.trim() || null;
  return { name, amountUsd, why, floor, asWho: asWhoFor(c) };
}

/** What `rgstr offer` prints before it asks. */
export function renderOfferPlan(p: OfferPlan): string[] {
  const { floor } = p;
  const lines = [`Offering ${fmtUsd(p.amountUsd)} for ${p.name} as ${p.asWho}`];
  lines.push(
    kv([
      ['floor', `${fmtUsd(floor.floorUsd)}${floor.weeklyDownloads != null ? ` (${fmtDownloads(floor.weeklyDownloads)} on the busiest index)` : ''}`],
      ['amount', fmtUsd(p.amountUsd) + (p.amountUsd === floor.floorUsd ? ' (the floor; --amount to offer more)' : '')],
      ['why', p.why ?? '(none — --why "<one line>" is shown to the maintainer and the reviewer)'],
      ['open offer', floor.openOffer ? `${fmtUsd(floor.openOffer.amountUsd)} by ${floor.openOffer.by}, window closes ${fmtDate(floor.openOffer.windowClosesAt)}` : null],
    ]).split('\n').map((l) => `  ${l}`).join('\n'),
  );
  lines.push('');
  lines.push(
    floor.windowClosesAt
      ? `Files the offer: a card hold of ${fmtUsd(p.amountUsd)} is taken; the highest offer standing when the window closes on ${fmtDate(floor.windowClosesAt)} is charged and registers the name.`
      : `Files the offer: a card hold of ${fmtUsd(p.amountUsd)} is taken and a 30-day window opens once your organization's identity is verified; if nobody who maintains ${p.name} claims it by then, the hold is charged and the name is registered to you.`,
  );
  lines.push(OFFER_RULE);
  return lines;
}

/** The apply half — only ever after the user said yes to the plan. */
export async function applyOffer(c: RgstrClient, p: OfferPlan): Promise<OfferResponse> {
  return c.post<OfferResponse>('/api/v1/registry/offers', { name: p.name, amountUsd: p.amountUsd, why: p.why });
}

/** What `rgstr offer` prints once the offer is filed. */
export function describeFiled(res: OfferResponse): string[] {
  const o = res.offer;
  const lines = [`Filed: offer ${fmtUsd(o.amountUsd)} for ${o.name} (${res.url})`];
  if (o.status === 'unverified') lines.push("The window opens once your organization's identity is verified; an unverified offer lapses after 7 days and is never shown to the maintainer.");
  else if (o.windowClosesAt) lines.push(`Window closes ${fmtDate(o.windowClosesAt)}. The maintainer is told once; if nobody who maintains ${o.name} claims it by then, the highest offer registers the name.`);
  lines.push(`Withdraw with \`rgstr offer --withdraw ${o.name}\`; \`rgstr offers\` lists your offers.`);
  return lines;
}

/** The --json shape of the plan and of the filed offer. */
export function offerPlanJson(c: RgstrClient, p: OfferPlan) {
  return { name: p.name, org: c.auth.org, amountUsd: p.amountUsd, why: p.why, floor: p.floor, rule: OFFER_RULE, filed: false };
}

export async function listOffers(c: RgstrClient): Promise<OfferRecord[]> {
  return (await c.get<{ offers: OfferRecord[] }>('/api/v1/registry/offers')).offers;
}

const STATE_WORDS: Record<OfferStatus, string> = {
  unverified: 'waiting for identity verification',
  open: 'open',
  won: 'won — name registered',
  refunded: 'refunded — the maintainer claimed the name',
  lapsed: 'lapsed',
  withdrawn: 'withdrawn',
};

export function offerState(o: OfferRecord): string {
  return STATE_WORDS[o.status] ?? o.status;
}

/** `rgstr offers`: name, amount, state, when the window closes. */
export function offersTable(offers: OfferRecord[]): string {
  return table(
    offers.map((o) => [o.name, fmtUsd(o.amountUsd), offerState(o), o.status === 'open' || o.status === 'unverified' ? fmtDate(o.windowClosesAt) : '—']),
    ['name', 'amount', 'state', 'window closes'],
  );
}

/** The offer `--withdraw <name>` would end: the organization's own open (or
 *  still unverified) offer on that name. Reads only. */
export async function planWithdraw(c: RgstrClient, name: string): Promise<OfferRecord> {
  const mine = (await listOffers(c)).find((o) => o.name === name && (o.status === 'open' || o.status === 'unverified'));
  if (!mine) throw new RgstrCliError('not_found', `${c.auth.org ?? 'Your organization'} has no open offer on ${name}.`, '`rgstr offers` lists your offers');
  return mine;
}

export async function applyWithdraw(c: RgstrClient, offer: OfferRecord): Promise<OfferRecord> {
  return (await c.post<{ offer: OfferRecord }>(`/api/v1/registry/offers/${encodeURIComponent(offer.id)}/withdraw`)).offer;
}
