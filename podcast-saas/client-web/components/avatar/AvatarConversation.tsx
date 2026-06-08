'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Hand } from 'lucide-react';
import { createClient, AnamEvent } from '@anam-ai/js-sdk';
import { characterMeta } from './characters';
import { endAvatarSession, startAvatarSession, type AvatarDisplay } from './avatarApi';
import { useVisualTrigger } from './hooks/useVisualTrigger';
import { useImageTrigger } from './hooks/useImageTrigger';
import { useConversationMemory } from './hooks/useConversationMemory';
import { VisualPanel } from './VisualPanel';
import { SimulationOverlay } from './SimulationOverlay';
import { AvatarImageOverlay } from './AvatarImageOverlay';

type AnamClient = ReturnType<typeof createClient>;

interface Props {
  characterId: string;
  projectId?: string;
  sessionToken: string;
  display?: AvatarDisplay;
  onLeave: () => void;
}

const VIDEO_ELEMENT_ID = 'anam-avatar-video';

// Mic-only port of darwin-avatar/client/src/components/AnamConversationView.tsx.
export function AvatarConversation({ characterId, projectId, sessionToken, display, onLeave }: Props) {
  const character = characterMeta(characterId, display);
  const clientRef = useRef<AnamClient | null>(null);
  const leftRef = useRef(false);

  const [micMuted, setMicMuted] = useState(false);
  const [interrupted, setInterrupted] = useState(false);
  const [videoStarted, setVideoStarted] = useState(false);
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

  const attachListeners = useCallback((client: AnamClient) => {
    client.addListener(AnamEvent.VIDEO_PLAY_STARTED, () => {
      setVideoStarted(true);
      setTimeout(() => { memoryRef.current.inject(client as unknown as { addContext?: (s: string) => void }); }, 3000);
    });
    client.addListener(AnamEvent.VIDEO_STREAM_STARTED, () => { setTimeout(() => setVideoStarted(true), 2000); });
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
  }, [onLeave]);

  useEffect(() => {
    // React StrictMode (Next dev) mounts effects twice. Without this guard the
    // connect effect would open TWO Anam sessions at once → "Concurrency limit
    // reached". `cancelled` is set by the StrictMode cleanup before the 150ms
    // pre-warm finishes, so the throwaway first mount never starts a session.
    let cancelled = false;
    leftRef.current = false;
    const client = createClient(sessionToken, { voiceDetection: { endOfSpeechSensitivity: character.voiceSensitivity } });
    clientRef.current = client;
    attachListeners(client);

    // Pre-warm the browser audio decoder with 150ms of silence so the OPUS codec
    // is already running when Anam's first RTP packets arrive — prevents the first
    // word of the greeting from being dropped. (Ported from darwin-avatar.)
    (async () => {
      try {
        const ACtx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const audioCtx = new ACtx();
        await audioCtx.resume();
        const dest = audioCtx.createMediaStreamDestination();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        gain.gain.setValueAtTime(0, 0);
        osc.connect(gain); gain.connect(dest); osc.start();
        const videoEl = document.getElementById(VIDEO_ELEMENT_ID) as HTMLVideoElement | null;
        if (videoEl) {
          videoEl.srcObject = dest.stream;
          await videoEl.play().catch(() => {});
          await new Promise<void>((r) => setTimeout(r, 150));
          videoEl.srcObject = null;
        }
        osc.stop(); audioCtx.close();
      } catch { /* non-critical */ }
      if (cancelled) return; // StrictMode threw away this mount — don't open a session
      client.streamToVideoElement(VIDEO_ELEMENT_ID).catch((err: Error) => setJoinError(err.message ?? 'Failed to start avatar stream'));
    })();

    const handleUnload = () => { endAvatarSession(characterId); client.stopStreaming().catch(() => {}); };
    window.addEventListener('beforeunload', handleUnload);
    return () => {
      cancelled = true;
      window.removeEventListener('beforeunload', handleUnload);
      if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (personaMsgTimerRef.current) clearTimeout(personaMsgTimerRef.current);
      if (!leftRef.current) { leftRef.current = true; endAvatarSession(characterId); client.stopStreaming().catch(() => {}); }
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
      const data = await startAvatarSession(characterId, projectId);
      if (!data.sessionToken) throw new Error('No session token');
      const newClient = createClient(data.sessionToken, { voiceDetection: { endOfSpeechSensitivity: data.voiceSensitivity ?? character.voiceSensitivity } });
      clientRef.current = newClient;
      leftRef.current = false;
      setLostConnection(false);
      setVideoStarted(false);
      attachListeners(newClient);
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
