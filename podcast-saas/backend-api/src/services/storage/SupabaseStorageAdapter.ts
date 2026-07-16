import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  HeadObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { CompletedPart, StorageService } from './StorageService.js';
import { publicApiOrigin } from '../../config/publicOrigins.js';

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

    this.client = new S3Client({
      region,
      endpoint,
      forcePathStyle: true, // Supabase S3 requires path-style addressing
      credentials: { accessKeyId, secretAccessKey },
      // Match R2: don't embed CRC checksums (they break presigned URLs on some S3 impls).
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      // Fail fast instead of hanging (fiji's StorageService pattern). Without a socket
      // timeout, a black-holed connection through Supabase's CDN waits FOREVER — a sim
      // upload wave's Promise.all then never resolves and the sim sits at 'processing'
      // indefinitely. socketTimeout fires on socket INACTIVITY (verified in
      // @smithy/node-http-handler), so slow-but-flowing large streams are unaffected.
      requestHandler: {
        connectionTimeout: 5_000, // 5s to establish TCP
        // 15s of ZERO socket activity → fail + retry. Healthy transfers of any size
        // keep the socket busy continuously, so this only fires on truly dead
        // connections. 60s proved painfully slow in practice: a network flap mid-sim-
        // upload meant each dead socket burned the full minute × retries (~5 min of
        // "Processing…" for 44 files) before recovering.
        socketTimeout: 15_000,
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
   */
  private async withRetry<T>(op: () => Promise<T>, attempts = 4): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await op();
      } catch (err) {
        const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
        const retryable = status === undefined || status >= 500 || status === 429 || status === 408;
        if (!retryable || attempt >= attempts) throw err;
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

  async objectExists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (err as { name?: string }).name === 'NotFound') return false;
      throw err; // real error (auth/network) — don't misreport as "missing"
    }
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
