/**
 * MIGRATION INVARIANTS — every simulation surface delegates its lifecycle to the shared runtime.
 *
 * These used to grep the players' own source for the orderings they implemented by hand. That
 * machinery now lives in `lib/sim/SimRuntimeClient.ts`, and its behaviour is pinned properly (by
 * execution, not by string match) in `simRuntimeClient.test.ts`. What still needs pinning is the
 * thing a behavioural test of the runtime cannot see: that each SURFACE actually routes through it
 * and has not quietly regrown a private copy.
 *
 * That regression is the whole reason the runtime exists — three consecutive audits each found a
 * defect that existed only because one surface implemented a rule the others did not. A surface
 * that reintroduces its own message listener, its own paint latch or its own reveal timer would
 * pass every behavioural suite in the repo while recreating exactly that class of bug.
 */
// WHY THIS FILE PARSES INSTEAD OF GREPPING
// (deliberately line comments: this text has to name block-comment delimiters, which a block
// comment cannot contain — the same ambiguity that made the old scanner exploitable.)
//
// The previous version stripped comments with two regexes and string-matched the result. Both are
// trivially exploitable, in the direction that makes a violation INVISIBLE rather than noisy:
//   • the block-comment regex treats a `/*` inside a STRING as a comment opener, so everything up
//     to the next genuine close delimiter — arbitrary amounts of live code — is deleted before the
//     scan ever runs;
//   • the line-comment regex treats the `//` in a value like 'sim/a//b' as a comment and eats the
//     rest of that line.
// A surface could therefore reintroduce a private paint latch or a raw startScript post and still
// pass. Every check below runs on the TypeScript AST — comments produce no nodes at all, and a
// string is a string literal, never code — so neither trick works. The final describe block pins
// exactly that, by showing the old scanner blind to constructs this one still finds.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const read = (rel: string): string => readFileSync(join(__dirname, '..', rel), 'utf8');

/** Every shipping surface that hosts a simulation iframe. */
const SURFACES = {
  viewer: 'components/viewer/useProjectPlayer.ts',
  editor: 'components/VideoPlayer.tsx',
  sectionEditor: 'components/SectionEditor.tsx',
  avatar: 'components/avatar/SimulationOverlay.tsx',
} as const;

// ── token-aware scanning ────────────────────────────────────────────────────────────────────

function parse(src: string, fileName = 'surface.tsx'): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    src,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

const cache = new Map<string, ts.SourceFile>();
/** Parse a shipping file (memoised — these are large and every check re-reads them). */
const ast = (rel: string): ts.SourceFile => {
  let sf = cache.get(rel);
  if (!sf) { sf = parse(read(rel), rel); cache.set(rel, sf); }
  return sf;
};

function walk(root: ts.Node, visit: (n: ts.Node) => void): void {
  visit(root);
  root.forEachChild((c) => walk(c, visit));
}

/** A violation, reported with the location that produced it. */
type Hit = string;
const hitAt = (sf: ts.SourceFile, node: ts.Node, what: string): Hit => {
  const { line } = ts.getLineAndCharacterOfPosition(sf, node.getStart(sf));
  return `${sf.fileName}:${line + 1} ${what}`;
};

const propName = (n: ts.PropertyName): string | null =>
  ts.isIdentifier(n) || ts.isStringLiteralLike(n) ? n.text : null;

const calleeName = (e: ts.Expression): string | null =>
  ts.isIdentifier(e) ? e.text
    : ts.isPropertyAccessExpression(e) ? e.name.text
      : null;

/**
 * Object literals whose `type` property is one of `values` — i.e. a wire message built in source.
 * Deliberately broader than "an argument of postMessage": every surface posts through a small
 * wrapper (`sendToFrame`, `post`), so requiring the literal to sit syntactically inside a
 * `postMessage(...)` call would miss exactly the code this rule exists to forbid.
 */

/**
 * Local names bound to lib/sim/protocol exports in this file (including aliased imports), mapped
 * to the WIRE VALUE each export carries. `{ type: START_SCRIPT }` and `import { SIM_READY as R }`
 * are the laundering vectors a literal-only scanner missed (proven by mutation in review F7).
 */
