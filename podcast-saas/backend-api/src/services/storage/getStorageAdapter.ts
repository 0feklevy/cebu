import { R2StorageAdapter } from './R2StorageAdapter.js';
import { LocalStorageAdapter } from './LocalStorageAdapter.js';
import type { StorageService } from './StorageService.js';

let _adapter: StorageService | null = null;

export function getStorageAdapter(): StorageService {
  if (_adapter) return _adapter;

  const hasR2 =
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY;

  _adapter = hasR2 ? new R2StorageAdapter() : new LocalStorageAdapter();
  return _adapter;
}
