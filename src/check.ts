// `rgstr check`: the install-time signal. npm and pip give a registry no way
// to print during an install, so this reads the project's direct dependencies
// and says, per name, what resolving through rgstr did: who holds it and
// where it is served from. Unclaimed names fall through to npm / PyPI
// unchanged — the line says so rather than implying rgstr touched them.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Ecosystem } from './project.js';
import type { RouteRecord } from './routes.js';

export interface Dependency {
  name: string;
  ecosystem: Ecosystem;
  /** The file it was read from, relative to the project. */
  source: string;
  /** Which table it sat in (`dependencies`, `devDependencies`, `optional-dependencies.test`, …). */
  section: string;
}

export interface SkippedDependency extends Dependency {
  /** The spec that keeps it off any registry (`workspace:*`, `file:…`, a git URL). */
  spec: string;
}

export interface ReadDependencies {
  deps: Dependency[];
  skipped: SkippedDependency[];
  /** Manifests found, in the order they were read. */
  files: string[];
}

const NPM_SECTIONS = ['dependencies', 'devDependencies'] as const;

/** package.json direct dependencies. A spec that is not a registry range
 *  (`workspace:`, `file:`, `link:`, git, tarball URL) never reaches rgstr and is
 *  reported as skipped; an `npm:<other>@range` alias checks the real name. */
export function parseNpmDependencies(json: string, source = 'package.json'): { deps: Dependency[]; skipped: SkippedDependency[] } {
  const pkg = JSON.parse(json) as Record<string, unknown>;
  const deps: Dependency[] = [];
  const skipped: SkippedDependency[] = [];
  for (const section of NPM_SECTIONS) {
    const tbl = pkg[section];
    if (!tbl || typeof tbl !== 'object') continue;
    for (const [key, raw] of Object.entries(tbl as Record<string, unknown>)) {
      const spec = typeof raw === 'string' ? raw : '';
      const base = { ecosystem: 'npm' as const, source, section };
      if (/^npm:/.test(spec)) {
        const target = spec.slice(4).replace(/(?<=.)@.*$/, '');
        deps.push({ ...base, name: target || key });
        continue;
      }
      // Anything that is not a version/range/tag is fetched outside the registry:
      // protocols, git (incl. `git@…` and the `owner/repo[#ref]` shorthand), tarballs.
      if (/^(workspace:|file:|link:|portal:|patch:|git\+|git:|git@|github:|gitlab:|bitbucket:|https?:\/\/|ssh:)/.test(spec) || spec.includes('/') || /\.(tgz|tar\.gz)$/.test(spec)) {
        skipped.push({ ...base, name: key, spec });
        continue;
      }
      deps.push({ ...base, name: key });
    }
  }
  return { deps: dedupe(deps), skipped };
}

/** PEP 503 normalisation: PyPI treats `Foo_Bar.baz` and `foo-bar-baz` as one name. */
export function normalizePypiName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/** The project name out of a PEP 508 requirement string, or null for a line
 *  that is not a plain requirement (a URL, a `-r` include, an option). */