const PROTOCOL_WIRE_VALUES: Record<string, string> = {
  SIM_READY: 'SIM_READY', SIM_PAINTED: 'SIM_PAINTED', SCRIPT_APPLIED: 'SCRIPT_APPLIED',
  SCRIPT_MISSING: 'SCRIPT_MISSING', SCRIPT_ERROR: 'SCRIPT_ERROR', AUTO_PAUSED: 'AUTO_PAUSED',
  USER_INTERACTION: 'userInteraction', START_SCRIPT: 'startScript', STOP_SCRIPT: 'stopScript',
  PAUSE_SCRIPT: 'pauseScript', SIM_PAUSE: 'simPause', SIM_RESUME: 'simResume',
  SIM_MUTE: 'simMute', SIM_UNMUTE: 'simUnmute', SIM_RELAYOUT: 'simRelayout',
  CLEAR_BOOT_HIDE: 'clearBootHide', GUIDANCE_GATE: 'guidanceGate',
  PING_SIM_READY: 'PING_SIM_READY', PING_SIM_PAINTED: 'PING_SIM_PAINTED',
};

/** localName → wire value, for every protocol import specifier in the file (aliases resolved). */
function protocolAliases(sf: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  walk(sf, (n) => {
    if (!ts.isImportDeclaration(n) || !ts.isStringLiteral(n.moduleSpecifier)) return;
    if (!/lib\/sim\/protocol/.test(n.moduleSpecifier.text)) return;
    const named = n.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) return;
    for (const el of named.elements) {
      const exported = (el.propertyName ?? el.name).text;
      const wire = PROTOCOL_WIRE_VALUES[exported];
      if (wire) out.set(el.name.text, wire);
    }
  });
  return out;
}

function messagesBuilt(sf: ts.SourceFile, values: readonly string[], root: ts.Node = sf): Hit[] {
  const hits: Hit[] = [];
  walk(root, (n) => {
    if (!ts.isObjectLiteralExpression(n)) return;
    for (const p of n.properties) {
      if (!ts.isPropertyAssignment(p) || propName(p.name) !== 'type') continue;
      const init = p.initializer;
      if (ts.isStringLiteralLike(init) && values.includes(init.text)) {
        hits.push(hitAt(sf, init, `{ type: '${init.text}' }`));
      } else if (ts.isIdentifier(init)) {
        // review F7: a protocol CONSTANT as the type initializer laundered the message past the
        // literal-only scanner. Resolve the import (aliases included) to its wire value.
        const wire = protocolAliases(sf).get(init.text);
        if (wire && values.includes(wire)) {
          hits.push(hitAt(sf, init, `{ type: ${init.text} /* = '${wire}' */ }`));
        }
      }
    }
  });
  return hits;
}

/** Identifiers with any of these names (declarations, reads, property names — never comments). */
function identifiersNamed(sf: ts.SourceFile, names: readonly string[], root: ts.Node = sf): Hit[] {
  const hits: Hit[] = [];
  const aliases = protocolAliases(sf);
  walk(root, (n) => {
    if (!ts.isIdentifier(n)) return;
    if (names.includes(n.text)) { hits.push(hitAt(sf, n, n.text)); return; }
    // review F7: `import { SIM_READY as R }` must still read as SIM_READY.
    const wire = aliases.get(n.text);
    if (wire && names.includes(wire)) hits.push(hitAt(sf, n, `${n.text} /* = ${wire} */`));
  });
  return hits;
}

/**
 * A token as CODE: an identifier of that name, or a string literal whose whole value is that
 * token. Prose that merely mentions it (`'we never post PING_SIM_PAINTED here'`) is not a match,
 * and a comment produces no node at all.
 */
function tokensUsed(sf: ts.SourceFile, names: readonly string[], root: ts.Node = sf): Hit[] {
  const hits: Hit[] = [...identifiersNamed(sf, names, root)];
  walk(root, (n) => {
    if (ts.isStringLiteralLike(n) && names.includes(n.text)) hits.push(hitAt(sf, n, `'${n.text}'`));
  });
  return hits;
}

