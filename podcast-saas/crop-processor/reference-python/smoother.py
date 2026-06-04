"""
Temporal smoothing for the crop-position keyframe sequence.

Strategy:
  • Within each shot: Gaussian smoothing to remove jitter while
    preserving intentional slow pans.
  • At shot boundaries: hard reset — no blending across cuts, since
    the crop position at a cut can legitimately jump to a completely
    different part of the frame.
"""

from __future__ import annotations

import numpy as np
from scipy.ndimage import gaussian_filter1d


def smooth_keyframes(
    keyframes:       list[dict],   # [{t: float, x: float}, …]
    shot_times:      list[float],  # boundary timestamps from shot_detector
    sigma_sec:       float = 1.5,  # Gaussian width in seconds
    sample_interval: float = 1.0,  # seconds between keyframes
) -> list[dict]:
    """
    Apply per-shot Gaussian smoothing and return a new keyframe list
    with the same timestamps but smoothed x values.
    """
    if len(keyframes) < 2:
        return keyframes

    times = np.array([k['t'] for k in keyframes], dtype=np.float64)
    xs    = np.array([k['x'] for k in keyframes], dtype=np.float64)

    sigma_samples = max(0.5, sigma_sec / sample_interval)
    out_xs = xs.copy()

    # Build shot segments from boundary list
    bounds = sorted(set(shot_times))
    total_dur = float(times[-1]) + sample_interval
    segments  = _to_segments(bounds, total_dur)

    for t_start, t_end in segments:
        mask = (times >= t_start) & (times < t_end)
        if mask.sum() < 2:
            continue
        out_xs[mask] = gaussian_filter1d(xs[mask], sigma=sigma_samples, mode='nearest')

    return [
        {'t': float(k['t']), 'x': round(float(x), 4)}
        for k, x in zip(keyframes, out_xs)
    ]


def _to_segments(boundaries: list[float], total_dur: float) -> list[tuple[float, float]]:
    segs: list[tuple[float, float]] = []
    for i, t in enumerate(boundaries):
        end = boundaries[i + 1] if i + 1 < len(boundaries) else total_dur
        segs.append((t, end))
    return segs
