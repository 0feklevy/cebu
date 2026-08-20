/**
 * The player's audio-language switcher (migration 067).
 *
 * WHY THIS FILE EXISTS SEPARATELY. `a11yOperableControls.test.tsx` enforces this CLASS of rule —
 * every control has a resolvable accessible name and works from the keyboard — but it names its
 * subjects explicitly and `ControlsBar` is not among them. The switcher therefore inherits no
 * coverage from it, and a regression here would be caught by nothing. These tests resolve every
 * control through the accessibility tree, exactly as that suite does, so the two agree on what
 * "operable" means.
 *
 * The acceptance criteria, one describe block each:
 *   • only languages with a completed dub appear — the server filters, and the component must not
 *     re-add anything;
 *   • the current language is marked as current, not merely styled;
 *   • selecting one asks the wrapper to navigate — the component never mutates audio itself;
 *   • the whole thing is reachable and operable by keyboard, with a real accessible name.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { ControlsBar, type AudioLanguage, type CaptionStyle } from '../components/viewer/ControlsBar';

afterEach(cleanup);

const CAPTION_STYLE: CaptionStyle = {
  fontSize: 22, backgroundColor: '#000000', backgroundOpacity: 72, textOpacity: 100,
};

const LANGUAGES: AudioLanguage[] = [
  { code: 'es', name: 'Spanish', endonym: 'Español', rtl: false },
  { code: 'he', name: 'Hebrew', endonym: 'עברית', rtl: true },
];

const noRef = { current: null };

function renderBar(over: Partial<Parameters<typeof ControlsBar>[0]> = {}) {
  const onLanguageChange = vi.fn();
  render(
    <ControlsBar
      playing={false}
      started
      timeline={[]}
      totalDuration={100}
      simMarkers={[]}
      videoMarkers={[]}
      brollMarkers={[]}
      progressFillRef={noRef}
      progressThumbRef={noRef}
      progressBufRef={noRef}
      progressTrackRef={noRef}
      progressWrapRef={noRef}
      curTimeRef={noRef}
      totTimeRef={noRef}
      onTogglePlay={() => {}}
      volume={1}
      muted={false}
      onVolumeChange={() => {}}
      onToggleMute={() => {}}
      captionsAvailable
      captionsEnabled={false}
      captionStatus="ready"
      captionStyle={CAPTION_STYLE}
      onToggleCaptions={() => {}}
      onCaptionStyleChange={() => {}}
      audioLanguages={LANGUAGES}
      currentLanguage={null}
      onLanguageChange={onLanguageChange}
      {...over}
    />,
  );
  return { onLanguageChange };
}

/** Open the settings menu the way a user does — through its named button. */
function openMenu(): HTMLElement {
  const gear = screen.getByRole('button', { name: 'Language and caption settings' });
  fireEvent.click(gear);
  return gear;
}

