'use client';

import { useEffect, useRef, useState } from 'react';
import { getAuth } from 'firebase/auth';
import type { Simulation } from 'shared/src/generated/client-v1';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';
const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;
const MAX_UPLOAD_FILES = 1000;

interface UploadItem {
  file: File;
  path: string;
}

interface WebkitEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
}

interface WebkitFileEntry extends WebkitEntry {
  file: (success: (file: File) => void, error?: (err: DOMException) => void) => void;
}

interface WebkitDirectoryEntry extends WebkitEntry {
  createReader: () => {
    readEntries: (success: (entries: WebkitEntry[]) => void, error?: (err: DOMException) => void) => void;
  };
}

type FileWithRelativePath = File & {
  webkitRelativePath?: string;
};

function browserRelativePath(file: File): string {
  return (file as FileWithRelativePath).webkitRelativePath || file.name;
}

function skipBundlePath(path: string): boolean {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.some(part =>
    part === '__MACOSX' ||
    part === '.DS_Store' ||
    part.startsWith('._') ||
    part.startsWith('.'),
  );
}

function inferBundleName(items: UploadItem[]): string {
  if (items.length === 1 && items[0].file.name.toLowerCase().endsWith('.zip')) {
    return items[0].file.name.replace(/\.zip$/i, '');
  }
  const roots = items
    .map(item => item.path.replace(/\\/g, '/').split('/').filter(Boolean))
    .filter(parts => parts.length > 1)
    .map(parts => parts[0]);
  if (roots.length > 0 && roots.every(root => root === roots[0])) return roots[0];
  const html = items.find(item => /\.(html|htm)$/i.test(item.path));
  return html ? html.file.name.replace(/\.(html|htm)$/i, '') : 'simulation';
}

function fileEntryToItem(entry: WebkitFileEntry, path: string): Promise<UploadItem> {
  return new Promise((resolve, reject) => {
    entry.file(
      file => resolve({ file, path }),
      err => reject(err),
    );
  });
}

function readDirectoryEntries(entry: WebkitDirectoryEntry): Promise<WebkitEntry[]> {
  const reader = entry.createReader();
  const entries: WebkitEntry[] = [];
  return new Promise((resolve, reject) => {
    const readBatch = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(entries);
          return;
        }
        entries.push(...batch);
        readBatch();
      }, reject);
    };
    readBatch();
  });
}

async function collectEntryFiles(entry: WebkitEntry, prefix = ''): Promise<UploadItem[]> {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) return [await fileEntryToItem(entry as WebkitFileEntry, path)];
  if (!entry.isDirectory) return [];
  const children = await readDirectoryEntries(entry as WebkitDirectoryEntry);
  const nested = await Promise.all(children.map(child => collectEntryFiles(child, path)));
  return nested.flat();
}

