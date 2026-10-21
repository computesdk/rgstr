// `rgstr use`: the Setup page as a command. Writes the one-time "point your
// client at rgstr" lines into the project's own config files, inside a marked
// block so `--off` can remove exactly what was written and nothing else.

import { promises as fs } from 'node:fs';
import path from 'node:path';

export const BLOCK_START = '# >>> rgstr (managed by `rgstr setup`; remove with `rgstr setup --off`)';
/** What 0.0.1–0.0.7 wrote; still recognised so `--off` removes it. */
const LEGACY_BLOCK_START = '# >>> rgstr (managed by `rgstr use`; remove with `rgstr use --off`)';
export const BLOCK_END = '# <<< rgstr';
const NEEDS_NEWLINE = `${BLOCK_START} +nl`;
/** Header variant for a file the CLI created, so `--off` knows it may delete it. */
const CREATED_FILE = `${BLOCK_START} +new`;

/** Index of the managed block's header line, current or legacy wording. */
function blockStart(current: string): number {
  const now = current.indexOf(BLOCK_START);
  return now === -1 ? current.indexOf(LEGACY_BLOCK_START) : now;
}

export type ClientId = 'npm' | 'yarn' | 'bun' | 'pip' | 'uv' | 'poetry';

export interface ClientConfig {
  id: ClientId;
  file: string;
  /** The exact lines the Setup page shows for this client. */
  lines: string[];
  /** A table header already in the file to extend (`[install]`, `[global]`) —
   *  a second copy would be invalid TOML/INI, so the block goes inside it. */
  anchor?: string;
}

/** Every file `rgstr use` may have written to, for `--off` after a manifest is gone. */
export const MANAGED_FILES = ['.npmrc', '.yarnrc.yml', 'bunfig.toml', 'pyproject.toml', 'pip.conf'];

export const npmRegistryUrl = (origin: string) => `${origin}/api/registry`;
export const pypiIndexUrl = (origin: string) => `${origin}/api/pypi`;

