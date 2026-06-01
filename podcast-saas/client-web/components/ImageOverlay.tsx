'use client';

import { useMemo } from 'react';
import type { ImageFile } from 'shared/src/generated/client-v1';

export interface ImageOverlayData {
  image: ImageFile;
  durationSec: number;
  cameraMovement: string;
  /** Whether the overlay is currently active (controls opacity) */
  visible: boolean;
}

// Camera movement keyframes as CSS animation strings.
// All animations use linear timing so motion is constant-velocity.
function getCameraKeyframes(movement: string): string {
  switch (movement) {
    case 'zoom_in':
      return `@keyframes img-cam-zoom_in  { from { transform: scale(1.0) translate(0,0); } to { transform: scale(1.18) translate(0,0); } }`;
    case 'zoom_out':
      return `@keyframes img-cam-zoom_out { from { transform: scale(1.18) translate(0,0); } to { transform: scale(1.0) translate(0,0); } }`;
    case 'pan_right':
      return `@keyframes img-cam-pan_right { from { transform: scale(1.08) translateX(-5%); } to { transform: scale(1.08) translateX(5%); } }`;
    case 'pan_left':
      return `@keyframes img-cam-pan_left  { from { transform: scale(1.08) translateX(5%); }  to { transform: scale(1.08) translateX(-5%); } }`;
    case 'dolly_in':
      return `@keyframes img-cam-dolly_in  { from { transform: scale(1.0) translate(-3%,2%); } to { transform: scale(1.2) translate(0,0); } }`;
    case 'drift':
      return `@keyframes img-cam-drift     { 0% { transform: scale(1.05) translate(-2%,-1%); } 50% { transform: scale(1.1) translate(2%,1%); } 100% { transform: scale(1.05) translate(-2%,-1%); } }`;
    default:
      return `@keyframes img-cam-zoom_in  { from { transform: scale(1.0); } to { transform: scale(1.18); } }`;
  }
}

const MOVEMENT_NAMES: Record<string, string> = {
  zoom_in: 'img-cam-zoom_in',
  zoom_out: 'img-cam-zoom_out',
  pan_right: 'img-cam-pan_right',
  pan_left: 'img-cam-pan_left',
  dolly_in: 'img-cam-dolly_in',
  drift: 'img-cam-drift',
};

interface Props {
  data: ImageOverlayData;
  /** z-index for the overlay layer */
  zIndex?: number;
}

export function ImageOverlay({ data, zIndex = 3 }: Props) {
  const { image, durationSec, cameraMovement, visible } = data;
  const animName = MOVEMENT_NAMES[cameraMovement] ?? 'img-cam-zoom_in';

  // Inject keyframe CSS once per movement type via a <style> tag
  const keyframes = useMemo(() => getCameraKeyframes(cameraMovement), [cameraMovement]);

  // Crop the image to fill the 16:9 area exactly.
  // We scale the img element so the cropped region maps to 100%x100% of the container.
  const imgStyle: React.CSSProperties = {
    position: 'absolute',
    width:  `${(1 / image.crop_w) * 100}%`,
    height: `${(1 / image.crop_h) * 100}%`,
    left:   `${(-image.crop_x / image.crop_w) * 100}%`,
    top:    `${(-image.crop_y / image.crop_h) * 100}%`,
    objectFit: 'fill',
    display: 'block',
  };

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: keyframes }} />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          zIndex,
          overflow: 'hidden',
          opacity: visible ? 1 : 0,
          transition: 'opacity 200ms ease',
          pointerEvents: 'none',
        }}
      >
        {/* Inner wrapper carries the camera movement animation */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            animation: visible
              ? `${animName} ${durationSec.toFixed(2)}s linear forwards`
              : 'none',
            transformOrigin: 'center center',
          }}
        >
          <img
            src={image.original_url}
            alt=""
            draggable={false}
            style={imgStyle}
          />
        </div>
      </div>
    </>
  );
}
