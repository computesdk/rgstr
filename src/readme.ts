// `rgstr claim` inside a git checkout: find the package(s) and their READMEs,
// make sure this checkout is the repository the package declares, and put the
// badge under the first heading. Pure helpers here; the command drives them.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectPackage, tomlProjectValue, type DetectedPackage, type Ecosystem } from './project.js';
import { repoUrlFrom } from './claim.js';

const run = promisify(execFile);

const README_NAMES = ['readme.md', 'readme', 'readme.markdown', 'readme.rst', 'readme.txt'];

/** The README next to `dir`, any case; null when there is none. */
export async function findReadmeIn(dir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }
  const byRank = entries
    .filter((e) => README_NAMES.includes(e.toLowerCase()))
    .sort((a, b) => README_NAMES.indexOf(a.toLowerCase()) - README_NAMES.indexOf(b.toLowerCase()));
  return byRank.length ? path.join(dir, byRank[0]) : null;
}

/** setup.cfg `[metadata] name = x` — the pre-pyproject Python layout. */
export function setupCfgName(cfg: string): string | null {
  let inMeta = false;
  for (const raw of cfg.split('\n')) {
    const line = raw.trim();
    if (/^\[.*\]$/.test(line)) {
      inMeta = line === '[metadata]';
      continue;
    }
    if (!inMeta) continue;
    const m = line.match(/^name\s*[=:]\s*(\S+)/);
    if (m) return m[1];
  }
  return null;
}

/** `detectPackage`, plus setup.cfg as the Python fallback. */
export async function detectPackageHere(dir: string, prefer?: Ecosystem): Promise<DetectedPackage | null> {
  const found = await detectPackage(dir, prefer);
  if (found) return found;
  try {
    const cfg = path.join(dir, 'setup.cfg');
    const name = setupCfgName(await fs.readFile(cfg, 'utf8'));
    if (name) return { name, ecosystem: 'pypi', manifest: cfg };
  } catch {
    // no setup.cfg
  }
  return null;
}

/** Workspace member globs: pnpm-workspace.yaml, package.json `workspaces`,
 *  `[tool.uv.workspace] members`, `[tool.poetry] packages`-style lists are
 *  rare so only uv's is read. Returns [] when this is not a workspace root. */
