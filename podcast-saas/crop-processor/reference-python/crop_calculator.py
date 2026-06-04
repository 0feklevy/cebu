"""
Converts a raw interest_x (0-1) into a valid crop-window centre (0-1),
clamped so the 9:16 window never extends outside the frame.

For a 16:9 video (1920×1080) with a 9:16 crop window:
  crop_window_px  = 1080 * (9/16)  = 607.5 px
  half_norm       = 607.5 / (2 * 1920) ≈ 0.158
  valid range     = [0.158 … 0.842]
"""

PORTRAIT_ASPECT = 9 / 16   # width / height of target portrait window


def interest_to_crop_x(
    interest_x:  float,
    video_width:  int,
    video_height: int,
    crop_aspect:  float = PORTRAIT_ASPECT,
) -> float:
    """
    Returns crop_x ∈ [half, 1 - half] — the normalised centre of the crop window.

    crop_aspect: target_width / target_height  (9/16 for vertical portrait)
    """
    # Width of the crop window expressed as a fraction of video_width
    crop_w_norm = (video_height * crop_aspect) / video_width
    half = crop_w_norm / 2.0
    # Clamp so the crop window stays inside the frame
    return max(half, min(1.0 - half, interest_x))