/** Same snippets as app/components/registry/registry-config.tsx. */
export function clientConfigs(origin: string, ids: ClientId[]): ClientConfig[] {
  const js = npmRegistryUrl(origin);
  const py = pypiIndexUrl(origin);
  const all: Record<ClientId, ClientConfig> = {
    npm: { id: 'npm', file: '.npmrc', lines: [`registry=${js}`] },
    yarn: { id: 'yarn', file: '.yarnrc.yml', lines: [`npmRegistryServer: "${js}"`] },
    bun: { id: 'bun', file: 'bunfig.toml', lines: ['[install]', `registry = "${js}"`], anchor: '[install]' },
    pip: { id: 'pip', file: 'pip.conf', lines: ['[global]', `index-url = ${py}`], anchor: '[global]' },
    uv: { id: 'uv', file: 'pyproject.toml', lines: ['[[tool.uv.index]]', `url = "${py}"`, 'default = true'] },
    poetry: { id: 'poetry', file: 'pyproject.toml', lines: ['[[tool.poetry.source]]', 'name = "rgstr"', `url = "${py}"`, 'priority = "primary"'] },
  };
  return ids.map((id) => all[id]);
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** Which clients this project uses, from its lockfiles and manifests. */
export async function detectClients(dir: string, want: { npm?: boolean; pip?: boolean }): Promise<ClientId[]> {
  const has = async (f: string) => exists(path.join(dir, f));
  const out: ClientId[] = [];
  const explicit = want.npm || want.pip;
  const js = want.npm || (!explicit && (await has('package.json')));
  const py = want.pip || (!explicit && ((await has('pyproject.toml')) || (await has('requirements.txt')) || (await has('setup.py'))));
  if (js) {
    out.push('npm');
    if ((await has('yarn.lock')) || (await has('.yarnrc.yml'))) out.push('yarn');
    if ((await has('bun.lock')) || (await has('bun.lockb')) || (await has('bunfig.toml'))) out.push('bun');
  }
  if (py) {
    if (await has('uv.lock')) out.push('uv');
    else if (await has('poetry.lock')) out.push('poetry');
    else out.push('pip');
  }
  return out;
}

/** pip reads no project-level file; the virtualenv's pip.conf is the closest
 *  thing (`$VIRTUAL_ENV/pip.conf`, else `./.venv/pip.conf`). Without a venv the
 *  Setup page's `pip config set global.index-url …` is the only option. */
export async function pipConfigTarget(dir: string): Promise<string | null> {
  const venv = process.env.VIRTUAL_ENV;
  if (venv && (await exists(venv))) return path.join(venv, 'pip.conf');
  const local = path.join(dir, '.venv');
  if (await exists(local)) return path.join(local, 'pip.conf');
  return null;
}

export function renderBlock(lines: string[], needsLeadingNewline: boolean, createdFile = false): string {
  const header = createdFile ? CREATED_FILE : needsLeadingNewline ? NEEDS_NEWLINE : BLOCK_START;
  return `${header}\n${lines.join('\n')}\n${BLOCK_END}\n`;
}

/** Add or refresh the managed block; unchanged content returns `changed: false`.
 *  With `anchor`, an existing `[table]` header is extended in place instead of
 *  duplicated: the block (minus its own header line) goes right after it. */
export function applyBlock(current: string | null, lines: string[], anchor?: string): { next: string; changed: boolean } {
  const stripped = stripBlock(current ?? '');
  const base = stripped.content;
  // A re-run keeps the "created by rgstr" mark; a brand-new file gets it.
  const createdFile = current == null || stripped.createdFile;
  if (anchor) {
    const baseLines = base.split('\n');
    const at = baseLines.findIndex((l) => l.trim() === anchor);
    if (at !== -1) {
      const body = lines[0] === anchor ? lines.slice(1) : lines;
      // Our keys replace the table's own assignment of the same key (a
      // duplicate key is invalid TOML/INI); the original line comes back on --off.
      const keys = body.map((l) => l.match(/^\s*([\w.-]+)\s*=/)?.[1]).filter((k): k is string => !!k);
      let end = at + 1;
      while (end < baseLines.length && !/^\s*\[/.test(baseLines[end])) end++;
      const shadowed: string[] = [];
      for (let i = at + 1; i < end; i++) {
        const k = baseLines[i].match(/^\s*([\w.-]+)\s*=/)?.[1];
        if (k && keys.includes(k)) shadowed.push(baseLines[i]);
      }
      const kept = baseLines.filter((l, i) => !(i > at && i < end && shadowed.includes(l)));
      const block = [...body, ...shadowed.map((l) => `${SHADOW_PREFIX}${l}`)];
      kept.splice(at + 1, 0, renderBlock(block, false, createdFile).replace(/\n$/, ''));
      const next = kept.join('\n');
      return { next, changed: next !== (current ?? '') };
    }
  }
  const needsNl = base.length > 0 && !base.endsWith('\n');
  const next = base + (needsNl ? '\n' : '') + renderBlock(lines, needsNl, createdFile);
  return { next, changed: next !== (current ?? '') };
}

/** A line the block displaced from an anchored table, kept inside the block
 *  as a comment so `--off` can put it back where the table header is. */
const SHADOW_PREFIX = '#rgstr-was: ';

/** Remove the managed block, restoring the original bytes around it.
 *  `createdFile` says the file did not exist before `rgstr use` wrote it. */
export function stripBlock(current: string): { content: string; found: boolean; createdFile: boolean } {
  const start = blockStart(current);
  if (start === -1) return { content: current, found: false, createdFile: false };
  const endMarker = current.indexOf(BLOCK_END, start);
  if (endMarker === -1) return { content: current, found: false, createdFile: false };
  let end = endMarker + BLOCK_END.length;
  if (current[end] === '\n') end += 1;
  const header = current.slice(start, current.indexOf('\n', start));
  const addedNl = header.endsWith(' +nl');
  const createdFile = header.endsWith(' +new');
  const before = addedNl && current[start - 1] === '\n' ? current.slice(0, start - 1) : current.slice(0, start);
  const shadowed = current
    .slice(start, endMarker)
    .split('\n')
    .filter((l) => l.startsWith(SHADOW_PREFIX))
    .map((l) => l.slice(SHADOW_PREFIX.length) + '\n')
    .join('');
  return { content: before + shadowed + current.slice(end), found: true, createdFile };
}

export function unifiedDiff(file: string, before: string | null, after: string | null): string {
  const a = before == null ? [] : before.split('\n');
  const b = after == null ? [] : after.split('\n');
  if (a.length && a[a.length - 1] === '') a.pop();
  if (b.length && b[b.length - 1] === '') b.pop();
  // Common prefix/suffix is enough here: the change is always one contiguous block.
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const out = [`--- ${before == null ? '/dev/null' : file}`, `+++ ${after == null ? '/dev/null' : file}`];
  const ctx = (line: string) => ` ${line}`;
  out.push(...a.slice(Math.max(0, p - 2), p).map(ctx));
  out.push(...a.slice(p, a.length - s).map((l) => `-${l}`));
  out.push(...b.slice(p, b.length - s).map((l) => `+${l}`));
  out.push(...a.slice(a.length - s, Math.min(a.length, a.length - s + 2)).map(ctx));
  return out.join('\n');
}

export interface UseChange {
  file: string;
  clients: ClientId[];
  action: 'written' | 'unchanged' | 'removed' | 'absent' | 'manual';
  diff?: string;
  /** For `manual`: the Setup page command to run instead. */
  command?: string;
  /** For `written` / `removed`: the absolute path and the bytes `applyUse`
   *  puts there (null = delete the file). Planned, not yet done. */
  path?: string;
  after?: string | null;
}

export interface UseOptions {
  dir: string;
  origin: string;
  off?: boolean;
  npm?: boolean;
  pip?: boolean;
  dryRun?: boolean;
}

/** Plan, then write unless `dryRun`. Commands that confirm first call
 *  `planUse` and `applyUse` themselves. */
export async function runUse(opts: UseOptions): Promise<UseChange[]> {
  const changes = await planUse(opts);
  if (!opts.dryRun) await applyUse(changes);
  return changes;
}

/** Write what `planUse` decided; everything else is already reported. */
export async function applyUse(changes: UseChange[]): Promise<void> {
  for (const ch of changes) {
    if (!ch.path || (ch.action !== 'written' && ch.action !== 'removed')) continue;
    if (ch.after == null) await fs.rm(ch.path);
    else await fs.writeFile(ch.path, ch.after);
  }
}

/** What `rgstr setup` would do to this project. Touches nothing. */
export async function planUse(opts: Omit<UseOptions, 'dryRun'>): Promise<UseChange[]> {
  const ids = await detectClients(opts.dir, { npm: opts.npm, pip: opts.pip });
  const configs = clientConfigs(opts.origin, ids);
  const changes: UseChange[] = [];
  const pipTarget = await pipConfigTarget(opts.dir);
  for (const c of configs) {
    if (c.id !== 'pip') continue;
    if (pipTarget) c.file = path.relative(opts.dir, pipTarget) || pipTarget;
    else if (!opts.off) {
      changes.push({ file: 'pip.conf', clients: ['pip'], action: 'manual', command: `pip config set global.index-url ${pypiIndexUrl(opts.origin)}` });
    }
  }
  const active = configs.filter((c) => c.id !== 'pip' || pipTarget);
  // Several clients can share a file (uv + poetry never co-occur; bun/yarn don't share with npm).
  const byFile = new Map<string, ClientConfig[]>();
  for (const c of active) byFile.set(c.file, [...(byFile.get(c.file) ?? []), c]);
  if (opts.off) {
    // Undo what was written even if the manifest (or the VIRTUAL_ENV) that
    // selected the file has changed since: scan every place we may have written.
    const pipPlaces = [process.env.VIRTUAL_ENV, path.join(opts.dir, '.venv')]
      .filter((v): v is string => !!v)
      .map((v) => path.relative(opts.dir, path.join(v, 'pip.conf')) || path.join(v, 'pip.conf'));
    for (const f of [...MANAGED_FILES, ...pipPlaces]) {
      if (!byFile.has(f) && (await exists(path.join(opts.dir, f)))) byFile.set(f, []);
    }
  }

  for (const [file, cs] of byFile) {
    const full = path.join(opts.dir, file);
    const current = (await exists(full)) ? await fs.readFile(full, 'utf8') : null;
    const clients = cs.map((c) => c.id);
    if (opts.off) {
      if (current == null) {
        changes.push({ file, clients, action: 'absent' });
        continue;
      }
      const { content, found, createdFile } = stripBlock(current);
      if (!found) {
        // Files only visited by the scan are reported when they carried a block.
        if (cs.length > 0) changes.push({ file, clients, action: 'absent' });
        continue;
      }
      // Only a file rgstr created goes away; a pre-existing empty file stays empty.
      const after = createdFile && content.length === 0 ? null : content;
      changes.push({ file, clients, action: 'removed', diff: unifiedDiff(file, current, after), path: full, after });
      continue;
    }
    const lines = cs.flatMap((c, i) => (i === 0 ? c.lines : ['', ...c.lines]));
    const anchor = cs.length === 1 ? cs[0].anchor : undefined;
    const { next, changed } = applyBlock(current, lines, anchor);
    if (!changed) {
      changes.push({ file, clients, action: 'unchanged' });
      continue;
    }
    changes.push({ file, clients, action: 'written', diff: unifiedDiff(file, current, next), path: full, after: next });
  }
  return changes;
}

export interface StatusFile {
  file: string;
  clients: ClientId[];
  /** The rgstr origin the file points installs at. */
  origin: string;
  /** True when it is our managed block; false for a line someone wrote by hand. */
  managed: boolean;
}

const ORIGIN_RE = /(https?:\/\/[^\s"'/]+)\/api\/(?:registry|pypi)\b/;

function clientsForFile(file: string, text: string): ClientId[] {
  const base = path.basename(file);
  if (base === '.npmrc') return ['npm'];
  if (base === '.yarnrc.yml') return ['yarn'];
  if (base === 'bunfig.toml') return ['bun'];
  if (base === 'pip.conf') return ['pip'];
  const out: ClientId[] = [];
  if (text.includes('tool.uv.index')) out.push('uv');
  if (text.includes('tool.poetry.source')) out.push('poetry');
  return out;
}

/** `rgstr status`: every config file in the project that sends installs to
 *  an rgstr origin, whether `rgstr setup` wrote it or not. */
export async function projectStatus(dir: string): Promise<StatusFile[]> {
  const pipPlaces = [process.env.VIRTUAL_ENV, path.join(dir, '.venv')]
    .filter((v): v is string => !!v)
    .map((v) => path.relative(dir, path.join(v, 'pip.conf')) || path.join(v, 'pip.conf'));
  const out: StatusFile[] = [];
  for (const file of [...new Set([...MANAGED_FILES, ...pipPlaces])]) {
    const full = path.join(dir, file);
    if (!(await exists(full))) continue;
    const current = await fs.readFile(full, 'utf8');
    const start = blockStart(current);
    const end = start === -1 ? -1 : current.indexOf(BLOCK_END, start);
    const managed = start !== -1 && end !== -1;
    const text = managed ? current.slice(start, end) : current;
    const live = text
      .split('\n')
      .filter((l) => !/^\s*[#;]/.test(l))
      .join('\n');
    const origin = live.match(ORIGIN_RE)?.[1];
    if (!origin) continue;
    out.push({ file, clients: clientsForFile(file, text), origin, managed });
  }
  return out;
}