export function requirementName(req: string): string | null {
  const line = req.replace(/(^|\s)#.*$/, '').trim();
  if (!line || line.startsWith('-') || /^[a-z][a-z0-9+.-]*:\/\//i.test(line) || line.startsWith('.') || line.startsWith('/')) return null;
  const m = line.match(/^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/);
  if (!m) return null;
  // `name @ url` pins a direct reference; the index never sees it.
  if (/^\s*@/.test(line.slice(m[1].length))) return null;
  return normalizePypiName(m[1]);
}

/** pyproject.toml: `[project] dependencies`, every `[project.optional-dependencies]`
 *  group and `[dependency-groups]` (PEP 735). Poetry's `[tool.poetry.dependencies]`
 *  table is read by key. */
export function parsePyprojectDependencies(toml: string, source = 'pyproject.toml'): Dependency[] {
  const deps: Dependency[] = [];
  const push = (name: string | null, section: string) => {
    if (name) deps.push({ name, ecosystem: 'pypi', source, section });
  };
  const lines = toml.split('\n');
  let table = '';
  for (let i = 0; i < lines.length; i++) {
    const t = stripTomlComment(lines[i]).trim();
    // `[table]` and `[[array.of.tables]]` both switch the active table.
    const header = t.match(/^\[\[?([^\]]+)\]\]?$/);
    if (header) {
      table = header[1].trim();
      continue;
    }
    if (!t) continue;
    const kv = t.match(/^([A-Za-z0-9_."'-]+)\s*=\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].replace(/^["']|["']$/g, '');
    let value = kv[2];
    if (table === 'project' && key === 'dependencies') {
      ({ value, i } = collectArray(lines, i, value));
      for (const s of tomlStrings(value)) push(requirementName(s), 'dependencies');
    } else if (table === 'project.optional-dependencies' || table === 'dependency-groups') {
      ({ value, i } = collectArray(lines, i, value));
      for (const s of tomlStrings(value)) push(requirementName(s), `${table === 'dependency-groups' ? 'dependency-groups' : 'optional-dependencies'}.${key}`);
    } else if (table === 'tool.poetry.dependencies' || /^tool\.poetry\.group\.[^.]+\.dependencies$/.test(table)) {
      if (key === 'python') continue;
      // `name = { path = "…" }` / `{ git = "…" }` / `{ url = "…" }` never hit the index.
      if (/^\{/.test(value) && /\b(path|git|url)\s*=/.test(value)) continue;
      push(normalizePypiName(key), table === 'tool.poetry.dependencies' ? 'tool.poetry.dependencies' : `tool.poetry.group.${table.split('.')[3]}`);
    }
  }
  return dedupe(deps);
}

/** requirements.txt: one requirement per line; `-r`, `-e`, URLs and options are not names. */
export function parseRequirements(text: string, source = 'requirements.txt'): Dependency[] {
  const deps: Dependency[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\\\s*$/, '');
    const name = requirementName(line);
    if (name) deps.push({ name, ecosystem: 'pypi', source, section: 'requirements' });
  }
  return dedupe(deps);
}

function stripTomlComment(line: string): string {
  let inStr: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      if (ch === '\\' && inStr === '"') i++;
      else if (ch === inStr) inStr = null;
    } else if (ch === '"' || ch === "'") inStr = ch;
    else if (ch === '#') return line.slice(0, i);
  }
  return line;
}

/** A TOML array may span lines; gather until the brackets balance. */
function collectArray(lines: string[], i: number, first: string): { value: string; i: number } {
  let value = first;
  let depth = bracketDepth(first);
  while (depth > 0 && i + 1 < lines.length) {
    i++;
    const t = stripTomlComment(lines[i]);
    value += '\n' + t;
    depth += bracketDepth(t);
  }
  return { value, i };
}

function bracketDepth(s: string): number {
  let d = 0;
  let inStr: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === '\\' && inStr === '"') i++;
      else if (ch === inStr) inStr = null;
    } else if (ch === '"' || ch === "'") inStr = ch;
    else if (ch === '[') d++;
    else if (ch === ']') d--;
  }
  return d;
}

function tomlStrings(value: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]);
  return out;
}

