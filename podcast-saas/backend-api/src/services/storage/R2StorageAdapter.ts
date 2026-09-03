import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutBucketCorsCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  UploadPartCopyCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';

import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { listOpenMultipartUploads } from './listMultipartUploads.js';
import type { CompletedPart, MultipartUploadInfo, StorageService, StoredObjectHead } from './StorageService.js';
import { publicApiOrigin } from '../../config/publicOrigins.js';
import { mediaKeyScope, mintMediaToken } from './mediaToken.js';
import { copySourceFor, isCopyTooLarge, isCopyUnsupported, multipartCopyObject, readThenWriteCopy } from './s3Copy.js';
import { reroot } from './prefixScope.js';
import { keyFromPublicUrlAgainst } from './publicUrlKeys.js';
import { logger } from '../../lib/logger.js';

export class R2StorageAdapter implements StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicUrl: string;
  private readonly legacyPublicUrl: string;

  constructor() {
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

    if (!accountId || !accessKeyId || !secretAccessKey) {
      throw new Error(
        'R2 storage is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY in your .env file.',
      );
    }

    this.bucket = process.env.R2_BUCKET_NAME ?? 'podcast-saas';
    // A custom domain in front of the bucket (CDN-cached, zero egress) is the public base when
    // set; the r2.dev URL stays recognised for rows written before the domain existed.
    this.legacyPublicUrl = (process.env.R2_PUBLIC_URL ?? '').replace(/\/+$/, '');
    this.publicUrl = (process.env.R2_PUBLIC_BASE_URL ?? '').replace(/\/+$/, '') || this.legacyPublicUrl;

    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
      // Disable automatic CRC32 checksums — R2 rejects presigned URLs that include them
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async uploadFile(path: string, data: Buffer, contentType: string, cacheControl?: string): Promise<string> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: path,
        Body: data,
        ContentType: contentType,
        CacheControl: cacheControl,
      }),
    );
    return `${this.publicUrl}/${path}`;
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
    return `${this.publicUrl}/${path}`;
  }

  async getPresignedDownloadUrl(path: string, _ttlSeconds: number): Promise<string> {
    // Route through backend proxy so CORS headers are guaranteed for browser playback.
    // Server-side callers (ffmpeg, ingestion) also work fine against localhost.
    // The scoped media token authorizes private projects' media (security-002).
    const backendUrl = publicApiOrigin();
    const scope = mediaKeyScope(path);
    if (scope) return `${backendUrl}/video-proxy/t/${mintMediaToken(scope)}/${path}`;
    return `${backendUrl}/video-proxy/${path}`;
  }

  async streamObject(key: string, rangeHeader?: string): Promise<{
    body: NodeJS.ReadableStream;
    contentType: string;
    contentLength?: number;
    statusCode: number;
    contentRange?: string;
    acceptRanges: string;
  }> {
    const cmd = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(rangeHeader ? { Range: rangeHeader } : {}),
    });
    const resp = await this.client.send(cmd);
    const ext = key.split('.').pop()?.toLowerCase() ?? 'mp4';
    const contentType =
      ext === 'webm' ? 'video/webm' :
      ext === 'mov'  ? 'video/quicktime' :
      ext === 'm4v'  ? 'video/mp4' : 'video/mp4';
    return {
      body: resp.Body as NodeJS.ReadableStream,
      contentType,
      contentLength: resp.ContentLength,
      statusCode: rangeHeader ? 206 : 200,
      contentRange: resp.ContentRange,
      acceptRanges: resp.AcceptRanges ?? 'bytes',
    };
  }

  async getPresignedUploadUrl(path: string, contentType: string, ttlSeconds: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: path, ContentType: contentType }),
      { expiresIn: ttlSeconds },
    );
  }

  // ── S3 multipart upload (large files) — R2 is S3-compatible, so the same flow works. ──
  async createMultipartUpload(path: string, contentType: string): Promise<string> {
    const resp = await this.client.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: path, ContentType: contentType }),
    );
    if (!resp.UploadId) throw new Error('R2 did not return an UploadId for the multipart upload');
    return resp.UploadId;
  }

  async getPresignedUploadPartUrl(
    path: string,
    uploadId: string,
    partNumber: number,
    ttlSeconds: number,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new UploadPartCommand({ Bucket: this.bucket, Key: path, UploadId: uploadId, PartNumber: partNumber }),
      { expiresIn: ttlSeconds },
    );
  }

  async completeMultipartUpload(path: string, uploadId: string, parts: CompletedPart[]): Promise<string> {
    await this.client.send(
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
    );
    return `${this.publicUrl}/${path}`;
  }

  async abortMultipartUpload(path: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: path, UploadId: uploadId }),
    );
  }

  async listMultipartUploads(prefix?: string): Promise<MultipartUploadInfo[]> {
    return listOpenMultipartUploads((cmd) => this.client.send(cmd), this.bucket, prefix);
  }

  async deleteFile(path: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: path }),
    );
  }

  async deleteWithPrefix(prefix: string): Promise<void> {
    let continuationToken: string | undefined;
    do {
      const list = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      if (list.Contents && list.Contents.length > 0) {
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: list.Contents.map((o) => ({ Key: o.Key! })) },
          }),
        );
      }
      continuationToken = list.NextContinuationToken;
    } while (continuationToken);
  }

  /**
   * Server-side copy. `MetadataDirective` is left at its default (`COPY`), so the destination
   * inherits the source's Content-Type AND Cache-Control — which is load-bearing here: a copied
   * HLS run tree or simulation revision that lost `max-age=31536000, immutable` would be correct
   * but would quietly revalidate every segment for the life of the copy.
   */
  async copyObject(srcKey: string, destKey: string): Promise<void> {
    try {
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          Key: destKey,
          CopySource: copySourceFor(this.bucket, srcKey),
        }),
      );
    } catch (err) {
      // Too big for a single-part copy is NOT "unsupported", and the two paths must never meet: the
      // read-then-write fallback would drag >5 GiB through the Node heap. Re-issue it as a ranged
      // multipart copy instead, which keeps the bytes inside R2 and has no 5 GiB wall.
      //
      // REACTIVE, by design. Asking HEAD first would add a round trip to every one of the hundreds
      // of HLS segments a `copyPrefix` walks, all of them orders of magnitude below the ceiling, to
      // learn something only this branch needs. The HEAD lives inside the fallback.
      if (isCopyTooLarge(err)) {
        await this.multipartCopy(srcKey, destKey, err);
        return;
      }
      if (!isCopyUnsupported(err)) throw err;
      logger.warn({ err, srcKey }, 'R2: server-side copy unsupported — falling back to read+write');
      // BOUNDED. `isCopyUnsupported` says nothing about size, so without the guard inside this
      // helper an arbitrarily large object travels through the heap of the API process.
      await readThenWriteCopy(srcKey, destKey, 'R2', {
        head: () => this.headObject(srcKey),
        read: () => this.readObject(srcKey),
        write: (bytes, contentType, cacheControl) => this.uploadFile(destKey, bytes, contentType, cacheControl),
      });
    }
  }

  /**
   * `CopyObject` past the 5 GiB wall: create → N × `UploadPartCopy` → complete, aborting on failure.
   *
   * Only the dispatch is here; the ranges, the ordering and the abort discipline are
   * `multipartCopyObject`'s, so R2 and Supabase cannot drift apart on them. `CreateMultipartUpload`
   * is issued directly rather than through this class's own `createMultipartUpload` because that
   * one carries no Cache-Control — and a copy that dropped `immutable` would be a silently
   * different object.
   */
  private async multipartCopy(srcKey: string, destKey: string, cause: unknown): Promise<void> {
    const CopySource = copySourceFor(this.bucket, srcKey);
    await multipartCopyObject(srcKey, destKey, {
      head: () => this.headObject(srcKey),
      create: async (meta) => {
        const resp = await this.client.send(
          new CreateMultipartUploadCommand({
            Bucket: this.bucket,
            Key: destKey,
            ContentType: meta.contentType ?? undefined,
            CacheControl: meta.cacheControl ?? undefined,
          }),
        );
        if (!resp.UploadId) throw new Error('R2 did not return an UploadId for the multipart copy');
        return resp.UploadId;
      },
      copyPart: async (uploadId, part) => {
        const resp = await this.client.send(
          new UploadPartCopyCommand({
            Bucket: this.bucket,
            Key: destKey,
            UploadId: uploadId,
            PartNumber: part.partNumber,
            CopySource,
            CopySourceRange: part.range,
          }),
        );
        const etag = resp.CopyPartResult?.ETag;
        if (!etag) throw new Error(`R2 did not return an ETag for part ${part.partNumber} of ${destKey}`);
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
      const list = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: srcPrefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const obj of list.Contents ?? []) {
        if (!obj.Key) continue;
        // ListObjectsV2 matches by raw string, which is wider than what copyPrefix promises.
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
    // Route HLS through the backend proxy so CORS headers are guaranteed regardless
    // of whether Cloudflare's pub-*.r2.dev CDN respects PutBucketCorsCommand rules.
    // Token in the PATH so relative segment URLs inherit it (security-002).
    const backendUrl = publicApiOrigin();
    const scope = path.startsWith('hls/') ? mediaKeyScope(path) : null;
    if (scope) return `${backendUrl}/hls-proxy/t/${mintMediaToken(scope)}/${path}`;
    return `${backendUrl}/hls-proxy/${path}`;
  }

  getSimPublicUrl(path: string): string {
    // Simulation static files are served directly from R2 public URL (no proxy needed —
    // they load via iframe which uses allow-same-origin, and postMessage works cross-origin).
    return `${this.publicUrl}/${path}`;
  }

  /** The inverse of the two shapes above. See `publicUrlKeys.ts`. */
  keyFromPublicUrl(url: string | null | undefined): string | null {
    return keyFromPublicUrlAgainst(url, [
      `${publicApiOrigin().replace(/\/+$/, '')}/hls-proxy`,
      this.publicUrl,
      this.legacyPublicUrl,
    ]);
  }

  async objectExists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (err as { name?: string }).name === 'NotFound') return false;
      throw err;
    }
  }

  async headObject(key: string): Promise<StoredObjectHead | null> {
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
        lastModified: r.LastModified instanceof Date ? r.LastModified.toISOString() : null,
      };
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (err as { name?: string }).name === 'NotFound') return null;
      throw err; // real error (auth/network) — don't misreport as "missing"
    }
  }

  async readObject(key: string): Promise<Buffer> {
    const resp = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const stream = resp.Body as NodeJS.ReadableStream;
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }

  async listObjects(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const list = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const obj of list.Contents ?? []) {
        if (obj.Key) keys.push(obj.Key);
      }
      continuationToken = list.NextContinuationToken;
    } while (continuationToken);
    return keys;
  }

  async ensureBucketCors(allowedOrigins: string[]): Promise<void> {
    try {
      await this.client.send(
        new PutBucketCorsCommand({
          Bucket: this.bucket,
          CORSConfiguration: {
            CORSRules: [
              {
                // PUT uploads — locked to known app origins
                AllowedOrigins: allowedOrigins,
                AllowedMethods: ['PUT'],
                AllowedHeaders: ['*'],
                MaxAgeSeconds: 3600,
              },
              {
                // GET/HEAD for HLS segments & manifests — must be '*' so any viewer
                // domain (including localhost during dev) can load them without auth.
                AllowedOrigins: ['*'],
                AllowedMethods: ['GET', 'HEAD'],
                AllowedHeaders: ['*'],
                MaxAgeSeconds: 86400,
              },
            ],
          },
        }),
      );
      logger.info({ allowedOrigins }, '[r2] CORS configured (PUT restricted to these origins; GET/HEAD open)');
      logger.info('R2 bucket CORS configured');
    } catch (err) {
      logger.error({ err: (err as Error).message?.slice(0, 200) }, '[r2] CORS setup failed');
      logger.warn({ err }, 'R2 CORS setup failed — configure manually in Cloudflare dashboard');
    }
  }
}
