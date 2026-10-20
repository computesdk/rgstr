import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkRow, checkTableRows, mapLimit, parseNpmDependencies, parsePyprojectDependencies, parseRequirements, readDependencies, requirementName, summaryLine, unansweredRow, type Dependency, type WhoisLike } from '../check.js';
import { RgstrClient } from '../client.js';
import type { RouteRecord } from '../routes.js';

const dep = (name: string, ecosystem: 'npm' | 'pypi' = 'npm'): Dependency => ({ name, ecosystem, source: 'x', section: 'dependencies' });
const whois = (name: string, over: Partial<WhoisLike> = {}): WhoisLike => ({ name, url: `https://rgstr.org/registry/${name}`, trust: 'unclaimed', state: 'unclaimed', holder: null, routes: [], ...over });
const route = (upstreamName: string, versionRange = '*', upstreamKind: RouteRecord['upstreamKind'] = 'npm') => ({ id: 'r1', versionRange, upstreamKind, upstream: 'https://registry.npmjs.org', upstreamName, position: 0 });

describe('reading dependencies', () => {
  it('package.json: dependencies + devDependencies, aliases resolved, non-registry specs skipped', () => {
    const r = parseNpmDependencies(
      JSON.stringify({
        dependencies: { react: '^19', local: 'file:../x', ws: 'workspace:*', gh: 'github:a/b', short: 'a/b', shortRef: 'a/b#v1', ssh: 'git@github.com:a/b.git', url: 'https://x/y.tgz', alias: 'npm:zod@^3', scoped: 'npm:@scope/pkg@1', tag: 'latest' },
        devDependencies: { typescript: '^5', react: '^18' },
        peerDependencies: { ignored: '*' },
      }),
    );
    expect(r.deps.map((d) => d.name)).toEqual(['react', 'zod', '@scope/pkg', 'tag', 'typescript']);
    expect(r.deps.every((d) => d.ecosystem === 'npm')).toBe(true);
    expect(r.deps.find((d) => d.name === 'typescript')?.section).toBe('devDependencies');
    expect(r.skipped.map((s) => [s.name, s.spec])).toEqual([
      ['local', 'file:../x'],
      ['ws', 'workspace:*'],
      ['gh', 'github:a/b'],
      ['short', 'a/b'],
      ['shortRef', 'a/b#v1'],
      ['ssh', 'git@github.com:a/b.git'],
      ['url', 'https://x/y.tgz'],
    ]);
  });

  it('PEP 508 names: extras, markers, pins and comments stripped; URLs and options are not names', () => {
    expect(requirementName('FastAPI[all]>=0.1 ; python_version > "3.8"')).toBe('fastapi');
    expect(requirementName('Requests_Oauth.Lib == 2')).toBe('requests-oauth-lib');
    expect(requirementName('  numpy  # pinned')).toBe('numpy');
    expect(requirementName('-r other.txt')).toBeNull();
    expect(requirementName('-e .')).toBeNull();
    expect(requirementName('https://x/y.whl')).toBeNull();
    expect(requirementName('pkg @ https://x/y.whl')).toBeNull();
    expect(requirementName('# only a comment')).toBeNull();
  });

  it('pyproject.toml: [project] dependencies (multi-line), optional groups, dependency-groups, poetry tables', () => {
    const deps = parsePyprojectDependencies(`
[project]
name = "demo"
dependencies = [
  "requests>=2",  # http
  'Pydantic[email]',
  "a-url @ https://example/x.whl",
]

[project.optional-dependencies]
test = ["pytest", "requests"]

[dependency-groups]
dev = ["ruff"]

[tool.poetry.dependencies]
python = "^3.11"
httpx = "^0.27"
"local-thing" = { path = "../x" }

[tool.poetry.group.dev.dependencies]
mypy = "*"

[[tool.poetry.source]]
name = "private"
url = "https://pypi.example/simple"
priority = "supplemental"

[tool.other]
dependencies = ["not-this"]
`);
    expect(deps.map((d) => [d.name, d.section])).toEqual([
      ['requests', 'dependencies'],
      ['pydantic', 'dependencies'],
      ['pytest', 'optional-dependencies.test'],
      ['ruff', 'dependency-groups.dev'],
      ['httpx', 'tool.poetry.dependencies'],
      ['mypy', 'tool.poetry.group.dev'],
    ]);
    expect(deps.every((d) => d.ecosystem === 'pypi')).toBe(true);
  });

  it('requirements.txt: one name per line', () => {
    expect(parseRequirements('requests>=2\nFastAPI[all]==0.1 \\\n  --hash=sha256:x\n-r other.txt\n\n# c\nrequests\n').map((d) => d.name)).toEqual(['requests', 'fastapi']);
  });

  it('reads every manifest in a directory and dedupes across them', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rgstr-check-'));
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { react: '^19' } }));
    await fs.writeFile(path.join(dir, 'pyproject.toml'), '[project]\ndependencies = ["requests"]\n');
    await fs.writeFile(path.join(dir, 'requirements.txt'), 'requests\nnumpy\n');
    const r = await readDependencies(dir);
    expect(r.files).toEqual(['package.json', 'pyproject.toml', 'requirements.txt']);
    expect(r.deps.map((d) => `${d.ecosystem}:${d.name}`)).toEqual(['npm:react', 'pypi:requests', 'pypi:numpy']);
    expect(await readDependencies(path.join(dir, 'nothing-here'))).toEqual({ deps: [], skipped: [], files: [] });
  });
});

