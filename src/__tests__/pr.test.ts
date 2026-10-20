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

  it('finds the default branch from origin/HEAD, gh, or the remote', async () => {
    const { bare, clone, seed } = await repos();
    expect(await defaultBranch(clone, exec)).toBe('main');
    await git(clone, 'remote', 'set-head', 'origin', '-d');
    expect(await defaultBranch(clone, exec)).toBe('main');
    const noGh = (async (cmd: string, args: string[], opts: { cwd: string }) => {
      if (cmd === 'gh') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return run(cmd, args, opts);
    }) as typeof run;
    await git(seed, 'branch', '-m', 'main', 'trunk');
    await git(seed, 'push', '-q', 'origin', 'trunk');
    await git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/trunk');
    expect(await defaultBranch(clone, noGh)).toBe('trunk');
  });
});
