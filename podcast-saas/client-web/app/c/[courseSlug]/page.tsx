import type { Metadata, Route } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import Link from 'next/link';
import { getCoursePage } from '@/lib/courseApi';
import { seoToMetadata, serializeJsonLd } from '@/lib/seo';

// ISR: pages revalidate periodically and are purged on publish via /api/revalidate.
export const revalidate = 300;

type Params = { params: Promise<{ courseSlug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { courseSlug } = await params;
  const result = await getCoursePage(courseSlug);
  if (result.status !== 'ok') return { title: 'Not found', robots: { index: false, follow: false } };
  return seoToMetadata(result.data.seo, { ogType: 'website' });
}

export default async function CoursePage({ params }: Params) {
  const { courseSlug } = await params;
  const result = await getCoursePage(courseSlug);
  if (result.status === 'redirect') permanentRedirect(result.redirectUrl);
  if (result.status !== 'ok') notFound(); // 'gone' is served as 410 by middleware before this

  const c = result.data;

  return (
    <main className="mx-auto max-w-3xl px-5 py-10 text-[var(--fg,#111)]">
      {/* Structured data */}
      {c.jsonLd.map((ld, i) => (
        <script
          key={i}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(ld) }}
        />
      ))}

      <nav aria-label="Breadcrumb" className="mb-6 text-sm text-black/50">
        <ol className="flex flex-wrap gap-1">
          {c.breadcrumbs.map((b, i) => (
            <li key={b.url} className="flex items-center gap-1">
              {i > 0 && <span aria-hidden>/</span>}
              {i < c.breadcrumbs.length - 1 ? <a href={b.url} className="hover:underline">{b.name}</a> : <span aria-current="page">{b.name}</span>}
            </li>
          ))}
        </ol>
      </nav>

      <article>
        <header className="mb-8">
          <h1 className="text-3xl font-bold leading-tight">{c.title}</h1>
          {c.subtitle && <p className="mt-2 text-lg text-black/60">{c.subtitle}</p>}
          {c.coverImageUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={c.coverImageUrl} alt={`Cover image for ${c.title}`} className="mt-5 w-full rounded-lg object-cover" />
          )}
          {c.instructor && (
            <p className="mt-4 text-sm text-black/70">
              <span className="font-medium">Instructor:</span> {c.instructor.name}
              {c.instructor.bio ? ` — ${c.instructor.bio}` : ''}
            </p>
          )}
        </header>

        {c.description && (
          <section className="prose mb-8 max-w-none">
            <h2 className="text-xl font-semibold">About this course</h2>
            <p className="mt-2 whitespace-pre-line text-black/80">{c.description}</p>
          </section>
        )}

        {c.learningOutcomes.length > 0 && (
          <section className="mb-8">
            <h2 className="text-xl font-semibold">What you’ll learn</h2>
            <ul className="mt-2 list-disc pl-5 text-black/80">
              {c.learningOutcomes.map((o, i) => <li key={i}>{o}</li>)}
            </ul>
          </section>
        )}

        <section aria-labelledby="lessons-heading">
          <h2 id="lessons-heading" className="text-xl font-semibold">
            {c.lessons.length === 1 ? 'Lesson' : `${c.lessons.length} lessons`}
          </h2>
          <ol className="mt-3 divide-y divide-black/10 border-y border-black/10">
            {c.lessons.map((l) => (
              <li key={l.slug} className="py-3">
                <Link href={l.href as Route} className="group flex items-baseline gap-3">
                  <span className="text-sm tabular-nums text-black/40">{String(l.position + 1).padStart(2, '0')}</span>
                  <span className="flex-1">
                    <span className="font-medium group-hover:underline">{l.title}</span>
                    {l.summary && <span className="mt-0.5 block text-sm text-black/55">{l.summary}</span>}
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        </section>
      </article>
    </main>
  );
}
