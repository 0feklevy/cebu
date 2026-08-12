import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  UploadPartCopyCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { CompletedPart, StorageService, StoredObjectHead } from './StorageService.js';
import { publicApiOrigin } from '../../config/publicOrigins.js';
import { copySourceFor, isCopyTooLarge, isCopyUnsupported, multipartCopyObject, readThenWriteCopy } from './s3Copy.js';
import { reroot } from './prefixScope.js';
import { keyFromPublicUrlAgainst } from './publicUrlKeys.js';
import { logger } from '../../lib/logger.js';

/** TCP connect budget. Establishing a socket is fast or it is broken; size does not enter into it. */
export const SUPABASE_CONNECTION_TIMEOUT_MS = 5_000;

/** Socket-INACTIVITY allowance for an ordinary request. See the constructor for why it is this low. */
export const SUPABASE_SOCKET_TIMEOUT_MS = 15_000;

/**
 * Socket-inactivity allowance for a SERVER-SIDE COPY (`CopyObject`, `UploadPartCopy`).
 *
 * These two are the only commands whose response time is a function of the object's SIZE while the
 * socket carries nothing at all: the gateway copies the bytes internally and answers when it is
 * done. Fifteen seconds is right for a request that should answer immediately and wrong for one
 * that is moving gigabytes, so the two get different clients. Five minutes is roughly three times
 * the worst realistic case (a 5 GiB single copy, or a 256 MiB part) and is still a bound — a
 * genuinely dead socket on the copy path costs minutes, not forever.
 */
export const SUPABASE_COPY_SOCKET_TIMEOUT_MS = 5 * 60_000;

/**
 * Supabase Storage adapter — uses Supabase's **S3-compatible** endpoint, so it reuses
 * the same AWS SDK + presigned-URL machinery as R2 (no new dependency). HTTPS-only,
 * which fits hosts that only allow outbound 80/443.
 *
 * Required env (see .env.example):
 *   SUPABASE_URL                   e.g. https://<project-ref>.supabase.co
 *   SUPABASE_S3_ACCESS_KEY_ID      from Supabase → Storage → S3 access keys
 *   SUPABASE_S3_SECRET_ACCESS_KEY  "
 *   SUPABASE_S3_REGION             the project region shown in that panel (e.g. us-east-1)
 *   SUPABASE_STORAGE_BUCKET        the bucket name (created in the dashboard)
 * Optional: SUPABASE_S3_ENDPOINT (defaults to `${SUPABASE_URL}/storage/v1/s3`).
 */
export class SupabaseStorageAdapter implements StorageService {
  private readonly client: S3Client;
  /**
   * A second client, identical but for its socket timeout, used ONLY for server-side copies.
   *
   * See `SUPABASE_COPY_SOCKET_TIMEOUT_MS`. A per-request override is not available — the AWS SDK
   * resolves `socketTimeout` once, from the client's `requestHandler` — so the allowance has to be
   * carried by a second client rather than by the two commands that need it.
   */
  private readonly copyClient: S3Client;
  private readonly bucket: string;
  private readonly publicBase: string;

