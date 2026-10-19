import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  chooseTargets,
  detectPackages,
  existingBadge,
  expandGlobs,
  findReadmeIn,
  gitCheckout,
  nextSteps,
  openBadgePr,
  shellQuote,
  planBadge,
  readmeFor,
  sameRepo,
  setupCfgName,
  workspaceGlobs,
} from '../readme.js';

const TOKEN = 'rgstr_k3f9x2m8q1w7e5r4t6y0';
const BADGE = `[![rgstr](https://rgstr.org/registry/tsc-rs/badge.svg?proof=${TOKEN})](https://rgstr.org/registry/tsc-rs)`;

async function tmp(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rgstr-readme-'));
  for (const [f, c] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, f)), { recursive: true });
    await fs.writeFile(path.join(dir, f), c);
  }
  return dir;
}

describe('README detection', () => {
  it('finds the README next to the manifest, any case, preferring .md', async () => {
    expect(path.basename((await findReadmeIn(await tmp({ 'Readme.md': '', 'package.json': '{}' })))!)).toBe('Readme.md');
    expect(path.basename((await findReadmeIn(await tmp({ README: '', 'readme.rst': '' })))!)).toBe('README');
    expect(await findReadmeIn(await tmp({ 'package.json': '{}' }))).toBeNull();
    expect(await findReadmeIn('/nonexistent/dir')).toBeNull();
  });

  it('falls back to the repo root README for a single package in a subdirectory', async () => {
    const root = await tmp({ 'README.md': '# mono', 'packages/a/package.json': '{"name":"a"}' });
    const a = { name: 'a', ecosystem: 'npm' as const, manifest: path.join(root, 'packages/a/package.json'), dir: path.join(root, 'packages/a') };
    expect(await readmeFor(a, root, true)).toEqual({ file: path.join(root, 'README.md'), exists: true, where: 'fallback' });
    expect(await readmeFor(a, root, false)).toEqual({ file: path.join(root, 'packages/a/README.md'), exists: false, where: 'own' });
    await fs.writeFile(path.join(root, 'packages/a/readme.md'), '# a');
    expect(await readmeFor(a, root, true)).toEqual({ file: path.join(root, 'packages/a/readme.md'), exists: true, where: 'own' });
  });
});

  it('puts the badge where the declared repository points, not next to the manifest', async () => {
    const root = await tmp({ 'README.md': '# mono', 'packages/a/package.json': '{"name":"a"}', 'packages/a/README.md': '# a', 'packages/b/package.json': '{"name":"b"}' });
    const a = { name: 'a', ecosystem: 'npm' as const, manifest: path.join(root, 'packages/a/package.json'), dir: path.join(root, 'packages/a') };
    const b = { name: 'b', ecosystem: 'npm' as const, manifest: path.join(root, 'packages/b/package.json'), dir: path.join(root, 'packages/b') };
    // npm says the repo root (no `repository.directory`): rgstr reads the root README, so the badge goes there.
    expect(await readmeFor(a, root, true, null)).toEqual({ file: path.join(root, 'README.md'), exists: true, where: 'root' });
    expect(await readmeFor(a, root, false, null)).toEqual({ file: path.join(root, 'README.md'), exists: true, where: 'root' });
    // npm says this folder: its own README (created if missing).
    expect(await readmeFor(a, root, false, 'packages/a')).toEqual({ file: path.join(root, 'packages/a/README.md'), exists: true, where: 'own' });
    expect(await readmeFor(b, root, false, './packages/b/')).toEqual({ file: path.join(root, 'packages/b/README.md'), exists: false, where: 'own' });
    // npm says a different folder: that folder's README.
    expect(await readmeFor(b, root, false, 'packages/a')).toEqual({ file: path.join(root, 'packages/a/README.md'), exists: true, where: 'declared' });
    // a package at the repo root with no directory hint: its own README.
    const r = { name: 'r', ecosystem: 'npm' as const, manifest: path.join(root, 'package.json'), dir: root };
    expect(await readmeFor(r, root, true, null)).toEqual({ file: path.join(root, 'README.md'), exists: true, where: 'own' });
    // no declared repository at all: the old own → root fallback.
    expect(await readmeFor(b, root, true)).toEqual({ file: path.join(root, 'README.md'), exists: true, where: 'fallback' });
  });

