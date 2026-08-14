/**
 * The thin pipe transport, verified without Chrome: NUL-delimited framing survives arbitrary
 * chunking, the connection pairs responses to requests and never hangs (a dead pipe rejects every
 * pending command, classified), and a launch that cannot spawn surfaces as `chrome_launch`.
 */

import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';

import {
  CdpConnection,
  CdpFramer,
  encodeCdpMessage,
  launchHeadlessShell,
} from '../cdpPipeTransport.js';
import { CaptureStageError } from '../captureTypes.js';

describe('CdpFramer — NUL-delimited JSON framing', () => {
  it('decodes one message, multiple messages, and messages split across chunks', () => {
    const framer = new CdpFramer();
    expect(framer.feed(encodeCdpMessage({ id: 1 }))).toEqual([{ id: 1 }]);

    const two = Buffer.concat([encodeCdpMessage({ id: 2 }), encodeCdpMessage({ id: 3 })]);
    expect(framer.feed(two)).toEqual([{ id: 2 }, { id: 3 }]);

    const whole = encodeCdpMessage({ id: 4, method: 'X' });
    expect(framer.feed(whole.subarray(0, 5))).toEqual([]);
    expect(framer.feed(whole.subarray(5))).toEqual([{ id: 4, method: 'X' }]);
  });

  it('throws a classified error on a malformed frame — a corrupt stream must not be skipped', () => {
    const framer = new CdpFramer();
    expect(() => framer.feed(Buffer.from('not-json\0'))).toThrowError(CaptureStageError);
    try {
      new CdpFramer().feed(Buffer.from('{broken\0'));
    } catch (err) {
      expect((err as CaptureStageError).stage).toBe('cdp_connect');
    }
  });
});

/** A fake Chrome end of the pipe: scripted responses keyed by method. */
function pipePair() {
  const toChrome = new PassThrough();
  const fromChrome = new PassThrough();
  const connection = new CdpConnection(toChrome, fromChrome);
  const framer = new CdpFramer();
  const received: Array<Record<string, unknown>> = [];
  toChrome.on('data', (chunk: Buffer) => received.push(...framer.feed(chunk)));
  const reply = (message: Record<string, unknown>): void => {
    fromChrome.write(encodeCdpMessage(message));
  };
  return { connection, fromChrome, received, reply };
}

describe('CdpConnection', () => {
  it('pairs a response to its request id and resolves with the result', async () => {
    const { connection, received, reply } = pipePair();
    const pending = connection.send('Target.createTarget', { url: 'about:blank' });
    await new Promise((r) => setImmediate(r));
    expect(received[0]).toMatchObject({ method: 'Target.createTarget' });
    reply({ id: received[0].id as number, result: { targetId: 'T1' } });
    await expect(pending).resolves.toEqual({ targetId: 'T1' });
  });

  it('rejects with the method name when CDP answers with an error object', async () => {
    const { connection, received, reply } = pipePair();
    const pending = connection.send('HeadlessExperimental.beginFrame');
    await new Promise((r) => setImmediate(r));
    reply({ id: received[0].id as number, error: { message: "wasn't found" } });
    await expect(pending).rejects.toThrow(/HeadlessExperimental\.beginFrame.*wasn't found/);
  });

  it('delivers events, filtered by sessionId in waitForEvent', async () => {
    const { connection, reply } = pipePair();
    const wait = connection.waitForEvent('Page.domContentEventFired', 'S1', 1_000);
    reply({ method: 'Page.domContentEventFired', params: {}, sessionId: 'OTHER' });
    reply({ method: 'Page.domContentEventFired', params: { ts: 5 }, sessionId: 'S1' });
    const event = await wait;
    expect(event.sessionId).toBe('S1');
    expect(event.params).toEqual({ ts: 5 });
  });

  it('a closed pipe rejects EVERY pending command (classified) and refuses new sends — never a hang', async () => {
    const { connection, fromChrome } = pipePair();
    const inFlight = connection.send('Runtime.evaluate', { expression: '1' });
    fromChrome.destroy();
    await expect(inFlight).rejects.toThrow(/CDP pipe closed/);
    await expect(connection.send('Page.enable')).rejects.toThrow(/CDP pipe closed/);
  });
});

describe('launchHeadlessShell', () => {
  it('a binary that cannot spawn surfaces as chrome_launch and pending sends reject', async () => {
    const handle = launchHeadlessShell({ executablePath: '/nonexistent-headless-shell', flags: [] });
    await handle.exited;
    await expect(handle.connection.send('Page.enable')).rejects.toThrow(/spawn failed|chrome exited/);
    await handle.kill(); // idempotent on an already-dead process
  });
});
