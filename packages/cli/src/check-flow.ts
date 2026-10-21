/**
 * The `rgstr check` flow, importable: what resolving this project's
 * dependencies through rgstr does — per name, who claims it and where it is
 * served from. Reads only. The CLI prints `text`; @rgstr/mcp returns both.
 */
import { RgstrApiError, RgstrClient, RgstrCliError, resolveAuth, type GlobalOptions } from './client.js';
import type { Ecosystem } from './project.js';
import { projectStatus } from './use.js';
import { table } from './output.js';
import { checkRow, checkTableRows, mapLimit, readDependencies, summaryLine, unansweredRow, type CheckRow, type Dependency } from './check.js';
import type { WhoisResponse } from './api-types.js';

export interface CheckResult {
  dir: string;
  origin: string | null;
  origins: Record<string, string>;
  files: string[];
  manifests: string[];
  names: CheckRow[];
  skipped: Awaited<ReturnType<typeof readDependencies>>['skipped'];
  notPointed: Dependency[];
  held: number;
  registered: number;
  total: number;
  summary: string;
}

export async function checkProject(g: GlobalOptions, dir: string, names: string[]): Promise<{ result: CheckResult; text: string }> {
  const files = await projectStatus(dir);
  if (files.length === 0) {
    throw new RgstrCliError('not_configured', 'This project is not pointed at rgstr (no .npmrc / pip config written for it) — run `npx @rgstr/cli setup` first.');
  }
  const read = await readDependencies(dir);
  // Which ecosystems this project actually sends through rgstr, and to which
  // origin: a `.npmrc` alone says nothing about pip, and npm and pip may be
  // pointed at different hosts. Ask the origin each install really goes to.
  const ecosystemOf = (id: string): Ecosystem => (id === 'pip' || id === 'uv' || id === 'poetry' ? 'pypi' : 'npm');
  const originFor = new Map<Ecosystem, string>();
  for (const f of files) for (const id of f.clients) if (!originFor.has(ecosystemOf(id))) originFor.set(ecosystemOf(id), f.origin);
  const override = g.baseUrl || process.env.RGSTR_URL;
  const origins = [...new Set(override ? [override] : [...originFor.values()])];
  const clients = new Map(await Promise.all(origins.map(async (o) => [o, new RgstrClient(await resolveAuth({ ...g, baseUrl: o, optional: true }))] as const)));
  const clientFor = (d: Dependency) => clients.get(override || originFor.get(d.ecosystem) || origins[0])!;
  const pointed = read.deps.filter((d) => originFor.has(d.ecosystem));
  let notPointed = read.deps.filter((d) => !originFor.has(d.ecosystem));
  let deps: Dependency[];
  if (names.length) {
    const only = new Set(names);
    const known = pointed.filter((d) => only.has(d.name));
    notPointed = notPointed.filter((d) => only.has(d.name));
    const guess: Ecosystem = originFor.size === 1 ? [...originFor.keys()][0] : read.files.length > 0 && !read.files.includes('package.json') ? 'pypi' : 'npm';
    const missing = names
      .filter((n) => !known.some((d) => d.name === n) && !notPointed.some((d) => d.name === n))
      .map((n) => ({ name: n, ecosystem: guess, source: '(argument)', section: 'argument' }));
    deps = [...known, ...missing];
  } else deps = pointed;

  const rows: CheckRow[] = await mapLimit(deps, 8, async (d) => {
    const c = clientFor(d);
    try {
      return checkRow(d, await c.get<WhoisResponse>(`/api/v1/registry/whois/${encodeURIComponent(d.name)}`));
    } catch (err) {
      // A bad name is that name's problem; anything else means the check could not run.
      if (err instanceof RgstrApiError && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 403) return unansweredRow(d, err.message);
      if (err instanceof RgstrApiError) throw err;
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      throw new Error(`Could not reach ${c.baseUrl} (${cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err))}) — nothing was checked.`);
    }
  });
  const summary = summaryLine(rows);
  const result: CheckResult = {
    dir,
    origin: origins.length === 1 ? origins[0] : null,
    origins: Object.fromEntries([...originFor].map(([eco, o]) => [eco, override || o])),
    files: files.map((f) => f.file),
    manifests: read.files,
    names: rows,
    skipped: names.length ? [] : read.skipped,
    notPointed,
    held: rows.filter((r) => r.held).length,
    registered: rows.filter((r) => r.registered).length,
    total: rows.length,
    summary,
  };

  const notes: string[] = [];
  if (!names.length && read.skipped.length) {
    notes.push(`(${read.skipped.length} not checked: ${read.skipped.map((s) => `${s.name} is ${s.spec}`).join(', ')} — not fetched from a registry.)`);
  }
  if (notPointed.length) {
    const py = notPointed[0].ecosystem === 'pypi';
    notes.push(`(${notPointed.length} ${py ? 'PyPI' : 'npm'} name${notPointed.length === 1 ? '' : 's'} not checked: ${py ? 'pip' : 'npm'} installs here do not go through rgstr — \`rgstr setup ${py ? '--pip' : '--npm'}\` to point them at it.)`);
  }
  const lines: string[] = [
    origins.length === 1
      ? `Installs here resolve through ${origins[0]} (${files.map((f) => f.file).join(', ')}).`
      : `Installs here resolve through ${files.map((f) => `${f.origin} (${f.file})`).join(' and ')}.`,
  ];
  if (rows.length === 0) {
    lines.push(read.files.length ? `No dependencies to check in ${read.files.join(' / ')}.` : 'No package.json, pyproject.toml or requirements.txt here — pass the names: rgstr check <name…>');
    lines.push(...notes);
  } else {
    lines.push('', table(checkTableRows(rows), ['name', 'trust', 'claimed by', 'served from']), '', summary, ...notes);
  }
  return { result, text: lines.join('\n') };
}
