import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  PutBucketCorsCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';

import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { CompletedPart, StorageService } from './StorageService.js';
import { logger } from '../../lib/logger.js';

export class R2StorageAdapter implements StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicUrl: string;

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
    this.publicUrl = process.env.R2_PUBLIC_URL ?? '';

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
    const backendUrl = process.env.BACKEND_API_URL ?? 'http://localhost:8080';
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

  getPublicUrl(path: string): string {
    // Route HLS through the backend proxy so CORS headers are guaranteed regardless
    // of whether Cloudflare's pub-*.r2.dev CDN respects PutBucketCorsCommand rules.
    const backendUrl = process.env.BACKEND_API_URL ?? 'http://localhost:8080';
    return `${backendUrl}/hls-proxy/${path}`;
  }

  getSimPublicUrl(path: string): string {
    // Simulation static files are served directly from R2 public URL (no proxy needed —
    // they load via iframe which uses allow-same-origin, and postMessage works cross-origin).
    return `${this.publicUrl}/${path}`;
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
      console.log(`[R2] CORS configured — PUT: ${allowedOrigins.join(', ')} | GET/HEAD: *`);
      logger.info('R2 bucket CORS configured');
    } catch (err) {
      console.error('[R2] CORS setup failed:', err);
      logger.warn({ err }, 'R2 CORS setup failed — configure manually in Cloudflare dashboard');
    }
  }
}
