import { SharedViewerPage } from '@/components/viewer/SharedViewerPage';

/**
 * The language codes this product dubs into — mirrors the backend's DUBBING_LANGUAGES.
 *
 * Validated here rather than passed through so an arbitrary `?lang=` value cannot reach the
 * config request. The server would reject it anyway, but a closed list keeps the URL honest: an
 * unrecognised language plays the original, which is what the viewer gets either way.
 */
const DUB_LANGUAGES = new Set(['en', 'es', 'he']);

/**
 * Public, no auth — the shareable video link.
 *
 * The language rides as `?lang=` here rather than as a path suffix, because this route's path IS
 * the random token; `/v/{token}/he` would read as a second token. Permalinks, whose paths are
 * creator-chosen words, get the `/{slug}/{lang}` form the product asked for.
 */
export default async function SharedVideoRoute({
  params,
  searchParams,
}: {
  params: Promise<{ shareToken: string }>;
  searchParams: Promise<{ lang?: string }>;
}) {
  const { shareToken } = await params;
  const { lang } = await searchParams;
  const language = lang && DUB_LANGUAGES.has(lang) ? lang : undefined;
  return (
    <div className="h-dvh w-screen overflow-hidden bg-black">
      <SharedViewerPage shareToken={shareToken} language={language} />
    </div>
  );
}
