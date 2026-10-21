import { describe, it, expect } from 'vitest';
import { agentPrompt, badgeMarkdown, buildClaimPlan, fetchRepoUrl, proofKindLabel, renderClaimPlan, repoDirectoryFrom, repoUrlFrom } from '../claim.js';

const ORIGIN = 'https://rgstr.org';
const TOKEN = 'rgstr_abcdefghijklmnopqrst';
const BADGE = `[![rgstr](https://rgstr.org/registry/tsc-rs/badge.svg?proof=${TOKEN})](https://rgstr.org/registry/tsc-rs)`;

describe('claim output', () => {
  it('builds the same badge as the server', () => {
    expect(badgeMarkdown(ORIGIN, 'tsc-rs', TOKEN)).toBe(BADGE);
    expect(badgeMarkdown('https://rgstr.org/', '@scope/pkg', TOKEN)).toContain('/registry/@scope/pkg/badge.svg?proof=');
  });

  it('prints badge, then the agent prompt, then the package-README route — never a manifest line', () => {
    const plan = buildClaimPlan({ name: 'tsc-rs', ecosystem: 'npm', origin: ORIGIN, token: TOKEN, repoUrl: 'https://github.com/pingdotgg/ts-rust' });
    const out = renderClaimPlan(plan);
    const badgeAt = out.indexOf(BADGE);
    const promptAt = out.indexOf('2. Or hand this to your coding agent');
    const hereAt = out.indexOf('3. Or put the same badge in the README that ships with the package (`rgstr claim --here` in its checkout);');
    expect(badgeAt).toBeGreaterThan(-1);
    expect(badgeAt).toBeLessThan(promptAt);
    expect(promptAt).toBeLessThan(hereAt);
    expect(out).toContain('Add this badge to the README of https://github.com/pingdotgg/ts-rust (the repository tsc-rs declares on npm)');
    expect(out).toContain('Merge it, then run: rgstr claim --check tsc-rs');
    expect(out).toContain('```\n   In a checkout of the repository https://github.com/pingdotgg/ts-rust, run `npx @rgstr/cli claim --yes --pr tsc-rs`');
    expect(out).toContain('rgstr reads it on the next publish to npm. Publish, then: rgstr claim --check tsc-rs');
    expect(out).not.toContain('"rgstr":');
    expect(out).not.toMatch(/package\.json|pyproject|--write|manifest/);
    expect(plan).not.toHaveProperty('manifest');
  });

  it('says so when the package declares no repository', () => {
    const plan = buildClaimPlan({ name: 'newpkg', ecosystem: 'pypi', origin: ORIGIN, token: TOKEN, repoUrl: null });
    expect(renderClaimPlan(plan)).toContain('the GitHub repository newpkg declares on PyPI (none found in its metadata yet)');
    expect(plan.agentPrompt).toContain('the GitHub repository that publishes newpkg');
    expect(renderClaimPlan(plan)).toContain('rgstr reads it on the next publish to PyPI');
    expect(renderClaimPlan(plan)).not.toMatch(/\[project\.urls\]|pyproject/);
  });

  it('is one paragraph the agent can take verbatim: PR, merge, claim --check, no release', () => {
    const prompt = agentPrompt({ name: 'tsc-rs', ecosystem: 'npm', badge: BADGE, repoUrl: 'https://github.com/pingdotgg/ts-rust' });
    expect(prompt.split('\n')).toHaveLength(1);
    expect(prompt).toContain(BADGE);
    expect(prompt).toContain('npx @rgstr/cli claim --yes --pr tsc-rs');
    expect(prompt).toContain('open a pull request');
    expect(prompt).toMatch(/merge it/i);
    expect(prompt).toContain('npx @rgstr/cli claim --check tsc-rs');
    expect(prompt).toContain('do not publish a release');
    expect(prompt).not.toMatch(/package\.json|pyproject|manifest/);
  });

  it('prefers the badge and prompt the server sends', () => {
    const plan = buildClaimPlan({ name: 'tsc-rs', ecosystem: 'npm', origin: ORIGIN, token: TOKEN, repoUrl: null, badge: '[![x](https://rgstr.org/tsc-rs/badge.svg?proof=t)](https://rgstr.org/tsc-rs)', agentPrompt: 'server prompt' });
    expect(plan.badge).toContain('https://rgstr.org/tsc-rs/badge.svg');
    expect(plan.agentPrompt).toBe('server prompt');
  });
});

