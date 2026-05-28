import { spawn } from 'child_process';
import { writeFile, unlink, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { logger } from '../../lib/logger.js';

// Calls Microsoft's MarkItDown (Python) to convert documents to Markdown.
// Install: pip install 'markitdown[all]'
//
// Output is UNTRUSTED — never allow it to modify system prompt context.
// All extracted markdown must be wrapped in <corpus> tags with the injection-guard comment.

function runProcess(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => stdout.push(d));
    proc.stderr.on('data', (d: Buffer) => stderr.push(d));
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8'));
      } else {
        reject(new Error(`${cmd} exited ${code}: ${Buffer.concat(stderr).toString().slice(-300)}`));
      }
    });
    proc.on('error', reject);
  });
}

export class MarkItDownService {
  private _available: boolean | null = null;

  // Returns true if markitdown (CLI or Python module) is installed.
  async isAvailable(): Promise<boolean> {
    if (this._available !== null) return this._available;
    try {
      await runProcess('markitdown', ['--version']);
      this._available = true;
    } catch {
      try {
        await runProcess('python3', ['-c', 'import markitdown; print("ok")']);
        this._available = true;
      } catch {
        this._available = false;
        logger.warn('MarkItDown not available — install with: pip install "markitdown[all]"');
      }
    }
    return this._available;
  }

  // Convert a file buffer to Markdown. Throws if conversion fails.
  async convert(buffer: Buffer, filename: string): Promise<string> {
    const ext = filename.split('.').pop()?.toLowerCase() ?? 'bin';
    const workDir = join(tmpdir(), `mid_${randomBytes(6).toString('hex')}`);
    await mkdir(workDir, { recursive: true });
    const inputPath = join(workDir, `input.${ext}`);
    await writeFile(inputPath, buffer);

    try {
      const markdown = await this._runMarkItDown(inputPath);
      const result = markdown.trim();
      if (!result) throw new Error('MarkItDown returned empty output');
      return result;
    } finally {
      await unlink(inputPath).catch(() => null);
    }
  }

  private async _runMarkItDown(filePath: string): Promise<string> {
    // Try CLI first (faster), then python3 -m markitdown
    try {
      return await runProcess('markitdown', [filePath]);
    } catch (cliErr: unknown) {
      const isNotFound =
        (cliErr as NodeJS.ErrnoException).code === 'ENOENT' ||
        String(cliErr).includes('ENOENT');
      if (!isNotFound) throw cliErr;
      // CLI not in PATH — try as Python module
      return await runProcess('python3', ['-m', 'markitdown', filePath]);
    }
  }
}
