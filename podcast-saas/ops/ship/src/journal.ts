/**
 * The event journal — `ship.ndjson`.
 *
 * One JSON object per line, appended synchronously and never rewritten, so a
 * `tail -f` reader (the Claude Monitor) can follow a live shipment and a crashed
 * conductor still leaves a complete record of everything it knew.
 *
 * Each event carries a pre-rendered `line`, so the reader needs no formatting logic:
 *   tail -f ship.ndjson | jq -r --unbuffered 'select(.notify) | .line'
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { SHIP_EVENT_SCHEMA, type ShipEvent, type ShipEventLevel, type ShipStageName } from './types.js';

const LEVEL_MARK: Record<ShipEventLevel, string> = {
  info: '·',
  warn: '!',
  error: '✗',
  action: '?',
};

export class Journal {
  private seq = 0;

  constructor(
    private readonly file: string,
    private readonly echo: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
  ) {
    mkdirSync(dirname(file), { recursive: true });
    // Resuming an existing run continues the sequence rather than restarting it, so
    // event order stays total across conductor restarts.
    if (existsSync(file)) this.seq = countLines(file);
  }

  emit(args: {
    stage: ShipStageName | 'run';
    event: ShipEvent['event'];
    level?: ShipEventLevel;
    msg: string;
    notify?: boolean;
    data?: Record<string, unknown>;
  }): ShipEvent {
    const level = args.level ?? 'info';
    const ts = new Date().toISOString();
    const ev: ShipEvent = {
      schema: SHIP_EVENT_SCHEMA,
      seq: ++this.seq,
      ts,
      stage: args.stage,
      event: args.event,
      level,
      line: `${ts.slice(11, 19)} ${LEVEL_MARK[level]} [${args.stage}] ${args.msg}`,
      // Progress chatter is recorded but never interrupts anyone; everything else does.
      notify: args.notify ?? args.event !== 'progress',
      data: args.data,
    };
    appendFileSync(this.file, `${JSON.stringify(ev)}\n`, 'utf8');
    this.echo(ev.line);
    return ev;
  }
}

function countLines(file: string): number {
  try {
    const text = readFileSync(file, 'utf8');
    if (!text) return 0;
    return text.split('\n').filter((l) => l.trim() !== '').length;
  } catch {
    return 0;
  }
}

/** Read a journal back — used by `ship status` and by the tests. */
export function readJournal(file: string): ShipEvent[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as ShipEvent];
      } catch {
        return [];
      }
    });
}
