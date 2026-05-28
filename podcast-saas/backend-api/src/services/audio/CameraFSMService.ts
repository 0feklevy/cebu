import type { CameraCut, CameraPlan, ShotType } from 'shared';
import type { RawScene } from './SceneSegmentationService.js';

type Pacing = 'relaxed' | 'standard' | 'energetic';

interface FSMConstants {
  minHoldMs: number;
  wideResetMs: number;
  reactionGapMs: number;
}

const FSM_CONSTANTS: Record<Pacing, FSMConstants> = {
  relaxed:   { minHoldMs: 4_000, wideResetMs: 60_000, reactionGapMs: 1_000 },
  standard:  { minHoldMs: 3_000, wideResetMs: 50_000, reactionGapMs: 800 },
  energetic: { minHoldMs: 2_500, wideResetMs: 40_000, reactionGapMs: 600 },
};

const FPS = 30;

function ms2frame(ms: number): number {
  return Math.round((ms / 1000) * FPS);
}

function speakerShot(speaker: 'host_a' | 'host_b'): ShotType {
  return speaker === 'host_a' ? 'closeup_a' : 'closeup_b';
}

function reactionShot(speaker: 'host_a' | 'host_b'): ShotType {
  return speaker === 'host_a' ? 'reaction_b' : 'reaction_a';
}

const COLLECTIVE_TAGS = new Set(['laughs', 'excited', 'interrupting']);
const OPEN_CLOSE_MS = 5_000;
const WIDE_RESET_HOLD_MS = 5_000;
const LEAD_IN_MS = 250;

