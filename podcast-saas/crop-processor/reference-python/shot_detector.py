"""
Shot boundary detection via HSV histogram comparison (Bhattacharyya distance).
Returns timestamps of cut points so the smoother can apply hard resets there.
"""

import cv2
import numpy as np

THRESHOLD = 0.35   # Bhattacharyya distance ∈ [0, 1]; higher → fewer detected cuts


def detect_shots(cap: cv2.VideoCapture, fps: float, threshold: float = THRESHOLD) -> list[float]:
    """
    Scan the video and return a list of shot-boundary timestamps (seconds).
    Always includes 0.0.  Resets cap to frame 0 before returning.
    """
    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)

    # Compare ~6 frames per second (fast enough to catch sub-second cuts)
    step = max(1, int(fps / 6))

    boundaries: list[float] = [0.0]
    prev_hist: np.ndarray | None = None
    frame_idx = 0

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        if frame_idx % step == 0:
            # Downscale before histogram to speed things up
            small = cv2.resize(frame, (320, 180))
            hsv   = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
            hist  = cv2.calcHist([hsv], [0, 1], None, [36, 32], [0, 180, 0, 256])
            cv2.normalize(hist, hist)

            if prev_hist is not None:
                dist = cv2.compareHist(prev_hist, hist, cv2.HISTCMP_BHATTACHARYYA)
                if dist > threshold:
                    t = round(frame_idx / fps, 3)
                    # Minimum 0.5 s gap between detected cuts
                    if t - boundaries[-1] > 0.5:
                        boundaries.append(t)

            prev_hist = hist

        frame_idx += 1

    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
    return boundaries
