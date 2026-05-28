import Link from 'next/link';

const STEPS = [
  {
    n: '01',
    title: 'Describe your topic',
    body: 'Upload a PDF, paste a URL, or write a brief. The AI reads and structures your material automatically.',
  },
  {
    n: '02',
    title: 'Watch the script form',
    body: 'Three-pass AI generation in real time — structural analysis, full draft, then broadcast-quality rewrite.',
  },
  {
    n: '03',
    title: 'Edit and approve',
    body: "Refine any dialogue turn, swap speakers, or regenerate a line. Approve the script when you're ready.",
  },
];

export default function LandingPage() {
  return (
    <div className="h-full overflow-y-auto">
      {/* Nav */}
      <header className="sticky top-0 z-20 border-b border-border/60 bg-background/90 backdrop-blur-md">
        <div className="max-w-5xl mx-auto flex h-14 items-center justify-between px-6">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center shadow-sm">
              <svg width="14" height="10" viewBox="0 0 14 10" fill="none" aria-hidden>
                <ellipse cx="5" cy="5" rx="4" ry="4" fill="white" fillOpacity="0.9" />
                <ellipse cx="11" cy="5" rx="2.5" ry="2.5" fill="white" fillOpacity="0.5" />
              </svg>
            </div>
            <span className="font-semibold tracking-tight text-sm text-foreground">PodcastAI</span>
          </div>
          <Link
            href="/new"
            className="h-8 px-4 bg-primary text-primary-foreground text-sm font-medium rounded-lg inline-flex items-center hover:bg-primary/90 transition-colors shadow-sm"
          >
            Get started
          </Link>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden pt-24 pb-20 px-6">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              'radial-gradient(ellipse 80% 50% at 50% -10%, hsl(243 74% 59% / 0.09) 0%, transparent 70%)',
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              'radial-gradient(circle, hsl(243 74% 59% / 0.04) 1px, transparent 1px)',
            backgroundSize: '28px 28px',
          }}
        />

        <div className="relative max-w-3xl mx-auto text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/6 px-3.5 py-1 text-xs font-medium text-primary mb-8">
            <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse inline-block" />
            Phase 1 Preview
          </span>

          <h1 className="text-5xl sm:text-[3.5rem] font-bold tracking-tight leading-[1.1] text-foreground mb-6">
            Turn any idea into a
            <br />
            <span
              className="bg-clip-text text-transparent"
              style={{
                backgroundImage:
                  'linear-gradient(135deg, hsl(243 74% 59%), hsl(280 75% 60%))',
              }}
            >
              two-host podcast
            </span>
          </h1>

          <p className="text-[1.0625rem] text-muted-foreground max-w-lg mx-auto leading-relaxed mb-10">
            Upload a PDF, paste a URL, or describe your topic. We generate a broadcast-quality
            script with two distinct hosts — ready to edit and approve.
          </p>

          <div className="flex items-center justify-center gap-3 flex-wrap">
            <Link
              href="/new"
              className="h-11 px-6 bg-primary text-primary-foreground font-semibold rounded-lg inline-flex items-center gap-2 hover:bg-primary/90 transition-all shadow-sm hover:shadow-md active:translate-y-px"
            >
              Create your podcast
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden>
                <path
                  d="M1 6.5h11M7 1.5l5 5-5 5"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </Link>
            <a
              href="#how"
              className="h-11 px-6 border border-border text-foreground font-semibold rounded-lg inline-flex items-center hover:bg-muted transition-colors"
            >
              See how it works
            </a>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="py-20 px-6 border-t border-border bg-muted/25">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-12">
            <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-primary/70 mb-2">
              How it works
            </p>
            <h2 className="text-2xl font-bold text-foreground">Three steps to your podcast</h2>
          </div>

          <div className="grid md:grid-cols-3 gap-5">
            {STEPS.map((s) => (
              <div
                key={s.n}
                className="rounded-2xl border border-border bg-card p-6 shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all duration-200"
              >
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center mb-4">
                  <span className="font-mono text-xs font-bold text-primary">{s.n}</span>
                </div>
                <h3 className="font-semibold text-foreground mb-2">{s.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-8 px-6 border-t border-border">
        <div className="max-w-5xl mx-auto flex items-center justify-between text-xs text-muted-foreground">
          <span>© 2025 PodcastAI</span>
          <div className="flex gap-5">
            <a href="#" className="hover:text-foreground transition-colors">Privacy</a>
            <a href="#" className="hover:text-foreground transition-colors">Terms</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
