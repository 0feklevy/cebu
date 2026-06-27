import { resolve, sep } from 'path';

/**
 * Resolve a request key under a base directory and reject path traversal.
 *
 * Returns the safe absolute path, or `null` when the key escapes `baseDir`
 * (via `..` segments or an absolute path). Callers must treat `null` as a 403.
 */
export function safeLocalPath(baseDir: string, key: string): string | null {
  const base = resolve(baseDir);
  const target = resolve(base, key);
  if (target !== base && !target.startsWith(base + sep)) return null;
  return target;
}

/**
 * Reject object keys (used to compose R2/proxy URLs, not filesystem paths) that
 * contain a `..` segment.
 */
export function keyHasTraversal(key: string): boolean {
  return key.split('/').some((seg) => seg === '..');
}
