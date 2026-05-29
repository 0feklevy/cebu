-- Waveform peaks: 200 normalised float values [0-1] stored as JSON text.
-- Populated by ffmpeg during HLS transcoding. NULL until first transcode completes.
ALTER TABLE video_files ADD COLUMN IF NOT EXISTS waveform_peaks text;