/** Calls to a named function or method (`applyGateFor(...)`, `rt.activate(...)`). */
function callsTo(sf: ts.SourceFile, name: string, root: ts.Node = sf): Hit[] {
  const hits: Hit[] = [];
  walk(root, (n) => {
    if (ts.isCallExpression(n) && calleeName(n.expression) === name) hits.push(hitAt(sf, n, `${name}()`));
  });
  return hits;
}

/** `new X(...)` expressions. */
function constructions(sf: ts.SourceFile, name: string): Hit[] {
  const hits: Hit[] = [];
  walk(sf, (n) => {
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) {
      hits.push(hitAt(sf, n, `new ${name}()`));
    }
  });
  return hits;
}

/** `const NAME = ...` / `let NAME = ...` declared IN this file (import bindings are not these). */
function declaresVariable(sf: ts.SourceFile, name: string): Hit[] {
  const hits: Hit[] = [];
  walk(sf, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) {
      hits.push(hitAt(sf, n, `const ${name} =`));
    }
  });
  return hits;
}

/** Module specifiers this file actually imports from. */
function importSpecifiers(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  walk(sf, (n) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteralLike(n.moduleSpecifier)) out.push(n.moduleSpecifier.text);
  });
  return out;
}

interface MessageListener {
  at: string;
  /**
   * The handler bodies to scan. A named handler resolves to EVERY same-named function in the file,
   * not just the first: several `const handler = …` can coexist (SectionEditor has three), and
   * picking one of them would silently scan the wrong body.
   */
  handlers: ts.Node[];
  /** Set when the second argument could not be resolved to a function in this file. */
  unresolved: string | null;
}

/**
 * Every `addEventListener('message', handler)` in the file, with its handler RESOLVED — an inline
 * function, or a same-file `const handler = …` / `function handler(…)`. An unresolvable handler is
 * reported rather than skipped: silently ignoring one is how this check would go vacuous.
 */
function messageListeners(sf: ts.SourceFile): MessageListener[] {
  const found: MessageListener[] = [];
  walk(sf, (n) => {
    if (!ts.isCallExpression(n) || calleeName(n.expression) !== 'addEventListener') return;
    const [event, handlerArg] = n.arguments;
    if (!event || !ts.isStringLiteralLike(event) || event.text !== 'message') return;
    const at = hitAt(sf, n, `addEventListener('message', …)`);
    if (!handlerArg) { found.push({ at, handlers: [], unresolved: '<no handler argument>' }); return; }
    if (ts.isFunctionExpression(handlerArg) || ts.isArrowFunction(handlerArg)) {
      found.push({ at, handlers: [handlerArg], unresolved: null });
      return;
    }
    if (ts.isIdentifier(handlerArg)) {
      const resolved = resolveFunctions(sf, handlerArg.text);
      found.push({ at, handlers: resolved, unresolved: resolved.length ? null : handlerArg.text });
      return;
    }
    found.push({ at, handlers: [], unresolved: handlerArg.getText(sf).slice(0, 40) });
  });
  return found;
}

/** Every same-file `const name = fn` / `function name()` — all of them, see MessageListener. */
function resolveFunctions(sf: ts.SourceFile, name: string): ts.Node[] {
  const out: ts.Node[] = [];
  walk(sf, (n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) { out.push(n); return; }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) {
      if (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)) out.push(n.initializer);
    }
  });
  return out;
}

// ── the invariants ──────────────────────────────────────────────────────────────────────────

describe('every simulation surface routes through the shared runtime', () => {
  for (const [name, rel] of Object.entries(SURFACES)) {
    it(`${name} imports the shared runtime`, () => {
      // An IMPORT, not a mention: a doc comment naming the module used to satisfy this.
      const shared = importSpecifiers(ast(rel))
        .filter((s) => /lib\/sim\/(SimRuntimeClient|useSimRuntime|SimSurface)$/.test(s));
      expect(shared.length, `${name} imports nothing from lib/sim/*`).toBeGreaterThan(0);
    });
  }
});