describe('the control has a real accessible name and announces its menu', () => {
  it('names the gear after what the menu contains', () => {
    renderBar();
    expect(screen.getByRole('button', { name: 'Language and caption settings' })).toBeTruthy();
  });

  it('falls back to the caption-only name when there is nothing to translate into', () => {
    renderBar({ audioLanguages: [] });
    expect(screen.getByRole('button', { name: 'Caption settings' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Language and caption settings' })).toBeNull();
  });

  it('declares that it opens a menu, and whether the menu is open', () => {
    renderBar();
    const gear = screen.getByRole('button', { name: 'Language and caption settings' });
    expect(gear.getAttribute('aria-haspopup')).toBe('menu');
    expect(gear.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(gear);
    expect(gear.getAttribute('aria-expanded')).toBe('true');
  });

  it('opens for a video with dubs even when captions are unavailable', () => {
    // The regression this prevents: one shared `disabled` condition hid the language switcher
    // behind "captions unavailable" for a video that had dubs but no caption track yet.
    renderBar({ captionsAvailable: false, captionStatus: 'none' });
    const gear = screen.getByRole('button', { name: 'Language and caption settings' });
    expect((gear as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(gear);
    expect(screen.getByRole('radio', { name: 'עברית' })).toBeTruthy();
  });

  it('stays disabled when there is neither a caption track nor a dub', () => {
    renderBar({ captionsAvailable: false, captionStatus: 'none', audioLanguages: [] });
    expect((screen.getByRole('button', { name: 'Caption settings' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('only languages with a completed dub appear', () => {
  it('lists exactly what it was given, plus the original', () => {
    renderBar();
    openMenu();
    const names = screen.getAllByRole('radio').map((el) => el.closest('label')?.textContent?.trim());
    expect(names).toEqual(['Original', 'Español', 'עברית']);
  });

  it('draws no switcher at all when nothing is dubbed', () => {
    renderBar({ audioLanguages: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Caption settings' }));
    expect(screen.queryByRole('radio')).toBeNull();
    // The caption-style controls are still there — the menu did not become language-only.
    expect(screen.getByRole('combobox', { name: /font size/i })).toBeTruthy();
  });

  it('draws no switcher when the wrapper cannot navigate', () => {
    // A surface that passes languages but no handler (the editor preview) must not offer a
    // control that would do nothing.
    renderBar({ onLanguageChange: undefined });
    fireEvent.click(screen.getByRole('button', { name: 'Caption settings' }));
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('renders each language in its own name, with the right text direction', () => {
    renderBar();
    openMenu();
    const hebrew = screen.getByRole('radio', { name: 'עברית' });
    expect(hebrew.closest('label')?.getAttribute('lang')).toBe('he');
    expect(hebrew.closest('label')?.querySelector('span')?.getAttribute('dir')).toBe('rtl');
    expect(screen.getByRole('radio', { name: 'Español' }).closest('label')?.querySelector('span')?.getAttribute('dir')).toBeNull();
  });
});

describe('the current language is marked', () => {
  it('marks the original when nothing is dubbed-selected', () => {
    renderBar({ currentLanguage: null });
    openMenu();
    const original = screen.getByRole('radio', { name: 'Original' }) as HTMLInputElement;
    expect(original.checked).toBe(true);
    expect(original.getAttribute('aria-current')).toBe('true');
  });

  it('marks the dubbed language a viewer arrived on', () => {
    renderBar({ currentLanguage: 'he' });
    openMenu();
    const hebrew = screen.getByRole('radio', { name: 'עברית' }) as HTMLInputElement;
    expect(hebrew.checked).toBe(true);
    expect(hebrew.getAttribute('aria-current')).toBe('true');
    // And exactly one is current — a second marked option would make the state ambiguous.
    expect(screen.getAllByRole('radio').filter((r) => r.getAttribute('aria-current') === 'true')).toHaveLength(1);
    expect((screen.getByRole('radio', { name: 'Original' }) as HTMLInputElement).checked).toBe(false);
  });
});

describe('selecting a language asks the wrapper to navigate', () => {
  it('reports the chosen code', () => {
    const { onLanguageChange } = renderBar({ currentLanguage: null });
    openMenu();
    fireEvent.click(screen.getByRole('radio', { name: 'עברית' }));
    expect(onLanguageChange).toHaveBeenCalledWith('he');
  });

  it('reports null for the original, so the wrapper drops the suffix', () => {
    const { onLanguageChange } = renderBar({ currentLanguage: 'he' });
    openMenu();
    fireEvent.click(screen.getByRole('radio', { name: 'Original' }));
    expect(onLanguageChange).toHaveBeenCalledWith(null);
  });

  it('does nothing when the current language is re-selected — no pointless navigation', () => {
    const { onLanguageChange } = renderBar({ currentLanguage: 'he' });
    openMenu();
    fireEvent.click(screen.getByRole('radio', { name: 'עברית' }));
    expect(onLanguageChange).not.toHaveBeenCalled();
  });
});

describe('operable by keyboard alone (the ui-ux-005 class of rule)', () => {
  it('the gear is a real button, so Tab reaches it and Enter activates it', () => {
    renderBar();
    const gear = screen.getByRole('button', { name: 'Language and caption settings' });
    expect(gear.tagName).toBe('BUTTON');
    // A <button> is in the tab order without a tabindex and fires onClick from Enter and Space;
    // asserting the tag is asserting exactly that, without re-testing the browser.
    expect(gear.getAttribute('tabindex')).toBeNull();
    expect((gear as HTMLButtonElement).disabled).toBe(false);
  });

  it('every language is a native radio in the tab order, named by its own label', () => {
    renderBar();
    openMenu();
    for (const name of ['Original', 'Español', 'עברית']) {
      const radio = screen.getByRole('radio', { name });
      expect(radio.tagName).toBe('INPUT');
      expect(radio.getAttribute('tabindex')).toBeNull();
    }
  });

  it('the radios form ONE group, so arrow keys move within it', () => {
    renderBar();
    openMenu();
    const names = new Set(screen.getAllByRole('radio').map((r) => r.getAttribute('name')));
    expect(names).toEqual(new Set(['viewer-audio-language']));
  });

  it('each radio can hold focus, which is what arrow-key navigation moves', () => {
    renderBar({ currentLanguage: null });
    openMenu();
    const spanish = screen.getByRole('radio', { name: 'Español' }) as HTMLInputElement;
    spanish.focus();
    expect(document.activeElement).toBe(spanish);
  });

  it('a focused radio selects without a pointer', () => {
    // Arrow-key selection in a native radio group dispatches a CLICK on the newly-selected
    // radio — that is the DOM behaviour, not a testing-library convention, and it is why a bare
    // `change` event would not exercise the real keyboard path here.
    const { onLanguageChange } = renderBar({ currentLanguage: null });
    openMenu();
    const spanish = screen.getByRole('radio', { name: 'Español' }) as HTMLInputElement;
    spanish.focus();
    fireEvent.click(spanish);
    expect(onLanguageChange).toHaveBeenCalledWith('es');
  });

  it('the group carries a name of its own', () => {
    renderBar();
    openMenu();
    expect(screen.getByRole('group', { name: 'Audio language' })).toBeTruthy();
  });
});
