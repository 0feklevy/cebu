"""
Per-frame interest detection.

Returns a FrameAnalysis that includes:
  interest_x  — weighted centroid of the interest map (fallback / non-face scenes)
  face_xs     — normalized cx positions of each detected face, sorted left→right
  face_confs  — detection confidence per face (parallel to face_xs)
  shot_type   — 'two_shot' | 'single' | 'no_face'

Signal weights:
  center_bias  0.5  — mild prior toward frame centre
  face         2.0  — detected face
  motion       0.6  — frame-difference movement
  saliency     0.4  — spectral-residual pop-out
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

import cv2
import numpy as np
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision as mp_vision

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_MODEL_PATH  = os.path.join(_SCRIPT_DIR, 'models', 'blaze_face_short_range.tflite')


# ── saliency (no cv2-contrib needed) ─────────────────────────────────────────

def _spectral_residual_saliency(gray_small: np.ndarray) -> np.ndarray:
    """
    Spectral Residual Saliency (Hou & Zhang 2007), pure NumPy.
    Returns a float32 saliency map ∈ [0, 1], same size as input.
    """
    f       = np.fft.fft2(gray_small.astype(np.float32))
    log_amp = np.log(np.abs(f) + 1e-7)
    avg_log = cv2.filter2D(log_amp, -1, np.ones((3, 3), np.float32) / 9.0)
    residual = log_amp - avg_log
    f_res   = np.exp(residual) * np.exp(1j * np.angle(f))
    sal     = np.abs(np.fft.ifft2(f_res)) ** 2
    sal     = cv2.GaussianBlur(sal.astype(np.float32), (9, 9), 2.5)
    s_max   = sal.max()
    return sal / s_max if s_max > 1e-9 else sal


# ── result type ───────────────────────────────────────────────────────────────

@dataclass
class FrameAnalysis:
    interest_x:    float               # fallback crop centre (interest map)
    face_xs:       list[float]         # detected face cx positions, sorted left→right
    shot_type:     str                 # 'two_shot' | 'single' | 'no_face'
    active_face_x: float | None = None # face with most motion (speaking face in two-shot)
    face_confs:    list[float] = field(default_factory=list)  # MediaPipe confidence per face


# ── analyser ──────────────────────────────────────────────────────────────────

class SceneAnalyzer:
    # Two faces are "distinct" if their centres are >= this far apart (norm.)
    _DEDUP_MIN_DIST = 0.15

    def __init__(self, width: int, height: int) -> None:
        self.W = width
        self.H = height

        base_opts = mp_python.BaseOptions(model_asset_path=_MODEL_PATH)
        det_opts  = mp_vision.FaceDetectorOptions(
            base_options=base_opts,
            min_detection_confidence=0.5,
        )
        self._detector = mp_vision.FaceDetector.create_from_options(det_opts)

        # Pre-computed center-bias weights
        cols = np.linspace(0, 1, width)
        cb   = np.exp(-0.5 * ((cols - 0.5) ** 2) / (0.35 ** 2))
        self._center_bias = cb / cb.sum()

    def __del__(self) -> None:
        try:
            self._detector.close()
        except Exception:
            pass

    # ── helpers ───────────────────────────────────────────────────────────────

    def _active_face_by_motion(
        self, face_xs: list[float], gray: np.ndarray, prev_gray: np.ndarray,
    ) -> float | None:
        """
        Return the cx of the face region with the highest frame-diff motion.
        In a static two-shot scene the speaking face (lip/head movement)
        consistently shows more pixel change than the silent one.
        """
        diff    = cv2.absdiff(gray, prev_gray).astype(np.float32)
        margin  = max(15, int(0.07 * self.W))
        motions = []
        for cx in face_xs:
            cx_px = int(cx * self.W)
            x0 = max(0, cx_px - margin)
            x1 = min(self.W, cx_px + margin)
            motions.append(float(diff[:, x0:x1].mean()))
        if not motions:
            return None
        return face_xs[int(np.argmax(motions))]

    def _col_gauss(self, cx: float, sigma: float = 0.12) -> np.ndarray:
        cols = np.linspace(0, 1, self.W)
        g    = np.exp(-0.5 * ((cols - cx) ** 2) / (sigma ** 2))
        s    = g.sum()
        return g / s if s > 1e-9 else g

    def _detect_faces(self, frame_bgr: np.ndarray) -> tuple[list[float], list[float]]:
        """
        Detect faces using MediaPipe BlazeFace (Tasks API).
        Returns (face_xs, face_confs) — normalised cx positions and confidences,
        both sorted left → right, deduplicated via NMS.
        """
        rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        result   = self._detector.detect(mp_image)

        if not result.detections:
            return [], []

        # Collect (cx_norm, conf, area_norm) — bounding box coords are in pixels
        raw: list[tuple[float, float, float]] = []
        for det in result.detections:
            bb      = det.bounding_box
            cx_px   = bb.origin_x + bb.width / 2.0
            cx_norm = max(0.0, min(1.0, cx_px / self.W))
            conf    = float(det.categories[0].score) if det.categories else 0.0
            area    = (bb.width / self.W) * (bb.height / self.H)
            raw.append((cx_norm, conf, area))

        # NMS: greedily keep largest-area faces; drop those too close to kept faces
        raw.sort(key=lambda f: f[2], reverse=True)
        kept_cx:   list[float] = []
        kept_conf: list[float] = []
        for cx, conf, _ in raw:
            if not any(abs(cx - k) < self._DEDUP_MIN_DIST for k in kept_cx):
                kept_cx.append(cx)
                kept_conf.append(conf)

        # Sort by cx (left → right), keeping confs aligned
        paired = sorted(zip(kept_cx, kept_conf), key=lambda p: p[0])
        face_xs    = [p[0] for p in paired]
        face_confs = [p[1] for p in paired]
        return face_xs, face_confs

    # ── public API ────────────────────────────────────────────────────────────

    def analyze(
        self,
        frame:     np.ndarray,
        gray:      np.ndarray,
        prev_gray: np.ndarray | None,
    ) -> FrameAnalysis:
        """
        Analyse one frame. Returns a FrameAnalysis with interest_x, face_xs,
        face_confs, and shot_type.
        """
        W = self.W
        interest = np.zeros(W, dtype=np.float64)

        # 1. Center bias
        interest += self._center_bias * 0.5

        # 2. Face detection (MediaPipe BlazeFace)
        face_xs, face_confs = self._detect_faces(frame)

        for cx in face_xs:
            interest += self._col_gauss(cx, sigma=0.12) * 2.0

        # 3. Motion
        if prev_gray is not None:
            diff = cv2.absdiff(gray, prev_gray).astype(np.float64)
            diff[diff < 12] = 0
            m1d = diff.sum(axis=0)
            m_max = m1d.max()
            if m_max > 1.0:
                interest += (m1d / m_max) * 0.6

        # 4. Spectral residual saliency
        sal_small = cv2.resize(gray, (256, 144))
        sal_map   = _spectral_residual_saliency(sal_small)
        sal_up    = cv2.resize(sal_map, (W, self.H), interpolation=cv2.INTER_LINEAR)
        s1d       = sal_up.sum(axis=0).astype(np.float64)
        s_max     = s1d.max()
        if s_max > 1e-6:
            interest += (s1d / s_max) * 0.4

        # 5. Weighted horizontal centroid
        total = interest.sum()
        if total < 1e-9:
            ix = 0.5
        else:
            cols = np.arange(W, dtype=np.float64)
            ix   = float((interest * cols).sum() / (total * max(W - 1, 1)))

        # Shot type
        if   len(face_xs) >= 2: shot_type = 'two_shot'
        elif len(face_xs) == 1: shot_type = 'single'
        else:                   shot_type = 'no_face'

        # Active face by motion (only meaningful for two-shot static scenes)
        active_face_x = None
        if shot_type == 'two_shot' and prev_gray is not None:
            active_face_x = self._active_face_by_motion(face_xs, gray, prev_gray)

        return FrameAnalysis(
            interest_x=ix,
            face_xs=face_xs,
            shot_type=shot_type,
            active_face_x=active_face_x,
            face_confs=face_confs,
        )
