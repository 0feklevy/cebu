'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Hand, Volume2 } from 'lucide-react';
import type { AnamClient } from '@anam-ai/js-sdk';
import { loadAnamSdk, type AnamSdk } from './anamSdk';
import { characterMeta } from './characters';
import { endAvatarSession, startAvatarSession, type AvatarDisplay } from './avatarApi';
import { useVisualTrigger } from './hooks/useVisualTrigger';
import { useImageTrigger } from './hooks/useImageTrigger';
import { useConversationMemory } from './hooks/useConversationMemory';
import { VisualPanel } from './VisualPanel';
import { SimulationOverlay } from './SimulationOverlay';
import { AvatarImageOverlay } from './AvatarImageOverlay';

/** The SDK's AnamEvent enum object, handed in once the chunk has loaded. */
type AnamEvents = AnamSdk['AnamEvent'];

interface Props {
  characterId: string;
  projectId?: string;
  sessionToken: string;
  display?: AvatarDisplay;
  onLeave: () => void;
}

const VIDEO_ELEMENT_ID = 'anam-avatar-video';

const getVideoEl = () => document.getElementById(VIDEO_ELEMENT_ID) as HTMLVideoElement | null;

/**
 * PRE-CONNECT ELEMENT PRIME — measured before it was touched, and kept for the half
 * of it that survives measurement.
 *
 * What it does NOT do, despite its previous name: warm the OPUS decoder. The
 * oscillator feeds a WebAudio MediaStreamDestination, whose track is raw PCM and
 * passes through no codec at all; Anam's audio arrives on the RTCPeerConnection and
 * is decoded inside the WebRTC stack, which is not the media element's decoder. The
 * AudioContext opened here is closed again before the session even starts, and
 * @anam-ai/js-sdk 4.15.0 never constructs one (no AudioContext anywhere in the
 * package). There is no OPUS anywhere in this function's reach.
 *
 * What it DOES do, which is worth keeping: it calls play() on the real
 * <video id="anam-avatar-video"> while the click that opened the popup still counts
 * as user activation, which is what marks the element as user-initiated so the SDK's
 * later srcObject assignment plus native autoPlay is not refused. That is the whole
 * mechanism, and it is best-effort only — attemptAudiblePlayback() is the guarantee.
 *
 * REMOVED: the unconditional `await new Promise(r => setTimeout(r, 150))` that used
 * to sit between play() and the srcObject reset. Nothing observed it — `await play()`
 * has already resolved once playback began, and the reset does not need a delay — so
 * it was 150ms of dead serial latency in front of every single connect, on the
 * slowest path in the product.
 */
async function primeVideoElementForAutoplay(): Promise<void> {
  try {
    const ACtx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const audioCtx = new ACtx();
    await audioCtx.resume();
    const dest = audioCtx.createMediaStreamDestination();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0, 0);
    osc.connect(gain); gain.connect(dest); osc.start();
    const videoEl = getVideoEl();
    if (videoEl) {
      videoEl.srcObject = dest.stream;
      await videoEl.play().catch(() => {});
      videoEl.srcObject = null;
    }
    osc.stop(); audioCtx.close();
  } catch { /* non-critical: the element simply does not get primed */ }
}

