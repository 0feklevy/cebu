'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Bot, Brush, Database, KeyRound, Monitor, Moon, SlidersHorizontal, Sun, User, X } from 'lucide-react';
import { useAuth } from '../lib/firebase';
import { type ThemeOption, useTheme } from '../lib/theme';

type SettingsTab = 'profile' | 'preferences' | 'ai' | 'advanced' | 'privacy';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const LOCAL_PREFS_KEY = 'podcast-saas-user-preferences';

interface LocalPrefs {
  guidedTutorial: boolean;
  compactEditor: boolean;
  alwaysExpertMode: boolean;
  reduceMotion: boolean;
}

const DEFAULT_PREFS: LocalPrefs = {
  guidedTutorial: true,
  compactEditor: false,
  alwaysExpertMode: false,
  reduceMotion: false,
};

function readPrefs(): LocalPrefs {
  if (typeof window === 'undefined') return DEFAULT_PREFS;
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(window.localStorage.getItem(LOCAL_PREFS_KEY) ?? '{}') };
  } catch {
    return DEFAULT_PREFS;
  }
}

function initials(value: string | null | undefined) {
  return (value ?? '?')
    .split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function formatMemberSince(date?: string) {
  if (!date) return 'Unknown';
  return new Date(date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function PreferenceToggle({
  title,
  description,
  active,
  disabled,
  onToggle,
}: {
  title: string;
  description: string;
  active: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      className={`flex w-full items-center justify-between gap-4 rounded-lg border p-4 text-left transition-colors focus-ring ${
        active
          ? 'border-violet-300 bg-violet-50 text-slate-950'
          : 'border-border bg-card hover:bg-muted/50'
      } disabled:cursor-not-allowed disabled:opacity-50`}
    >
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-foreground">{title}</span>
        <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{description}</span>
      </span>
      <span
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${active ? 'bg-violet-500' : 'bg-slate-300'}`}
        aria-hidden
      >
        <span
          className="absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform"
          style={{ transform: active ? 'translateX(18px)' : 'translateX(2px)' }}
        />
      </span>
    </button>
  );
}

export function UserSettingsDialog({ open, onOpenChange }: Props) {
  const { user, isAnonymous, signOutUser } = useAuth();
  const { theme, resolvedTheme, setTheme } = useTheme();
  const [activeTab, setActiveTab] = useState<SettingsTab>('preferences');
  const [prefs, setPrefs] = useState<LocalPrefs>(DEFAULT_PREFS);

  useEffect(() => {
    if (open) setPrefs(readPrefs());
  }, [open]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.dataset.motion = prefs.reduceMotion ? 'reduced' : 'full';
    document.documentElement.dataset.editorDensity = prefs.compactEditor ? 'compact' : 'comfortable';
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(LOCAL_PREFS_KEY, JSON.stringify(prefs));
    }
  }, [prefs]);

  const updatePref = (key: keyof LocalPrefs, value: boolean) => {
    setPrefs((current) => ({ ...current, [key]: value }));
  };

  const displayName = user?.displayName || user?.email || (isAnonymous ? 'Guest workspace' : 'User');
  const email = user?.email || (isAnonymous ? 'Anonymous session' : 'No email');
  const avatar = initials(user?.displayName || user?.email || 'Guest');

  const tabs: Array<{ id: SettingsTab; label: string; icon: ReactNode; hidden?: boolean }> = [
    { id: 'profile', label: 'Profile', icon: <User size={15} aria-hidden />, hidden: isAnonymous },
    { id: 'preferences', label: 'Preferences', icon: <Brush size={15} aria-hidden /> },
    { id: 'ai', label: 'AI & API Keys', icon: <Bot size={15} aria-hidden />, hidden: isAnonymous },
    { id: 'advanced', label: 'Advanced', icon: <SlidersHorizontal size={15} aria-hidden /> },
    { id: 'privacy', label: 'Data & Privacy', icon: <Database size={15} aria-hidden />, hidden: isAnonymous },
  ];

  const themeOptions: Array<{ value: ThemeOption; label: string; icon: ReactNode }> = [
    { value: 'dark', label: 'Dark', icon: <Moon size={16} aria-hidden /> },
    { value: 'light', label: 'Light', icon: <Sun size={16} aria-hidden /> },
    { value: 'system', label: 'System', icon: <Monitor size={16} aria-hidden /> },
  ];

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[900] bg-slate-950/55 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[901] flex h-[min(760px,calc(100vh-32px))] w-[min(920px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-lg border border-border bg-background shadow-modal">
          <aside className="hidden w-60 shrink-0 border-r shell-bg p-3 md:block">
            <div className="mb-3 flex items-center gap-3 rounded-lg border px-3 py-3" style={{ borderColor: 'hsl(var(--shell-border))' }}>
              <div className="flex h-9 w-9 items-center justify-center rounded-full gradient-action text-xs font-bold">
                {avatar}
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold shell-text">{displayName}</p>
                <p className="truncate text-xs shell-muted">{email}</p>
              </div>
            </div>
            <nav className="space-y-1">
              {tabs.filter((tab) => !tab.hidden).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors focus-ring ${
                    activeTab === tab.id
                      ? 'gradient-action shadow-sm'
                      : 'shell-muted shell-hover'
                  }`}
                >
                  {tab.icon}
                  {tab.label}
                </button>
              ))}
            </nav>
          </aside>

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center justify-between border-b border-border bg-card px-5 py-4">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-primary/70">Settings</p>
                <Dialog.Title className="text-lg font-bold text-foreground">
                  Account and preferences
                </Dialog.Title>
              </div>
              <Dialog.Close className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-ring">
                <X size={16} strokeWidth={1.8} aria-hidden />
                <span className="sr-only">Close settings</span>
              </Dialog.Close>
            </div>

            <div className="flex gap-1 overflow-x-auto border-b border-border bg-card px-3 py-2 md:hidden">
              {tabs.filter((tab) => !tab.hidden).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold focus-ring ${
                    activeTab === tab.id ? 'gradient-action' : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {tab.icon}
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto p-5 fine-scrollbar">
              {activeTab === 'profile' && (
                <section className="space-y-4">
                  <div className="rounded-lg border border-border bg-card p-5 shadow-sm-soft">
                    <h3 className="mb-4 text-sm font-semibold text-foreground">Public Profile</h3>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Display Name</label>
                        <div className="mt-1 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-foreground">
                          {user?.displayName || 'Not set'}
                        </div>
                      </div>
                      <div>
                        <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Email</label>
                        <div className="mt-1 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-foreground">
                          {user?.email || 'No email'}
                        </div>
                      </div>
                      <div>
                        <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Member Since</label>
                        <div className="mt-1 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-foreground">
                          {formatMemberSince(user?.metadata?.creationTime)}
                        </div>
                      </div>
                      <div>
                        <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Account Provider</label>
                        <div className="mt-1 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-foreground">
                          {user?.providerData?.[0]?.providerId ?? 'Anonymous'}
                        </div>
                      </div>
                    </div>
                  </div>
                </section>
              )}

              {activeTab === 'preferences' && (
                <section className="space-y-4">
                  <div className="rounded-lg border border-border bg-card p-5 shadow-sm-soft">
                    <h3 className="text-sm font-semibold text-foreground">Theme</h3>
                    <p className="mt-1 text-xs text-muted-foreground">Choose your preferred color scheme. Current resolved theme: {resolvedTheme}.</p>
                    <div className="mt-4 grid gap-2 sm:grid-cols-3">
                      {themeOptions.map((option) => (
                        <label
                          key={option.value}
                          className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-3 text-sm font-semibold transition-colors ${
                            theme === option.value ? 'border-violet-300 bg-violet-50 text-slate-950' : 'border-border bg-background hover:bg-muted/50'
                          }`}
                        >
                          <input
                            type="radio"
                            name="theme"
                            value={option.value}
                            checked={theme === option.value}
                            onChange={() => setTheme(option.value)}
                            className="sr-only"
                          />
                          {option.icon}
                          {option.label}
                        </label>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <PreferenceToggle
                      title="Guided Tutorial"
                      description="Show walkthrough hints for important editor controls."
                      active={prefs.guidedTutorial}
                      onToggle={() => updatePref('guidedTutorial', !prefs.guidedTutorial)}
                    />
                    <PreferenceToggle
                      title="Compact Editor"
                      description="Use denser spacing in editor panels and timelines."
                      active={prefs.compactEditor}
                      onToggle={() => updatePref('compactEditor', !prefs.compactEditor)}
                    />
                  </div>
                </section>
              )}

              {activeTab === 'advanced' && (
                <section className="space-y-2">
                  <PreferenceToggle
                    title="Always use Expert mode"
                    description="Prefer advanced controls when creating or editing interactive sections."
                    active={prefs.alwaysExpertMode}
                    onToggle={() => updatePref('alwaysExpertMode', !prefs.alwaysExpertMode)}
                  />
                  <PreferenceToggle
                    title="Reduce Motion"
                    description="Minimize interface animation for a calmer workspace."
                    active={prefs.reduceMotion}
                    onToggle={() => updatePref('reduceMotion', !prefs.reduceMotion)}
                  />
                </section>
              )}

              {activeTab === 'ai' && (
                <section className="space-y-4">
                  <div className="rounded-lg border border-border bg-card p-5 shadow-sm-soft">
                    <h3 className="text-sm font-semibold text-foreground">AI & API Keys</h3>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      Fiji exposes per-user model keys here. Podcast Studio currently uses server-managed providers, so this view mirrors the same account area without storing secrets locally.
                    </p>
                    <div className="mt-4 grid gap-2">
                      {['Anthropic Claude', 'OpenAI', 'Google Gemini'].map((provider) => (
                        <div key={provider} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-3">
                          <div className="flex min-w-0 items-center gap-3">
                            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                              <KeyRound size={15} strokeWidth={1.8} aria-hidden />
                            </span>
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold text-foreground">{provider}</p>
                              <p className="text-xs text-muted-foreground">Managed by workspace configuration</p>
                            </div>
                          </div>
                          <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-1 text-[10px] font-semibold text-emerald-600">
                            Server
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </section>
              )}

              {activeTab === 'privacy' && (
                <section className="space-y-4">
                  <div className="rounded-lg border border-border bg-card p-5 shadow-sm-soft">
                    <h3 className="text-sm font-semibold text-foreground">Data & Privacy</h3>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      Your project data is attached to your authenticated account. Local UI preferences can be reset here.
                    </p>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          window.localStorage.removeItem(LOCAL_PREFS_KEY);
                          setPrefs(DEFAULT_PREFS);
                        }}
                        className="rounded-lg border border-border px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-muted focus-ring"
                      >
                        Reset local preferences
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          onOpenChange(false);
                          void signOutUser();
                        }}
                        className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 transition-colors hover:bg-red-100 focus-ring"
                      >
                        Sign out
                      </button>
                    </div>
                  </div>
                </section>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
