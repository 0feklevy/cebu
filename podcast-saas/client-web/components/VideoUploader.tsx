'use client';

import { useRef, useState } from 'react';
import { getAuth } from 'firebase/auth';
import type { VideoFile } from 'shared/src/generated/client-v1';

const ACCEPTED = '.mp4,.mov,.webm,.mkv,.avi,.m4v';
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';

interface UploadProgress {
  filename: string;
  percent: number;
  speed: string;
  done: boolean;
  error?: string;
}

interface Props {
  projectId: string;
  // Receives the uploaded VideoFile (including raw_url) so the editor can play
  // the video immediately without waiting for a polling cycle.
  onUploaded: (video: VideoFile) => void;
}

export function VideoUploader({ projectId, onUploaded }: Props) {
  const [dragging, setDragging] = useState(false);
  const [uploads, setUploads] = useState<UploadProgress[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const updateUpload = (idx: number, patch: Partial<UploadProgress>) => {
    setUploads((prev) => prev.map((u, i) => (i === idx ? { ...u, ...patch } : u)));
  };

  // Shared XHR progress reporter.
  const trackProgress = (xhr: XMLHttpRequest, idx: number) => {
    const startTime = Date.now();
    xhr.upload.addEventListener('progress', (e) => {
      if (!e.lengthComputable) return;
      const percent = Math.round((e.loaded / e.total) * 100);
      const elapsed = (Date.now() - startTime) / 1000;
      const bytesPerSec = e.loaded / Math.max(elapsed, 0.001);
      const speed = bytesPerSec > 1_000_000
        ? `${(bytesPerSec / 1_000_000).toFixed(1)} MB/s`
        : `${(bytesPerSec / 1_000).toFixed(0)} KB/s`;
      updateUpload(idx, { percent, speed });
    });
  };

  // Legacy path: stream the file through the API (multipart). Used as a fallback.
  const uploadMultipart = (file: File, idx: number, token: string): Promise<VideoFile> => {
    const formData = new FormData();
    formData.append('file_size', String(file.size));
    formData.append('file', file, file.name);
    return new Promise<VideoFile>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      trackProgress(xhr, idx);
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText) as VideoFile); }
          catch { reject(new Error('Upload succeeded but response could not be parsed')); }
        } else reject(new Error(`Upload failed: ${xhr.status} ${xhr.responseText}`));
      });
      xhr.addEventListener('error', () => reject(new Error('Network error')));
      xhr.open('POST', `${API_URL}/api/v1/projects/${projectId}/videos/upload`);
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.send(formData);
    });
  };

  // Preferred path: PUT the file straight to cloud storage via a presigned URL (no
  // bytes through the API), then confirm so the server records it + starts processing.
  const uploadPresigned = async (file: File, idx: number, token: string): Promise<VideoFile> => {
    const urlRes = await fetch(`${API_URL}/api/v1/projects/${projectId}/videos/upload-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ filename: file.name, content_type: file.type || 'video/mp4' }),
    });
    if (!urlRes.ok) throw new Error(`upload-url ${urlRes.status}`);
    const { upload_url, storage_key, content_type } =
      (await urlRes.json()) as { upload_url: string; storage_key: string; content_type: string };

    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      trackProgress(xhr, idx);
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`PUT ${xhr.status}`));
      });
      xhr.addEventListener('error', () => reject(new Error('Network error during direct upload')));
      xhr.open('PUT', upload_url);
      // Must match the content-type the presigned URL was signed with.
      xhr.setRequestHeader('Content-Type', content_type);
      xhr.send(file);
    });

    const confirmRes = await fetch(`${API_URL}/api/v1/projects/${projectId}/videos/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ storage_key, filename: file.name, file_size: file.size }),
    });
    if (!confirmRes.ok) throw new Error(`confirm ${confirmRes.status}`);
    return (await confirmRes.json()) as VideoFile;
  };

  const uploadFile = async (file: File, idx: number) => {
    try {
      const token = await getAuth().currentUser?.getIdToken();
      if (!token) throw new Error('Not authenticated');

      let videoData: VideoFile;
      try {
        videoData = await uploadPresigned(file, idx, token);
      } catch (presignErr) {
        // Direct-to-cloud unavailable (storage not presign-capable, or bucket CORS not
        // set) — fall back to streaming through the API so uploads never hard-break.
        console.warn('Presigned upload failed, falling back to multipart:', presignErr);
        updateUpload(idx, { percent: 0, speed: '' });
        videoData = await uploadMultipart(file, idx, token);
      }

      updateUpload(idx, { percent: 100, done: true });
      onUploaded(videoData);
    } catch (err) {
      updateUpload(idx, { error: (err as Error).message });
    }
  };

  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const newFiles = Array.from(files);
    const startIdx = uploads.length;
    setUploads((prev) => [
      ...prev,
      ...newFiles.map((f) => ({ filename: f.name, percent: 0, speed: '', done: false })),
    ]);
    newFiles.forEach((file, i) => uploadFile(file, startIdx + i));
  };

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files); }}
        onClick={() => inputRef.current?.click()}
        className={`rounded-lg border-2 border-dashed px-4 py-5 text-center cursor-pointer transition-colors focus-ring sm:px-6 sm:py-8 ${
          dragging ? 'border-violet-400 bg-violet-50' : 'border-border bg-white/70 hover:border-violet-300 hover:bg-muted/30'
        }`}
      >
        <svg width="32" height="32" viewBox="0 0 32 32" fill="none" className="mx-auto mb-2 text-muted-foreground/50" aria-hidden>
          <rect x="3" y="6" width="26" height="20" rx="2.5" stroke="currentColor" strokeWidth="1.3" />
          <path d="M13 11l7 5-7 5V11z" fill="currentColor" />
        </svg>
        <p className="text-sm font-medium text-foreground">Drop video files here</p>
        <p className="text-xs text-muted-foreground mt-1">MP4, MOV, WebM, MKV · up to 10 GB each</p>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED}
        multiple
        className="hidden"
        onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }}
      />

      {uploads.length > 0 && (
        <div className="space-y-2">
          {uploads.map((u, i) => (
            <div key={i} className="rounded-lg border border-border/70 bg-white px-3 py-2.5 shadow-sm-soft">
              <div className="mb-1.5 flex min-w-0 flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <span className="min-w-0 truncate text-xs font-medium text-foreground">{u.filename}</span>
                <span className="text-[10px] text-muted-foreground sm:ml-2 sm:shrink-0">
                  {u.error ? <span className="text-destructive">{u.error}</span>
                    : u.done ? '✓ Done'
                    : `${u.percent}% · ${u.speed}`}
                </span>
              </div>
              {!u.done && !u.error && (
                <div className="h-1 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full transition-all duration-300 rounded-full"
                    style={{ width: `${u.percent}%`, background: 'linear-gradient(135deg,#a855f7,#6366f1)' }}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
