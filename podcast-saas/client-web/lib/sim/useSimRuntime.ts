/**
 * React binding for SimRuntimeClient.
 *
 * The client is deliberately framework-free; this hook is the ONLY place that knows about React.
 * It owns one client for the component's lifetime, mirrors its state into a render-visible value,
 * and guarantees disposal — the leak that every hand-rolled surface had to remember on its own.
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { SimRuntimeClient, type SimRuntimeCallbacks, type SimRuntimeState } from './SimRuntimeClient';
import { simTelemetry } from '../simTelemetry';

export interface UseSimRuntimeResult {
  /** Live lifecycle state — safe to render from. */
  state: SimRuntimeState;
  /** The client itself, for imperative calls (activate/deactivate/mute/…). Stable identity. */
  runtime: SimRuntimeClient;
  /** Pass to the iframe's `ref`. Binds/unbinds the element as it mounts. */
  frameRef: (el: HTMLIFrameElement | null) => void;
  /** Pass to the iframe's `onLoad`. */
  onFrameLoad: () => void;
}

/**
 * @param documentKey the resolved iframe src. Changing it means a NEW document: the client resets
 *        every per-document flag and cancels in-flight timers, so a late event from the previous
 *        document can never act on the new one.
 */
export function useSimRuntime(documentKey: string | null, cbs: SimRuntimeCallbacks = {}): UseSimRuntimeResult {
  // Callbacks are read through a ref so a caller passing inline closures (the normal React style)
  // never causes the client to be rebuilt — rebuilding it mid-transition would drop the pending
  // activation and its timers.
  const cbsRef = useRef(cbs);
  cbsRef.current = cbs;

  const clientRef = useRef<SimRuntimeClient | null>(null);
  if (clientRef.current === null) {
    clientRef.current = new SimRuntimeClient({
      onState: (s) => { setState(s); cbsRef.current.onState?.(s); },
      onUserInteraction: () => cbsRef.current.onUserInteraction?.(),
      onTelemetry: (e, d) => { simTelemetry(e, d); cbsRef.current.onTelemetry?.(e, d); },
    });
  }
  const client = clientRef.current;
  const [state, setState] = useState<SimRuntimeState>(() => client.getState());

  const elRef = useRef<HTMLIFrameElement | null>(null);
  const keyRef = useRef<string | null>(documentKey);
  keyRef.current = documentKey;

  const frameRef = useCallback((el: HTMLIFrameElement | null) => {
    elRef.current = el;
    client.attach(el, el ? keyRef.current : null);
  }, [client]);

  // A src change on an ALREADY MOUNTED element does not re-run the ref callback, so the document
  // change has to be reported here or the client would keep the previous document's flags.
  useEffect(() => {
    if (elRef.current) client.attach(elRef.current, documentKey);
  }, [client, documentKey]);

  const onFrameLoad = useCallback(() => client.handleFrameLoad(), [client]);

  useEffect(() => () => { client.dispose(); }, [client]);

  return { state, runtime: client, frameRef, onFrameLoad };
}