describe('no surface keeps a private simulation message listener', () => {
  // The runtime scopes every event to its OWN document by e.source. A second, unscoped listener is
  // how the section editor once answered the timeline player's handshake as if it were its own.
  const LIFECYCLE = ['SIM_READY', 'SIM_PAINTED', 'SCRIPT_APPLIED', 'SCRIPT_MISSING', 'SCRIPT_ERROR'] as const;
  // Surfaces that legitimately listen for NON-lifecycle messages today (guidance cues, the
  // Minimal-UI control scan). Pinned so "no listener at all" is an asserted fact per surface, not
  // an early return that quietly skips the check.
  const LISTENS: Record<string, boolean> = { viewer: true, editor: false, sectionEditor: true, avatar: false };

  for (const [name, rel] of Object.entries(SURFACES)) {
    it(`${name} does not interpret sim lifecycle messages itself`, () => {
      const sf = ast(rel);
      const listeners = messageListeners(sf);

      // 1. Every handler must be resolvable — an unresolved one would make (3) vacuous.
      expect(listeners.filter((l) => l.unresolved).map((l) => `${l.at} → ${l.unresolved}`),
        `${name}: a 'message' handler could not be resolved, so it was never scanned`).toEqual([]);

      // 2. Whether the surface listens at all is asserted, never assumed.
      expect(listeners.length > 0, `${name}: expected listensForMessages=${LISTENS[name]}`).toBe(LISTENS[name]);

      // 3. A surface may listen for its own protocols. It must not interpret the LIFECYCLE one.
      const offenders = listeners.flatMap((l) => l.handlers.flatMap((h) => tokensUsed(sf, LIFECYCLE, h)));
      expect(offenders, `${name} still handles a lifecycle message itself`).toEqual([]);
    });
  }
});

describe('no surface reimplements the reveal or cleanup machinery', () => {
  const FORBIDDEN: { what: string; why: string; find: (sf: ts.SourceFile) => Hit[] }[] = [
    { what: 'simPaintedRef', why: 'a private paint latch — the runtime owns `painted`',
      find: (sf) => identifiersNamed(sf, ['simPaintedRef']) },
    { what: 'pendingApplyRef', why: 'a private ack hold — the runtime owns the apply gate',
      find: (sf) => identifiersNamed(sf, ['pendingApplyRef']) },
    { what: 'simActivationTokenRef', why: 'private activation tokens — the runtime mints them',
      find: (sf) => identifiersNamed(sf, ['simActivationTokenRef']) },
    { what: 'PING_SIM_PAINTED / PING_SIM_READY', why: 'a private paint poll — use startPaintRecovery()',
      find: (sf) => tokensUsed(sf, ['PING_SIM_PAINTED', 'PING_SIM_READY']) },
    { what: "a { type: 'startScript' } message", why: 'a raw startScript post — use runtime.activate()',
      find: (sf) => messagesBuilt(sf, ['startScript']) },
    { what: "a { type: 'stopScript' } message", why: 'a raw stopScript post — use deactivate()/stopNow()',
      find: (sf) => messagesBuilt(sf, ['stopScript']) },
    { what: "a { type: 'simMute' | 'simUnmute' } message", why: 'raw mute posts — the runtime latches mute',
      find: (sf) => messagesBuilt(sf, ['simMute', 'simUnmute']) },
  ];

  for (const [name, rel] of Object.entries(SURFACES)) {
    for (const { what, why, find } of FORBIDDEN) {
      it(`${name} has no ${what}`, () => {
        expect(find(ast(rel)), `${name} reintroduced ${why}`).toEqual([]);
      });
    }
  }
});

