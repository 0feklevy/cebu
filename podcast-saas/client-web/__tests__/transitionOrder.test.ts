/**
 * SOURCE INVARIANTS for the player-side transition ORDERING.
 *
 * The browser suite (e2e/sim-transitions.spec.ts) proves the CHILD side: given a message
 * sequence, the sim behaves. It replays those sequences from its own fixtures, so it cannot
 * prove the player still EMITS them — the flagship atomic-exit fix had no test anywhere that
 * failed if it regressed, while the suite's control test made it look regression-proof (audited).
 *
 * These tests read the real hook/component sources and assert the orderings that carry the
 * user-visible guarantees. They are deliberately structural: a unit test cannot run the hook
 * (it owns iframes, rAF and cross-origin postMessage), but the ORDER of these statements is
 * exactly what broke before, twice.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const viewer = readFileSync(join(__dirname, '../components/viewer/useProjectPlayer.ts'), 'utf8');
const editor = readFileSync(join(__dirname, '../components/VideoPlayer.tsx'), 'utf8');

/** Index of the first match, asserted to exist. */
const at = (src: string, needle: string, label: string): number => {
  const i = src.indexOf(needle);
  expect(i, `${label}: not found — ${needle}`).toBeGreaterThan(-1);
  return i;
};

describe('atomic exit — the fade must complete BEFORE the section is torn down', () => {
  // stopScript restores the controls the section had hidden. Posting it at the boundary rendered
  // the full UI for the whole 200ms fade — a deterministic Minimal-UI flash on every exit.
  it('viewer: deactivateSim freezes and mutes, and defers stopScript rather than posting it', () => {
    const body = viewer.slice(at(viewer, 'const deactivateSim', 'viewer deactivateSim'));
    const block = body.slice(0, body.indexOf('\n  };'));
    expect(block, 'exit must freeze the frame').toContain("simPause");
    expect(block, 'a hidden frame must never keep sounding').toContain("simMute");
    expect(block, 'stopScript must be DEFERRED past the fade').toContain('scheduleDeferredStop');
    expect(block, 'stopScript must not be posted synchronously at the boundary')
      .not.toMatch(/type:\s*'stopScript'/);
  });

  it('viewer: the deferred stop is registered in the map the planner and unmount both read', () => {
    // A bare setTimeout is invisible to the planner's mid-fade keep-set and to unmount cleanup:
    // the frame could be evicted mid-fade (hard cut) and the timer fire into a detached iframe.
    const sched = viewer.slice(at(viewer, 'const scheduleDeferredStop', 'scheduleDeferredStop'));
    expect(sched.slice(0, 400)).toContain('simDeferredStopRef.current.set');
    // The legacy back-to-video reload path must use the same registry.
    const legacy = viewer.slice(at(viewer, 'reset-reload-legacy', 'legacy reload path'));
    expect(legacy.slice(0, 600), 'legacy reload timer must be registered, not bare')
      .toContain('simDeferredStopRef.current.set');
  });

  it('editor: the deferred stop survives the block that arms it', () => {
    // It armed the timer and then unconditionally cleared it 12 lines later, in the same
    // synchronous block — so stopScript was never sent on exit at all (audited dead code).
    const exit = editor.slice(at(editor, 'const stopTarget = activeSimUrlRef.current', 'editor exit'));
    const block = exit.slice(0, exit.indexOf('return;'));
    const armed = at(block, 'simStopTimerRef.current = setTimeout', 'editor arm');
    const cleared = block.indexOf('simStopTimerRef.current = null', armed + 1);
    // Only the clear INSIDE the timer callback may follow; no second unconditional clear.
    const strayClear = block.indexOf('if (simStopTimerRef.current) { clearTimeout', armed);
    expect(strayClear, 'the exit block must not cancel the stop it just armed').toBe(-1);
    expect(cleared, 'the timer callback should null its own ref').toBeGreaterThan(armed);
  });
});

describe('reveal ordering — never present an unacknowledged or torn-down frame', () => {
  it('viewer: the gate decision is taken before lastScript is overwritten', () => {
    // Duplicated from simApplyGate.test.ts on purpose: this is the ordering that silently
    // disabled the entire ack mechanism, and it should fail loudly from more than one place.
    expect(at(viewer, 'applyGateFor(meta, script)', 'gate call'))
      .toBeLessThan(at(viewer, 'meta.lastScript = script;', 'lastScript write'));
  });

  it('viewer: a deferred stop marks the document stopped, not merely script-less', () => {
    // lastScript=null alone reads as a genuine FIRST activation, which the gate reveals
    // immediately — so nulling it GUARANTEED the no-wait path over a document showing the old
    // frozen frame with its full UI restored.
    const sched = viewer.slice(at(viewer, 'const scheduleDeferredStop', 'scheduleDeferredStop'));
    const block = sched.slice(0, sched.indexOf('const cancelPendingApply'));
    expect(block, 'the teardown must be recorded as stopped').toMatch(/stopped\s*=\s*true/);
  });

  it('viewer: every activation path clears the stopped flag', () => {
    // If an activation forgot this, the package would wait for an ack on every later entry.
    expect((viewer.match(/\.stopped\s*=\s*false/g) ?? []).length,
      'each activation/fresh-document path must clear stopped').toBeGreaterThanOrEqual(4);
  });

  it('viewer: the awaited apply always has a terminal reveal', () => {
    const awaitBlock = viewer.slice(at(viewer, "=== 'await-ack'", 'await branch'));
    expect(awaitBlock.slice(0, 1200)).toContain('revealSim({ force: true })');
  });

  it('editor: SIM_PAINTED latches, so the reveal poll can early-exit', () => {
    const painted = editor.slice(at(editor, "type === 'SIM_PAINTED'", 'SIM_PAINTED handler'));
    expect(painted.slice(0, 300)).toContain('simPaintedRef.current = true');
  });

  it('editor: a fresh document resets the paint latch', () => {
    const load = editor.slice(at(editor, 'const handleSimFrameLoad', 'handleSimFrameLoad'));
    expect(load.slice(0, 400)).toContain('simPaintedRef.current = false');
  });
});

describe('mute ordering — a frame muted on exit must be unmuted on every re-entry', () => {
  // The gate LATCHES mute (it patches play() to force muted until an explicit simUnmute), so a
  // path that activates without unmuting brings the sim back permanently silent.
  it('editor: the SIM_READY activation path unmutes', () => {
    const ready = editor.slice(at(editor, "type === 'SIM_READY'", 'editor SIM_READY'));
    const block = ready.slice(0, ready.indexOf("type === 'SIM_PAINTED'"));
    expect(block, 'the pending-start path must unmute').toContain('simUnmute');
  });

  it('viewer: every startScript send is accompanied by an unmute in the same block', () => {
    // Cheap structural proxy: the viewer has an unmute for each of its activation paths.
    const unmutes = (viewer.match(/type:\s*'simUnmute'/g) ?? []).length;
    expect(unmutes, 'each activation path needs its own unmute').toBeGreaterThanOrEqual(3);
  });
});
