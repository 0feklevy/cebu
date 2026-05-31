'use client';

import { useRef, useState } from 'react';
import { getAuth } from 'firebase/auth';
import type { Simulation } from 'shared/src/generated/client-v1';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';

interface Props {
  projectId: string;
  onUploaded: (sim: Simulation) => void;
}

export function SimulationUploader({ projectId, onUploaded }: Props) {
  const [dragging, setDragging]   = useState(false);
  const [name, setName]           = useState('');
  const [percent, setPercent]     = useState(0);
  const [uploading, setUploading] = useState(false);
  const [speed, setSpeed]         = useState('');
  const [error, setError]         = useState<string | null>(null);
  const [done, setDone]           = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const uploadFile = async (file: File) => {
    const simName = name.trim() || file.name.replace(/\.zip$/i, '');
    setUploading(true);
    setError(null);
    setPercent(0);
    setDone(false);
    try {
      const token = await getAuth().currentUser?.getIdToken();
      if (!token) throw new Error('Not authenticated');

      const formData = new FormData();
      formData.append('name', simName);
      formData.append('file', file, file.name);

      const sim = await new Promise<Simulation>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const startTime = Date.now();

        xhr.upload.addEventListener('progress', (e) => {
          if (!e.lengthComputable) return;
          const pct = Math.round((e.loaded / e.total) * 100);
          const elapsed = (Date.now() - startTime) / 1000;
          const bytesPerSec = e.loaded / elapsed;
          const spd = bytesPerSec > 1_000_000
            ? `${(bytesPerSec / 1_000_000).toFixed(1)} MB/s`
            : `${(bytesPerSec / 1_000).toFixed(0)} KB/s`;
          setPercent(pct);
          setSpeed(spd);
        });

        xhr.addEventListener('load', () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try { resolve(JSON.parse(xhr.responseText) as Simulation); }
            catch { reject(new Error('Upload succeeded but response could not be parsed')); }
          } else {
            reject(new Error(`Upload failed: ${xhr.status} ${xhr.responseText}`));
          }
        });
        xhr.addEventListener('error', () => reject(new Error('Network error')));

        xhr.open('POST', `${API_URL}/api/v1/projects/${projectId}/simulations/upload`);
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.send(formData);
      });

      setPercent(100);
      setDone(true);
      onUploaded(sim);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const handleFiles = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.zip')) {
      setError('Only .zip files are accepted');
      return;
    }
    uploadFile(file);
  };

  return (
    <div className="space-y-3">
      {/* Name input */}
      <input
        type="text"
        placeholder="Simulation name (optional)"
        value={name}
        onChange={e => setName(e.target.value)}
        disabled={uploading}
        className="w-full h-8 px-3 rounded-lg border border-border bg-white text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-400/20 disabled:opacity-50"
      />

      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files); }}
        onClick={() => !uploading && inputRef.current?.click()}
        className={`rounded-lg border-2 border-dashed px-6 py-7 text-center transition-colors ${
          uploading ? 'opacity-50 cursor-not-allowed border-border' :
          dragging   ? 'border-amber-400 bg-amber-50 cursor-pointer'
                     : 'border-border bg-white/70 hover:border-amber-400/50 hover:bg-muted/30 cursor-pointer'
        }`}
      >
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none" className="mx-auto mb-2 text-amber-400/70" aria-hidden>
          <rect x="2" y="4" width="24" height="20" rx="2" stroke="currentColor" strokeWidth="1.3" />
          <path d="M8 14h12M14 8v12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
        <p className="text-sm font-medium text-foreground">Drop ZIP file here</p>
        <p className="text-xs text-muted-foreground mt-1">HTML / CSS / JS bundle · max 50 MB</p>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept=".zip"
        className="hidden"
        onChange={e => { handleFiles(e.target.files); e.target.value = ''; }}
      />

      {/* Progress */}
      {(uploading || done || error) && (
        <div className="rounded-lg border border-border/70 bg-white px-3 py-2.5 shadow-sm-soft">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-medium text-foreground">Uploading…</span>
            <span className="text-[10px] text-muted-foreground shrink-0 ml-2">
              {error ? <span className="text-destructive">{error}</span>
                : done ? '✓ Processing…'
                : `${percent}% · ${speed}`}
            </span>
          </div>
          {!done && !error && (
            <div className="h-1 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-amber-400 transition-all duration-300 rounded-full"
                style={{ width: `${percent}%` }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
