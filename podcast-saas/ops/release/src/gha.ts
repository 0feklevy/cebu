/**
 * Minimal GitHub Actions integration: step outputs and job summaries.
 * No-ops outside Actions so every command also runs locally (dry-run).
 */
import { appendFileSync } from 'node:fs';
import { redactText } from './redact.js';

function appendTo(envVar: string, content: string): boolean {
  const path = process.env[envVar];
  if (!path) return false;
  appendFileSync(path, content);
  return true;
}

/** Set a step output (multiline-safe via heredoc delimiters). */
export function setOutput(name: string, value: string): void {
  const safe = redactText(value);
  const delimiter = `EOF_${name.replace(/[^A-Za-z0-9]/g, '_')}`;
  if (!appendTo('GITHUB_OUTPUT', `${name}<<${delimiter}\n${safe}\n${delimiter}\n`)) {
    // Local/dry-run fallback: print in a grep-able form.
    process.stdout.write(`[output] ${name}=${safe}\n`);
  }
}

/** Append Markdown to the job summary (or stdout locally). */
export function addSummary(markdown: string): void {
  const safe = redactText(markdown);
  if (!appendTo('GITHUB_STEP_SUMMARY', safe + '\n')) {
    process.stdout.write(safe + '\n');
  }
}