describe('surface-specific behaviour that must SURVIVE the migration', () => {
  // These have no counterpart in the runtime by design. Losing them silently would be a
  // regression the runtime's own tests cannot detect.
  it('the editor keeps its destroy grace — the runtime never unmounts a frame', () => {
    const sf = ast(SURFACES.editor);
    expect(identifiersNamed(sf, ['simDestroyGraceMs']).length,
      'the editor lost its destroy grace').toBeGreaterThan(0);
    // The grace must still CLEAR the url (freeing the WebGL context), not merely mention it.
    const clears = callsTo(sf, 'setSimUrl').length > 0 && (() => {
      let cleared = false;
      walk(sf, (n) => {
        if (ts.isCallExpression(n) && calleeName(n.expression) === 'setSimUrl'
          && n.arguments[0]?.kind === ts.SyntaxKind.NullKeyword) cleared = true;
      });
      return cleared;
    })();
    expect(clears, 'the grace must still clear the URL so the WebGL context is freed').toBe(true);
  });

  it('the editor keeps the preview coordination pact with the section editor', () => {
    // A CustomEvent name — it only counts as a string literal in live code.
    expect(tokensUsed(ast(SURFACES.editor), ['sim-preview-active']).length).toBeGreaterThan(0);
    expect(tokensUsed(ast(SURFACES.sectionEditor), ['sim-preview-active']).length).toBeGreaterThan(0);
  });

  it('the section editor keeps the Minimal-UI control scan (a DIFFERENT protocol)', () => {
    expect(tokensUsed(ast(SURFACES.sectionEditor), ['simControlsList']).length).toBeGreaterThan(0);
  });

  it('the viewer keeps pooling, warming and residency planning', () => {
    const sf = ast(SURFACES.viewer);
    for (const token of ['dropPooled', 'planWindowResidency', 'navigateFrame']) {
      expect(identifiersNamed(sf, [token]).length, `the viewer lost ${token}`).toBeGreaterThan(0);
    }
  });

  it('the viewer keeps guidance gating and branching', () => {
    const sf = ast(SURFACES.viewer);
    const codeMentions = (re: RegExp): number => {
      let n = 0;
      walk(sf, (node) => {
        if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && re.test(node.text)) n++;
      });
      return n;
    };
    expect(codeMentions(/guidance/i), 'the viewer lost guidance gating').toBeGreaterThan(0);
    expect(codeMentions(/branch/i), 'the viewer lost branching').toBeGreaterThan(0);
  });
});

describe('the runtime is the single authority for the presentation gate', () => {
  it('ONLY the runtime consumes applyGateFor', () => {
    // Two copies of this rule is precisely the duplication the consolidation removed — and the
    // rule itself is the one that decides whether a wrong sub-simulation can reach the screen.
    const consumers = Object.entries(SURFACES)
      .filter(([, rel]) => callsTo(ast(rel), 'applyGateFor').length > 0 || importSpecifiers(ast(rel)).some((s) => /simApplyGate$/.test(s)))
      .map(([n]) => n);
    expect(consumers, `applyGateFor is reachable directly from: ${consumers.join(', ')}`).toEqual([]);
    expect(callsTo(ast('lib/sim/SimRuntimeClient.ts'), 'applyGateFor').length,
      'the runtime must be the one that calls it').toBeGreaterThan(0);
  });

  it('the viewer delegates the bulk of its lifecycle to the runtime', () => {
    const sf = ast(SURFACES.viewer);
    // Positive proof of delegation, so the "known gap" above cannot quietly become "no migration".
    expect(constructions(sf, 'SimRuntimeClient').length, 'the viewer never builds a runtime').toBeGreaterThan(0);
    for (const call of ['activate', 'deactivate', 'startPaintRecovery', 'handleFrameLoad']) {
      expect(callsTo(sf, call).length, `the viewer no longer delegates .${call}()`).toBeGreaterThan(0);
    }
    // The things it must NOT have taken back.
    expect(identifiersNamed(sf, ['simActivationTokenRef'])).toEqual([]);
    expect(tokensUsed(sf, ['PING_SIM_PAINTED'])).toEqual([]);
    expect(messagesBuilt(sf, ['startScript'])).toEqual([]);
  });

  it('the timings are defined once, in the protocol module', () => {
    const protocol = ast('lib/sim/protocol.ts');
    for (const c of ['SIM_FADE_MS', 'SIM_EXIT_STOP_MS', 'SIM_APPLY_STALL_MS', 'SIM_LEGACY_REVEAL_MS']) {
      expect(declaresVariable(protocol, c).length, `${c} missing from protocol.ts`).toBeGreaterThan(0);
    }
    // No surface may redefine them — divergent literals are how the exit fade and the deferred
    // teardown drifted apart in the first place. (An IMPORT binding is not a declaration here.)
    for (const [name, rel] of Object.entries(SURFACES)) {
      for (const c of ['SIM_EXIT_STOP_MS', 'SIM_APPLY_STALL_MS']) {
        expect(declaresVariable(ast(rel), c), `${name} redefines ${c}`).toEqual([]);
      }
    }
  });
});

