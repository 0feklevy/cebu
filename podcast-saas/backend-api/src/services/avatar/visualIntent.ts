// Ported verbatim from darwin-avatar/server/visual/visualIntent.ts
// Pure sync module — no imports, no network calls, zero latency.

export interface VisualIntent {
  requestedType: 'simulation' | 'chart' | 'equation' | 'diagram' | 'image' | null;
  explicit: boolean;
  topic: string;
  confidence: number;
}

const META_WORDS =
  /\b(show\s+me|let\s+me\s+see|i\s+want\s+to\s+see|can\s+you|please|a\b|an\b|the\b|simulation|interactive|about|of\b|with\b|some\b)\b/gi;

const SIM_STRONG  = /\b(simulation|simulate|particle\s+simulation|physics\s+demo)\b/i;
const SIM_PHRASE  = /\binteractive\s+simulation\b|\bplay\s+with\s+(a\s+)?model\b|\bshow\s+(?:me\s+)?how\s+.{0,30}(?:moves?|changes?\s+over\s+time)\b/i;

const CHART_STRONG = /\b(chart|graph|plot)\b/i;
const CHART_PHRASE = /\b(compare|comparison)\s+.{0,30}\b(numbers?|data|statistics|rates?|counts?)\b/i;
const CHART_STATS  = /\bstatistics\b/i;
const CHART_VIS    = /\b(show|display|visualize)\b/i;

const EQ_STRONG   = /\b(equation|formula)\b/i;
const EQ_PHRASE   = /\bthe\s+math\b|\bmathematically\b|\bshow\s+the\s+formula\b|\bwrite\s+it\s+out\b/i;

const DIAG_STRONG = /\b(diagram|flowchart)\b/i;
const DIAG_PHRASE = /\bmap\s+it\s+out\b|\bshow\s+the\s+structure\b|\bdraw\s+.{0,30}\b(structure|process|flow|cycle|mechanism)\b/i;

const IMG_PHRASE  = /\b(picture|photo|photograph|image)\s+of\b|\bshow\s+me\s+(?:a\s+|an\s+)?(?:photo|picture|image)\b/i;

export function detectVisualIntent(userMessage: string): VisualIntent {
  const msg = userMessage;

  if (SIM_STRONG.test(msg)) {
    return { requestedType: 'simulation', explicit: true, topic: extractTopic(msg), confidence: 0.9 };
  }
  if (SIM_PHRASE.test(msg)) {
    return { requestedType: 'simulation', explicit: true, topic: extractTopic(msg), confidence: 0.75 };
  }
  if (EQ_STRONG.test(msg) || EQ_PHRASE.test(msg)) {
    return { requestedType: 'equation', explicit: true, topic: extractTopic(msg), confidence: 0.9 };
  }
  if (CHART_STRONG.test(msg) || CHART_PHRASE.test(msg) || (CHART_STATS.test(msg) && CHART_VIS.test(msg))) {
    return { requestedType: 'chart', explicit: true, topic: extractTopic(msg), confidence: CHART_STRONG.test(msg) ? 0.9 : 0.75 };
  }
  if (DIAG_STRONG.test(msg) || DIAG_PHRASE.test(msg)) {
    return { requestedType: 'diagram', explicit: true, topic: extractTopic(msg), confidence: DIAG_STRONG.test(msg) ? 0.9 : 0.75 };
  }
  if (IMG_PHRASE.test(msg)) {
    return { requestedType: 'image', explicit: true, topic: extractTopic(msg), confidence: 0.9 };
  }
  return { requestedType: null, explicit: false, topic: extractTopic(msg), confidence: 0 };
}

export function extractTopic(userMessage: string, context?: string): string {
  let topic = userMessage
    .replace(META_WORDS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

  if (topic.length < 20 && context && context !== userMessage) {
    const ctxClean = context.replace(META_WORDS, ' ').replace(/\s+/g, ' ').trim();
    const extra = ctxClean.slice(0, 40);
    if (extra && !topic.includes(extra.slice(0, 10))) {
      topic = `${topic} ${extra}`.trim().slice(0, 120);
    }
  }
  return topic;
}

export function isFallbackTypeAllowed(
  requestedType: VisualIntent['requestedType'],
  resultType: string,
): boolean {
  if (!requestedType) return true;
  return requestedType === resultType;
}