  constructor() {
    // Derive the clean project origin (https://<ref>.supabase.co), tolerating a
    // SUPABASE_URL that includes a path like /rest/v1 or a trailing slash.
    const rawUrl = (process.env.SUPABASE_URL ?? '').trim();
    let origin = '';
    if (rawUrl) {
      try { origin = new URL(rawUrl).origin; } catch { origin = rawUrl.replace(/\/+$/, ''); }
    }
    const endpoint = process.env.SUPABASE_S3_ENDPOINT ?? (origin ? `${origin}/storage/v1/s3` : '');
    const accessKeyId = process.env.SUPABASE_S3_ACCESS_KEY_ID;
    const secretAccessKey = process.env.SUPABASE_S3_SECRET_ACCESS_KEY;
    const region = process.env.SUPABASE_S3_REGION ?? 'us-east-1';

    if (!endpoint || !accessKeyId || !secretAccessKey) {
      throw new Error(
        'Supabase Storage is not configured. Set SUPABASE_URL (or SUPABASE_S3_ENDPOINT), ' +
          'SUPABASE_S3_ACCESS_KEY_ID, SUPABASE_S3_SECRET_ACCESS_KEY, SUPABASE_S3_REGION, ' +
          'and SUPABASE_STORAGE_BUCKET.',
      );
    }

    this.bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'media';
    // Public object URL base (works for objects in a public bucket / with public policy).
    this.publicBase = origin ? `${origin}/storage/v1/object/public/${this.bucket}` : '';

    const shared = {
      region,
      endpoint,
      forcePathStyle: true, // Supabase S3 requires path-style addressing
      credentials: { accessKeyId, secretAccessKey },
      // Match R2: don't embed CRC checksums (they break presigned URLs on some S3 impls).
      requestChecksumCalculation: 'WHEN_REQUIRED' as const,
      responseChecksumValidation: 'WHEN_REQUIRED' as const,
    };

    this.client = new S3Client({
      ...shared,
      // Fail fast instead of hanging (fiji's StorageService pattern). Without a socket
      // timeout, a black-holed connection through Supabase's CDN waits FOREVER — a sim
      // upload wave's Promise.all then never resolves and the sim sits at 'processing'
      // indefinitely. socketTimeout fires on socket INACTIVITY (verified in
      // @smithy/node-http-handler), so slow-but-flowing large streams are unaffected.
      requestHandler: {
        connectionTimeout: SUPABASE_CONNECTION_TIMEOUT_MS,
        // 15s of ZERO socket activity → fail + retry. Healthy transfers of any size
        // keep the socket busy continuously, so this only fires on truly dead
        // connections. 60s proved painfully slow in practice: a network flap mid-sim-
        // upload meant each dead socket burned the full minute × retries (~5 min of
        // "Processing…" for 44 files) before recovering.
        socketTimeout: SUPABASE_SOCKET_TIMEOUT_MS,
      },
    });

    // "Slow-but-flowing large streams are unaffected" is true of an UPLOAD and false of a
    // SERVER-SIDE COPY — the one shape where nothing flows precisely because the transfer is large.
    // The client sends a bodyless request and waits; every byte moves INSIDE the store, so the
    // socket is idle for as long as the copy takes and the 15s inactivity timer, sized for a small
    // request, destroys a copy that was working. Worse than slow: the `TimeoutError` it raises is
    // neither "unsupported" nor "too large", so `copyObject` rethrows it and the duplication dies
    // with "you can try again" — after the copy has, quite possibly, already completed server-side.
    this.copyClient = new S3Client({
      ...shared,
      requestHandler: {
        connectionTimeout: SUPABASE_CONNECTION_TIMEOUT_MS,
        socketTimeout: SUPABASE_COPY_SOCKET_TIMEOUT_MS,
      },
    });
  }

