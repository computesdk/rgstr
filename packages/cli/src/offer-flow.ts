/**
 * The `rgstr offer` flow, importable: plan (reads the floor for the name and
 * any offer already open on it; prints what would be filed and the rule) and
 * apply (files the offer). For a name the user cannot claim — unclaimed, and
 * not theirs to maintain. A claim always wins: the maintainer can claim the
 * name for free at any time during the window; the card is charged only if the
 * offer wins, so nothing is ever refunded because nothing was held. The CLI and
 * @rgstr/mcp both run exactly this.
 */
import { RgstrClient, RgstrCliError } from './client.js';
import { fmtDate, fmtDownloads, fmtUsd, kv, table } from './output.js';
import type { OpenOffer } from './api-types.js';

/** The rule, in the words the plan prints and skills/rgstr/SKILL.md repeats. */
export const OFFER_RULE = 'The maintainer can claim this name for free at any time during the 30-day window, and that beats your offer; your card is charged only if your offer wins, so their claim costs you nothing — there is nothing to refund.';

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
  /** The offering organization; `identityVerified` says which step an unverified offer still waits on. */
  organization?: { name?: string; slug?: string; identityVerified?: boolean } | null;
}

export interface OfferResponse {
  offer: OfferRecord;
  url: string;
  /** Stripe Checkout (setup mode) that saves the card; charged off-session only if the offer wins. */
  checkoutUrl?: string | null;
  /** Whether the organization's identity is verified; if not, the page to do it and the API's hint. */
  identity?: { verified: true } | { verified: false; url: string; hint: string } | null;
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

/** `400`, `$400`, `1,000` → whole dollars (the API takes no cents). Anything else is a usage error. */
export function parseAmount(raw: string): number {
  const n = Number(raw.trim().replace(/^\$/, '').replace(/,/g, ''));
  if (!Number.isInteger(n) || n <= 0) throw new RgstrCliError('invalid_argument', `--amount must be a whole number of dollars, not "${raw}"`, 'Pass whole dollars, e.g. --amount 400');
  return n;
}

export const asWhoFor = (c: RgstrClient) => c.auth.org ?? (c.auth.kind === 'api_key' ? 'the organization your API key belongs to' : 'your organization (pick one with `rgstr org use <slug>`)');

/** Everything up to the question. One read: the floor (the API answers
 *  `name_claimed` here for a claimed name, so nothing is filed to find out). */
export async function fetchFloor(c: RgstrClient, name: string): Promise<OfferFloor> {
  return c.get<OfferFloor>(`/api/v1/registry/offers/floor/${encodeURIComponent(name)}`);
}

export async function planOffer(c: RgstrClient, name: string, opts: OfferOpts): Promise<OfferPlan> {
  const floor = await fetchFloor(c, name);
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
      ? `Files the offer and returns a checkout link where you save the card — charged ${fmtUsd(p.amountUsd)} only if yours is the highest offer standing when the window closes on ${fmtDate(floor.windowClosesAt)}; the name is then registered to you. The offer joins the window once the card is saved and your organization's identity is verified.`
      : `Files the offer and returns a checkout link where you save the card — charged ${fmtUsd(p.amountUsd)} only if your offer wins. The 30-day window opens once the card is saved and your organization's identity is verified; if nobody who maintains ${p.name} claims it by then, the name is registered to you.`,
  );
  lines.push(OFFER_RULE);
  return lines;
}

/** The apply half — only ever after the user said yes to the plan. */
export async function applyOffer(c: RgstrClient, p: OfferPlan): Promise<OfferResponse> {
  // `acknowledged`: the rule was shown and the user said yes (the web form has a checkbox for it).
  return c.post<OfferResponse>('/api/v1/registry/offers', { name: p.name, amountUsd: p.amountUsd, why: p.why, acknowledged: true });
}

/** What `rgstr offer` prints once the offer is filed. */
export function describeFiled(res: OfferResponse): string[] {
  const o = res.offer;
  const lines = [`Filed: offer ${fmtUsd(o.amountUsd)} for ${o.name} (${res.url})`];
  const identityPending = res.identity != null && res.identity.verified === false;
  if (res.checkoutUrl) lines.push(`Save the card (charged ${fmtUsd(o.amountUsd)} only if your offer wins): ${res.checkoutUrl}`);
  if (identityPending && res.identity && res.identity.verified === false) lines.push(res.identity.hint || `Verify your organization's identity: ${res.identity.url}`);
  if (o.status === 'unverified') {
    lines.push(`The window opens once the card is saved${identityPending ? ' and the identity is verified' : ''}; an offer still waiting after 7 days lapses and is never shown to the maintainer.`);
  } else if (o.windowClosesAt) lines.push(`Window closes ${fmtDate(o.windowClosesAt)}. The maintainer is told once; if nobody who maintains ${o.name} claims it by then, the highest offer is charged and registers the name.`);
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
  unverified: 'waiting for the card and identity verification',
  open: 'open',
  won: 'won — name registered',
  refunded: 'closed — the maintainer claimed the name; nothing was charged',
  lapsed: 'lapsed',
  withdrawn: 'withdrawn',
};

export function offerState(o: OfferRecord): string {
  if (o.status === 'unverified' && o.organization?.identityVerified === true) return 'waiting for the card';
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
