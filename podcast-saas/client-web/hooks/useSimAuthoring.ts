'use client';

/**
 * React lifecycle around one authoring session, so `SectionEditor` never holds a port itself.
 *
 * THE SESSION IS TIED TO A DOCUMENT, NOT TO A COMPONENT. The transferred port dies when the frame
 * navigates, so every reload needs a fresh CONNECT — that is what `notifyFrameLoad()` is for, and
 * it is why the caller must call it from the frame's own `load` handler rather than trusting a
 * dependency array to notice.
 *
 * CONNECTING IS ALLOWED TO FAIL, and the caller is expected to carry on. A package served before
 * this feature shipped has no hook, so CONNECT times out — which is a fact about that package, not
 * an error state for the editor. `status` reports it and the picker falls back to the old gate and
 * then to the static scan.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { connectSimAuthoring, type SimAuthoringSession } from '../lib/sim/SimAuthoringClient';
import type { AuthoringMark, AuthoringScanResult } from 'shared/src/sim/authoringProtocol';

export type SimAuthoringStatus = 'idle' | 'connecting' | 'live' | 'unavailable';

interface Options {
  /** The live preview frame. Read at call time, never captured. */
  frameRef: React.MutableRefObject<HTMLIFrameElement | null>;
  /** Identity of the document being picked in — a change forces a fresh session. */
  documentKey: string | null;
  /** Sessions exist only while the picker is open; nothing connects for an ordinary viewer. */
  enabled: boolean;
  /** The full current mark set. Pushed on every change — the child renders from it wholesale. */
  marks: AuthoringMark[];
  onMarkToggled: (selector: string) => void;
  onScriptTouched: (selectors: string[]) => void;
  onEscape: () => void;
}

export interface SimAuthoringHandle {
  status: SimAuthoringStatus;
  /** Resolves with the live document's controls, or rejects if there is no session to ask. */
  scan: () => Promise<AuthoringScanResult>;
  /** Bracket the automation's lifetime — see the protocol on why observation is not always-on. */
  observe: (on: boolean) => void;
  /** Call from the frame's own `load`: the old port died with the old document. */
  notifyFrameLoad: () => void;
}

export function useSimAuthoring(opts: Options): SimAuthoringHandle {
  const { frameRef, documentKey, enabled, marks, onMarkToggled, onScriptTouched, onEscape } = opts;
  const [status, setStatus] = useState<SimAuthoringStatus>('idle');
  const sessionRef = useRef<SimAuthoringSession | null>(null);
  const [generation, setGeneration] = useState(0);

  // Callbacks live in a ref so a re-render with a new closure does not tear down a live session.
  const cbs = useRef({ onMarkToggled, onScriptTouched, onEscape });
  cbs.current = { onMarkToggled, onScriptTouched, onEscape };

  useEffect(() => {
    if (!enabled || !documentKey) {
      sessionRef.current?.dispose();
      sessionRef.current = null;
      setStatus('idle');
      return;
    }

    let cancelled = false;
    setStatus('connecting');

    const open = async (): Promise<void> => {
      const frame = frameRef.current;
      if (!frame) { if (!cancelled) setStatus('unavailable'); return; }
      try {
        const s = await connectSimAuthoring(frame);
        if (cancelled) { s.dispose(); return; }
        s.on('markToggled', (sel) => cbs.current.onMarkToggled(sel));
        s.on('scriptTouched', (sels) => cbs.current.onScriptTouched(sels));
        s.on('escapeRequested', () => cbs.current.onEscape());
        sessionRef.current = s;
        setStatus('live');
      } catch {
        // Expected for any package served before this shipped. The picker degrades; it does not
        // error.
        if (!cancelled) setStatus('unavailable');
      }
    };
    void open();

    return () => {
      cancelled = true;
      sessionRef.current?.dispose();
      sessionRef.current = null;
    };
  }, [enabled, documentKey, generation, frameRef]);

  // Marks are pushed wholesale rather than diffed: the child renders from the set it was last
  // given, so a dropped diff would leave a badge showing the opposite of the row beside it.
  useEffect(() => {
    if (status === 'live') sessionRef.current?.setMarks(marks);
  }, [marks, status]);

  const scan = useCallback((): Promise<AuthoringScanResult> => {
    const s = sessionRef.current;
    if (!s) return Promise.reject(new Error('sim-authoring: no session'));
    return s.scan();
  }, []);

  const observe = useCallback((on: boolean) => { sessionRef.current?.observe(on); }, []);

  const notifyFrameLoad = useCallback(() => {
    // A new document means a new port. Bumping the generation is what re-runs the effect above,
    // and disposing here keeps the old session from lingering until it does.
    sessionRef.current?.dispose();
    sessionRef.current = null;
    setGeneration((g) => g + 1);
  }, []);

  return { status, scan, observe, notifyFrameLoad };
}