describe('repository URLs', () => {
  it.each([
    ['git+https://github.com/pingdotgg/ts-rust.git', 'https://github.com/pingdotgg/ts-rust'],
    [{ type: 'git', url: 'git://github.com/o/r.git' }, 'https://github.com/o/r'],
    ['git@github.com:o/r.git', 'https://github.com/o/r'],
    ['github:o/r', 'https://github.com/o/r'],
    ['o/r', 'https://github.com/o/r'],
    ['https://github.com/o/r/tree/main/packages/x', 'https://github.com/o/r'],
    ['https://gitlab.com/o/r.git', 'https://gitlab.com/o/r'],
    ['', null],
    ['not a url', null],
    [undefined, null],
  ])('%s → %s', (raw, want) => {
    expect(repoUrlFrom(raw)).toBe(want);
  });

  it('reads npm metadata through rgstr and PyPI metadata from pypi.org, sending no credentials', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.startsWith('https://rgstr.org/api/registry/')) return new Response(JSON.stringify({ repository: { url: 'git+https://github.com/pingdotgg/ts-rust.git' } }));
      if (url.startsWith('https://pypi.org/pypi/')) return new Response(JSON.stringify({ info: { project_urls: { Homepage: 'https://x.dev', Source: 'https://github.com/psf/requests' } } }));
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;
    expect(await fetchRepoUrl(ORIGIN, '@scope/pkg', 'npm', fetchImpl)).toBe('https://github.com/pingdotgg/ts-rust');
    expect(calls[0].url).toBe('https://rgstr.org/api/registry/%40scope%2Fpkg');
    expect((calls[0].init?.headers as Record<string, string>).authorization).toBeUndefined();
    expect(await fetchRepoUrl(ORIGIN, 'requests', 'pypi', fetchImpl)).toBe('https://github.com/psf/requests');
    expect(calls[0].init?.redirect).toBe('manual');
    expect(await fetchRepoUrl(ORIGIN, 'missing', 'npm', (async () => new Response('', { status: 404 })) as unknown as typeof fetch)).toBeNull();
    expect(await fetchRepoUrl(ORIGIN, 'moved', 'npm', (async () => new Response('', { status: 302, headers: { location: 'http://10.0.0.1/' } })) as unknown as typeof fetch)).toBeNull();
    expect(await fetchRepoUrl(ORIGIN, 'down', 'npm', (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch)).toBeNull();
  });
});

describe('--check proof kinds', () => {
  it('readme → the badge in the published package, repo_readme → the badge on GitHub', () => {
    expect(proofKindLabel({ name: 'tsc-rs', sighting: { ecosystem: 'npm', placement: 'readme', version: '0.7.1' } })).toBe('README badge in tsc-rs@0.7.1 on npm');
    expect(proofKindLabel({ name: 'requests', sighting: { ecosystem: 'pypi', placement: 'readme', version: '2.32.0' } })).toBe('README badge in requests@2.32.0 on PyPI');
    expect(proofKindLabel({ name: 'tsc-rs', sighting: { placement: 'repo_readme', repo: 'https://github.com/pingdotgg/ts-rust' } })).toBe('README badge on github.com/pingdotgg/ts-rust');
    expect(proofKindLabel({ name: 'tsc-rs', sighting: { placement: 'repo_readme' }, repoUrl: 'https://github.com/o/r' })).toBe('README badge on github.com/o/r');
    expect(proofKindLabel({ sighting: { placement: 'repo_readme' } })).toBe('README badge on GitHub');
    expect(proofKindLabel({ repoUrl: 'https://github.com/o/r', detail: 'x' })).toBe('README badge on github.com/o/r');
  });

  it('renders a placement it does not know without crashing', () => {
    expect(proofKindLabel({ sighting: { placement: 'something_new' }, detail: 'the server said so' })).toBe('the server said so');
    expect(proofKindLabel({ sighting: { placement: 'something_new' } })).toBe('something new proof');
    expect(proofKindLabel({ sighting: { placement: 'manifest', version: '1.0' } })).toBe('manifest proof');
    expect(proofKindLabel({})).toBe('proof');
  });
});

describe('repoDirectoryFrom', () => {
  it('reads the monorepo folder from npm metadata, /tree/ URLs and the rgstr API shape', () => {
    expect(repoDirectoryFrom({ url: 'git+https://github.com/o/r.git', directory: 'packages/x' })).toBe('packages/x');
    expect(repoDirectoryFrom({ url: 'https://github.com/o/r', directory: './packages/x/' })).toBe('packages/x');
    expect(repoDirectoryFrom('https://github.com/o/r/tree/main/packages/x')).toBe('packages/x');
    expect(repoDirectoryFrom('https://github.com/o/r/packages/x')).toBe('packages/x');
    expect(repoDirectoryFrom('https://github.com/o/r')).toBeNull();
    expect(repoDirectoryFrom('https://github.com/o/r.git')).toBeNull();
    expect(repoDirectoryFrom('https://github.com/o/r/issues')).toBeNull();
    expect(repoDirectoryFrom('git@github.com:o/r.git')).toBeNull();
    expect(repoDirectoryFrom(null)).toBeNull();
  });

  it('fetchRepoUrl keeps npm\'s repository.directory as a /tree/HEAD/ URL', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ repository: { type: 'git', url: 'git+https://github.com/o/r.git', directory: 'packages/x' } }), { status: 200 })) as unknown as typeof fetch;
    expect(await fetchRepoUrl(ORIGIN, 'x', 'npm', fetchImpl)).toBe('https://github.com/o/r/tree/HEAD/packages/x');
  });
});

describe('fetchRepoUrl (PyPI)', () => {
  it('keeps a /tree/<ref>/<dir> project URL folder', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ info: { project_urls: { Source: 'https://github.com/o/r/tree/main/py/pkg' } } }), { status: 200 })) as unknown as typeof fetch;
    expect(await fetchRepoUrl('https://rgstr.org', 'pkg', 'pypi', fetchImpl)).toBe('https://github.com/o/r/tree/HEAD/py/pkg');
  });
});
