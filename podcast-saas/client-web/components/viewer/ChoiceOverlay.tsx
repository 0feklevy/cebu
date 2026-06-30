'use client';

import type { PlayerChoicePoint, PlayerBranchEdge } from './types';

// Decision overlay shown near the end of a sequence. Bandersnatch-style: one decision
// moment, clear choices, an optional shrinking countdown, and a way back. Sits over the
// video (which keeps playing / pauses / loops per the choice point's behavior).

export function ChoiceOverlay({
  choice,
  countdown,
  canGoBack,
  onSelect,
  onBack,
}: {
  choice: PlayerChoicePoint;
  countdown: number | null;
  canGoBack: boolean;
  onSelect: (edge: PlayerBranchEdge) => void;
  onBack: () => void;
}) {
  // Only choices the viewer can act on (skip server-disabled destinations).
  const edges = choice.edges.filter((e) => !e.disabled);
  const timeoutPct = choice.timeout_sec && countdown != null
    ? Math.max(0, Math.min(1, countdown / choice.timeout_sec))
    : null;
  const isQuiz = choice.layout === 'quiz';
  const LETTERS = 'ABCDEFGH';

  return (
    <div className="viewer-choice-overlay" role="dialog" aria-label="Choose what happens next">
      <div className="viewer-choice-inner">
        {choice.prompt && (
          <p className={isQuiz ? 'viewer-choice-prompt viewer-choice-question' : 'viewer-choice-prompt'}>{choice.prompt}</p>
        )}

        <div className={`viewer-choice-cards${isQuiz ? ' viewer-choice-quiz' : choice.layout === 'buttons' ? ' viewer-choice-buttons' : ''}`}>
          {edges.map((edge, i) => (
            <button
              key={edge.id}
              type="button"
              className="viewer-choice-card"
              onClick={() => onSelect(edge)}
            >
              {isQuiz && <span className="viewer-choice-letter">{LETTERS[i] ?? '•'}</span>}
              {!isQuiz && edge.thumbnail_url && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={edge.thumbnail_url} alt="" className="viewer-choice-thumb" />
              )}
              <span className="viewer-choice-card-text">
                <span className="viewer-choice-card-label">{edge.label ?? 'Continue'}</span>
                {edge.description && <span className="viewer-choice-card-desc">{edge.description}</span>}
              </span>
            </button>
          ))}
        </div>

        <div className="viewer-choice-footer">
          {canGoBack && (
            <button type="button" className="viewer-choice-back" onClick={onBack}>
              ← Back to previous decision
            </button>
          )}
          {timeoutPct != null && (
            <div className="viewer-choice-timer" aria-hidden>
              <div className="viewer-choice-timer-bar" style={{ width: `${timeoutPct * 100}%` }} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
