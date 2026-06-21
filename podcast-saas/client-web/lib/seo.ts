/**
 * SEO mapping helpers for the public /c/ routes. The backend resolves effective
 * SEO; these just adapt it to Next's Metadata and safely serialize JSON-LD.
 */
import type { Metadata } from 'next';
import type { EffectiveSeo } from 'shared/src/types/course-view';

/**
 * Escape so stored text can never break out of a <script type="application/ld+json">
 * element. Escaping '<' is sufficient to neutralize "</script>" and "<!--".
 */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

export function seoToMetadata(seo: EffectiveSeo, opts: { ogType?: 'website' | 'video.other' } = {}): Metadata {
  return {
    title: seo.title,
    description: seo.description,
    ...(seo.keywords ? { keywords: seo.keywords } : {}),
    alternates: { canonical: seo.canonicalUrl },
    openGraph: {
      title: seo.ogTitle,
      description: seo.ogDescription,
      url: seo.canonicalUrl,
      images: seo.ogImageUrl ? [{ url: seo.ogImageUrl }] : undefined,
      type: opts.ogType ?? 'website',
      locale: seo.language,
    },
    twitter: {
      card: 'summary_large_image',
      title: seo.ogTitle,
      description: seo.ogDescription,
      images: seo.ogImageUrl ? [seo.ogImageUrl] : undefined,
    },
    robots: seo.indexable
      ? { index: true, follow: true }
      : { index: false, follow: false, googleBot: { index: false, follow: false } },
  };
}
