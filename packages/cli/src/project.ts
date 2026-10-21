// The package in the current directory: its name, ecosystem and manifest,
// and where the README badge (the proof) goes.

import { promises as fs } from 'node:fs';
import path from 'node:path';

export type Ecosystem = 'npm' | 'pypi';

export interface DetectedPackage {
  name: string;
  ecosystem: Ecosystem;
  manifest: string;
  version?: string;
}

export async function detectPackage(dir: string, prefer?: Ecosystem): Promise<DetectedPackage | null> {
  const pkgPath = path.join(dir, 'package.json');
  const pyPath = path.join(dir, 'pyproject.toml');
  const tryNpm = async (): Promise<DetectedPackage | null> => {
    try {
      const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8')) as { name?: unknown; version?: unknown };
      if (typeof pkg.name === 'string' && pkg.name) {
        return { name: pkg.name, ecosystem: 'npm', manifest: pkgPath, version: typeof pkg.version === 'string' ? pkg.version : undefined };
      }
    } catch {
      // no package.json
    }
    return null;
  };
  const tryPy = async (): Promise<DetectedPackage | null> => {
    try {
      const toml = await fs.readFile(pyPath, 'utf8');
      const name = tomlProjectValue(toml, 'name');
      if (name) return { name, ecosystem: 'pypi', manifest: pyPath, version: tomlProjectValue(toml, 'version') ?? undefined };
    } catch {
      // no pyproject
    }
    return null;
  };
  if (prefer === 'pypi') return (await tryPy()) ?? (await tryNpm());
  return (await tryNpm()) ?? (await tryPy());
}

/** `[project] key = "value"` — the first match inside the [project] table. */
export function tomlProjectValue(toml: string, key: string): string | null {
  const lines = toml.split('\n');
  let inProject = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^\[.*\]$/.test(line)) {
      inProject = line === '[project]';
      continue;
    }
    if (!inProject) continue;
    const m = line.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`));
    if (m) return m[1];
  }
  return null;
}

/** README: the badge near the top, after the first heading if there is one. */
export function withBadge(source: string | null, badge: string): { next: string; changed: boolean } {
  if (source && source.includes(badge)) return { next: source, changed: false };
  if (!source) return { next: `${badge}\n`, changed: true };
  const lines = source.split('\n');
  const h1 = lines.findIndex((l) => /^#\s/.test(l));
  if (h1 === -1) return { next: `${badge}\n\n${source}`, changed: true };
  lines.splice(h1 + 1, 0, '', badge);
  return { next: lines.join('\n'), changed: true };
}

export async function findReadme(dir: string): Promise<string> {
  for (const f of ['README.md', 'readme.md', 'README.markdown', 'README']) {
    try {
      await fs.access(path.join(dir, f));
      return path.join(dir, f);
    } catch {
      // next
    }
  }
  return path.join(dir, 'README.md');
}
