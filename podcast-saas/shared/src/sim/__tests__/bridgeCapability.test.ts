/**
 * The publication-time bridge capability record (audit P0.5).
 *
 * This one boolean is what turns the viewer's FIRST activation of a package from a guess into a
 * lookup. Both of its failure directions are viewer-visible, and they are opposite:
 *   a false TRUE  → the gate waits for an acknowledgement that can never come, and the section sits
 *                   behind a cover for its whole duration;
 *   a false FALSE → the gate reveals whatever the pooled document had already drawn — the boot
 *                   scene, the default sub-simulation — as if it were the section requested.
 * So the detector is tested against the real assembled shapes, and the reader is tested against
 * every kind of garbage a JSONB column written by several releases can hold.
 */
import { describe, it, expect } from 'vitest';
import {
  BRIDGE_CAPABILITIES_KEY,
  bridgeAckCapableFromMetadata,
  detectBridgeCapabilities,
  detectEntryCapabilities,
  requiresImportMapsFromMetadata,
} from '../bridgeCapability.js';

/** The shape the combined wrapper actually emits (SimulationService.wrapBridgeCombined). */
const ACKING_BRIDGE = `(function () {
  'use strict';
  function startScript(name, params, token) {
    try {
      _cancelFn = _trackTimers(function () { return fn(params || {}) || null; });
      var _ack = function () { _post({ type: 'SCRIPT_APPLIED', script: name || 'main', token: token }); };
      if (_sysRaf) _sysRaf(_ack); else _ack();
    } catch (err) {
      _post({ type: 'SCRIPT_ERROR', phase: 'start', script: name, token: token, message: String(err) });
    }
  }
})();`;

describe('detectBridgeCapabilities', () => {
  it('recognises the acknowledgement the combined wrapper emits', () => {
    expect(detectBridgeCapabilities(ACKING_BRIDGE)).toEqual({ scriptApplied: true });
  });

  it('reports FALSE for a pre-ack bridge that is otherwise complete', () => {
    // A dynamic bridge from the one-day window between `dispatch: 'dynamic'` shipping and
    // SCRIPT_APPLIED shipping. These are real stored packages and the honest answer about them is
    // "cannot acknowledge", which is what lets the viewer reveal their switches without waiting.
    const preAck = ACKING_BRIDGE.replace(/var _ack[\s\S]*?else _ack\(\);/, '');
    expect(preAck).not.toContain('SCRIPT_APPLIED');
    expect(detectBridgeCapabilities(preAck)).toEqual({ scriptApplied: false });
  });

  it('requires the POST, not just the word — vocabulary is not behaviour', () => {
    // The name appears in comments and in the parent's own protocol constants. A bridge that merely
    // mentions it acknowledges nothing, and recording `true` for it would hold every one of its
    // switches behind a cover waiting for a message no code path sends.
    const mentionsOnly = `(function(){ /* the player listens for SCRIPT_APPLIED */ var t = 'SCRIPT_APPLIED'; })();`;
    expect(detectBridgeCapabilities(mentionsOnly)).toEqual({ scriptApplied: false });
  });

  it('is not defeated by whitespace or quote style', () => {
    for (const variant of [
      `_post({type:'SCRIPT_APPLIED',script:n,token:t});`,
      `_post( {  type : "SCRIPT_APPLIED", script: n } );`,
    ]) {
      expect(detectBridgeCapabilities(variant).scriptApplied, variant).toBe(true);
    }
  });

  it('an empty bridge is not capable', () => {
    expect(detectBridgeCapabilities('')).toEqual({ scriptApplied: false });
  });
});

// ── The import-map requirement (audit P0.8) ──────────────────────────────────────────────────────
//
// Both failure directions are viewer-visible and opposite, as with the ack:
//   a false TRUE  → a package that would have run is replaced by a still image on a browser that
//                   could have shown the real thing;
//   a false FALSE → the user gets a permanently blank frame, which is the whole defect P0.8 exists
//                   to end.
// So the detector is tested against the real shapes an entry document takes, including the ones a
// regex is most likely to get wrong.

/** What the flagship packages' entry HTML actually looks like. */
const IMPORT_MAP_ENTRY = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <script type="importmap">
      { "imports": { "three": "./vendor/three.module.js" } }
    </script>
    <script type="module" src="./main.js"></script>
  </head>
  <body><canvas id="c"></canvas></body>
