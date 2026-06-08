import { revalidatePath, revalidateTag } from 'next/cache';

/**
 * On-demand revalidation webhook. The backend's PublishingInvalidationService
 * POSTs the affected { paths, tags } here whenever course/lesson data changes.
 * Centralized — pages never call revalidatePath themselves.
 */
export async function POST(req: Request) {
  const secret = process.env.REVALIDATE_SECRET;
  if (secret && req.headers.get('x-revalidate-secret') !== secret) {
    return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401 });
  }
  let body: { paths?: string[]; tags?: string[] };
  try {
    body = (await req.json()) as { paths?: string[]; tags?: string[] };
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'bad request' }), { status: 400 });
  }
  for (const p of body.paths ?? []) {
    try { revalidatePath(p); } catch { /* ignore individual failures */ }
  }
  for (const t of body.tags ?? []) {
    try { revalidateTag(t); } catch { /* ignore */ }
  }
  return Response.json({ ok: true, revalidated: { paths: body.paths?.length ?? 0, tags: body.tags?.length ?? 0 } });
}
