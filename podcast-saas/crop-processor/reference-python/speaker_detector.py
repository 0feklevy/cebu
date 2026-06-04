"""
Speaker detection via pitch estimation (autocorrelation-based F0).

Why autocorrelation, not raw FFT peak:
  Raw FFT finds the strongest partial — often a harmonic (2×F0, 3×F0), not
  the fundamental.  Autocorrelation finds the lag at which the signal repeats,
  which directly equals the period of the fundamental, regardless of harmonic
  weighting.

Pipeline:
  1. extract_full_audio()  — one ffmpeg call per video → float32 array
  2. classify_chunk()      — per-second window → 'male'|'female'|'silence'|'unclear'
  3. calibrate()           — from single-speaker frames: learn female_x, male_x
  4. SpeakerCalibration.speaker_face_x() — resolve two-shot crop target

Pitch thresholds (tweakable via constants):
  Female podcast speech: ~160–300 Hz
  Male   podcast speech: ~90–160 Hz
  Gray zone ±10 Hz around the threshold → 'unclear'
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass, field

import numpy as np

# ── constants ─────────────────────────────────────────────────────────────────
SAMPLE_RATE      = 16_000   # Hz (pitch < 500 Hz, so 16k is plenty)
SILENCE_RMS      = 0.005    # frames below this RMS treated as silence
MIN_CONF         = 0.30     # minimum autocorr peak to trust an F0 estimate
FEMALE_THRESH_HZ = 160      # F0 >= this → female speaker
GRAY_ZONE_HZ     = 10       # ±10 Hz around threshold → 'unclear'
CAL_MIN_CONF     = 0.35     # minimum speaker confidence to use in calibration
TWO_SHOT_MIN     = 5        # minimum two-shot samples before calibration is valid


# ── audio extraction ──────────────────────────────────────────────────────────

def extract_full_audio(video_path: str, sr: int = SAMPLE_RATE) -> np.ndarray:
    """
    Extract the full audio track as a mono float32 array via ffmpeg.
    One call per video — the caller slices by time index.
    Raises RuntimeError if ffmpeg produces no output.
    """
    cmd = [
        'ffmpeg', '-y',
        '-i', video_path,
        '-vn',               # skip video
        '-ar', str(sr),      # resample to sr
        '-ac', '1',          # mono
        '-f', 's16le',       # raw signed 16-bit PCM on stdout
        'pipe:1',
        '-loglevel', 'error',
    ]
    proc = subprocess.run(cmd, capture_output=True, timeout=600)
    if not proc.stdout:
        raise RuntimeError(f'ffmpeg produced no audio output for {video_path!r}')
    audio = np.frombuffer(proc.stdout, dtype=np.int16).astype(np.float32) / 32768.0
    return audio


# ── pitch estimation ──────────────────────────────────────────────────────────

def _f0_autocorr(
    chunk: np.ndarray,
    sr:    int,
    fmin:  int = 70,
    fmax:  int = 450,
) -> tuple[float, float]:
    """
    Estimate fundamental frequency via normalized autocorrelation.
    Returns (f0_hz, confidence ∈ [0, 1]).
    Low confidence → non-tonal (noise, music, mixed voices).
    """
    n = len(chunk)
    lag_min = max(1, sr // fmax)
    lag_max = min(n - 1, sr // fmin)
    if lag_min >= lag_max or n < 64:
        return 0.0, 0.0

    # Pre-emphasis: y[n] = x[n] - 0.97·x[n-1]  (boost upper harmonics)
    emph = np.empty_like(chunk)
    emph[0] = chunk[0]
    emph[1:] = chunk[1:] - 0.97 * chunk[:-1]

    windowed = emph * np.hanning(n)

    # FFT-based autocorrelation — O(n log n), handles any length
    fft_size = 1 << int(np.ceil(np.log2(2 * n)))
    F   = np.fft.rfft(windowed, n=fft_size)
    acf = np.fft.irfft(F * np.conj(F))[:n].real

    zero_lag = acf[0]
    if zero_lag < 1e-9:
        return 0.0, 0.0

    acf_norm = acf / zero_lag

    # Find the highest peak in the valid lag range
    segment  = acf_norm[lag_min : lag_max + 1]
    if segment.size == 0:
        return 0.0, 0.0

    peak_off  = int(np.argmax(segment))
    peak_lag  = lag_min + peak_off
    confidence = float(acf_norm[peak_lag])
    f0         = float(sr / peak_lag) if peak_lag > 0 else 0.0
    return f0, confidence


def classify_chunk(chunk: np.ndarray, sr: int = SAMPLE_RATE) -> tuple[str, float]:
    """
    Classify a mono audio chunk as one of:
      'silence'  — very low energy
      'male'     — F0 below FEMALE_THRESH_HZ with sufficient confidence
      'female'   — F0 at or above FEMALE_THRESH_HZ with sufficient confidence
      'unclear'  — low pitch confidence or in the gray zone (both speakers?
                   background music? breath sounds?)

    Returns (label, confidence ∈ [0, 1]).
    """
    if chunk.size == 0:
        return 'silence', 1.0

    rms = float(np.sqrt(np.mean(chunk ** 2)))
    if rms < SILENCE_RMS:
        return 'silence', 1.0

    f0, conf = _f0_autocorr(chunk, sr)

    if conf < MIN_CONF or f0 == 0.0:
        return 'unclear', 0.0

    lo = FEMALE_THRESH_HZ - GRAY_ZONE_HZ
    hi = FEMALE_THRESH_HZ + GRAY_ZONE_HZ

    if f0 >= hi:
        return 'female', conf
    elif f0 < lo:
        return 'male', conf
    else:
        # Gray zone — soft 'unclear' with partial confidence
        return 'unclear', conf * 0.4


# ── calibration ───────────────────────────────────────────────────────────────

@dataclass
class SpeakerCalibration:
    """
    Learned mapping from speaker gender → face-centre X in the frame.
    Derived from two-shot frames where face position, pitch, and motion
    signal are combined to identify which face belongs to which speaker.

    Positions are weighted means (speaker_conf × face_detection_confidence),
    so low-quality detections have less influence than high-quality ones.
    """
    female_x:         float | None = None
    male_x:           float | None = None
    valid:            bool         = False
    female_x_stddev:  float = field(default=0.0, repr=False)  # spread of samples
    male_x_stddev:    float = field(default=0.0, repr=False)

    # Diagnostic counters
    n_female_cal: int = field(default=0, repr=False)
    n_male_cal:   int = field(default=0, repr=False)

    def speaker_face_x(self, speaker: str, face_xs: list[float]) -> float | None:
        """
        Given the detected speaker label and the list of face-centre x positions
        in a two-shot frame (sorted left→right), return the x of the face most
        likely to be speaking.

        Returns None if calibration data is missing for that speaker.
        """
        if not face_xs or speaker not in ('male', 'female'):
            return None
        ref = self.female_x if speaker == 'female' else self.male_x
        if ref is None:
            return None
        # Nearest face to the calibrated anchor
        return min(face_xs, key=lambda x: abs(x - ref))

    def summary(self) -> str:
        f = (f'{self.female_x:.3f} ±{self.female_x_stddev:.3f} ({self.n_female_cal} samples)'
             if self.female_x is not None else 'n/a')
        m = (f'{self.male_x:.3f} ±{self.male_x_stddev:.3f} ({self.n_male_cal} samples)'
             if self.male_x   is not None else 'n/a')
        return f'female_x={f}  male_x={m}  valid={self.valid}'


def _weighted_mean_std(
    samples: list[tuple[float, float]],
) -> tuple[float, float]:
    """
    Compute weighted mean and weighted standard deviation.
    samples: list of (value, weight) pairs.
    Falls back to plain mean/std when all weights are negligible.
    """
    vals    = np.array([v for v, _ in samples], dtype=np.float64)
    weights = np.array([w for _, w in samples], dtype=np.float64)
    weights = np.clip(weights, 0.0, None)

    w_sum = weights.sum()
    if w_sum < 1e-6:
        # All weights are negligible — fall back to unweighted statistics.
        return float(np.median(vals)), float(np.std(vals))

    mean     = float(np.average(vals, weights=weights))
    variance = float(np.average((vals - mean) ** 2, weights=weights))
    return mean, float(np.sqrt(variance))


def _face_conf_for_x(
    face_xs: list[float], face_confs: list[float], target_x: float,
) -> float:
    """Return the detection confidence for the face nearest to target_x."""
    if not face_xs or not face_confs or len(face_xs) != len(face_confs):
        return 1.0  # unknown confidence — don't penalise
    idx = int(np.argmin(np.abs(np.array(face_xs) - target_x)))
    return float(face_confs[idx])


def calibrate(keyframes: list[dict]) -> SpeakerCalibration:
    """
    Build a SpeakerCalibration from two-shot frames (primary) and
    single-speaker frames (fallback).

    Two-shot calibration uses audio pitch (speaker identity) combined with
    face-region motion (active_face_x — the face with most pixel change).
    In static two-shot scenes the speaking face consistently shows lip/head
    movement while the silent face is still, so the motion signal reliably
    identifies WHICH face belongs to WHICH speaker without hardcoding left/right.

    Samples are weighted by speaker_conf × face_detection_confidence so that
    uncertain detections contribute less to the final calibrated position.

    Required keyframe fields: shot_type, face_xs, face_confs (optional),
                              speaker, speaker_conf, active_face_x (optional).
    """
    # Primary: (value, weight) tuples from two-shot frames with motion signal
    female_samples_two: list[tuple[float, float]] = []
    male_samples_two:   list[tuple[float, float]] = []

    # Fallback: single-speaker close-ups
    female_samples_single: list[tuple[float, float]] = []
    male_samples_single:   list[tuple[float, float]] = []

    for kf in keyframes:
        sp   = kf.get('speaker',      'unclear')
        conf = kf.get('speaker_conf', 0.0)
        shot = kf.get('shot_type',    '')
        fxs  = kf.get('face_xs',      [])
        fcs  = kf.get('face_confs',   [])

        if sp not in ('male', 'female') or conf < CAL_MIN_CONF:
            continue

        if shot == 'two_shot' and len(fxs) >= 2:
            active_x = kf.get('active_face_x')
            if active_x is not None:
                face_conf = _face_conf_for_x(fxs, fcs, active_x)
                weight    = conf * face_conf
                bucket    = female_samples_two if sp == 'female' else male_samples_two
                bucket.append((float(active_x), weight))

        elif shot == 'single' and fxs:
            face_conf = _face_conf_for_x(fxs, fcs, fxs[0])
            weight    = conf * face_conf
            bucket    = female_samples_single if sp == 'female' else male_samples_single
            bucket.append((float(fxs[0]), weight))

    cal = SpeakerCalibration()

    # Prefer two-shot samples; fall back to single-speaker only when scarce.
    female_samples = (female_samples_two
                      if len(female_samples_two) >= TWO_SHOT_MIN
                      else female_samples_single)
    male_samples   = (male_samples_two
                      if len(male_samples_two)   >= TWO_SHOT_MIN
                      else male_samples_single)

    cal.n_female_cal = len(female_samples)
    cal.n_male_cal   = len(male_samples)

    if female_samples:
        cal.female_x, cal.female_x_stddev = _weighted_mean_std(female_samples)
    if male_samples:
        cal.male_x,   cal.male_x_stddev   = _weighted_mean_std(male_samples)

    cal.valid = (cal.female_x is not None and cal.male_x is not None)
    return cal