</html>`;

describe('detectEntryCapabilities — what the entry document needs from the browser', () => {
  it('finds the import map the flagship packages actually ship', () => {
    expect(detectEntryCapabilities(IMPORT_MAP_ENTRY)).toEqual({ requiresImportMaps: true });
  });

  it('is not defeated by attribute order, quoting, whitespace or case', () => {
    // Every one of these is a `<script type=importmap>` to the HTML parser, so every one of them
    // fails identically on Safari 16.3. A detector that missed any of them would report a confident
    // `false` for a package that cannot run — the blank frame, recorded as "fine".
    for (const variant of [
      '<script type="importmap">{}</script>',
      "<script type='importmap'>{}</script>",
      '<script type=importmap>{}</script>',
      '<script type = "importmap" >{}</script>',
      '<script type="  importmap  ">{}</script>',
      '<SCRIPT TYPE="ImportMap">{}</SCRIPT>',
      '<script async id="im" type="importmap" data-x="1">{}</script>',
      '<script\n  type="importmap"\n>{}</script>',
      '<script type=importmap />',
    ]) {
      expect(detectEntryCapabilities(variant).requiresImportMaps, variant).toBe(true);
    }
  });

  it('does not match a module script, a shim attribute, or an empty document', () => {
    // `type="module"` is on nearly every modern entry document and needs no import map; the shim
    // attribute is the polyfill's own and is inert to every real browser. Matching either would
    // poster-only a huge share of packages that run fine.
    for (const notAnImportMap of [
      '<script type="module" src="./main.js"></script>',
      '<script type="text/javascript"></script>',
      '<script type="importmap-shim">{}</script>',
      '<script type="application/importmap+json">{}</script>',
      '<html><body>no scripts at all</body></html>',
      '',
    ]) {
      expect(detectEntryCapabilities(notAnImportMap).requiresImportMaps, notAnImportMap).toBe(false);
    }
  });

  it('ignores a commented-out import map', () => {
    const commented = `<head><!-- <script type="importmap">{}</script> --></head>`;
    expect(detectEntryCapabilities(commented).requiresImportMaps).toBe(false);
  });

  it('ignores an import map that is only a string inside another script', () => {
    // A loader that BUILDS an import map has the tag text in its source. The tag is not in the
    // document, so the document does not depend on import-map support to parse and evaluate.
    const inSource = `<script>const t = '<script type="importmap">{}<\\/script>'; use(t);</script>`;
    expect(detectEntryCapabilities(inSource).requiresImportMaps).toBe(false);
  });

  it('still finds a real import map in a document that also mentions one in a comment', () => {
    // The stripping must remove the decoys, not the evidence.
    const both = `<!-- we used to inline <script type="importmap"> here -->
      <script type="importmap">{ "imports": {} }</script>`;
    expect(detectEntryCapabilities(both).requiresImportMaps).toBe(true);
  });
});

describe('bridgeAckCapableFromMetadata — absence is UNKNOWN, never "no"', () => {
  it('reads a recorded true and a recorded false', () => {
    expect(bridgeAckCapableFromMetadata({ [BRIDGE_CAPABILITIES_KEY]: { scriptApplied: true } })).toBe(true);
    expect(bridgeAckCapableFromMetadata({ [BRIDGE_CAPABILITIES_KEY]: { scriptApplied: false } })).toBe(false);
  });

  it('returns null for every shape that is not a recorded boolean', () => {
    // Each of these is reachable: null metadata (an old draft), a metadata object written before
    // the key existed, a half-written record, and a value of the wrong type from a hand-edited row.
    const cases: unknown[] = [
      null,
      undefined,
      {},
      { weight: { totalBytes: 1 } },
      { [BRIDGE_CAPABILITIES_KEY]: null },
      { [BRIDGE_CAPABILITIES_KEY]: {} },
      { [BRIDGE_CAPABILITIES_KEY]: { scriptApplied: 'true' } },
      { [BRIDGE_CAPABILITIES_KEY]: { scriptApplied: 1 } },
      { [BRIDGE_CAPABILITIES_KEY]: 'yes' },
      'not an object',
      42,
    ];
    for (const c of cases) {
      expect(bridgeAckCapableFromMetadata(c), JSON.stringify(c) ?? String(c)).toBeNull();
    }
  });

  it('coexists with the weight report — they share one metadata column', () => {
    const metadata = {
      trigger: 'section-generation',
      weight: { totalBytes: 10, fileCount: 2 },
      [BRIDGE_CAPABILITIES_KEY]: { scriptApplied: true },
    };
    expect(bridgeAckCapableFromMetadata(metadata)).toBe(true);
  });

  it('round-trips what the detector produced', () => {
    const caps = detectBridgeCapabilities(ACKING_BRIDGE);
    expect(bridgeAckCapableFromMetadata({ [BRIDGE_CAPABILITIES_KEY]: caps })).toBe(true);
  });
});

describe('requiresImportMapsFromMetadata — the two facts share a record without shadowing', () => {
  it('reads a recorded true and a recorded false', () => {
    expect(requiresImportMapsFromMetadata({ [BRIDGE_CAPABILITIES_KEY]: { requiresImportMaps: true } })).toBe(true);
    expect(requiresImportMapsFromMetadata({ [BRIDGE_CAPABILITIES_KEY]: { requiresImportMaps: false } })).toBe(false);
  });

  it('reads NULL when the record exists but predates this field', () => {
    // Every revision published between P0.5 and P0.8 is exactly this shape. It knows about the
    // bridge and nothing about the entry document, and each answer must stand on its own.
    const p05Only = { [BRIDGE_CAPABILITIES_KEY]: { scriptApplied: true } };
    expect(bridgeAckCapableFromMetadata(p05Only)).toBe(true);
    expect(requiresImportMapsFromMetadata(p05Only)).toBeNull();
  });

  it('returns null for every shape that is not a recorded boolean', () => {
    const cases: unknown[] = [
      null, undefined, {}, { weight: { totalBytes: 1 } },
      { [BRIDGE_CAPABILITIES_KEY]: null },
      { [BRIDGE_CAPABILITIES_KEY]: {} },
      { [BRIDGE_CAPABILITIES_KEY]: { requiresImportMaps: 'true' } },
      { [BRIDGE_CAPABILITIES_KEY]: { requiresImportMaps: 1 } },
      { [BRIDGE_CAPABILITIES_KEY]: 'yes' },
      'not an object', 42,
    ];
    for (const c of cases) {
      expect(requiresImportMapsFromMetadata(c), JSON.stringify(c) ?? String(c)).toBeNull();
    }
  });

  it('round-trips a record carrying BOTH detections', () => {
    const caps = { ...detectBridgeCapabilities(ACKING_BRIDGE), ...detectEntryCapabilities(IMPORT_MAP_ENTRY) };
    expect(bridgeAckCapableFromMetadata({ [BRIDGE_CAPABILITIES_KEY]: caps })).toBe(true);
    expect(requiresImportMapsFromMetadata({ [BRIDGE_CAPABILITIES_KEY]: caps })).toBe(true);
  });
});
