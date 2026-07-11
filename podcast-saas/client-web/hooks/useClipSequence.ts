// The `useClipSequence` hook was superseded by `useEditorPlayback` (see the note in
// useSegmentedPlaybackCore.ts). The hook body was dead code — nothing called it — and was
// removed (frontend-009). Only the `Clip` type is still consumed (VideoEditor, VideoPlayer,
// useEditorPlayback), so it is retained here to keep those imports stable.

export interface Clip {
  id: string;
  hlsUrl: string | null;
  rawUrl: string | null;
  duration: number;
}
