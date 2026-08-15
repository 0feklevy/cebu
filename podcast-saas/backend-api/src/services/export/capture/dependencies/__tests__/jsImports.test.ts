/**
 * JS module specifiers — the half of the dependency graph an import map does NOT govern.
 *
 * An import map redirects BARE specifiers. A module naming an absolute URL directly
 * (`import x from 'https://cdn…'`) bypasses it completely, so a validator that read only the HTML
 * would call such a package capture-compatible and it would die inside `--network none` exactly as
 * v0.1.26 did. Finding those means telling code from text — a comment, a template literal and a
 * regex all contain quotes — which is why this is a lexer and not a pattern match.
 */

import { describe, expect, it } from 'vitest';

import { externalJsImports, scanJsModuleSpecifiers } from 'shared/sim/captureDependencies';

describe('scanJsModuleSpecifiers', () => {
  it('finds static, named, dynamic and re-export specifiers', () => {
    const src = `
      import * as THREE from 'three';
      import { OrbitControls } from "three/addons/controls/OrbitControls.js";
      export { x } from './local.js';
      const m = await import('https://cdn.jsdelivr.net/npm/d3@7/+esm');
    `;
    expect(scanJsModuleSpecifiers(src)).toEqual(
      expect.arrayContaining(['three', 'three/addons/controls/OrbitControls.js', './local.js', 'https://cdn.jsdelivr.net/npm/d3@7/+esm']),
    );
  });

  it('IGNORES quotes that are not code: comments, strings, templates and regex literals', () => {
    const src = `
      // import evil from 'https://evil.example/a.js'
      /* import evil2 from 'https://evil.example/b.js' */
      const label = "import x from 'https://evil.example/c.js'";
      const t = \`import y from 'https://evil.example/d.js'\`;
      const re = /import z from 'https:\\/\\/evil.example\\/e.js'/;
      import ok from './real.js';
    `;
    const found = scanJsModuleSpecifiers(src);
    expect(found).toContain('./real.js');
    for (const decoy of ['a.js', 'b.js', 'c.js', 'd.js', 'e.js']) {
      expect(found.join(' '), decoy).not.toContain(decoy);
    }
  });

  it('still scans code inside a template interpolation', () => {
    expect(scanJsModuleSpecifiers("const s = `x${await import('https://cdn.example/m.js')}y`;"))
      .toContain('https://cdn.example/m.js');
  });
});

describe('externalJsImports', () => {
  it('reports only ABSOLUTE specifiers, as boot-critical', () => {
    const refs = externalJsImports(`
      import 'three';
      import './a.js';
      import 'https://cdn.jsdelivr.net/npm/d3@7/+esm';
      import '//unpkg.com/x@1/x.js';
    `);
    expect(refs.map((r) => r.raw).sort()).toEqual([
      '//unpkg.com/x@1/x.js',
      'https://cdn.jsdelivr.net/npm/d3@7/+esm',
    ]);
    expect(refs.every((r) => r.criticality === 'boot')).toBe(true);
    expect(refs.every((r) => r.kind === 'module-specifier')).toBe(true);
  });

  it('a package with only bare and relative specifiers has none', () => {
    expect(externalJsImports("import * as THREE from 'three'; import './x.js';")).toEqual([]);
  });
});
