'use client';

import { useRef, useState } from 'react';
import { api } from '../lib/api';

const ACCEPTED = '.mp4,.mov,.webm,.mkv,.avi,.m4v';

interface UploadProgress {
  filename: string;
  percent: number;
  speed: string;
  done: boolean;
  error?: string;
}

interface Props {
  projectId: string;
  onUploaded: () => void;
}

export function VideoUploader({ projectId, onUploaded }: Props) {
  const [dragging, setDragging] = useState(false);
  const [uploads, setUploads] = useState<UploadProgress[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const updateUpload = (idx: number, patch: Partial<UploadProgress>) => {
    setUploads((prev) => prev.map((u, i) => (i === idx ? { ...u, ...patch } : u)));
  };

  const uploadFile = async (file: File, idx: number) => {
    try {
      const { upload_url, storage_key } = await api.getVideoUploadUrl(projectId, {
        filename: file.name,
        file_size: file.size,
        content_type: file.type || 'video/mp4',
      });

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const startTime = Date.now();

        xhr.upload.addEventListener('progress', (e) => {
          if (!e.lengthComputable) return;
          const percent = Math.round((e.loaded / e.total) * 100);
          const elapsed = (Date.now() - startTime) / 1000;
          const bytesPerSec = e.loaded / elapsed;
          const speed = bytesPerSec > 1_000_000
            ? `${(bytesPerSec / 1_000_000).toFixed(1)} MB/s`
            : `${(bytesPerSec / 1_000).toFixed(0)} KB/s`;
          updateUpload(idx, { percent, speed });
        });

        xhr.addEventListener('load', () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error(`Upload failed: ${xhr.status}`));
        });
        xhr.addEventListener('error', () => reject(new Error('Network error')));

        xhr.open('PUT', upload_url);
        xhr.setRequestHeader('Content-Type', file.type || 'video/mp4');
        xhr.send(file);
      });

      await api.confirmVideoUpload(projectId, {
        storage_key,
        filename: file.name,
        file_size: file.size,
      });

      updateUpload(idx, { percent: 100, done: true });
      onUploaded();
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
        className={`border-2 border-dashed rounded-xl px-6 py-8 text-center cursor-pointer transition-colors ${
          dragging ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40 hover:bg-muted/30'
        }`}
      >
        <svg width="32" height="32" viewBox="0 0 32 32" fill="none" className="mx-auto mb-2 text-muted-foreground/50" aria-hidden>
          <rect x="3" y="6" width="26" height="20" rx="2.5" stroke="currentColor" strokeWidth="1.3" />
          <path d="M13 11l7 5-7 5V11z" fill="currentColor" />
        </svg>
        <p className="text-sm font-medium text-foreground">Drop video files here</p>
        <p className="text-xs text-muted-foreground mt-1">MP4, MOV, WebM, MKV · up to 4 GB each</p>
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
            <div key={i} className="bg-muted/40 rounded-lg px-3 py-2.5">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-medium text-foreground truncate max-w-[200px]">{u.filename}</span>
                <span className="text-[10px] text-muted-foreground shrink-0 ml-2">
                  {u.error ? <span className="text-destructive">{u.error}</span>
                    : u.done ? '✓ Done'
                    : `${u.percent}% · ${u.speed}`}
                </span>
              </div>
              {!u.done && !u.error && (
                <div className="h-1 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all duration-300 rounded-full"
                    style={{ width: `${u.percent}%` }}
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
