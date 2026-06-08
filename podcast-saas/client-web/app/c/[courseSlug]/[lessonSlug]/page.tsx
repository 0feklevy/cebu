import type { Metadata, Route } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import Link from 'next/link';
import { getLessonPage } from '@/lib/courseApi';
import { seoToMetadata, serializeJsonLd } from '@/lib/seo';
import { LessonPlayer } from '@/components/viewer/LessonPlayer';
import type { PlayerConfig } from '@/components/viewer/types';

export const revalidate = 300;

type Params = { params: Promise<{ courseSlug: string; lessonSlug: string }> };

function fmtTime(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { courseSlug, lessonSlug } = await params;
  const result = await getLessonPage(courseSlug, lessonSlug);
  if (result.status !== 'ok') return { title: 'Not found', robots: { index: false, follow: false } };
  return seoToMetadata(result.data.seo, { ogType: 'video.other' });
}

export default async function LessonPage({ params }: Params) {
  const { courseSlug, lessonSlug } = await params;
  const result = await getLessonPage(courseSlug, lessonSlug);
  if (result.status === 'redirect') permanentRedirect(result.redirectUrl);
  if (result.status !== 'ok') notFound();

  const l = result.data;
  const player = l.player as PlayerConfig | null;

  return (
    <main className="mx-auto max-w-3xl px-5 py-8 text-[var(--fg,#111)]">
      {l.jsonLd.map((ld, i) => (
        <script key={i} type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(ld) }} />
      ))}

      <nav aria-label="Breadcrumb" className="mb-5 text-sm text-black/50">
        <ol className="flex flex-wrap gap-1">
          {l.breadcrumbs.map((b, i) => (
            <li key={b.url} className="flex items-center gap-1">
              {i > 0 && <span aria-hidden>/</span>}
              {i < l.breadcrumbs.length - 1 ? <a href={b.url} className="hover:underline">{b.name}</a> : <span aria-current="page">{b.name}</span>}
            </li>
          ))}
        </ol>
      </nav>

      <article>
        <h1 className="mb-1 text-2xl font-bold leading-tight">{l.title}</h1>
        <p className="mb-4 text-sm text-black/50">
          Part of <Link href={l.courseHref as Route} className="underline">{l.courseTitle}</Link>
        </p>

        {/* Interactive player island — composes the existing renderer */}
        {player && (
          <div className="relative mb-6 aspect-video w-full overflow-hidden rounded-lg bg-black">
            <LessonPlayer config={player} />
          </div>
        )}

        {l.summary && (
          <section className="mb-6">
            <h2 className="text-lg font-semibold">Summary</h2>
            <p className="mt-1 whitespace-pre-line text-black/80">{l.summary}</p>
          </section>
        )}

        {l.topics && (
          <section className="mb-6">
            <h2 className="text-lg font-semibold">Topics covered</h2>
            <p className="mt-1 whitespace-pre-line text-black/80">{l.topics}</p>
          </section>
        )}

        {l.learningOutcomes.length > 0 && (
          <section className="mb-6">
            <h2 className="text-lg font-semibold">What you’ll learn</h2>
            <ul className="mt-1 list-disc pl-5 text-black/80">
              {l.learningOutcomes.map((o, i) => <li key={i}>{o}</li>)}
            </ul>
          </section>
        )}

        {l.interactiveElements.length > 0 && (
          <section className="mb-6">
            <h2 className="text-lg font-semibold">Interactive elements</h2>
            <ul className="mt-1 space-y-1 text-black/80">
              {l.interactiveElements.map((el, i) => (
                <li key={i}><span className="font-medium">{el.label}:</span> {el.description}</li>
              ))}
            </ul>
          </section>
        )}

        {l.chapters.length > 0 && (
          <section className="mb-6">
            <h2 className="text-lg font-semibold">Chapters</h2>
            <ul className="mt-2 space-y-1 text-black/80">
              {l.chapters.map((ch, i) => (
                <li key={i} className="flex gap-3">
                  <span className="tabular-nums text-black/40">{fmtTime(ch.startSec)}</span>
                  <span>{ch.label}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {l.transcriptText && (
          <section className="mb-6">
            <h2 className="text-lg font-semibold">Transcript</h2>
            <p className="mt-1 whitespace-pre-line text-sm leading-6 text-black/70">{l.transcriptText}</p>
          </section>
        )}

        <nav aria-label="Lesson navigation" className="mt-8 flex items-center justify-between gap-4 border-t border-black/10 pt-4 text-sm">
          {l.prev ? (
            <Link href={l.prev.href as Route} className="text-left hover:underline">← {l.prev.title}</Link>
          ) : <span />}
          <Link href={l.courseHref as Route} className="shrink-0 text-black/50 hover:underline">All lessons</Link>
          {l.next ? (
            <Link href={l.next.href as Route} className="text-right hover:underline">{l.next.title} →</Link>
          ) : <span />}
        </nav>
      </article>
    </main>
  );
}
