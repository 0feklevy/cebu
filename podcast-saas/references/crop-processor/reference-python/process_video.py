#!/usr/bin/env python3
"""
Smart Crop Processor — offline pipeline.

Generates crop-metadata JSON for each video.  The player reads these at
runtime to apply dynamic portrait cropping without real-time inference.

Two-shot handling:
  In scenes where both speakers are visible, simple interest-map scoring
  crops to the centre and misses both faces.  This pipeline:
    1. Detects two-shot frames (≥ 2 distinct faces) via MediaPipe BlazeFace.
    2. Estimates speaker gender per frame via autocorrelation F0 analysis.
    3. Self-calibrates which face position → male / female from single-speaker
       close-up frames (no hardcoded assumptions about who sits where).
    4. Overrides two-shot crop x to the face of the active speaker.
    5. Debounces speaker switches: new speaker must be active for ≥ 1 s
       before the crop commits — brief interjections are ignored.

Usage:
  python process_video.py                  # process all missing videos
  python process_video.py clean algo       # process specific IDs
  python process_video.py --force          # re-process all
  python process_video.py clean --force    # re-process one
"""

from __future__ import annotations

import argparse
import bisect
import json
import os
import sys
import time
from dataclasses import dataclass
from collections import defaultdict

import cv2

from shot_detector    import detect_shots
from scene_analyzer   import SceneAnalyzer
from face_tracker     import FaceTracker
from crop_calculator  import interest_to_crop_x
from smoother         import smooth_keyframes
from speaker_detector import (
    extract_full_audio,
    classify_chunk,
    calibrate,
    SAMPLE_RATE,
)

# ── paths ─────────────────────────────────────────────────────────────────────
SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
VIDEO_DIR    = os.path.join(PROJECT_ROOT, 'videos')
OUTPUT_DIR   = os.path.join(PROJECT_ROOT, 'public', 'crop-metadata')

VIDEOS: dict[str, str] = {
    'clean':    'Annealing- clean.mp4',
    'waiting1': 'Annealing- waiting1.mp4',
    'waiting2': 'Anealing-waiting2.mp4',
    'waiting3': 'Annealing.mp4',
    'anlogy':   'annealing-niceville.mp4',
    'algo':     'Annealing-algo.mp4',
}

SAMPLE_INTERVAL      = 1.0    # seconds between keyframes
CROP_ASPECT          = 9 / 16 # portrait window aspect ratio

# Speaker debounce: new speaker must hold for this long before crop switches.
# Prevents brief interjections (< 1 s) from triggering an unwanted crop jump.
MIN_SPEAKER_DURATION = 1.0    # seconds
SILENCE_HOLD         = 1.5    # seconds of silence before resetting active speaker


# ── speaker debounce ──────────────────────────────────────────────────────────

@dataclass
class DebounceState:
    current_speaker:  str | None = None   # 'male' | 'female' | None
    current_face_x:   float | None = None # committed crop target (normalised)
    pending_speaker:  str | None = None   # candidate waiting to reach threshold
    pending_since:    float = 0.0         # timestamp when pending_speaker started
    last_speech_t:    float = -999.0      # last time non-silence was detected


def _apply_debounce(
    state:            DebounceState,
    speaker:          str,
    t:                float,
    face_x_candidate: float | None,
) -> float | None:
    """
    Apply speaker-continuity debounce to the crop target.

    Only commits a speaker switch after MIN_SPEAKER_DURATION of continuous
    speech — brief words by the other person are suppressed.

    Mutates state in place.  Returns the current committed face_x (or None
    if no speaker has been committed yet).
    """
    if speaker == 'silence':
        # During silence hold the last crop; reset active speaker after long pause.
        if t - state.last_speech_t > SILENCE_HOLD:
            state.current_speaker = None
            state.pending_speaker = None
        return state.current_face_x

    if speaker == 'unclear':
        # Ambiguous pitch — hold crop, don't reset silence timer.
        return state.current_face_x

    # Active speaker: 'male' or 'female'
    state.last_speech_t = t

    if state.current_speaker is None:
        # Post-silence or video start: commit the first speaker immediately.
        state.current_speaker = speaker
        state.current_face_x  = face_x_candidate
        state.pending_speaker = None
        return state.current_face_x

    if speaker == state.current_speaker:
        # Continued speech from the committed speaker — update position and hold.
        state.pending_speaker = None
        if face_x_candidate is not None:
            state.current_face_x = face_x_candidate
        return state.current_face_x

    # Different speaker detected — start or continue a pending switch.
    if speaker == state.pending_speaker:
        if t - state.pending_since >= MIN_SPEAKER_DURATION:
            # Threshold reached: commit the switch.
            state.current_speaker = speaker
            state.current_face_x  = face_x_candidate
            state.pending_speaker = None
        # else: still building up duration — hold current crop.
    else:
        # New candidate (displaces any previous pending speaker).
        state.pending_speaker = speaker
        state.pending_since   = t

    return state.current_face_x