describe('rows and the summary line', () => {
  it('unclaimed and pending names are served from the index unchanged', () => {
    expect(checkRow(dep('react'), whois('react'))).toMatchObject({ held: false, holder: null, trust: 'unclaimed', servedFrom: 'npm (unchanged)' });
    const pending = checkRow(dep('requests', 'pypi'), whois('requests', { state: 'pending' }));
    expect(pending).toMatchObject({ held: false, holder: null, servedFrom: 'PyPI (unchanged)' });
    expect(checkTableRows([pending])[0]).toEqual(['requests', 'unclaimed (application pending)', '—', 'PyPI (unchanged)']);
  });

  it('claimed names name the claimant and where it serves them from', () => {
    const holder = { name: 'ComputeSDK', slug: 'computesdk' };
    expect(checkRow(dep('computesdk'), whois('computesdk', { trust: 'claimed', state: 'held', holder }))).toMatchObject({
      held: true,
      holder: 'computesdk',
      servedFrom: "npm:computesdk (claimant's default)",
    });
    const routed = checkRow(dep('tsc'), whois('tsc', { trust: 'verified', state: 'held', holder, routes: [route('tsc-rs', '^0.7'), route('tsc-rs', '*', 'jsr')] }));
    expect(routed.servedFrom).toBe('npm:tsc-rs@^0.7, jsr:tsc-rs (claimant route)');
    expect(routed.routes[0]).toEqual({ versionRange: '^0.7', upstreamKind: 'npm', upstream: 'https://registry.npmjs.org', upstreamName: 'tsc-rs' });
    const disputed = checkRow(dep('zod'), whois('zod', { trust: 'claimed', state: 'disputed', holder }));
    expect(checkTableRows([disputed])[0][1]).toBe('claimed (disputed)');
  });

  it('an unanswered name shows the reason and counts as not claimed', () => {
    const row = unansweredRow(dep('Bad Name'), 'Invalid package name');
    expect(row).toMatchObject({ held: false, trust: null, servedFrom: 'npm (unchanged)', error: 'Invalid package name' });
    expect(checkTableRows([row])[0][1]).toBe('? (Invalid package name)');
  });

  it('summary: claimed count out of total, and that the rest are untouched', () => {
    const holder = { name: 'ComputeSDK', slug: 'computesdk' };
    const held = checkRow(dep('computesdk'), whois('computesdk', { trust: 'claimed', state: 'held', holder }));
    const npmFree = checkRow(dep('react'), whois('react'));
    const pyFree = checkRow(dep('requests', 'pypi'), whois('requests'));
    expect(summaryLine([held, npmFree, pyFree])).toBe('1 of 3 names are claimed on rgstr; the rest fall through to npm / PyPI unchanged.');
    expect(summaryLine([held, npmFree])).toBe('1 of 2 names are claimed on rgstr; the rest fall through to npm unchanged.');
    expect(summaryLine([npmFree, pyFree])).toBe('0 of 2 names are claimed on rgstr; all of them fall through to npm / PyPI unchanged.');
    expect(summaryLine([npmFree])).toBe('0 of 1 name is claimed on rgstr; all of them fall through to npm unchanged.');
    expect(summaryLine([held])).toBe('1 of 1 name is claimed on rgstr; every install here resolves where its claimant says.');
    expect(summaryLine([])).toBe('No names to check.');
  });
});

describe('lookups', () => {
  it('asks whois once per name through the client, at most 8 in flight, results in order', async () => {
    const calls: string[] = [];
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      const name = decodeURIComponent(u.split('/whois/')[1]);
      return new Response(JSON.stringify(whois(name, name === 'computesdk' ? { trust: 'claimed', state: 'held', holder: { name: 'ComputeSDK', slug: 'computesdk' } } : {})), { status: 200 });
    }) as typeof fetch;
    const c = new RgstrClient({ baseUrl: 'https://rgstr.org', token: null, kind: 'none', org: null }, fetchImpl);
    const deps = ['computesdk', '@scope/pkg', ...Array.from({ length: 18 }, (_, i) => `dep${i}`)].map((n) => dep(n));
    const rows = await mapLimit(deps, 8, async (d) => checkRow(d, await c.get<WhoisLike>(`/api/v1/registry/whois/${encodeURIComponent(d.name)}`)));
    expect(rows.map((r) => r.name)).toEqual(deps.map((d) => d.name));
    expect(rows[0].held).toBe(true);
    expect(calls).toHaveLength(20);
    expect(calls[1]).toBe('https://rgstr.org/api/v1/registry/whois/%40scope%2Fpkg');
    expect(peak).toBeLessThanOrEqual(8);
    expect(peak).toBeGreaterThan(1);
  });
});