export async function workspaceGlobs(dir: string): Promise<string[]> {
  const globs: string[] = [];
  try {
    const yaml = await fs.readFile(path.join(dir, 'pnpm-workspace.yaml'), 'utf8');
    let inPackages = false;
    for (const raw of yaml.split('\n')) {
      if (/^packages\s*:/.test(raw)) {
        inPackages = true;
        continue;
      }
      if (inPackages && /^\s+-\s+/.test(raw)) globs.push(raw.replace(/^\s+-\s+/, '').replace(/^['"]|['"]$/g, '').trim());
      else if (inPackages && /^\S/.test(raw)) inPackages = false;
    }
  } catch {
    // not pnpm
  }
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')) as { workspaces?: string[] | { packages?: string[] } };
    const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
    if (ws) globs.push(...ws);
  } catch {
    // not npm/yarn workspaces
  }
  try {
    const toml = await fs.readFile(path.join(dir, 'pyproject.toml'), 'utf8');
    const section = toml.split(/^\[tool\.uv\.workspace\]\s*$/m)[1]?.split(/^\[/m)[0];
    const members = section?.match(/members\s*=\s*\[([^\]]*)\]/)?.[1];
    if (members) globs.push(...[...members.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  } catch {
    // not uv
  }
  return [...new Set(globs.filter((g) => !g.startsWith('!')))];
}

/** Every directory below `dir` (skipping dot-dirs and node_modules). */
async function descendantDirs(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    out.push(full, ...(await descendantDirs(full)));
  }
  return out;
}

/** Expand workspace globs (`packages/*`, `packages/**`, `apps/web-*`, or a
 *  literal path) to directories that exist. Enough for workspace manifests. */
export async function expandGlobs(dir: string, globs: string[]): Promise<string[]> {
  const out = new Set<string>();
  for (const g of globs) {
    const parts = g.replace(/\/+$/, '').split('/');
    let dirs = [dir];
    for (const part of parts) {
      const next: string[] = [];
      for (const d of dirs) {
        if (part === '**') {
          next.push(d, ...(await descendantDirs(d)));
        } else if (part === '*') {
          try {
            for (const e of await fs.readdir(d, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') next.push(path.join(d, e.name));
          } catch {
            // unreadable
          }
        } else if (part.includes('*')) {
          const re = new RegExp('^' + part.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
          try {
            for (const e of await fs.readdir(d, { withFileTypes: true })) if (e.isDirectory() && re.test(e.name)) next.push(path.join(d, e.name));
          } catch {
            // unreadable
          }
        } else next.push(path.join(d, part));
      }
      dirs = next;
    }
    for (const d of dirs) {
      try {
        if ((await fs.stat(d)).isDirectory()) out.add(d);
      } catch {
        // skip
      }
    }
  }
  return [...out].sort();
}

export interface PackageTarget extends DetectedPackage {
  dir: string;
}

/** The package in `dir` and, when it is a workspace root (or `all`), every
 *  member package too. Private npm packages are skipped — nothing to claim. */
export async function detectPackages(dir: string, opts: { prefer?: Ecosystem; all?: boolean } = {}): Promise<PackageTarget[]> {
  const globs = await workspaceGlobs(dir);
  const here = await detectPackageHere(dir, opts.prefer);
  const targets: PackageTarget[] = [];
  if (here && !(await isPrivateNpm(here))) targets.push({ ...here, dir });
  if (globs.length) {
    for (const memberDir of await expandGlobs(dir, globs)) {
      const member = await detectPackageHere(memberDir, opts.prefer);
      if (member && !(await isPrivateNpm(member)) && !targets.some((t) => t.name === member.name && t.ecosystem === member.ecosystem)) targets.push({ ...member, dir: memberDir });
    }
  }
  return targets;
}

export type TargetChoice =
  | { kind: 'targets'; targets: PackageTarget[] }
  /** A workspace root without --all: list the members, claim nothing. */
  | { kind: 'workspace'; names: string[] };

/** Which packages `rgstr claim` acts on. Filing N claims and touching N
 *  READMEs is never implicit: a workspace root needs --all or a name. */
export function chooseTargets(found: PackageTarget[], workspaceRoot: boolean, opts: { name?: string; all?: boolean }): TargetChoice {
  if (opts.name) {
    const match = found.find((t) => t.name === opts.name);
    return { kind: 'targets', targets: match ? [match] : [] };
  }
  if (workspaceRoot && !opts.all) return { kind: 'workspace', names: found.map((t) => t.name) };
  return { kind: 'targets', targets: found };
}

async function isPrivateNpm(p: DetectedPackage): Promise<boolean> {
  if (p.ecosystem !== 'npm') return false;
  try {
    return (JSON.parse(await fs.readFile(p.manifest, 'utf8')) as { private?: unknown }).private === true;
  } catch {
    return false;
  }
}

export interface ReadmeChoice {
  file: string;
  exists: boolean;
  /** Why this README: the package's own, the repo root because the declared
   *  repository has no directory hint (rgstr reads the root README), the
   *  folder the package declares, or the single-package fallback. */
  where: 'own' | 'root' | 'declared' | 'fallback';
}

const relDir = (root: string, dir: string) => path.relative(root, dir).split(path.sep).filter(Boolean).join('/');

/** Where to put the badge for a package — where rgstr will read it. With a
 *  declared repository (`declared`: its directory hint, `null` for the root)
 *  that is the README of that folder, so a monorepo package whose manifest
 *  does not say `repository.directory` gets the repo-root README, not its own.
 *  Without one (`undefined`): its own README, else (single package) the repo
 *  root's, else a new README.md next to the manifest. */
export async function readmeFor(target: PackageTarget, repoRoot: string | null, single: boolean, declared?: string | null): Promise<ReadmeChoice> {
  // Registry metadata is untrusted: a declared directory that climbs out of
  // the checkout (`..`, absolute) is ignored, never resolved.
  const parts = declared ? declared.replace(/^\.?\//, '').replace(/\/+$/, '').split('/').filter(Boolean) : [];
  if (declared && (path.isAbsolute(declared) || parts.some((p) => p === '..'))) declared = undefined;
  if (declared !== undefined && repoRoot) {
    const want = parts.join('/');
    const here = relDir(repoRoot, target.dir);
    if (want !== here) {
      const dir = path.join(repoRoot, ...parts);
      const found = await findReadmeIn(dir);
      return { file: found ?? path.join(dir, 'README.md'), exists: !!found, where: want ? 'declared' : 'root' };
    }
  }
  const own = await findReadmeIn(target.dir);
  if (own) return { file: own, exists: true, where: 'own' };
  if (declared === undefined && single && repoRoot && path.resolve(repoRoot) !== path.resolve(target.dir)) {
    const root = await findReadmeIn(repoRoot);
    if (root) return { file: root, exists: true, where: 'fallback' };
  }
  return { file: path.join(target.dir, 'README.md'), exists: false, where: 'own' };
}

export interface GitCheckout {
  root: string;
  /** `origin` as an https URL (`https://github.com/o/r`), or null when there is no origin. */
  remote: string | null;
  branch: string | null;
}

/** The git checkout `dir` is in, or null outside one. */
export async function gitCheckout(dir: string, exec: typeof run = run): Promise<GitCheckout | null> {
  try {
    const { stdout: root } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: dir });
    // The raw configured URL, not `remote get-url`: that one applies
    // url.*.insteadOf rewrites (mirrors, proxies) and would name the wrong host.
    const remote = await exec('git', ['config', '--get', 'remote.origin.url'], { cwd: dir }).then((r) => repoUrlFrom(r.stdout.trim())).catch(() => null);
    const branch = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir }).then((r) => r.stdout.trim()).catch(() => null);
    return { root: root.trim(), remote, branch };
  } catch {
    return null;
  }
}

/** Same repository, whatever the spelling (https / ssh / .git / trailing slash / case). */
export function sameRepo(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = repoUrlFrom(a ?? null);
  const nb = repoUrlFrom(b ?? null);
  return !!na && !!nb && na.toLowerCase() === nb.toLowerCase();
}

export const shortRepo = (url: string) => url.replace(/^https?:\/\//, '');

export interface BadgeSighting {
  line: string;
  token: string | null;
}

/** An rgstr badge for `name` already in the README, if any. */
export function existingBadge(source: string, name: string): BadgeSighting | null {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\[!\\[[^\\]]*\\]\\(https?://[^)\\s]*rgstr\\.org/(?:registry/)?${esc}/badge\\.svg(?:\\?proof=([A-Za-z0-9_-]+))?\\)\\]\\([^)]*\\)`);
  const m = source.match(re);
  return m ? { line: m[0], token: m[1] ?? null } : null;
}

export type BadgePlan =
  | { kind: 'insert'; next: string }
  | { kind: 'replace'; next: string; old: BadgeSighting }
  | { kind: 'present'; old: BadgeSighting };

/** The badge directly under the first H1 (top of file when there is none);
 *  an existing rgstr badge for the name is replaced when its token differs. */
export function planBadge(source: string | null, name: string, badge: string): BadgePlan {
  const old = source ? existingBadge(source, name) : null;
  if (old) {
    if (old.line === badge) return { kind: 'present', old };
    return { kind: 'replace', next: source!.replace(old.line, badge), old };
  }
  if (!source) return { kind: 'insert', next: `${badge}\n` };
  const lines = source.split('\n');
  const h1 = lines.findIndex((l) => /^#\s/.test(l));
  if (h1 === -1) return { kind: 'insert', next: `${badge}\n\n${source}` };
  lines.splice(h1 + 1, 0, '', badge);
  return { kind: 'insert', next: lines.join('\n') };
}

/** Quote for a POSIX shell unless it is plainly safe. */
export function shellQuote(s: string): string {
  return /^[A-Za-z0-9@%+=:,./_-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** What to do once the badge is in the working tree. */
export function nextSteps(readmeRels: string[], names: string[]): string[] {
  return [
    `git add -- ${readmeRels.map(shellQuote).join(' ')} && git commit -m "Add rgstr badge" && git push`,
    'open a pull request with that commit and merge it',
    ...names.map((n) => `rgstr claim --check ${shellQuote(n)}`),
  ];
}

export interface PrResult {
  url: string | null;
  branch: string;
  reason?: string;
}

/** `--pr`: branch, commit, push, `gh pr create`. Returns url=null with a
 *  reason when gh is missing or not signed in; nothing is committed then. */
export async function openBadgePr(
  checkout: GitCheckout,
  files: string[],
  names: string[],
  exec: typeof run = run,
): Promise<PrResult> {
  const branch = names.length === 1 ? `rgstr-badge-${names[0].replace(/[^A-Za-z0-9._-]+/g, '-')}` : 'rgstr-badges';
  const git = (...args: string[]) => exec('git', args, { cwd: checkout.root });
  try {
    await exec('gh', ['auth', 'status'], { cwd: checkout.root });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { url: null, branch, reason: code === 'ENOENT' ? '`gh` is not on PATH' : '`gh` is not signed in (run `gh auth login`)' };
  }
  const list = names.map((n) => `\`${n}\``).join(', ');
  const checks = names.map((n) => `rgstr claim --check ${n}`).join('; ');
  const body = `Proves ownership of ${list} on rgstr: rgstr reads the badge off the README on GitHub, so no release is needed. After merging, run \`${checks}\`.`;
  await git('checkout', '-b', branch);
  await git('add', '--', ...files);
  // Only the READMEs: anything else already staged stays out of this commit.
  await git('commit', '-m', names.length === 1 ? 'Add rgstr badge' : 'Add rgstr badges', '--', ...files);
  await git('push', '-u', 'origin', branch);
  const { stdout } = await exec('gh', ['pr', 'create', '--title', names.length === 1 ? 'Add rgstr badge' : 'Add rgstr badges', '--body', body, '--head', branch], { cwd: checkout.root });
  const url = stdout.trim().split('\n').find((l) => /^https?:\/\//.test(l)) ?? stdout.trim();
  return { url, branch };
}

export { tomlProjectValue };
