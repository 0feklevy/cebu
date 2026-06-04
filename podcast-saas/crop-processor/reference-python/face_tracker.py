"""
Centroid-based face tracker for podcast two-shot scenes.

Assigns stable identity labels ('left_person', 'right_person') to detected
faces across frames using distance-based matching.  Prevents face identity
from flipping when one face is temporarily undetected (blink, head turn).

Designed for static podcast cameras where hosts stay on their respective
sides — left person has lower X, right person has higher X.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class _Track:
    last_cx: float
    last_t:  float


class FaceTracker:
    # Maximum normalised distance to match a single detected face to a track.
    MATCH_MAX_DIST = 0.35
    # Drop a track if the person hasn't been seen for this many seconds.
    EXPIRY_SECONDS = 3.0

    def __init__(self) -> None:
        self._left:  _Track | None = None
        self._right: _Track | None = None

    def update(self, face_xs: list[float], t: float) -> dict[str, float | None]:
        """
        Update tracker with face cx positions from the current frame.

        face_xs: sorted left→right list of normalised face centre X values
                 (as returned by SceneAnalyzer._detect_faces).
        t:       current frame timestamp in seconds.

        Returns {'left_person': cx | None, 'right_person': cx | None}.
        None means that person is not visible in this frame.
        """
        # Expire stale tracks so a re-entering person gets a clean assignment
        if self._left  is not None and t - self._left.last_t  > self.EXPIRY_SECONDS:
            self._left  = None
        if self._right is not None and t - self._right.last_t > self.EXPIRY_SECONDS:
            self._right = None

        if not face_xs:
            return {'left_person': None, 'right_person': None}

        if len(face_xs) >= 2:
            # Two or more faces: assign by spatial position (lowest X = left_person).
            # face_xs is already sorted left→right.
            left_cx  = face_xs[0]
            right_cx = face_xs[-1]
            self._left  = _Track(left_cx,  t)
            self._right = _Track(right_cx, t)
            return {'left_person': left_cx, 'right_person': right_cx}

        # Exactly one face: match to the nearest known track by distance.
        cx = face_xs[0]

        if self._left is None and self._right is None:
            # No prior context — cannot assign an identity yet.
            return {'left_person': None, 'right_person': None}

        candidates: dict[str, float] = {}
        if self._left  is not None:
            candidates['left_person']  = abs(cx - self._left.last_cx)
        if self._right is not None:
            candidates['right_person'] = abs(cx - self._right.last_cx)

        best_id = min(candidates, key=candidates.__getitem__)
        if candidates[best_id] > self.MATCH_MAX_DIST:
            # Face is too far from any known track — ambiguous, skip.
            return {'left_person': None, 'right_person': None}

        if best_id == 'left_person':
            self._left.last_cx = cx
            self._left.last_t  = t
            return {'left_person': cx, 'right_person': None}
        else:
            self._right.last_cx = cx
            self._right.last_t  = t
            return {'left_person': None, 'right_person': cx}