describe('package detection', () => {
  it('reads setup.cfg names', () => {
    expect(setupCfgName('[metadata]\nname = requests\nversion = 1\n')).toBe('requests');
    expect(setupCfgName('[options]\nname = nope\n')).toBeNull();
  });

  it('lists workspace members from pnpm, npm/yarn and uv manifests and skips private roots', async () => {
    const root = await tmp({
      'package.json': '{"name":"root","private":true,"workspaces":["packages/*"]}',
      'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n  - tools/cli\n  - '!**/test/**'\n",
      'pyproject.toml': '[project]\nname = "py-root"\n[tool.uv.workspace]\nmembers = ["py/*"]\n',
      'packages/a/package.json': '{"name":"@acme/a","version":"1.0.0"}',
      'packages/b/package.json': '{"name":"@acme/b"}',
      'packages/c/package.json': '{"name":"@acme/c","private":true}',
      'tools/cli/package.json': '{"name":"acme-cli"}',
      'py/lib/pyproject.toml': '[project]\nname = "acme-lib"\n',
      'py/old/setup.cfg': '[metadata]\nname = acme-old\n',
    });
    expect(await workspaceGlobs(root)).toEqual(['packages/*', 'tools/cli', 'py/*']);
    expect((await expandGlobs(root, ['packages/*', 'tools/cli', 'missing/*'])).map((d) => path.relative(root, d))).toEqual(['packages/a', 'packages/b', 'packages/c', 'tools/cli']);
    await fs.mkdir(path.join(root, 'packages/group/deep'), { recursive: true });
    await fs.writeFile(path.join(root, 'packages/group/deep/package.json'), '{"name":"@acme/deep"}');
    expect((await expandGlobs(root, ['packages/**'])).map((d) => path.relative(root, d))).toEqual(['packages', 'packages/a', 'packages/b', 'packages/c', 'packages/group', 'packages/group/deep']);
    const deepRoot = await tmp({ 'package.json': '{"name":"r","private":true,"workspaces":["packages/**"]}', 'packages/group/deep/package.json': '{"name":"@acme/deep"}' });
    expect((await detectPackages(deepRoot)).map((t) => t.name)).toEqual(['@acme/deep']);
    await fs.rm(path.join(root, 'packages/group'), { recursive: true });
    const found = await detectPackages(root);
    expect(found.map((t) => `${t.ecosystem}:${t.name}`)).toEqual(['npm:@acme/a', 'npm:@acme/b', 'pypi:acme-lib', 'pypi:acme-old', 'npm:acme-cli']);
    expect(found[0]).toMatchObject({ version: '1.0.0', dir: path.join(root, 'packages/a') });
  });

  it('never claims a whole workspace implicitly', () => {
    const a = { name: '@acme/a', ecosystem: 'npm' as const, manifest: '/m/packages/a/package.json', dir: '/m/packages/a' };
    const b = { name: '@acme/b', ecosystem: 'npm' as const, manifest: '/m/packages/b/package.json', dir: '/m/packages/b' };
    expect(chooseTargets([a, b], true, {})).toEqual({ kind: 'workspace', names: ['@acme/a', '@acme/b'] });
    expect(chooseTargets([a, b], true, { all: true })).toEqual({ kind: 'targets', targets: [a, b] });
    expect(chooseTargets([a, b], true, { name: '@acme/b' })).toEqual({ kind: 'targets', targets: [b] });
    expect(chooseTargets([a, b], true, { name: 'other' })).toEqual({ kind: 'targets', targets: [] });
    expect(chooseTargets([a], false, {})).toEqual({ kind: 'targets', targets: [a] });
    expect(chooseTargets([], true, {})).toEqual({ kind: 'workspace', names: [] });
  });

  it('is just the one package outside a workspace', async () => {
    const dir = await tmp({ 'package.json': '{"name":"solo"}' });
    expect((await detectPackages(dir)).map((t) => t.name)).toEqual(['solo']);
    expect(await workspaceGlobs(dir)).toEqual([]);
  });
});

describe('remote matching', () => {
  it.each([
    ['https://github.com/pingdotgg/ts-rust', 'git@github.com:pingdotgg/ts-rust.git', true],
    ['https://github.com/pingdotgg/ts-rust.git', 'https://github.com/pingdotgg/ts-rust/', true],
    ['git+https://github.com/PingDotGG/TS-Rust.git', 'ssh://git@github.com/pingdotgg/ts-rust', true],
    ['https://github.com/pingdotgg/ts-rust', 'https://github.com/someone/ts-rust', false],
    ['https://github.com/pingdotgg/ts-rust', null, false],
    [null, null, false],
  ])('%s vs %s → %s', (a, b, want) => {
    expect(sameRepo(a, b)).toBe(want);
  });

  it('reads the checkout root, origin and branch through git', async () => {
    const exec = (async (_cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { stdout: '/work/ts-rust\n', stderr: '' };
      if (args[0] === 'config') return { stdout: 'git@github.com:pingdotgg/ts-rust.git\n', stderr: '' };
      return { stdout: 'main\n', stderr: '' };
    }) as never;
    expect(await gitCheckout('/work/ts-rust/packages/x', exec)).toEqual({ root: '/work/ts-rust', remote: 'https://github.com/pingdotgg/ts-rust', branch: 'main' });
    const noGit = (async () => {
      throw new Error('not a git repository');
    }) as never;
    expect(await gitCheckout('/tmp', noGit)).toBeNull();
    const noRemote = (async (_cmd: string, args: string[]) => {
      if (args[0] === 'config') throw new Error('no such key');
      return { stdout: args[0] === 'rev-parse' && args[1] === '--show-toplevel' ? '/work/x\n' : 'main\n', stderr: '' };
    }) as never;
    expect(await gitCheckout('/work/x', noRemote)).toEqual({ root: '/work/x', remote: null, branch: 'main' });
  });
});

describe('badge placement', () => {
  it('goes directly under the first H1', () => {
    const plan = planBadge('# tsc-rs\n\nA Rust port.\n', 'tsc-rs', BADGE);
    expect(plan.kind).toBe('insert');
    expect(plan.kind === 'insert' && plan.next).toBe(`# tsc-rs\n\n${BADGE}\n\nA Rust port.\n`);
  });

  it('goes to the top when there is no H1, and makes the file when there is none', () => {
    const plan = planBadge('Some intro\n\n## Usage\n', 'tsc-rs', BADGE);
    expect(plan.kind === 'insert' && plan.next).toBe(`${BADGE}\n\nSome intro\n\n## Usage\n`);
    expect(planBadge(null, 'tsc-rs', BADGE)).toEqual({ kind: 'insert', next: `${BADGE}\n` });
  });

  it('recognises an existing badge for the name, with or without the token, and replaces a stale one', () => {
    const same = `# x\n\n${BADGE}\n`;
    expect(planBadge(same, 'tsc-rs', BADGE)).toMatchObject({ kind: 'present', old: { token: TOKEN } });
    const stale = `# x\n\n[![rgstr](https://rgstr.org/registry/tsc-rs/badge.svg?proof=rgstr_old)](https://rgstr.org/registry/tsc-rs)\n`;
    const plan = planBadge(stale, 'tsc-rs', BADGE);
    expect(plan).toMatchObject({ kind: 'replace', old: { token: 'rgstr_old' } });
    expect(plan.kind === 'replace' && plan.next).toBe(same);
    expect(existingBadge('[![rgstr](https://rgstr.org/tsc-rs/badge.svg)](https://rgstr.org/tsc-rs)', 'tsc-rs')).toMatchObject({ token: null });
    // another package's badge does not count
    expect(existingBadge(`[![rgstr](https://rgstr.org/registry/other/badge.svg?proof=x)](https://rgstr.org/registry/other)`, 'tsc-rs')).toBeNull();
    expect(existingBadge(`[![rgstr](https://rgstr.org/registry/@scope/pkg/badge.svg?proof=x)](https://rgstr.org/registry/@scope/pkg)`, '@scope/pkg')).not.toBeNull();
  });
});

describe('after the write', () => {
  it('tells you how to land it, shell-safe', () => {
    expect(nextSteps(['README.md'], ['tsc-rs'])).toEqual([
      'git add -- README.md && git commit -m "Add rgstr badge" && git push',
      'open a pull request with that commit and merge it',
      'rgstr claim --check tsc-rs',
    ]);
    expect(nextSteps(['my docs/README.md'], ['@scope/pkg', 'x;rm -rf ~'])).toEqual([
      `git add -- 'my docs/README.md' && git commit -m "Add rgstr badge" && git push`,
      'open a pull request with that commit and merge it',
      'rgstr claim --check @scope/pkg',
      `rgstr claim --check 'x;rm -rf ~'`,
    ]);
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it('--pr: branch, commit, push, gh pr create — or say why not, touching nothing', async () => {
    const calls: string[] = [];
    const checkout = { root: '/work/ts-rust', remote: 'https://github.com/pingdotgg/ts-rust', branch: 'main' };
    const ok = (async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args.slice(0, cmd === 'git' && args[0] === 'commit' ? 5 : 3)].join(' '));
      if (cmd === 'gh' && args[0] === 'pr') return { stdout: 'Creating pull request…\nhttps://github.com/pingdotgg/ts-rust/pull/42\n', stderr: '' };
      return { stdout: '', stderr: '' };
    }) as never;
    expect(await openBadgePr(checkout, ['/work/ts-rust/README.md'], ['tsc-rs'], ok)).toEqual({ url: 'https://github.com/pingdotgg/ts-rust/pull/42', branch: 'rgstr-badge-tsc-rs' });
    expect(calls).toEqual([
      'gh auth status',
      'git checkout -b rgstr-badge-tsc-rs',
      'git add -- /work/ts-rust/README.md',
      'git commit -m Add rgstr badge -- /work/ts-rust/README.md',
      'git push -u origin',
      'gh pr create --title',
    ]);
    expect((await openBadgePr(checkout, ['a'], ['@scope/a', 'b'], ok)).branch).toBe('rgstr-badges');

    const missing = (async () => {
      throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    }) as never;
    expect(await openBadgePr(checkout, ['README.md'], ['tsc-rs'], missing)).toEqual({ url: null, branch: 'rgstr-badge-tsc-rs', reason: '`gh` is not on PATH' });
    const loggedOut = (async () => {
      throw Object.assign(new Error('You are not logged into any GitHub hosts'), { code: 1 });
    }) as never;
    expect((await openBadgePr(checkout, ['README.md'], ['tsc-rs'], loggedOut)).reason).toMatch(/not signed in/);
  });
});

describe('readmeFor ignores declared directories outside the checkout', () => {
  it('treats `..` and absolute directories as undeclared', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rgstr-readme-'));
    await fs.mkdir(path.join(root, 'packages', 'a'), { recursive: true });
    await fs.writeFile(path.join(root, 'README.md'), '# root\n');
    const target = { dir: path.join(root, 'packages', 'a'), manifest: path.join(root, 'packages', 'a', 'package.json') } as Parameters<typeof readmeFor>[0];
    for (const bad of ['../../etc', 'packages/../../x', '/tmp/x']) {
      const pick = await readmeFor(target, root, false, bad);
      expect(pick.where).toBe('own');
      expect(pick.file).toBe(path.join(root, 'packages', 'a', 'README.md'));
    }
  });
});
