/** Shapes rgstr.org answers with on its public reads (whois, search). */
import type { RouteRecord } from './routes.js';

export interface WhoisResponse {
  name: string;
  url: string;
  trust: 'unclaimed' | 'claimed' | 'verified';
  /** `registered`: an identity-verified organization won an offer on the name; no maintainer has claimed it. */
  state: 'unclaimed' | 'pending' | 'held' | 'disputed' | 'registered';
  holder: { name: string; slug: string; url: string; via: string; kind: string; status: string } | null;
  routes: RouteRecord[];
  hiddenCopies: number | null;
  /** The organization that registered the name (state `registered`); older servers send nothing. */
  registrant?: { name: string; slug: string; url: string; identityVerified: boolean } | null;
  /** The name a registered name resolves to through rgstr: a name the registrant claims. */
  routesTo?: string | null;
  /** An offer whose 30-day window is open on this unclaimed name. */
  openOffer?: OpenOffer | null;
}

export interface OpenOffer {
  amountUsd: number;
  /** The offering organization's display name. */
  by: string;
  windowClosesAt: string;
}

export interface SearchObject {
  package: { name: string; version?: string; description?: string };
  rgstr: {
    trust: string;
    /** `registered` when an organization registered the name through an offer; `owner` is then the registrant. */
    state?: string | null;
    /** The claiming (or registering) organization's display name (the API sends a string), or null when unclaimed. */
    owner?: string | null;
    tier: string;
    demotion?: { kind: 'sibling' | 'namesake' | 'copy'; of: string } | null;
    weeklyDownloads?: number | null;
  };
}
