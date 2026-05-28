'use client';

import { useState, useRef } from 'react';

interface Props {
  files: File[];
  urls: string[];
  onFilesChange: (files: File[]) => void;
  onUrlsChange: (urls: string[]) => void;
}

export function CorpusUploader({ files, urls, onFilesChange, onUrlsChange }: Props) {
  const [urlInput, setUrlInput] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const addUrl = () => {
    const trimmed = urlInput.trim();
    if (!trimmed) return;
    try {
      new URL(trimmed);
      onUrlsChange([...urls, trimmed]);
      setUrlInput('');
    } catch {
      // invalid url — ignore
    }
  };

  const removeUrl = (i: number) => onUrlsChange(urls.filter((_, idx) => idx !== i));
  const removeFile = (i: number) => onFilesChange(files.filter((_, idx) => idx !== i));

  const mergeFiles = (incoming: File[]) => {
    const existing = new Set(files.map((f) => `${f.name}:${f.size}`));
    const deduped = incoming.filter((f) => !existing.has(`${f.name}:${f.size}`));
    onFilesChange([...files, ...deduped]);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const dropped = Array.from(e.dataTransfer.files).filter((f) =>
      /\.(pdf|mp3|m4a|wav|ogg|jpg|jpeg|png|webp)$/i.test(f.name),
    );
    mergeFiles(dropped);
  };

  return (
    <div className="space-y-4">
      {/* Drop zone */}
      <div
        onDrop={handleDrop}
        onDragOver={(e) => e.preventDefault()}
        onClick={() => fileRef.current?.click()}
        className="border-2 border-dashed border-border rounded-xl p-8 text-center cursor-pointer hover:border-primary/50 transition-colors"
      >
        <div className="text-3xl mb-2">📄</div>
        <p className="text-sm font-medium">Drop PDFs, audio, or images here</p>
        <p className="text-xs text-muted-foreground mt-1">or click to browse</p>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept=".pdf,.mp3,.m4a,.wav,.ogg,.jpg,.jpeg,.png,.webp"
          className="hidden"
          onChange={(e) => {
            mergeFiles(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
      </div>

      {/* URL input */}
      <div className="flex gap-2">
        <input
          type="url"
          placeholder="Paste a URL or YouTube link…"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addUrl()}
          className="flex-1 rounded-lg border border-input bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <button
          onClick={addUrl}
          className="px-4 py-2 bg-secondary text-secondary-foreground rounded-lg text-sm hover:bg-secondary/80 transition-colors"
        >
          Add
        </button>
      </div>

      {/* Items list */}
      {(files.length > 0 || urls.length > 0) && (
        <ul className="space-y-2">
          {files.map((f, i) => (
            <li key={`file-${i}`} className="flex items-center gap-2 text-sm bg-card rounded-lg px-3 py-2">
              <span className="text-lg">{f.name.endsWith('.pdf') ? '📄' : f.type.startsWith('audio') ? '🎵' : '🖼'}</span>
              <span className="flex-1 truncate">{f.name}</span>
              <span className="text-muted-foreground text-xs">{(f.size / 1024).toFixed(0)} KB</span>
              <button onClick={() => removeFile(i)} className="text-muted-foreground hover:text-destructive ml-2">✕</button>
            </li>
          ))}
          {urls.map((u, i) => {
            const isYt = u.includes('youtube.com') || u.includes('youtu.be');
            return (
              <li key={`url-${i}`} className="flex items-center gap-2 text-sm bg-card rounded-lg px-3 py-2">
                <span className="text-lg">{isYt ? '▶️' : '🔗'}</span>
                <span className="flex-1 truncate text-primary">{u}</span>
                <button onClick={() => removeUrl(i)} className="text-muted-foreground hover:text-destructive ml-2">✕</button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