export class CameraFSMService {
  generate(scenes: RawScene[], pacing: Pacing = 'standard', totalDurationMs: number): CameraPlan {
    const C = FSM_CONSTANTS[pacing];
    const cuts: CameraCut[] = [];

    if (scenes.length === 0) return { fps: FPS, cuts: [] };

    let currentShot: ShotType = 'wide';
    let shotStartMs = 0;
    let lastWideResetMs = 0;

    function pushCut(frameStart: number, frameEnd: number, shot: ShotType, sceneIdx: number) {
      if (frameEnd <= frameStart) return;
      cuts.push({ frame_start: frameStart, frame_end: frameEnd, shot, scene_idx: sceneIdx });
    }

    // Rule 1: Open on Wide for OPEN_CLOSE_MS
    const openEndMs = Math.min(OPEN_CLOSE_MS, scenes[0]?.end_ms ?? OPEN_CLOSE_MS);
    pushCut(0, ms2frame(openEndMs), 'wide', 0);
    currentShot = 'wide';
    shotStartMs = 0;
    lastWideResetMs = 0;

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const prevScene = scenes[i - 1];

      const sceneStartMs = Math.max(scene.start_ms, i === 0 ? openEndMs : 0);
      if (sceneStartMs >= scene.end_ms) continue;

      // Rule 6: collective beats → force Wide
      const hasCollective = scene.audio_tags.some((t) => COLLECTIVE_TAGS.has(t));
      if (hasCollective) {
        const holdSinceLastWide = sceneStartMs - lastWideResetMs;
        if (holdSinceLastWide >= C.minHoldMs || currentShot !== 'wide') {
          pushCut(ms2frame(sceneStartMs), ms2frame(scene.end_ms), 'wide', i);
          currentShot = 'wide';
          shotStartMs = sceneStartMs;
          lastWideResetMs = sceneStartMs;
          continue;
        }
      }

      // Rule 4: periodic Wide reset
      const timeSinceWide = sceneStartMs - lastWideResetMs;
      if (timeSinceWide >= C.wideResetMs && currentShot !== 'wide') {
        const wideEndMs = Math.min(sceneStartMs + WIDE_RESET_HOLD_MS, scene.end_ms);
        pushCut(ms2frame(sceneStartMs), ms2frame(wideEndMs), 'wide', i);
        currentShot = 'wide';
        shotStartMs = sceneStartMs;
        lastWideResetMs = sceneStartMs;

        if (wideEndMs >= scene.end_ms) continue;

        // Continue into the rest of this scene with speaker shot
        const speakerShotType = speakerShot(scene.speaker);
        if (speakerShotType !== currentShot) {
          const leadMs = Math.max(wideEndMs, sceneStartMs);
          const leadEnd = Math.min(leadMs + LEAD_IN_MS, scene.end_ms);
          if (leadEnd > leadMs) {
            pushCut(ms2frame(leadMs), ms2frame(leadEnd), 'wide', i);
          }
          pushCut(ms2frame(leadEnd), ms2frame(scene.end_ms), speakerShotType, i);
          currentShot = speakerShotType;
          shotStartMs = leadMs;
        } else {
          pushCut(ms2frame(wideEndMs), ms2frame(scene.end_ms), speakerShotType, i);
        }
        continue;
      }

      // Rule 2: default cut to active speaker MCU on speaker change
      const speakerShotType = speakerShot(scene.speaker);
      const speakerChanged = prevScene && prevScene.speaker !== scene.speaker;

      // Rule 7: anti-jump (no closeup_a → closeup_b directly at high energy)
      const isHighEnergy =
        scene.audio_tags.includes('excited') || scene.audio_tags.includes('enthusiastic');
      const needsBridgeWide =
        speakerChanged &&
        prevScene &&
        speakerShot(prevScene.speaker) !== speakerShotType &&
        isHighEnergy &&
        currentShot !== 'wide';

      if (needsBridgeWide) {
        const bridgeEndMs = Math.min(sceneStartMs + 1_000, scene.end_ms);
        pushCut(ms2frame(sceneStartMs), ms2frame(bridgeEndMs), 'wide', i);
        currentShot = 'wide';
        shotStartMs = sceneStartMs;
        lastWideResetMs = sceneStartMs;

        if (bridgeEndMs >= scene.end_ms) continue;

        const afterBridge = bridgeEndMs;
        pushCut(ms2frame(afterBridge), ms2frame(scene.end_ms), speakerShotType, i);
        currentShot = speakerShotType;
        shotStartMs = afterBridge;
        continue;
      }

      if (speakerChanged || currentShot === 'wide') {
        // Rule 2: 200-350ms lead-in stays on current shot before cutting
        const leadEndMs = Math.min(sceneStartMs + LEAD_IN_MS, scene.end_ms);
        if (leadEndMs > sceneStartMs && currentShot !== speakerShotType) {
          pushCut(ms2frame(sceneStartMs), ms2frame(leadEndMs), currentShot, i);
        }
        const cutFrom = leadEndMs;

        // Rule 5: reaction insert — check for inter-word gap at start of scene
        const words = scene.aligned_words;
        let skipToMs = cutFrom;
        if (words.length >= 2 && prevScene) {
          const firstWordStart = words[0]?.start_ms ?? scene.start_ms;
          const gapMs = firstWordStart - scene.start_ms;
          if (gapMs >= C.reactionGapMs) {
            const reactEnd = Math.min(firstWordStart, scene.end_ms);
            pushCut(ms2frame(cutFrom), ms2frame(reactEnd), reactionShot(scene.speaker), i);
            skipToMs = reactEnd;
          }
        }

        // Rule 3: min hold — don't cut if we just cut <minHoldMs ago
        const sinceLastCut = skipToMs - shotStartMs;
        const canCut = sinceLastCut >= C.minHoldMs || currentShot === 'wide';

        if (canCut || skipToMs >= scene.end_ms) {
          pushCut(ms2frame(skipToMs), ms2frame(scene.end_ms), speakerShotType, i);
          currentShot = speakerShotType;
          shotStartMs = skipToMs;
        } else {
          // Hold current shot through min-hold period
          pushCut(ms2frame(skipToMs), ms2frame(scene.end_ms), currentShot, i);
        }
      } else {
        // Same speaker, same shot — just extend
        pushCut(ms2frame(sceneStartMs), ms2frame(scene.end_ms), currentShot, i);
      }
    }

    // Rule 1: close on Wide for last OPEN_CLOSE_MS
    if (totalDurationMs > OPEN_CLOSE_MS) {
      const closeStartMs = totalDurationMs - OPEN_CLOSE_MS;
      const closeStartFrame = ms2frame(closeStartMs);
      const closeEndFrame = ms2frame(totalDurationMs);

      // Trim last cut if it overlaps with close-wide
      if (cuts.length > 0) {
        const last = cuts[cuts.length - 1];
        if (last.frame_end > closeStartFrame) {
          last.frame_end = closeStartFrame;
          if (last.frame_end <= last.frame_start) cuts.pop();
        }
      }

      pushCut(closeStartFrame, closeEndFrame, 'wide', scenes.length - 1);
    }

    // Deduplicate consecutive same-shot cuts
    const deduped: CameraCut[] = [];
    for (const cut of cuts) {
      const prev = deduped[deduped.length - 1];
      if (prev && prev.shot === cut.shot && prev.frame_end === cut.frame_start) {
        prev.frame_end = cut.frame_end;
      } else {
        deduped.push({ ...cut });
      }
    }

    return { fps: FPS, cuts: deduped };
  }
}
