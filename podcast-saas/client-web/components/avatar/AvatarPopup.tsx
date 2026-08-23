'use client';

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { startAvatarSession, isAbortError, denialOf, type AvatarDisplay } from './avatarApi';
import { displayIdentity, type CharacterSource } from './characters';
import { AvatarConversation } from './AvatarConversation';
import { preloadAnamSdk } from './anamSdk';
import { beginConnectTrace, type ConnectTrace } from './connectTelemetry';
import { CONNECT_WATCHDOG_MS } from './anamConnectPolicy';
import './avatar.css';

interface Props {
  open: boolean;
  onClose: () => void;
  projectId?: string;
  videoTitle?: string | null;
  /**
   * A character the CALLER already knows this video runs as. No viewer surface passes one — the
   * video's persona is a server fact and arrives with the start — and it deliberately has no
   * default any more: a client-side fallback here is indistinguishable from a real choice by the
   * time it reaches the screen, and 'einstein' is what every viewer of every video used to see.
   */
  characterId?: string;
}

// Full-screen popup shown above the video. Pauses every other <video> on the page
// while open (and resumes them on close), then runs the live avatar conversation.
export function AvatarPopup({ open, onClose, projectId, videoTitle, characterId }: Props) {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Set only when the server EXPLAINED the refusal (D-14). Its presence changes two things on the
   * failure screen: the viewer is told which kind of "not now" this is, and `Try again` stops
   * offering an immediate retry that the same limit would refuse again the same second.
   */
  const [denied, setDenied] = useState<{ message: string; retryAfterSec: number } | null>(null);
  /**
   * Flips true once the refusal's own wait has elapsed, re-enabling `Try again`.
   *
   * Without it the disable is permanent, which trades one bad outcome for a worse one: the viewer
   * who did exactly as asked and waited comes back to a dead button and no way to reach the avatar
   * short of reloading the page. The server named the wait; honour it and then get out of the way.
   */
  const [retryReady, setRetryReady] = useState(false);
  const [resolvedCharacter, setResolvedCharacter] = useState<string | undefined>(characterId);
  const [avatarDisplay, setAvatarDisplay] = useState<AvatarDisplay | undefined>();
  const [characterSource, setCharacterSource] = useState<CharacterSource | undefined>();
  /** Bumped by "Try again" — re-runs the start effect from scratch. */
  const [attempt, setAttempt] = useState(0);
  const pausedVideos = useRef<HTMLVideoElement[]>([]);
  // Until somebody is actually named — by the server, or by a character someone chose — name
  // nobody. `resolvedCharacter` alone is not a name: it is always set once the start answers,
  // and for an unconfigured project it is the fallback 'einstein'.
  const meta = displayIdentity(resolvedCharacter, characterSource, avatarDisplay);

  /**
   * t0 for the click-to-first-frame trace (anam-latency-001, client half). It has to
   * start HERE: this is the first instant the viewer is waiting, and everything below
   * — the token round trip, the SDK chunk, the vendor session, the first frame — is
   * measured as an offset from it. The backend's correlationId is attached the moment
   * the start responds, which is what joins this trace to the server's phase timings.
   */
  const traceRef = useRef<ConnectTrace | null>(null);

  // Pause/resume other videos on the page.
  useEffect(() => {
    if (!open) return;
    const videos = Array.from(document.querySelectorAll('video')).filter((v) => v.id !== 'anam-avatar-video') as HTMLVideoElement[];
    pausedVideos.current = videos.filter((v) => !v.paused);
    pausedVideos.current.forEach((v) => { try { v.pause(); } catch { /* noop */ } });
    return () => {
      // Only resume videos we paused that are still paused at close-time. If another
      // effect resumed/started a video while the popup was open, re-check v.paused so
      // we don't spuriously replay it.
      pausedVideos.current.forEach((v) => {
        if (!v.paused) return;
        try { void v.play().catch(() => {}); } catch { /* noop */ }
      });
      pausedVideos.current = [];
    };
  }, [open]);

  // Fetch a session token when opened.
  //
  // The start is CANCELLED, not just ignored, when the popup closes while it is in
  // flight. The old `cancelled` flag let the request run to completion and then threw
  // the resolved token away — no leak (the backend opens no Anam session; the SDK's
  // startSession does that browser-side, and stopStreaming releases it), but a wasted
  // mint and the one-to-six vendor round-trips behind it, on the slowest endpoint in
  // the product. In React StrictMode it was wasted on every single open, because the
  // throwaway first mount issued a start of its own.
  // The wait the SERVER named, not one this component invented: a client-side guess that is
  // shorter re-refuses the viewer, and one that is longer keeps them waiting past the limit.
  useEffect(() => {
    if (!denied) { setRetryReady(false); return; }
    const t = setTimeout(() => setRetryReady(true), denied.retryAfterSec * 1000);
    return () => clearTimeout(t);
  }, [denied]);

  useEffect(() => {
    if (!open) { setToken(null); setError(null); setDenied(null); setAvatarDisplay(undefined); setCharacterSource(undefined); return; }
    const abort = new AbortController();
    const trace = beginConnectTrace();
    traceRef.current = trace;
    trace.mark('popup-open');
    setError(null);
    setDenied(null);
    setToken(null);
    setResolvedCharacter(characterId);
    setAvatarDisplay(undefined);
    setCharacterSource(characterId ? 'requested' : undefined);
    // Fetch the (lazy) Anam SDK chunk alongside the token rather than after it, so the
    // code split cannot show up as click-to-first-frame latency. Static asset only.
    preloadAnamSdk();
    // ONE OPEN, ONE MINT (anam-backend-003). The server dedupes concurrent starts, but only when
    // the caller names the open — and nothing named it, so the mechanism was inert and a
    // StrictMode double mount or a double click minted twice. The identity is per OPEN, not per
    // request: a retry of this same open must collapse, a genuinely new open must not.
    const startKey = `open-${trace.id}`;
    // Pass projectId so the server applies the video's saved persona config and
    // lets it choose the character; omit character_id so the config wins.
    startAvatarSession(undefined, projectId, abort.signal, startKey)
      .then((data) => {
        if (abort.signal.aborted) return;
        trace.join(data.correlationId);
        // IDENTITY FIRST, AND EVEN IF THE TOKEN IS UNUSABLE. The server has told us who this
        // video's avatar is; that is true whether or not the vendor mint produced a session. It
        // also means the failure screen below is headed "Ask <the actual persona>" rather than a
        // nameless one, which is what a viewer needs to know they were in the right place.
        setResolvedCharacter(data.characterId ?? characterId);
        setCharacterSource(data.characterSource ?? (characterId ? 'requested' : undefined));
        setAvatarDisplay(data.avatarDisplay ?? (data.voiceSensitivity != null ? { voiceSensitivity: data.voiceSensitivity } : undefined));

        // A 200 IS NOT A SESSION. The vendor mint can answer without a usable token, and this
        // used to `setToken('')` — falsy, so the conversation never mounted, no error was set,
        // and the popup sat on its spinner and its "Connecting…" label for the life of the tab.
        // A viewer reported exactly that, and from outside it is indistinguishable from a screen
        // that never finished loading.
        if (!data.sessionToken) {
          trace.mark('connect-failed', { at: 'token-empty' });
          console.error('[AvatarPopup] start returned no session token');
          setError("The avatar couldn't start right now. Please try again in a moment.");
          return;
        }
        trace.mark('token');
        setToken(data.sessionToken);
      })
      .catch((e) => {
        // A cancellation is not a failure: nobody is waiting for it, and it must not
        // reach the viewer's screen or the operator's log as one.
        if (isAbortError(e) || abort.signal.aborted) return;
        trace.mark('connect-failed', { at: 'token' });
        // Keep the real error in the console for operators; show viewers a friendly,
        // generic message (no server internals / env-var names). (ui-ux-205)
        console.error('[AvatarPopup] failed to start avatar session:', e);
        // A REFUSAL IS NOT A CRASH, and telling a viewer the same thing for both wastes the one
        // piece of information that would have helped them. This copy is generated by the shared
        // module from a closed enum of three reasons — it is not the server's string — so showing
        // it keeps ui-ux-205's rule that no server internals reach the screen.
        const denial = denialOf(e);
        if (denial) {
          setDenied({ message: denial.message, retryAfterSec: denial.retryAfterSec });
          setError(denial.message);
          return;
        }
        setError("The avatar couldn't start right now. Please try again in a moment.");
      });
    // AND BOUND THE WAIT ITSELF. The check above catches a start that answers uselessly; this
    // catches one that does not answer at all — a hung vendor call, a proxy holding the
    // connection, a network that goes away mid-flight. `fetch` has no timeout of its own, so
    // without this the spinner is unbounded. Same constant the conversation uses for the stream
    // phase, because it is the same promise to the viewer: you will not be left here.
    const watchdog = setTimeout(() => {
      if (abort.signal.aborted) return;
      trace.mark('connect-failed', { at: 'token-timeout' });
      abort.abort();
      setError("The avatar is taking longer than expected to start.");
    }, CONNECT_WATCHDOG_MS);

    return () => { clearTimeout(watchdog); abort.abort(); };
  }, [open, characterId, projectId, attempt]);

  const panelRef = useRef<HTMLDivElement>(null);

  // Focus management + trap: move focus into the dialog on open, keep Tab inside it,
  // close on Escape, and restore focus to the trigger on close (a11y, review ui-ux-001).
  useEffect(() => {
    if (!open) return;
    const prevActive = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'Tab' && panelRef.current) {
        const f = panelRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (f.length === 0) return;
        const first = f[0]!, last = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
      prevActive?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="avatar-popup-backdrop" role="dialog" aria-modal="true" aria-labelledby="avatar-popup-title">
      <div className="avatar-popup-panel" ref={panelRef} tabIndex={-1}>
        <div className="avatar-popup-header">
          <div className="avatar-popup-title">
            {meta.portrait ? (
              <img
                src={meta.portrait}
                alt=""
                className="avatar-popup-avatar"
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
              />
            ) : (
              <span className="avatar-popup-emoji">{meta.emoji}</span>
            )}
            <div>
              <p className="avatar-popup-name" id="avatar-popup-title">Ask {meta.displayName}</p>
              {videoTitle && <p className="avatar-popup-sub">about “{videoTitle}”</p>}
            </div>
          </div>
          <button className="avatar-popup-x" onClick={onClose} aria-label="Close">
            <X size={17} strokeWidth={1.9} aria-hidden />
          </button>
        </div>

        <div className="avatar-popup-body">
          {error ? (
            <div className="avatar-popup-status">
              <p style={{ color: '#e87762', marginBottom: 16 }}>⚠ {error}</p>
              <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13, maxWidth: 360, textAlign: 'center' }}>
                {/* A refusal already said what it was, in the line above. Repeating the generic
                    sentence under it would take an explanation and make it sound like a fault. */}
                {denied
                  ? 'Nothing is broken — the avatar will be back.'
                  : <>This video&apos;s avatar isn&apos;t available at the moment.</>}
              </p>
              <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
                <button
                  className="avatar-btn"
                  // A limit that just refused will refuse the same second. Offering `Try again`
                  // anyway spends a request to show the identical screen, and teaches the viewer
                  // the button does not work.
                  disabled={!!denied && !retryReady}
                  onClick={() => { setError(null); setDenied(null); setRetryReady(false); setToken(null); setAttempt((n) => n + 1); }}
                >
                  Try again
                </button>
                <button className="avatar-btn avatar-btn--secondary" onClick={onClose}>Close</button>
              </div>
            </div>
          ) : !token || !resolvedCharacter ? (
            // Both arrive from the SAME start response, so requiring the character here costs no
            // extra wait — it just removes the only way a conversation could run without knowing
            // whose it is (and hand '' to the memory session key and to /avatar/end).
            <div className="avatar-popup-status">
              <span className="avatar-spinner" />
              <p style={{ color: 'rgba(255,255,255,0.6)', marginTop: 14 }}>{meta.startingLabel}</p>
            </div>
          ) : (
            <AvatarConversation characterId={resolvedCharacter} identity={meta} projectId={projectId} sessionToken={token} display={avatarDisplay} trace={traceRef.current ?? undefined} onLeave={onClose} />
          )}
        </div>
      </div>
    </div>
  );
}
