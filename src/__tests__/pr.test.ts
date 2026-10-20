// `--pr` against real git: a bare "origin" that has moved on since the clone.
import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { defaultBranch, openBadgePr, planBadge } from '../readme.js';

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await run('git', args, { cwd })).stdout.trim();
const OTHER = '[![rgstr](https://rgstr.org/registry/other/badge.svg?proof=rgstr_other)](https://rgstr.org/registry/other)';
const BADGE = '[![rgstr](https://rgstr.org/registry/tsc-rs/badge.svg?proof=rgstr_tscrs)](https://rgstr.org/registry/tsc-rs)';

/** Real git, fake gh. */
const exec = (async (cmd: string, args: string[], opts: { cwd: string }) => {
  if (cmd !== 'gh') return run(cmd, args, opts);
  if (args[0] === 'auth') return { stdout: '', stderr: '' };
  if (args[0] === 'repo') return { stdout: 'main\n', stderr: '' };
  if (args[0] === 'pr') return { stdout: `https://github.com/acme/proj/pull/7\n`, stderr: '' };
  throw new Error(`unexpected gh ${args.join(' ')}`);
}) as typeof run;

beforeAll(() => {
  for (const k of ['GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME']) process.env[k] = 'rgstr test';
  for (const k of ['GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL']) process.env[k] = 'test@rgstr.invalid';
});

async function repos() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rgstr-pr-'));
  const bare = path.join(tmp, 'origin.git');
  const seed = path.join(tmp, 'seed');
  const clone = path.join(tmp, 'clone');
  await run('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  await fs.mkdir(seed);
  await git(seed, 'init', '-q', '-b', 'main');
  await fs.writeFile(path.join(seed, 'README.md'), '# proj\n\nv1\n');
  await git(seed, 'add', 'README.md');
  await git(seed, 'commit', '-q', '-m', 'v1');
  await git(seed, 'remote', 'add', 'origin', bare);
  await git(seed, 'push', '-q', '-u', 'origin', 'main');
  await run('git', ['clone', '-q', bare, clone]);
  return { bare, seed, clone };
}

describe('rgstr claim --pr', () => {
  it('branches from origin/<default> as it is now, not the stale local main, and puts the badge below an existing one', async () => {
    const { bare, seed, clone } = await repos();
    const staleMain = await git(clone, 'rev-parse', 'main');
    // Someone else's badge lands on origin after the clone.
    await fs.writeFile(path.join(seed, 'README.md'), `# proj\n\n${OTHER}\n\nv1\n`);
    await git(seed, 'commit', '-q', '-am', 'other badge');
    await git(seed, 'push', '-q');
    const originHead = await git(seed, 'rev-parse', 'HEAD');
    expect(originHead).not.toBe(staleMain);
    // What `rgstr claim --yes` wrote into the stale checkout.
    const stale = await fs.readFile(path.join(clone, 'README.md'), 'utf8');
    await fs.writeFile(path.join(clone, 'README.md'), (planBadge(stale, 'tsc-rs', BADGE) as { next: string }).next);

    const checkout = { root: clone, remote: 'https://github.com/acme/proj', branch: 'main' };
    const pr = await openBadgePr(checkout, [{ file: path.join(clone, 'README.md'), name: 'tsc-rs', badge: BADGE }], exec);
    expect(pr).toEqual({ url: 'https://github.com/acme/proj/pull/7', branch: 'rgstr-badge-tsc-rs' });

    expect(await git(bare, 'rev-parse', 'rgstr-badge-tsc-rs^')).toBe(originHead);
    expect(await git(bare, 'rev-parse', 'rgstr-badge-tsc-rs^')).not.toBe(staleMain);
    const readme = (await run('git', ['show', 'rgstr-badge-tsc-rs:README.md'], { cwd: bare })).stdout;
    expect(readme).toBe(`# proj\n\n${OTHER}\n${BADGE}\n\nv1\n`);
    // The user's checkout is left where it was; the worktree is gone.
    expect(await git(clone, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect((await git(clone, 'worktree', 'list')).split('\n')).toHaveLength(1);
  });

  it('a single-branch clone of another branch still branches from the default branch', async () => {
    const { bare, seed } = await repos();
    await git(seed, 'checkout', '-q', '-b', 'feature');
    await fs.writeFile(path.join(seed, 'feature.txt'), 'f\n');
    await git(seed, 'add', 'feature.txt');
    await git(seed, 'commit', '-q', '-m', 'feature');
    await git(seed, 'push', '-q', '-u', 'origin', 'feature');
    const originMain = await git(bare, 'rev-parse', 'main');
    const clone = path.join(path.dirname(bare), 'single');
    await run('git', ['clone', '-q', '--single-branch', '-b', 'feature', bare, clone]);
    await expect(git(clone, 'rev-parse', '--verify', 'origin/main')).rejects.toThrow();

    const checkout = { root: clone, remote: 'https://github.com/acme/proj', branch: 'feature' };
    const pr = await openBadgePr(checkout, [{ file: path.join(clone, 'README.md'), name: 'tsc-rs', badge: BADGE }], exec);
    expect(pr.url).toBe('https://github.com/acme/proj/pull/7');
    expect(await git(bare, 'rev-parse', 'rgstr-badge-tsc-rs^')).toBe(originMain);
    expect(await git(clone, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature');
  });

  it('asks the remote for the default branch, so a rename is seen at once; gh and origin/HEAD are fallbacks', async () => {
    const { bare, clone, seed } = await repos();
    expect(await defaultBranch(clone, exec)).toBe('main');
    // Renamed on the remote after the clone: origin/HEAD and the fake gh still say main.
    await git(seed, 'branch', '-m', 'main', 'trunk');
    await git(seed, 'push', '-q', 'origin', 'trunk');
    await git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/trunk');
    expect(await git(clone, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')).toBe('origin/main');
    expect(await defaultBranch(clone, exec)).toBe('trunk');

    const pr = await openBadgePr({ root: clone, remote: 'https://github.com/acme/proj', branch: 'main' }, [{ file: path.join(clone, 'README.md'), name: 'tsc-rs', badge: BADGE }], exec);
    expect(pr.url).toBe('https://github.com/acme/proj/pull/7');
    expect(await git(bare, 'rev-parse', 'rgstr-badge-tsc-rs^')).toBe(await git(bare, 'rev-parse', 'trunk'));

    // No answer from the remote: gh, then origin/HEAD.
    const noRemote = (async (cmd: string, args: string[], opts: { cwd: string }) => {
      if (cmd === 'git' && args[0] === 'ls-remote') return { stdout: '', stderr: '' };
      return exec(cmd, args, opts);
    }) as typeof run;
    expect(await defaultBranch(clone, noRemote)).toBe('main');
    const nothing = (async (cmd: string, args: string[], opts: { cwd: string }) => {
      if (cmd === 'gh' || args[0] === 'ls-remote') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return run(cmd, args, opts);
    }) as typeof run;
    expect(await defaultBranch(clone, nothing)).toBe('main');
    await git(clone, 'remote', 'set-head', 'origin', '-d');
    expect(await defaultBranch(clone, nothing)).toBe('main');
  });
});
