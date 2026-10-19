// What `rgstr claim` prints: the README badge first (the proof a coding
// agent can land with one PR), an agent prompt that does exactly that, and
// the publish-proof manifest line as the fallback. Everything here is pure
// or network-only (public package metadata, never credentials) so the
// command's output is testable without the API.

import type { Ecosystem } from './project.js';

/** Same string the platform's badgeMarkdown() produces; used only when the
 *  API response carries no badge of its own. */
export function badgeMarkdown(origin: string, name: string, token: string): string {
  const page = `${origin.replace(/\/+$/, '')}/registry/${name}`;
  return `[![rgstr](${page}/badge.svg?proof=${token})](${page})`;
}

export function manifestSnippet(origin: string, name: string, token: string, ecosystem: Ecosystem): string {
  if (ecosystem === 'npm') return `"rgstr": "${token}"`;
  return `rgstr = "${origin.replace(/\/+$/, '')}/registry/${name}?proof=${token}"`;
}

/** `git+https://github.com/o/r.git`, `git@github.com:o/r.git`, `github:o/r`,
 *  `o/r`, or a tree URL → `https://github.com/o/r`. Other hosts come back
 *  cleaned; anything unparseable is null. */
export function repoUrlFrom(raw: unknown): string | null {
  const value = typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? (raw as { url?: unknown }).url : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  let s = value.trim().replace(/^git\+/, '');
  const short = s.match(/^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (short) return `https://github.com/${short[1]}/${short[2]}`;
  const ssh = s.match(/^(?:ssh:\/\/)?git@([\w.-]+)[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}/${ssh[3]}`;
  s = s.replace(/^git:\/\//, 'https://').replace(/^ssh:\/\//, 'https://');
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const repo = parts[1].replace(/\.git$/, '');
  return `https://${url.hostname}/${parts[0]}/${repo}`;
}

/** Where the package says its source lives, from public registry metadata:
 *  npm's packument via the rgstr proxy, PyPI's JSON API. No credentials. */
export async function fetchRepoUrl(
  origin: string,
  name: string,
  ecosystem: Ecosystem,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    if (ecosystem === 'npm') {
      const res = await fetchImpl(`${origin}/api/registry/${encodeURIComponent(name)}`, { headers: { accept: 'application/json' } });
      if (!res.ok) return null;
      const doc = (await res.json()) as { repository?: unknown; homepage?: unknown };
      return repoUrlFrom(doc.repository) ?? (typeof doc.homepage === 'string' && /github\.com/.test(doc.homepage) ? repoUrlFrom(doc.homepage) : null);
    }
    const res = await fetchImpl(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const doc = (await res.json()) as { info?: { project_urls?: Record<string, string> | null; home_page?: string | null } };
    const urls = Object.values(doc.info?.project_urls ?? {});
    const github = urls.find((u) => /github\.com/.test(u)) ?? (doc.info?.home_page && /github\.com/.test(doc.info.home_page) ? doc.info.home_page : undefined);
    return repoUrlFrom(github ?? urls[0] ?? null);
  } catch {
    return null;
  }
}

export interface ClaimPlan {
  name: string;
  ecosystem: Ecosystem;
  origin: string;
  badge: string;
  /** From the API when it sends one; otherwise built here. */
  agentPrompt: string;
  manifest: string;
  repoUrl: string | null;
}

export function describeRepo(name: string, ecosystem: Ecosystem, repoUrl: string | null): string {
  const index = ecosystem === 'npm' ? 'npm' : 'PyPI';
  return repoUrl ? `${repoUrl} (the repository ${name} declares on ${index})` : `the GitHub repository ${name} declares on ${index} (none found in its metadata yet)`;
}

/** One paragraph a coding agent can take verbatim. */
export function agentPrompt(p: Pick<ClaimPlan, 'name' | 'ecosystem' | 'badge' | 'repoUrl'>): string {
  const repo = p.repoUrl ? `the repository ${p.repoUrl}` : `the GitHub repository that publishes ${p.name}`;
  return (
    `In ${repo}, add this line near the top of README.md (right under the first heading), open a pull request containing only that change, and merge it: ` +
    `${p.badge} ` +
    `Do not change anything else and do not publish a release. ` +
    `Once it is merged, run \`npx @rgstr/cli claim --check ${p.name}\`; rgstr reads the badge from the repository's README on GitHub and verifies the claim.`
  );
}

export function buildClaimPlan(input: {
  name: string;
  ecosystem: Ecosystem;
  origin: string;
  token: string;
  repoUrl: string | null;
  badge?: string | null;
  agentPrompt?: string | null;
}): ClaimPlan {
  const badge = input.badge || badgeMarkdown(input.origin, input.name, input.token);
  const base = { name: input.name, ecosystem: input.ecosystem, origin: input.origin, badge, repoUrl: input.repoUrl };
  return {
    ...base,
    agentPrompt: input.agentPrompt || agentPrompt(base),
    manifest: manifestSnippet(input.origin, input.name, input.token, input.ecosystem),
  };
}

const indent = (text: string, by = '   ') => text.split('\n').map((l) => (l ? by + l : l)).join('\n');

/** The default `rgstr claim` body, in the order a maintainer needs it:
 *  badge → agent prompt → release fallback. */
export function renderClaimPlan(p: ClaimPlan): string {
  const manifestFile = p.ecosystem === 'npm' ? 'package.json' : 'pyproject.toml, under [project.urls]';
  return [
    `1. Add this badge to the README of ${describeRepo(p.name, p.ecosystem, p.repoUrl)}:`,
    '',
    indent(p.badge),
    '',
    `   Merge it, then run: rgstr claim --check ${p.name}`,
    '',
    '2. Or hand this to your coding agent:',
    '',
    indent('```\n' + p.agentPrompt + '\n```'),
    '',
    `3. Or ship it in your next release — add to ${manifestFile}:`,
    '',
    indent(p.manifest),
    '',
    `   (\`rgstr claim --write\` adds it for you.) Publish, then: rgstr claim --check ${p.name}`,
  ].join('\n');
}

export interface ProofSightingLike {
  ecosystem?: string;
  placement?: string;
  version?: string;
  repo?: string | null;
  repoUrl?: string | null;
}

/** Which proof matched, for `--check`: badge on github.com/o/r,
 *  package.json@1.2.3, README-in-package@1.2.3. Unknown placements the API
 *  may add later fall through to its own words. */
export function proofKindLabel(o: { sighting?: ProofSightingLike | null; repoUrl?: string | null; detail?: string }): string {
  const s = o.sighting ?? {};
  const repo = s.repo ?? s.repoUrl ?? o.repoUrl ?? null;
  const at = s.version ? `@${s.version}` : '';
  if (s.placement === 'manifest') return `${s.ecosystem === 'pypi' ? 'pyproject.toml' : 'package.json'}${at}`;
  if (s.placement === 'readme') return `README-in-package${at}`;
  if (repo || (s.placement && /badge|github/.test(s.placement))) {
    return `badge on ${repo ? repo.replace(/^https?:\/\//, '') : 'GitHub'}`;
  }
  return o.detail ?? 'proof';
}
