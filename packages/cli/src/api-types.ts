/** Shapes rgstr.org answers with on its public reads (whois, search). */
import type { RouteRecord } from './routes.js';

export interface WhoisResponse {
  name: string;
  url: string;
  trust: 'unclaimed' | 'claimed' | 'verified';
  state: 'unclaimed' | 'pending' | 'held' | 'disputed';
  holder: { name: string; slug: string; url: string; via: string; kind: string; status: string } | null;
  routes: RouteRecord[];
  hiddenCopies: number | null;
}

export interface SearchObject {
  package: { name: string; version?: string; description?: string };
  rgstr: {
    trust: string;
    /** The claiming organization's display name (the API sends a string), or null when unclaimed. */
    owner?: string | null;
    tier: string;
    demotion?: { kind: 'sibling' | 'namesake' | 'copy'; of: string } | null;
    weeklyDownloads?: number | null;
  };
}