function dedupe(deps: Dependency[]): Dependency[] {
  const seen = new Set<string>();
  return deps.filter((d) => {
    const k = `${d.ecosystem}:${d.name}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const PY_MANIFESTS = ['pyproject.toml', 'requirements.txt'];

/** Every direct dependency the manifests in `dir` declare. */
export async function readDependencies(dir: string): Promise<ReadDependencies> {
  const out: ReadDependencies = { deps: [], skipped: [], files: [] };
  const read = async (file: string): Promise<string | null> => {
    try {
      return await fs.readFile(path.join(dir, file), 'utf8');
    } catch {
      return null;
    }
  };
  const pkg = await read('package.json');
  if (pkg != null) {
    const r = parseNpmDependencies(pkg);
    out.deps.push(...r.deps);
    out.skipped.push(...r.skipped);
    out.files.push('package.json');
  }
  for (const f of PY_MANIFESTS) {
    const text = await read(f);
    if (text == null) continue;
    out.deps.push(...(f === 'pyproject.toml' ? parsePyprojectDependencies(text) : parseRequirements(text)));
    out.files.push(f);
  }
  out.deps = dedupe(out.deps);
  return out;
}

/** Run `fn` over `items` with at most `limit` in flight, results in order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export interface WhoisLike {
  name: string;
  url: string;
  trust: 'unclaimed' | 'claimed' | 'verified';
  state: 'unclaimed' | 'pending' | 'held' | 'disputed';
  holder: { name: string; slug: string } | null;
  routes: RouteRecord[];
}

export interface CheckRow {
  name: string;
  ecosystem: Ecosystem;
  trust: WhoisLike['trust'] | null;
  state: WhoisLike['state'] | null;
  /** Org slug of the holder; null when nobody holds the name. */
  holder: string | null;
  /** True when a holder's answer (routes or default) is what installs get. */
  held: boolean;
  /** Where an install of this name is served from, in words. */
  servedFrom: string;
  routes: Array<{ versionRange: string; upstreamKind: string; upstream: string; upstreamName: string | null }>;
  url: string | null;
  /** Set when rgstr could not answer for this one name (the check itself still succeeded). */
  error?: string;
}

const INDEX_LABEL: Record<Ecosystem, string> = { npm: 'npm', pypi: 'PyPI' };

/** One dependency's line. `held` is true only when a holder's routes (or the
 *  holder's default) decide the install — never for a pending application. */
export function checkRow(dep: Dependency, w: WhoisLike): CheckRow {
  const held = !!w.holder && w.trust !== 'unclaimed';
  const index = INDEX_LABEL[dep.ecosystem];
  let servedFrom: string;
  if (!held) servedFrom = `${index} (unchanged)`;
  else if (w.routes.length === 0) servedFrom = `${index}:${w.name} (holder's default)`;
  else {
    servedFrom = w.routes
      .map((r) => `${r.upstreamKind}:${r.upstreamName ?? w.name}${r.versionRange && r.versionRange !== '*' ? `@${r.versionRange}` : ''}`)
      .join(', ') + ' (holder route)';
  }
  return {
    name: dep.name,
    ecosystem: dep.ecosystem,
    trust: w.trust,
    state: w.state,
    holder: held ? w.holder!.slug : null,
    held,
    servedFrom,
    routes: w.routes.map(({ versionRange, upstreamKind, upstream, upstreamName }) => ({ versionRange, upstreamKind, upstream, upstreamName })),
    url: w.url,
  };
}

export function unansweredRow(dep: Dependency, error: string): CheckRow {
  return { name: dep.name, ecosystem: dep.ecosystem, trust: null, state: null, holder: null, held: false, servedFrom: `${INDEX_LABEL[dep.ecosystem]} (unchanged)`, routes: [], url: null, error };
}

/** The last line: how many names a holder decides, and that the rest are untouched. */
export function summaryLine(rows: CheckRow[]): string {
  const held = rows.filter((r) => r.held).length;
  const total = rows.length;
  const names = (n: number) => `${n} name${n === 1 ? '' : 's'}`;
  if (total === 0) return 'No names to check.';
  const indexes = [...new Set(rows.map((r) => INDEX_LABEL[r.ecosystem]))].join(' / ');
  if (held === total) return `${held} of ${total} ${total === 1 ? 'name is' : 'names are'} held on rgstr; every install here resolves where its holder says.`;
  if (held === 0) return `0 of ${names(total)} ${total === 1 ? 'is' : 'are'} held on rgstr; all of them fall through to ${indexes} unchanged.`;
  return `${held} of ${total} names are held on rgstr; the rest fall through to ${indexes} unchanged.`;
}

/** Rows as the table the human output prints. */
export function checkTableRows(rows: CheckRow[]): string[][] {
  return rows.map((r) => [
    r.name,
    r.error ? `? (${r.error})` : (r.trust ?? '?') + (r.state === 'disputed' ? ' (disputed)' : r.state === 'pending' ? ' (application pending)' : ''),
    r.holder ?? '—',
    r.servedFrom,
  ]);
}