// Mic-only port of darwin-avatar/client/src/components/AnamConversationView.tsx.
export function AvatarConversation({ characterId, projectId, sessionToken, display, onLeave }: Props) {
  const character = characterMeta(characterId, display);
  const clientRef = useRef<AnamClient | null>(null);
  const leftRef = useRef(false);

  const [micMuted, setMicMuted] = useState(false);
  const [interrupted, setInterrupted] = useState(false);
  const [videoStarted, setVideoStarted] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [joinError, setJoinError] = useState('');
  const [warning, setWarning] = useState('');
  const [lostConnection, setLostConnection] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const warningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const personaMsgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTriggeredPersonaRef = useRef('');

  const visualVisibleRef = useRef(false);

  const { imageUrl, altText, caption, imageType, visible: imageVisible, trigger: triggerImage, reset: resetImage, dismiss: dismissImage, setDirectImage } =
    useImageTrigger(characterId, projectId, () => visualVisibleRef.current);
  const { visual, visible: visualVisible, trigger: triggerVisual, reset: resetVisual, dismiss: dismissVisual } =
    useVisualTrigger(characterId, projectId, setDirectImage);
  useEffect(() => { visualVisibleRef.current = visualVisible; }, [visualVisible]);
  useEffect(() => { if (visualVisible) lastVisualShownAtRef.current = Date.now(); }, [visualVisible]);

  const triggerVisualRef = useRef(triggerVisual);
  useEffect(() => { triggerVisualRef.current = triggerVisual; }, [triggerVisual]);
  const resetVisualRef = useRef(resetVisual);
  useEffect(() => { resetVisualRef.current = resetVisual; }, [resetVisual]);
  const triggerImageRef = useRef(triggerImage);
  useEffect(() => { triggerImageRef.current = triggerImage; }, [triggerImage]);
  const resetImageRef = useRef(resetImage);
  useEffect(() => { resetImageRef.current = resetImage; }, [resetImage]);

  const lastUserMsgRef = useRef('');
  const lastVisualShownAtRef = useRef(0);
  const lastPersonaSpokeAtRef = useRef(0);
  const lastPersonaContentRef = useRef('');
  const lastAutoTriggeredRef = useRef('');

  const memory = useConversationMemory(characterId, projectId);
  const memoryRef = useRef(memory);
  useEffect(() => { memoryRef.current = memory; }, [memory]);

  // Connection watchdog — if the avatar video hasn't started within ~20s (e.g. the
  // engine WebSocket failed), surface a clear error + retry instead of hanging.
  useEffect(() => {
    if (videoStarted) return;
    const t = setTimeout(() => {
      if (!leftRef.current) setJoinError('Could not connect to the avatar — the Anam engine WebSocket failed (network, an active session still holding your concurrency slot, or an invalid persona). Please try again.');
    }, 20_000);
    return () => clearTimeout(t);
  }, [videoStarted]);

  // Auto-visual: every 2.5s, if 10s elapsed since last visual while the avatar is still talking.
  useEffect(() => {
    const AUTO_DELAY_MS = 10_000;
    const AVATAR_ACTIVE_MS = 20_000;
    const check = () => {
      const now = Date.now();
      const content = lastPersonaContentRef.current;
      if (!content || content.length < 80) return;
      if (now - lastPersonaSpokeAtRef.current > AVATAR_ACTIVE_MS) return;
      const checkpoint = lastVisualShownAtRef.current > 0 ? lastVisualShownAtRef.current : lastPersonaSpokeAtRef.current;
      if (now - checkpoint < AUTO_DELAY_MS) return;
      if (content === lastAutoTriggeredRef.current) return;
      const lastSentence = (content.trimEnd().split(/(?<=[.!?])\s+/).pop() ?? '').trim();
      if (lastSentence.endsWith('?')) return;
      lastAutoTriggeredRef.current = content;
      lastVisualShownAtRef.current = now;
      const snippet = content.slice(0, 400);
      const ctx = lastUserMsgRef.current || undefined;
      triggerVisualRef.current(snippet, ctx).then((result) => {
        if (!result.handled && result.reason === 'fallback_image_allowed') triggerImageRef.current(snippet, ctx).catch(() => {});
      }).catch(() => {});
    };
    const id = setInterval(check, 2_500);
    return () => clearInterval(id);
  }, []);

  // ── Frame evidence ────────────────────────────────────────────────────────
  // The spinner comes down when a frame has demonstrably been presented, never on a
  // clock. VIDEO_STREAM_STARTED only means "a track arrived" — StreamingClient emits
  // it on the line BEFORE it assigns srcObject — and is equally true of a stream that
  // is about to sit frozen behind a refused autoplay. `playing` and a
  // requestVideoFrameCallback presentation are the two signals that mean pixels moved.
  const evidenceCleanupRef = useRef<(() => void) | null>(null);

  const armFrameEvidence = useCallback(() => {
    const el = getVideoEl();
    if (!el) return;
    evidenceCleanupRef.current?.();
    const settle = () => { evidenceCleanupRef.current?.(); setVideoStarted(true); };
    el.addEventListener('playing', settle);
    // Firefox ships neither request- nor cancelVideoFrameCallback (they are typed but
    // absent at runtime), so `playing` is the only evidence there — which is why both
    // are wired rather than rVFC alone.
    const handle = typeof el.requestVideoFrameCallback === 'function'
      ? el.requestVideoFrameCallback(() => settle())
      : undefined;
    evidenceCleanupRef.current = () => {
      evidenceCleanupRef.current = null;
      el.removeEventListener('playing', settle);
      if (handle !== undefined && typeof el.cancelVideoFrameCallback === 'function') el.cancelVideoFrameCallback(handle);
    };
  }, []);

  // ── Audible playback, explicitly ──────────────────────────────────────────
  // Nobody else does this: @anam-ai/js-sdk 4.15.0 assigns srcObject once
  // (modules/StreamingClient.js:491) and contains no `.play(` call at all, so the
  // start is left entirely to the element's native autoPlay. The element carries no
  // `muted` attribute — a viewer who opened a conversation wants to hear it — so an
  // autoplay policy can refuse it, and refuses it SILENTLY: no event, no rejected
  // promise anyone was holding, no console line. Asking for playback ourselves is the
  // only way the refusal becomes visible.
  const attemptAudiblePlayback = useCallback(async () => {
    const el = getVideoEl();
    if (!el) return;
    el.muted = false;
    try {
      await el.play();
      setAudioBlocked(false);
    } catch (err) {
      if ((err as DOMException | undefined)?.name !== 'NotAllowedError') return;
      // Sound was refused. Muted playback is still allowed, so give the viewer a
      // moving avatar instead of a frozen frame — and a control to get the audio
      // back in one gesture. Muted is a waypoint here, never a destination.
      el.muted = true;
      try { await el.play(); } catch { /* fully refused — the 20s watchdog surfaces it */ }
      setAudioBlocked(true);
    }
  }, []);

  const enableAudio = useCallback(async () => {
    const el = getVideoEl();
    if (!el) return;
    el.muted = false;
    try {
      await el.play();
      setAudioBlocked(false);
    } catch {
      // Refused even with the gesture: stay watchable and keep the control offered.
      el.muted = true;
      void el.play().catch(() => {});
    }
  }, []);

  const attachListeners = useCallback((client: AnamClient, AnamEvent: AnamEvents) => {
    client.addListener(AnamEvent.VIDEO_PLAY_STARTED, () => {
      // The SDK's own requestVideoFrameCallback — a genuinely presented frame.
      evidenceCleanupRef.current?.();
      setVideoStarted(true);
      setTimeout(() => { memoryRef.current.inject(client as unknown as { addContext?: (s: string) => void; isStreaming?: () => boolean }); }, 3000);
    });
    client.addListener(AnamEvent.VIDEO_STREAM_STARTED, () => {
      // PublicEventEmitter.emit is synchronous and StreamingClient assigns srcObject
      // on the line after the emit, so right now the element still holds the previous
      // source. One microtask later the real stream is attached.
      queueMicrotask(() => { armFrameEvidence(); void attemptAudiblePlayback(); });
    });
    client.addListener(AnamEvent.CONNECTION_CLOSED, () => {
      if (leftRef.current) return;
      setLostConnection(true);
      reconnectTimerRef.current = setTimeout(() => { if (!leftRef.current) { leftRef.current = true; onLeave(); } }, 60_000);
    });
    client.addListener(AnamEvent.SERVER_WARNING, (msg: string) => {
      setWarning(msg);
      if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
      warningTimerRef.current = setTimeout(() => setWarning(''), 6000);
    });
    client.addListener(AnamEvent.MIC_PERMISSION_DENIED, () => {
      setJoinError('Microphone permission denied. Please allow microphone access and try again.');
    });

    client.addListener(AnamEvent.MESSAGE_STREAM_EVENT_RECEIVED, (event: { endOfSpeech?: boolean; interrupted?: boolean; content?: string; role?: string }) => {
      if (!event.endOfSpeech || event.interrupted) return;
      const text = (event.content ?? '').trim();
      if (text.length <= 5) return;
      if (event.role === 'user') {
        lastUserMsgRef.current = text;
        if (personaMsgTimerRef.current) { clearTimeout(personaMsgTimerRef.current); personaMsgTimerRef.current = null; }
        lastTriggeredPersonaRef.current = '';
        resetVisualRef.current();
        resetImageRef.current();
        triggerVisualRef.current(text, text).then((result) => {
          if (!result.handled && result.reason === 'fallback_image_allowed') triggerImageRef.current(text).catch(() => {});
        }).catch(() => {});
      } else if (event.role === 'persona') {
        const ctx = lastUserMsgRef.current || undefined;
        triggerVisualRef.current(text, ctx).then((result) => {
          if (!result.handled && result.reason === 'fallback_image_allowed') triggerImageRef.current(text, ctx).catch(() => {});
        }).catch(() => {});
      }
    });

    client.addListener(AnamEvent.MESSAGE_HISTORY_UPDATED, (messages: Array<{ role: string; content: string }>) => {
      memoryRef.current.record(messages);
      const personaMsg = [...messages].reverse().find((m) => m.role === 'persona' || m.role === 'assistant');
      if (!personaMsg || personaMsg.content.length < 80) return;
      lastPersonaContentRef.current = personaMsg.content;
      lastPersonaSpokeAtRef.current = Date.now();
      const content = personaMsg.content;
      if (personaMsgTimerRef.current) clearTimeout(personaMsgTimerRef.current);
      personaMsgTimerRef.current = setTimeout(() => {
        personaMsgTimerRef.current = null;
        if (content === lastTriggeredPersonaRef.current) return;
        lastTriggeredPersonaRef.current = content;
        const snippet = content.slice(0, 400);
        const ctx = lastUserMsgRef.current || undefined;
        triggerVisualRef.current(snippet, ctx).then((result) => {
          if (!result.handled && result.reason === 'fallback_image_allowed') triggerImageRef.current(snippet, ctx).catch(() => {});
        }).catch(() => {});
      }, 1000);
    });
  }, [onLeave, armFrameEvidence, attemptAudiblePlayback]);

  useEffect(() => {
    // React StrictMode (Next dev) mounts effects twice. Without this guard the
    // connect effect would open TWO Anam sessions at once → "Concurrency limit
    // reached". The guard used to lean on the 150ms pre-warm still being in flight
    // when the StrictMode cleanup ran, which made it a race that a fast (or
    // AudioContext-less) environment lost. It now leans on `await loadAnamSdk()`,
    // which is unconditionally asynchronous, and the flag is re-checked immediately
    // before the only call that opens a session.
    let cancelled = false;
    leftRef.current = false;

    const handleUnload = () => { endAvatarSession(characterId); clientRef.current?.stopStreaming().catch(() => {}); };
    window.addEventListener('beforeunload', handleUnload);

    (async () => {
      let sdk: AnamSdk;
      try {
        sdk = await loadAnamSdk();
      } catch {
        if (!cancelled) setJoinError('Could not load the avatar player. Please check your connection and try again.');
        return;
      }
      if (cancelled) return; // StrictMode threw away this mount — don't open a session

      // v4 non-legacy construction: the persona is baked into the session token by the backend
      // (anamService.getSessionToken), so NEVER pass a personaConfig here — the SDK would then
      // error "This session token already contains a persona configuration". The "Legacy session
      // tokens are no longer supported" error is a BACKEND token-shape problem (a persona without
      // an llmId), fixed server-side — not here.
      const client = sdk.createClient(sessionToken, { voiceDetection: { endOfSpeechSensitivity: character.voiceSensitivity } });
      clientRef.current = client;
      attachListeners(client, sdk.AnamEvent);

      await primeVideoElementForAutoplay();
      if (cancelled) return;
      client.streamToVideoElement(VIDEO_ELEMENT_ID).catch((err: Error) => setJoinError(err.message ?? 'Failed to start avatar stream'));
    })();

    return () => {
      cancelled = true;
      window.removeEventListener('beforeunload', handleUnload);
      evidenceCleanupRef.current?.();
      if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (personaMsgTimerRef.current) clearTimeout(personaMsgTimerRef.current);
      if (!leftRef.current) { leftRef.current = true; endAvatarSession(characterId); clientRef.current?.stopStreaming().catch(() => {}); }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLeave = useCallback(() => {
    if (leftRef.current) return;
    leftRef.current = true;
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    endAvatarSession(characterId);
    clientRef.current?.stopStreaming().catch(() => {});
    onLeave();
  }, [onLeave, characterId]);

  const handleReconnect = useCallback(async () => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    setReconnecting(true);
    try {
      const sdk = await loadAnamSdk(); // already resolved — the chunk was fetched on the first connect
      const data = await startAvatarSession(characterId, projectId);
      if (!data.sessionToken) throw new Error('No session token');
      const newClient = sdk.createClient(data.sessionToken, { voiceDetection: { endOfSpeechSensitivity: data.voiceSensitivity ?? character.voiceSensitivity } });
      clientRef.current = newClient;
      leftRef.current = false;
      setLostConnection(false);
      setVideoStarted(false);
      attachListeners(newClient, sdk.AnamEvent);
      newClient.streamToVideoElement(VIDEO_ELEMENT_ID).catch((err: Error) => { setJoinError(err.message ?? 'Reconnect failed'); setLostConnection(false); });
    } catch {
      setJoinError('Reconnect failed. Please close and try again.');
      setLostConnection(false);
    } finally {
      setReconnecting(false);
    }
  }, [characterId, character.voiceSensitivity, attachListeners]);

  const toggleMic = useCallback(() => {
    const client = clientRef.current;
    if (!client) return;
    if (micMuted) client.unmuteInputAudio(); else client.muteInputAudio();
    setMicMuted((m) => !m);
  }, [micMuted]);

  // Interrupt — stop the avatar mid-sentence so the viewer can cut in, like a
  // real interruption. Cancels any pending visual triggers too.
  const handleInterrupt = useCallback(() => {
    const client = clientRef.current as (AnamClient & { interruptPersona?: () => void }) | null;
    if (!client) return;
    try { client.interruptPersona?.(); } catch { /* not streaming */ }
    if (personaMsgTimerRef.current) { clearTimeout(personaMsgTimerRef.current); personaMsgTimerRef.current = null; }
    if (micMuted) { try { client.unmuteInputAudio(); setMicMuted(false); } catch { /* noop */ } }
    setInterrupted(true);
    setTimeout(() => setInterrupted(false), 1600);
  }, [micMuted]);

  if (joinError) {
    return (
      <div className="avatar-conversation avatar-conversation--center">
        <div style={{ textAlign: 'center', padding: 32, maxWidth: 420 }}>
          <p style={{ color: '#e87762', marginBottom: 20, fontSize: 15 }}>⚠ {joinError}</p>
          <button className="avatar-btn avatar-btn--secondary" onClick={onLeave}>← Close</button>
        </div>
      </div>
    );
  }

  return (
    <div className="avatar-conversation">
      {warning && <div className="avatar-warning">{warning}</div>}

      <div className="avatar-video-stage">
        <video id={VIDEO_ELEMENT_ID} autoPlay playsInline style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
        {!videoStarted && (
          <div className="avatar-waiting-overlay">
            <img src={character.portrait} alt={character.displayName} className="avatar-waiting-portrait" onError={(e) => { (e.currentTarget.style.display = 'none'); }} />
            <p className="avatar-waiting-text">{character.startingLabel}</p>
            <span className="avatar-spinner" />
          </div>
        )}
        {videoStarted && <div className="avatar-nametag">{character.nametag}</div>}
        {audioBlocked && (
          // Autoplay-with-sound was refused, so the avatar is playing muted. This
          // click is the user gesture that buys the audio back.
          <button
            type="button"
            className="avatar-enable-audio"
            onClick={() => { void enableAudio(); }}
            aria-live="polite"
          >
            <Volume2 size={16} aria-hidden /> Tap to enable sound
          </button>
        )}
      </div>

      {visual && visual.type !== 'simulation' && (
        <VisualPanel visual={visual} visible={visualVisible} onDismiss={dismissVisual} />
      )}
      {visual?.type === 'simulation' && (
        <SimulationOverlay
          html={visual.simulationUrl ? undefined : visual.html}
          src={visual.simulationUrl}
          caption={visual.caption}
          visible={visualVisible}
          onDismiss={dismissVisual}
        />
      )}
      {imageUrl && (
        <AvatarImageOverlay imageUrl={imageUrl} altText={altText} caption={caption} imageType={imageType} visible={imageVisible} onDismiss={dismissImage} />
      )}

      {lostConnection && (
        <div className="avatar-lost-overlay">
          <p style={{ color: '#e0e0e0', fontSize: 18, margin: 0 }}>Connection lost</p>
          <div style={{ display: 'flex', gap: 12 }}>
            <button className="avatar-btn avatar-btn--secondary" onClick={handleReconnect} disabled={reconnecting}>{reconnecting ? 'Reconnecting…' : 'Reconnect'}</button>
            <button className="avatar-btn avatar-btn--danger" onClick={handleLeave}>Leave</button>
          </div>
        </div>
      )}

      {interrupted && <div className="avatar-interrupt-toast">Go ahead — I&apos;m listening…</div>}

      <div className="avatar-controls-bar">
        <button className={`avatar-btn avatar-btn--control${micMuted ? ' avatar-btn--muted' : ''}`} onClick={toggleMic} title={micMuted ? 'Unmute mic' : 'Mute mic'}>
          {micMuted ? <MicOff size={16} /> : <Mic size={16} />} {micMuted ? 'Unmute' : 'Mute'}
        </button>
        <button className="avatar-btn avatar-btn--interrupt" onClick={handleInterrupt} title="Interrupt — stop the avatar and speak">
          <Hand size={16} /> Interrupt
        </button>
        <button className="avatar-btn avatar-btn--danger" onClick={handleLeave} style={{ padding: '10px 28px', borderRadius: 24 }}>
          {character.leaveLabel}
        </button>
      </div>
    </div>
  );
}