async function collectDroppedItems(dataTransfer: DataTransfer): Promise<UploadItem[]> {
  const entryItems = Array.from(dataTransfer.items)
    .map(item => {
      const getAsEntry = (item as unknown as { webkitGetAsEntry?: () => unknown }).webkitGetAsEntry;
      return getAsEntry?.() ?? null;
    })
    .filter((entry): entry is WebkitEntry =>
      Boolean(entry) &&
      typeof (entry as WebkitEntry).name === 'string' &&
      typeof (entry as WebkitEntry).isFile === 'boolean' &&
      typeof (entry as WebkitEntry).isDirectory === 'boolean',
    );

  if (entryItems.length === 0) {
    return Array.from(dataTransfer.files).map(file => ({ file, path: browserRelativePath(file) }));
  }

  const nested = await Promise.all(entryItems.map(entry => collectEntryFiles(entry)));
  return nested.flat();
}

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
  const folderInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    folderInputRef.current?.setAttribute('webkitdirectory', '');
    folderInputRef.current?.setAttribute('directory', '');
  }, []);

  const uploadItems = async (rawItems: UploadItem[]) => {
    const items = rawItems
      .map(item => ({ ...item, path: item.path.replace(/\\/g, '/') }))
      .filter(item => !skipBundlePath(item.path));

    const isZip = items.length === 1 && items[0].file.name.toLowerCase().endsWith('.zip');
    if (items.length === 0) {
      setError('No uploadable files found');
      return;
    }
    if (items.length > MAX_UPLOAD_FILES) {
      setError(`Too many files (${items.length}). Maximum is ${MAX_UPLOAD_FILES}.`);
      return;
    }
    const totalBytes = items.reduce((sum, item) => sum + item.file.size, 0);
    if (totalBytes > MAX_UPLOAD_BYTES) {
      setError('Simulation bundle is over 250 MB');
      return;
    }
    if (!isZip && items.some(item => item.file.name.toLowerCase().endsWith('.zip'))) {
      setError('Upload one ZIP, or upload the unzipped folder/files');
      return;
    }
    if (!isZip && !items.some(item => /\.(html|htm)$/i.test(item.path))) {
      setError('Simulation bundle needs at least one HTML file');
      return;
    }

    const simName = name.trim() || inferBundleName(items);
    setUploading(true);
    setError(null);
    setPercent(0);
    setDone(false);
    try {
      const token = await getAuth().currentUser?.getIdToken();
      if (!token) throw new Error('Not authenticated');

      const formData = new FormData();
      formData.append('name', simName);
      if (isZip) {
        formData.append('file', items[0].file, items[0].file.name);
      } else {
        formData.append('manifest', JSON.stringify(items.map(item => ({ path: item.path }))));
        for (const item of items) {
          formData.append('files', item.file, item.file.name);
        }
      }

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
    if (!files || files.length === 0) return;
    void uploadItems(Array.from(files).map(file => ({ file, path: browserRelativePath(file) })));
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
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!uploading) void collectDroppedItems(e.dataTransfer).then(uploadItems);
        }}
        onClick={() => !uploading && inputRef.current?.click()}
        className={`rounded-lg border-2 border-dashed px-4 py-5 text-center transition-colors sm:px-6 sm:py-7 ${
          uploading ? 'opacity-50 cursor-not-allowed border-border' :
          dragging   ? 'border-amber-400 bg-amber-50 cursor-pointer'
                     : 'border-border bg-white/70 hover:border-amber-400/50 hover:bg-muted/30 cursor-pointer'
        }`}
      >
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none" className="mx-auto mb-2 text-amber-400/70" aria-hidden>
          <rect x="2" y="4" width="24" height="20" rx="2" stroke="currentColor" strokeWidth="1.3" />
          <path d="M8 14h12M14 8v12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
        <p className="text-sm font-medium text-foreground">Drop ZIP or folder here</p>
        <p className="text-xs text-muted-foreground mt-1">HTML / CSS / JS / PNG assets · max 250 MB</p>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); inputRef.current?.click(); }}
            disabled={uploading}
            className="h-8 rounded-md border border-border bg-white px-2.5 text-[11px] font-medium text-foreground hover:border-amber-300 disabled:opacity-50"
          >
            Choose ZIP
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); folderInputRef.current?.click(); }}
            disabled={uploading}
            className="h-8 rounded-md bg-amber-500 px-2.5 text-[11px] font-semibold text-white hover:bg-amber-400 disabled:opacity-50"
          >
            Choose folder
          </button>
        </div>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept=".zip"
        className="hidden"
        onChange={e => { handleFiles(e.target.files); e.target.value = ''; }}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={e => { handleFiles(e.target.files); e.target.value = ''; }}
      />

      {/* Progress */}
      {(uploading || done || error) && (
        <div className="rounded-lg border border-border/70 bg-white px-3 py-2.5 shadow-sm-soft">
          <div className="mb-1.5 flex min-w-0 flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-xs font-medium text-foreground">Uploading…</span>
            <span className="text-[10px] text-muted-foreground sm:ml-2 sm:shrink-0">
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
