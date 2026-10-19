import { describe, it, expect } from 'vitest';
import { tomlProjectValue, withBadge } from '../project.js';

describe('README badge and manifests', () => {
  it('README: badge goes under the first heading, once', () => {
    const badge = '[![rgstr](https://rgstr.org/registry/tsc-rs/badge.svg?proof=t)](https://rgstr.org/registry/tsc-rs)';
    const { next } = withBadge('# tsc-rs\n\nA compiler.\n', badge);
    expect(next).toBe(`# tsc-rs\n\n${badge}\n\nA compiler.\n`);
    expect(withBadge(next, badge).changed).toBe(false);
    expect(withBadge(null, badge).next).toBe(`${badge}\n`);
  });

  it('reads [project] name from pyproject', () => {
    expect(tomlProjectValue('[build-system]\nname = "no"\n[project]\nname = "tsc-rs"\nversion = "1.0"\n', 'name')).toBe('tsc-rs');
    expect(tomlProjectValue('[tool.poetry]\nname = "x"\n', 'name')).toBeNull();
  });
});