# ── core ──────────────────────────────────────────────────────────────────────

def process_video(video_id: str, video_path: str) -> dict:
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f'Cannot open: {video_path}')

    fps      = cap.get(cv2.CAP_PROP_FPS) or 30.0
    n_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    W        = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    H        = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    dur      = n_frames / fps
    print(f'  {video_id}  {W}×{H}  {dur:.1f}s  {fps:.0f}fps')

    # ── 1. Shot detection ─────────────────────────────────────────────────────
    print('  → detecting shots …', end='', flush=True)
    t0 = time.perf_counter()
    shot_times = detect_shots(cap, fps)
    print(f' {len(shot_times)} shots  ({time.perf_counter()-t0:.1f}s)')

    # ── 2. Audio extraction (one ffmpeg call for the whole video) ─────────────
    print('  → extracting audio …', end='', flush=True)
    t0 = time.perf_counter()
    try:
        audio = extract_full_audio(video_path, sr=SAMPLE_RATE)
        has_audio = True
        print(f' {len(audio)/SAMPLE_RATE:.1f}s  ({time.perf_counter()-t0:.1f}s)')
    except Exception as e:
        print(f' FAILED ({e}) — speaker detection disabled')
        audio     = None
        has_audio = False

    # ── 3. Per-second frame + audio analysis ──────────────────────────────────
    analyzer    = SceneAnalyzer(W, H)
    tracker     = FaceTracker()
    step_frames = max(1, int(fps * SAMPLE_INTERVAL))
    total_steps = max(1, int(dur / SAMPLE_INTERVAL))

    print(f'  → analysing {total_steps} keyframes …', end='', flush=True)
    t0 = time.perf_counter()

    keyframes: list[dict] = []
    prev_gray  = None
    frame_idx  = 0
    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        if frame_idx % step_frames == 0:
            t    = round(frame_idx / fps, 3)
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

            # Vision analysis (face detection + interest map)
            fa = analyzer.analyze(frame, gray, prev_gray)

            # Stable person identity (left_person / right_person across frames)
            person_ids = tracker.update(fa.face_xs, t)

            # Audio analysis for this 1-second window
            if has_audio and audio is not None:
                a0    = int(t * SAMPLE_RATE)
                a1    = int((t + SAMPLE_INTERVAL) * SAMPLE_RATE)
                chunk = audio[a0:a1] if a1 <= len(audio) else audio[a0:]
                speaker, sp_conf = classify_chunk(chunk, SAMPLE_RATE)
            else:
                speaker, sp_conf = 'unclear', 0.0

            # Default crop from interest map
            cx = interest_to_crop_x(fa.interest_x, W, H, CROP_ASPECT)
            keyframes.append({
                't':              t,
                'x':              round(cx, 4),
                # Internal fields (stripped before JSON output)
                '_face_xs':       fa.face_xs,
                '_face_confs':    fa.face_confs,
                '_shot_type':     fa.shot_type,
                '_speaker':       speaker,
                '_sp_conf':       round(sp_conf, 3),
                '_active_face_x': fa.active_face_x,
            })
            prev_gray = gray

            if len(keyframes) % 60 == 0:
                elapsed   = time.perf_counter() - t0
                remaining = elapsed / len(keyframes) * (total_steps - len(keyframes))
                print(f' {len(keyframes)}/{total_steps} (~{remaining:.0f}s left)',
                      end='', flush=True)

        frame_idx += 1

    cap.release()
    print(f'  done ({len(keyframes)} kf, {time.perf_counter()-t0:.1f}s)')

    # ── 4. Speaker calibration ────────────────────────────────────────────────
    if has_audio:
        print('  → calibrating speakers …', end='', flush=True)
        cal_input = [
            {
                't':             kf['t'],
                'shot_type':     kf['_shot_type'],
                'face_xs':       kf['_face_xs'],
                'face_confs':    kf['_face_confs'],
                'speaker':       kf['_speaker'],
                'speaker_conf':  kf['_sp_conf'],
                'active_face_x': kf.get('_active_face_x'),
            }
            for kf in keyframes
        ]
        cal = calibrate(cal_input)
        print(f' {cal.summary()}')
    else:
        cal = None

    # ── 5. Two-shot crop override with speaker debounce ───────────────────────
    # For each two-shot frame:
    #   Priority 1 — calibrated speaker face (pitch → gender → stored position)
    #   Priority 2 — motion-detected active face (speaking face moves more)
    #   Priority 3 — midpoint between faces (last resort)
    # Then the debounce gate: the switch only commits after MIN_SPEAKER_DURATION
    # of continuous speech, suppressing brief interjections.
    two_shot_total    = 0
    two_shot_cal      = 0
    two_shot_motion   = 0
    two_shot_fallback = 0

    debounce_state = DebounceState()
    last_seg_idx   = -1

    for kf in keyframes:
        if kf['_shot_type'] != 'two_shot':
            continue
        two_shot_total += 1

        t       = kf['t']
        face_xs = kf['_face_xs']
        speaker = kf['_speaker']

        # Reset debounce at shot boundaries so a new two-shot scene starts clean.
        seg_idx = bisect.bisect_right(shot_times, t) - 1
        if seg_idx != last_seg_idx:
            debounce_state = DebounceState()
            last_seg_idx   = seg_idx

        # Resolve face_x candidate (same priority chain as before)
        face_x_candidate = None
        if cal is not None and cal.valid:
            face_x_candidate = cal.speaker_face_x(speaker, face_xs)
            if face_x_candidate is not None:
                two_shot_cal += 1

        if face_x_candidate is None:
            motion_x = kf.get('_active_face_x')
            if motion_x is not None:
                face_x_candidate = motion_x
                two_shot_motion += 1

        if face_x_candidate is None and len(face_xs) >= 2:
            face_x_candidate = (face_xs[0] + face_xs[-1]) / 2
            two_shot_fallback += 1

        # Apply debounce — only commits switch after sustained speech
        committed_x = _apply_debounce(debounce_state, speaker, t, face_x_candidate)

        if committed_x is not None:
            kf['x'] = round(interest_to_crop_x(committed_x, W, H, CROP_ASPECT), 4)

    if two_shot_total > 0:
        print(f'  → two-shot: {two_shot_total} frames | '
              f'calibrated: {two_shot_cal} | '
              f'motion: {two_shot_motion} | '
              f'fallback (midpoint): {two_shot_fallback}')

    # ── 6. Temporal smoothing ─────────────────────────────────────────────────
    print('  → smoothing …', end='', flush=True)
    clean_kf = [{'t': kf['t'], 'x': kf['x']} for kf in keyframes]
    clean_kf = smooth_keyframes(clean_kf, shot_times, sample_interval=SAMPLE_INTERVAL)
    print(' done')

    return {
        'video_id':    video_id,
        'duration':    round(dur, 3),
        'width':       W,
        'height':      H,
        'crop_aspect': CROP_ASPECT,
        'keyframes':   clean_kf,
    }


# ── entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument('videos', nargs='*',
                        help='video IDs to process (default: all missing)')
    parser.add_argument('--force', action='store_true',
                        help='re-process even if output JSON already exists')
    args = parser.parse_args()

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    targets = args.videos if args.videos else list(VIDEOS.keys())
    unknown = [v for v in targets if v not in VIDEOS]
    if unknown:
        print(f'Unknown ID(s): {", ".join(unknown)}'
              f'\nValid: {", ".join(VIDEOS)}', file=sys.stderr)
        sys.exit(1)

    any_processed = False
    for video_id in targets:
        out_path   = os.path.join(OUTPUT_DIR, f'{video_id}.json')
        video_path = os.path.join(VIDEO_DIR, VIDEOS[video_id])

        if os.path.exists(out_path) and not args.force:
            print(f'✓  {video_id}: already processed → skipping')
            continue
        if not os.path.exists(video_path):
            print(f'✗  {video_id}: file not found: {video_path}', file=sys.stderr)
            continue

        print(f'\n▶  Processing {video_id} …')
        any_processed = True
        try:
            metadata = process_video(video_id, video_path)
            with open(out_path, 'w') as f:
                json.dump(metadata, f, separators=(',', ':'))
            size_kb = os.path.getsize(out_path) / 1024
            print(f'✓  {video_id}: saved  ({size_kb:.1f} KB)  →  {out_path}')
        except Exception as exc:
            print(f'✗  {video_id}: {exc}', file=sys.stderr)
            import traceback; traceback.print_exc()

    if not any_processed:
        print('\nAll videos already processed.  Use --force to re-run.')


if __name__ == '__main__':
    main()