  /**
   * Send an S3 command, retrying transient failures with backoff.
   *
   * Supabase's S3 gateway sits behind Cloudflare; sustained bursts occasionally get a
   * transient 5xx (e.g. 522) whose HTML error page ALSO breaks the SDK's XML response
   * parser — the SDK then surfaces a deserialization error after attempts:1 and its own
   * retry policy never engages. Retry here on the response's real status (kept in
   * err.$metadata), on 429/408, and on transport errors with no status at all (resets,
   * socket timeouts). Used only for idempotent commands whose bodies are re-sendable
   * (Buffers) — never streams.
   *
   * @param isFinal answers "this status is the gateway's SETTLED ANSWER, not a hiccup". Needed
   *                because the status classes above are heuristics about the transport, and one of
   *                them is wrong for a specific command: a `501 NotImplemented` is a 5xx, so it
   *                looks transient, while it is in fact a permanent statement about the endpoint.
   */
  private async withRetry<T>(op: () => Promise<T>, isFinal?: (err: unknown) => boolean, attempts = 4): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await op();
      } catch (err) {
        const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
        const transient = status === undefined || status >= 500 || status === 429 || status === 408;
        if (!transient || isFinal?.(err) || attempt >= attempts) throw err;
        await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1) + Math.random() * 250));
      }
    }
  }

  async uploadFile(path: string, data: Buffer, contentType: string, cacheControl?: string): Promise<string> {
    await this.withRetry(() =>
      this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: path,
          Body: data,
          ContentType: contentType,
          // Served verbatim by the public endpoint; without it Supabase serves `no-cache`.
          CacheControl: cacheControl,
        }),
      ),
    );
    return `${this.publicBase}/${path}`;
  }

  async uploadStream(
    path: string,
    stream: NodeJS.ReadableStream,
    contentType: string,
    contentLength?: number,
  ): Promise<string> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: path,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Body: stream as any,
        ContentType: contentType,
        ContentLength: contentLength,
      }),
    );
    return `${this.publicBase}/${path}`;
  }

  async getPresignedDownloadUrl(path: string, ttlSeconds: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: path }), {
      expiresIn: ttlSeconds,
    });
  }

  async getPresignedUploadUrl(path: string, contentType: string, ttlSeconds: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: path, ContentType: contentType }),
      { expiresIn: ttlSeconds },
    );
  }

  // ── S3 multipart upload (large files beyond a single PUT) ───────────────────────
  // Supabase Storage's S3 endpoint supports multipart. The per-part size cap is the
  // S3 minimum (5 MiB except the last part); the OVERALL object size is still bounded
  // by the bucket's file_size_limit, so raise that in the dashboard for big videos.
  async createMultipartUpload(path: string, contentType: string): Promise<string> {
    const resp = await this.withRetry(() =>
      this.client.send(
        new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: path, ContentType: contentType }),
      ),
    );
    if (!resp.UploadId) throw new Error('Supabase did not return an UploadId for the multipart upload');
    return resp.UploadId;
  }

  async getPresignedUploadPartUrl(
    path: string,
    uploadId: string,
    partNumber: number,
    ttlSeconds: number,
  ): Promise<string> {
    // No ContentType on a part PUT — the browser sends the raw chunk and shouldn't have
    // to set a matching header (parts are stitched into the object created above).
    return getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: path,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: ttlSeconds },
    );
  }

  async completeMultipartUpload(path: string, uploadId: string, parts: CompletedPart[]): Promise<string> {
    await this.withRetry(() =>
      this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: path,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts
              .slice()
              .sort((a, b) => a.partNumber - b.partNumber)
              .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
          },
        }),
      ),
    );
    return `${this.publicBase}/${path}`;
  }

  async abortMultipartUpload(path: string, uploadId: string): Promise<void> {
    await this.withRetry(() =>
      this.client.send(
        new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: path, UploadId: uploadId }),
      ),
    );
  }

  async deleteFile(path: string): Promise<void> {
    await this.withRetry(() =>
      this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: path })),
    );
  }

  async deleteWithPrefix(prefix: string): Promise<void> {
    let continuationToken: string | undefined;
    do {
      const list = await this.withRetry(() =>
        this.client.send(
          new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: continuationToken }),
        ),
      );
      if (list.Contents && list.Contents.length > 0) {
        const objects = list.Contents.map((o) => ({ Key: o.Key! }));
        await this.withRetry(() =>
          this.client.send(
            new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: objects } }),
          ),
        );
      }
      continuationToken = list.NextContinuationToken;
    } while (continuationToken);
  }

  /**
   * Server-side copy where the gateway supports it, read-then-write where it does not.
   *
   * Supabase's S3 gateway implements a subset of the protocol and `CopyObject` is not guaranteed
   * to be in it — so unlike R2 the fallback here is an EXPECTED path, not a curiosity. It is
   * routed through `withRetry` for the same reason `deleteWithPrefix` is: `CopyObject` is
   * idempotent and carries no body, which is exactly the class of command that helper is for.
   *
   * Sent on `copyClient`, whose socket-inactivity allowance is sized for a copy rather than for a
   * request that answers at once — see `SUPABASE_COPY_SOCKET_TIMEOUT_MS`.
   *
   * The two ANSWERS below — unsupported, and over the ceiling — are excluded from the retry. Both
   * arrive as statuses `withRetry` would otherwise re-send (`501` is a 5xx), and both are settled
   * facts about the endpoint that four attempts cannot change. On the gateway where the unsupported
   * branch is the EXPECTED one, retrying it charged every object of every duplication 3.5s of
   * backoff before taking the fallback it was always going to take: over ten minutes of pure
   * waiting for the few hundred objects an ordinary project holds, inline in the API process.
   */
  async copyObject(srcKey: string, destKey: string): Promise<void> {
    try {
      await this.withRetry(
        () =>
          this.copyClient.send(
            new CopyObjectCommand({
              Bucket: this.bucket,
              Key: destKey,
              CopySource: copySourceFor(this.bucket, srcKey),
            }),
          ),
        (err) => isCopyUnsupported(err) || isCopyTooLarge(err),
      );
    } catch (err) {
      // Same distinction R2 draws, and the same remedy: over the single-part ceiling is a permanent
      // 400 that a ranged multipart copy CAN get past, while read-then-write would pull >5 GiB
      // through the heap. The two fallbacks answer different failures and must never swap.
      // Reactive, so the HEAD it needs is paid for once here rather than on every segment copy.
      if (isCopyTooLarge(err)) {
        await this.multipartCopy(srcKey, destKey, err);
        return;
      }
      if (!isCopyUnsupported(err)) throw err;
      logger.warn({ err, srcKey }, 'Supabase: server-side copy unsupported — falling back to read+write');
      // BOUNDED, and this is the adapter where it matters most: the comment above calls the
      // unsupported branch an EXPECTED path, so on this gateway EVERY object of every duplication
      // takes it — including a 10 GB video master, inline in the API process.
      await readThenWriteCopy(srcKey, destKey, 'Supabase', {
        head: () => this.headObject(srcKey),
        read: () => this.readObject(srcKey),
        write: (bytes, contentType, cacheControl) => this.uploadFile(destKey, bytes, contentType, cacheControl),
      });
    }
  }

  /**
   * `CopyObject` past the 5 GiB wall: create → N × `UploadPartCopy` → complete, aborting on failure.
   *
   * The ranges, the ordering and the abort discipline are `multipartCopyObject`'s, so this adapter
   * and R2 cannot drift apart on them; only the dispatch differs, and here it goes through
   * `withRetry` — a part copy is idempotent and carries no body, exactly the class that helper
   * exists for, and this gateway's transient 5xx would otherwise fail a copy that is minutes in.
   * `CreateMultipartUpload` is issued directly rather than through this class's own
   * `createMultipartUpload` because that one cannot carry the source's Cache-Control.
   */
  private async multipartCopy(srcKey: string, destKey: string, cause: unknown): Promise<void> {
    const CopySource = copySourceFor(this.bucket, srcKey);
    await multipartCopyObject(srcKey, destKey, {
      head: () => this.headObject(srcKey),
      create: async (meta) => {
        const resp = await this.withRetry(() =>
          this.client.send(
            new CreateMultipartUploadCommand({
              Bucket: this.bucket,
              Key: destKey,
              ContentType: meta.contentType ?? undefined,
              CacheControl: meta.cacheControl ?? undefined,
            }),
          ),
        );
        if (!resp.UploadId) throw new Error('Supabase did not return an UploadId for the multipart copy');
        return resp.UploadId;
      },
      copyPart: async (uploadId, part) => {
        // `copyClient` again, and here it is not marginal: one part is up to 256 MiB of server-side
        // copying behind a socket that carries nothing while it happens.
        const resp = await this.withRetry(() =>
          this.copyClient.send(
            new UploadPartCopyCommand({
              Bucket: this.bucket,
              Key: destKey,
              UploadId: uploadId,
              PartNumber: part.partNumber,
              CopySource,
              CopySourceRange: part.range,
            }),
          ),
        );
        const etag = resp.CopyPartResult?.ETag;
        if (!etag) throw new Error(`Supabase did not return an ETag for part ${part.partNumber} of ${destKey}`);
        return etag;
      },
      complete: async (uploadId, parts) => { await this.completeMultipartUpload(destKey, uploadId, parts); },
      abort: (uploadId) => this.abortMultipartUpload(destKey, uploadId),
    }, cause);
  }

  async copyPrefix(srcPrefix: string, destPrefix: string): Promise<number> {
    let continuationToken: string | undefined;
    let copied = 0;
    do {
      const list = await this.withRetry(() =>
        this.client.send(
          new ListObjectsV2Command({ Bucket: this.bucket, Prefix: srcPrefix, ContinuationToken: continuationToken }),
        ),
      );
      for (const obj of list.Contents ?? []) {
        if (!obj.Key) continue;
        const dest = reroot(obj.Key, srcPrefix, destPrefix);
        if (dest === null) continue;
        await this.copyObject(obj.Key, dest);
        copied += 1;
      }
      continuationToken = list.NextContinuationToken;
    } while (continuationToken);
    return copied;
  }

  getPublicUrl(path: string): string {
    return `${this.publicBase}/${path}`;
  }

  getSimPublicUrl(path: string): string {
    // Supabase's public-bucket endpoint force-downgrades text/html → text/plain
    // (an anti-phishing measure; rendering HTML from a public bucket needs Pro + a
    // custom domain). An iframe pointed straight at the bucket URL therefore shows
    // the raw `<!DOCTYPE html>…` source. Serve sim files through the backend's
    // /sim-public/* proxy instead, which reads the object and re-asserts the correct
    // Content-Type (mirrors LocalStorageAdapter). BACKEND_API_URL must be the
    // backend's public origin in production.
    return `${publicApiOrigin()}/sim-public/${path}`;
  }

  /**
   * The inverse of the two shapes above. See `publicUrlKeys.ts`.
   *
   * THIS ADAPTER IS THE REASON THE METHOD EXISTS. `{origin}/storage/v1/object/public/{bucket}/{key}`
   * looks nothing like the dev-route shapes a host-stripping heuristic knows about, so the heuristic
   * recovered `storage/v1/object/public/{bucket}/{key}` and every caller went on to copy, delete or
   * re-root an object that does not exist.
   */
  keyFromPublicUrl(url: string | null | undefined): string | null {
    return keyFromPublicUrlAgainst(url, [
      this.publicBase,
      `${publicApiOrigin().replace(/\/+$/, '')}/sim-public`,
    ]);
  }

  /**
   * Is this the store ANSWERING "no such object", rather than failing to answer?
   *
   * The distinction is the whole reason the 404 test lives inside the retried closure below: an
   * answer is final, a failure is worth another attempt.
   */
  private static isMissing(err: unknown): boolean {
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    return status === 404 || (err as { name?: string })?.name === 'NotFound';
  }

  /**
   * RETRIED, like every other idempotent bodyless command on this gateway.
   *
   * These were the last two that were not, and they are the ones a duplication leans on hardest:
   * `ProjectDuplicationService.verifyBytes` issues one PER COPIED OBJECT — 50 to 300 back-to-back —
   * immediately after a multi-minute copy wave, which is exactly when this Cloudflare-fronted
   * gateway serves the transient 5xx `withRetry` was written for. One of them anywhere in that
   * burst failed the entire duplication, after every byte had already been copied.
   *
   * The 404 absorption stays INSIDE the closure on purpose: a genuine miss is an answer, so it
   * returns false at once instead of spending three more attempts re-asking a settled question.
   */
  async objectExists(key: string): Promise<boolean> {
    return this.withRetry(async () => {
      try {
        await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
        return true;
      } catch (err) {
        if (SupabaseStorageAdapter.isMissing(err)) return false;
        throw err; // real error (auth/network) — don't misreport as "missing"
      }
    });
  }

  /** Retried, and absent-means-absent, for the reasons on `objectExists`. */
  async headObject(key: string): Promise<StoredObjectHead | null> {
    return this.withRetry(async () => {
      try {
        const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
        // Each field is reported as null when absent rather than defaulted. A caller verifying a
        // published revision must be able to distinguish "the store says text/plain" from "the store
        // did not say" — defaulting here would turn the second into a false mismatch or a false pass.
        return {
          contentType: r.ContentType ?? null,
          cacheControl: r.CacheControl ?? null,
          size: typeof r.ContentLength === 'number' ? r.ContentLength : null,
          etag: r.ETag ?? null,
        };
      } catch (err) {
        if (SupabaseStorageAdapter.isMissing(err)) return null;
        throw err; // real error (auth/network) — don't misreport as "missing"
      }
    });
  }

  async readObject(key: string): Promise<Buffer> {
    // Retry covers the whole read (send + body collection): GetObject is idempotent, and
    // a mid-body connection reset should re-read from scratch rather than fail the caller.
    return this.withRetry(async () => {
      const resp = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const stream = resp.Body as NodeJS.ReadableStream;
      return new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
      });
    });
  }

  async listObjects(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const list = await this.withRetry(() =>
        this.client.send(
          new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: continuationToken }),
        ),
      );
      for (const obj of list.Contents ?? []) if (obj.Key) keys.push(obj.Key);
      continuationToken = list.NextContinuationToken;
    } while (continuationToken);
    return keys;
  }
}
