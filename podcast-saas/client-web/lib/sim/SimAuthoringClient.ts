/**
 * The editor's end of the authoring channel — framework-free, so it can be tested without React.
 *
 * WHAT IT TALKS TO. A dormant hook in every served simulation document (the boot snippet) that
 * loads the authoring script on CONNECT. See `SimAuthoringBootstrap.ts` for the other half and
 * `shared/src/sim/authoringProtocol.ts` for the contract.
 *
 * ── WHY A PORT, AND WHY THE TWO IDS ON TOP OF IT ──────────────────────────────────────────────
 *
 * `connect()` mints a MessageChannel and transfers one end in the CONNECT message. After that the
 * window is not used at all: the port is capability-based, so there is no targetOrigin to get
 * wrong on any subsequent message, and a port DIES WITH ITS DOCUMENT — which is the only staleness
 * guarantee here that does not depend on someone remembering to compare something.
 *
 * `e.source === iframe.contentWindow` would NOT have given that. A WindowProxy is the same object
 * across navigations of one browsing context, so a message from the document that was showing
 * before a reload passes that check perfectly.
 *
 * Two ids ride on top for what the port cannot express:
 *   - `sid` — which CONNECT a message belongs to, when the editor reconnects to a live document.
 *   - `requestId` — which scan a reply answers, when the author hits Rescan while one is in flight.
 * Both exist because the failure they prevent is silent: an older answer overwriting a newer one
 * looks exactly like a correct answer.
 */
import {
  SIM_AUTHORING_NS,
  SIM_AUTHORING_VERSION,
  SIM_AUTHORING_CONNECT,
  SIM_AUTHORING_PORT_TYPES as T,
  type AuthoringControl,
  type AuthoringMark,
  type AuthoringScanResult,
} from 'shared/src/sim/authoringProtocol';

export interface SimAuthoringEvents {
  markToggled: (selector: string) => void;
  scriptTouched: (selectors: string[]) => void;
  escapeRequested: () => void;
}

export interface SimAuthoringSession {
  readonly sid: string;
  /** Ask the live document for its controls. Rejects only on timeout — an empty list is an answer. */
  scan(timeoutMs?: number): Promise<AuthoringScanResult>;
  setMarks(marks: AuthoringMark[]): void;
  observe(on: boolean): void;
  on<K extends keyof SimAuthoringEvents>(event: K, cb: SimAuthoringEvents[K]): void;
  dispose(): void;
}

interface Envelope {
  ns?: string;
  v?: number;
  sid?: string;
  type?: string;
  requestId?: string;
  controls?: AuthoringControl[];
  truncated?: boolean;
  scanned?: boolean;
  selector?: string;
  selectors?: string[];
}

let seq = 0;
const nextId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/** The child's origin, derived from what we actually pointed the frame at. */
function originOf(iframe: HTMLIFrameElement): string | null {
  const src = iframe.getAttribute('src') ?? iframe.src;
  if (!src) return null;
  try {
    const u = new URL(src, window.location.href);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * Open an authoring session against a live simulation frame.
 *
 * Resolves when the document answers CONNECTED. Rejects on timeout — which is the honest signal
 * for "this package predates the authoring hook, or the script could not load", and is what lets
 * the caller fall back rather than sit on a spinner.
 */
export function connectSimAuthoring(
  iframe: HTMLIFrameElement,
  opts: { timeoutMs?: number } = {},
): Promise<SimAuthoringSession> {
  const timeoutMs = opts.timeoutMs ?? 2500;
  const win = iframe.contentWindow;
  const origin = originOf(iframe);

  if (!win || !origin) {
    return Promise.reject(new Error('sim-authoring: the frame has no reachable document'));
  }

  return new Promise<SimAuthoringSession>((resolve, reject) => {
    const sid = nextId('sid');
    const channel = new MessageChannel();
    const port = channel.port1;
    const handlers: Partial<SimAuthoringEvents> = {};
    const pendingScans = new Map<string, (r: AuthoringScanResult) => void>();
    let live = true;
    let settled = false;

    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      live = false;
      try { port.close(); } catch { /* already gone */ }
      reject(new Error('sim-authoring: no CONNECTED within timeout'));
    }, timeoutMs);

    port.onmessage = (e: MessageEvent) => {
      const d = e.data as Envelope | null;
      if (!d || d.ns !== SIM_AUTHORING_NS || d.v !== SIM_AUTHORING_VERSION) return;
      // A reply tagged with a superseded session belongs to a CONNECT we have replaced.
      if (d.sid && d.sid !== sid) return;

      if (d.type === T.CONNECTED) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(session);
        return;
      }
      if (d.type === T.CONTROLS_LIST && d.requestId) {
        const waiting = pendingScans.get(d.requestId);
        // No entry means this answers a scan the caller has already superseded. Dropping it here
        // is what stops an older list from overwriting a newer one.
        if (!waiting) return;
        pendingScans.delete(d.requestId);
        waiting({
          scanned: true,
          requestId: d.requestId,
          sid,
          controls: d.controls ?? [],
          truncated: d.truncated === true,
        });
        return;
      }
      if (d.type === T.MARK_TOGGLED && d.selector) { handlers.markToggled?.(d.selector); return; }
      if (d.type === T.SCRIPT_TOUCHED && d.selectors) { handlers.scriptTouched?.(d.selectors); return; }
      if (d.type === T.ESCAPE_REQUESTED) { handlers.escapeRequested?.(); return; }
    };
    port.start();

    const post = (type: string, extra: Record<string, unknown> = {}): void => {
      if (!live) return;
      try { port.postMessage({ ns: SIM_AUTHORING_NS, v: SIM_AUTHORING_VERSION, sid, type, ...extra }); }
      catch { /* the document went away */ }
    };

    const session: SimAuthoringSession = {
      sid,
      scan(scanTimeoutMs = 2500) {
        return new Promise<AuthoringScanResult>((res, rej) => {
          const requestId = nextId('scan');
          const to = window.setTimeout(() => {
            pendingScans.delete(requestId);
            rej(new Error('sim-authoring: scan timed out'));
          }, scanTimeoutMs);
          pendingScans.set(requestId, (r) => { window.clearTimeout(to); res(r); });
          post(T.SCAN_CONTROLS, { requestId });
        });
      },
      setMarks(marks) { post(T.SET_MARKS, { marks }); },
      observe(on) { post(on ? T.OBSERVE_START : T.OBSERVE_STOP); },
      on(event, cb) { (handlers as Record<string, unknown>)[event] = cb; },
      dispose() {
        if (!live) return;
        // DISARM first, then close: the child needs the message to tear its overlay down, and a
        // closed port delivers nothing.
        post(T.DISARM);
        live = false;
        window.clearTimeout(timer);
        try { port.close(); } catch { /* already gone */ }
      },
    };

    // The ONE window-level message. Exact targetOrigin — never '*'.
    try {
      win.postMessage(
        { ns: SIM_AUTHORING_NS, v: SIM_AUTHORING_VERSION, sid, type: SIM_AUTHORING_CONNECT },
        origin,
        [channel.port2],
      );
    } catch (err) {
      settled = true;
      window.clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