// ── the checker itself must not be foolable ─────────────────────────────────────────────────
describe('the scanner cannot be fooled by comment-shaped strings', () => {
  /** The EXACT comment-stripping this file used to do, kept only to prove why it was replaced. */
  const legacyStrip = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  // (a) A string containing `/*` opened a fake block comment; everything up to the next real `*/`
  //     — here, two genuine violations — was deleted before the old scanner ever saw it.
  const HIDDEN_BY_FAKE_BLOCK = [
    "const label = '/* looks like a comment opener';",
    "frame.contentWindow.postMessage({ type: 'startScript', script: 'main' }, '*');",
    "const simPaintedRef = { current: false };",
    "/* a genuine trailing comment */",
    "export const ok = true;",
  ].join('\n');

  // (b) A URL-ish value with `a//b` made the line-comment rule eat the rest of that line.
  const HIDDEN_BY_FAKE_LINE_COMMENT =
    "const src = 'sim/a//b'; frame.contentWindow.postMessage({ type: 'simMute' }, '*');";

  it('the OLD regex scanner really was blind to both (this is why it was replaced)', () => {
    expect(legacyStrip(HIDDEN_BY_FAKE_BLOCK), 'the fake block comment must swallow the violations')
      .not.toMatch(/startScript|simPaintedRef/);
    expect(legacyStrip(HIDDEN_BY_FAKE_LINE_COMMENT), 'the fake line comment must swallow the violation')
      .not.toMatch(/simMute/);
  });

  it('detects a startScript post and a paint latch hidden behind a string that opens `/*`', () => {
    const sf = parse(HIDDEN_BY_FAKE_BLOCK);
    expect(messagesBuilt(sf, ['startScript']).length, 'a raw startScript post went undetected').toBe(1);
    expect(identifiersNamed(sf, ['simPaintedRef']).length, 'a private paint latch went undetected').toBe(1);
  });

  it('detects a simMute post hidden behind a value containing `a//b`', () => {
    const sf = parse(HIDDEN_BY_FAKE_LINE_COMMENT);
    expect(messagesBuilt(sf, ['simMute']).length, 'a raw mute post went undetected').toBe(1);
  });

  it('detects a lifecycle listener whose handler is hidden the same way', () => {
    const src = [
      "const note = '/* the handler below is real code';",
      "const onMsg = (e) => { if (e.data.type === 'SIM_PAINTED') reveal(); };",
      "window.addEventListener('message', onMsg);",
      "/* trailing */",
    ].join('\n');
    expect(legacyStrip(src)).not.toMatch(/SIM_PAINTED/);      // the old scanner saw nothing
    const sf = parse(src);
    const listeners = messageListeners(sf);
    expect(listeners.length).toBe(1);
    expect(listeners[0].unresolved, 'the handler must resolve, not be skipped').toBe(null);
    expect(listeners[0].handlers.flatMap((h) => tokensUsed(sf, ['SIM_PAINTED'], h)).length).toBe(1);
  });

  it('does NOT report constructs that appear only in comments or in prose strings', () => {
    const src = [
      "// never post { type: 'startScript' } from a surface — use runtime.activate()",
      "/* simPaintedRef and PING_SIM_PAINTED belong to the runtime */",
      "const doc = 'we never build { type: \"stopScript\" } here';",
      "const why = 'PING_SIM_PAINTED is the runtime’s to send';",
    ].join('\n');
    const sf = parse(src);
    expect(messagesBuilt(sf, ['startScript', 'stopScript'])).toEqual([]);
    expect(identifiersNamed(sf, ['simPaintedRef'])).toEqual([]);
    expect(tokensUsed(sf, ['PING_SIM_PAINTED']), 'prose mentioning a token is not a use').toEqual([]);
  });

  it('parses every shipping surface (a broken parse would make each check vacuous)', () => {
    for (const [name, rel] of Object.entries(SURFACES)) {
      const sf = ast(rel);
      expect(sf.statements.length, `${name} parsed to an empty AST`).toBeGreaterThan(0);
      expect(importSpecifiers(sf).length, `${name} parsed with no imports — parse likely failed`).toBeGreaterThan(0);
    }
  });
});
