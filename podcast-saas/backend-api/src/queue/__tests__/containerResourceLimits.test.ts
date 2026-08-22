/**
 * Every long-lived service has a memory ceiling, and they sum to less than the host (config-003).
 *
 * WHY THIS IS A TEST AND NOT A COMMENT
 * Nothing on the production host had a memory limit, so any container's runaway allocation was
 * charged to the whole 7.6 GiB machine — taking nginx, and therefore every route into the system,
 * down with whatever misbehaved. The ceilings are the containment half of security-007 (six
 * multipart routes still buffer an entire upload in the heap).
 *
 * The failure mode this guards is not "someone deletes a limit"; it is "someone adds a SERVICE and
 * does not think about limits at all", which is exactly how the gap arose. So the assertion is
 * over the set of services, not over a list of names — a new long-lived service fails this until
 * it is given a ceiling or explicitly exempted below.
 *
 * A static assertion over checked-in configuration. It cannot prove a given VM is running this
 * file; it makes the intended shape impossible to drift away from by omission.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEPLOY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'deploy');
const compose = readFileSync(join(DEPLOY, 'docker-compose.yml'), 'utf8');

/**
 * Total RAM of the production host, in MiB (measured 2026-08-22: 7815 MiB).
 *
 * The ceilings must sum below this with room for the kernel and page cache. Sizing them so their
 * SUM can exceed host RAM would leave the host OOM reachable — which is the whole failure being
 * prevented — even though each container individually looked bounded.
 */
const HOST_RAM_MIB = 7815;

/** How much must stay unclaimed for the OS, page cache, and the SSH session used to fix things. */
const HOST_HEADROOM_MIB = 1200;

/** Services with no ceiling, and the reason each is exempt. */
const EXEMPT: Readonly<Record<string, string>> = {
  // Runs for a few seconds every twelve hours to renew a certificate, then exits.
  certbot: 'short-lived cron-style container, not a long-lived server',
};

/** Parse the top-level `services:` block into name → raw YAML body. */
function services(): Map<string, string> {
  const lines = compose.split('\n');
  const start = lines.findIndex((l) => l.trimEnd() === 'services:');
  if (start === -1) throw new Error('no services: block');
  const out = new Map<string, string>();
  let current: string | null = null;
  let buf: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\S/.test(line) && line.trim() !== '') break;          // left the services block
    const header = line.match(/^ {2}([a-z0-9_-]+):\s*$/);
    if (header) {
      if (current) out.set(current, buf.join('\n'));
      current = header[1]!;
      buf = [];
      continue;
    }
    if (current) buf.push(line);
  }
  if (current) out.set(current, buf.join('\n'));
  return out;
}

const mib = (body: string, key: string): number | null => {
  const m = body.match(new RegExp(`^\\s*${key}:\\s*(\\d+)m\\s*$`, 'm'));
  return m ? Number(m[1]) : null;
};

describe('production container resource ceilings', () => {
  const parsed = services();

  it('finds the services it is meant to be checking', () => {
    // Guards the parser itself: a regex that silently matched nothing would make every assertion
    // below vacuously true, which is the classic way a config test stops testing anything.
    for (const name of ['backend', 'worker', 'client-web', 'admin-web', 'nginx']) {
      expect(parsed.has(name), `service ${name} not parsed out of docker-compose.yml`).toBe(true);
    }
  });

  it('gives every long-lived service a memory ceiling', () => {
    for (const [name, body] of parsed) {
      if (name in EXEMPT) continue;
      expect(mib(body, 'mem_limit'), `service "${name}" has no mem_limit — add one, or add it to EXEMPT with a reason`)
        .toBeGreaterThan(0);
    }
  });

  it('disables swap on every ceiling, because swapping a Node heap only prolongs the outage', () => {
    for (const [name, body] of parsed) {
      if (name in EXEMPT) continue;
      expect(mib(body, 'memswap_limit'), `service "${name}"`).toBe(mib(body, 'mem_limit'));
    }
  });

  it('sums to less than host RAM, leaving headroom for the kernel', () => {
    let total = 0;
    for (const [name, body] of parsed) {
      if (name in EXEMPT) continue;
      total += mib(body, 'mem_limit') ?? 0;
    }
    expect(total).toBeGreaterThan(0);
    expect(total, `ceilings sum to ${total} MiB; the host has ${HOST_RAM_MIB} MiB`)
      .toBeLessThanOrEqual(HOST_RAM_MIB - HOST_HEADROOM_MIB);
  });

  it('leaves the API un-throttled on CPU and caps the worker instead', () => {
    // 2 vCPUs. A quota on the request-serving process makes it slower under exactly the load where
    // it must stay responsive; the contention this host suffers is the worker's ffmpeg.
    expect(parsed.get('backend')).not.toMatch(/^\s*cpus:/m);
    expect(parsed.get('worker')).toMatch(/^\s*cpus:\s*1\.5\s*$/m);
  });

  it('gives the worker the largest ceiling, since it is the one that runs ffmpeg', () => {
    const worker = mib(parsed.get('worker')!, 'mem_limit')!;
    for (const [name, body] of parsed) {
      if (name === 'worker' || name in EXEMPT) continue;
      expect(worker, `worker should out-rank ${name}`).toBeGreaterThanOrEqual(mib(body, 'mem_limit')!);
    }
  });
});
