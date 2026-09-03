/**
 * ListMultipartUploads, paginated, for both S3-compatible adapters (R2 and Supabase Storage).
 * The bucket answers a page at a time with a key marker and an upload-id marker; this walks them
 * all. Nothing here aborts anything — the multipart sweeper decides that, by age.
 */
import { ListMultipartUploadsCommand } from '@aws-sdk/client-s3';
import type { MultipartUploadInfo } from './StorageService.js';

type Send = (cmd: ListMultipartUploadsCommand) => Promise<{
  Uploads?: Array<{ Key?: string; UploadId?: string; Initiated?: Date }>;
  IsTruncated?: boolean;
  NextKeyMarker?: string;
  NextUploadIdMarker?: string;
}>;

export async function listOpenMultipartUploads(send: Send, bucket: string, prefix?: string): Promise<MultipartUploadInfo[]> {
  const out: MultipartUploadInfo[] = [];
  let keyMarker: string | undefined;
  let uploadIdMarker: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const res = await send(new ListMultipartUploadsCommand({
      Bucket: bucket, Prefix: prefix, KeyMarker: keyMarker, UploadIdMarker: uploadIdMarker,
    }));
    for (const u of res.Uploads ?? []) {
      if (!u.Key || !u.UploadId) continue;
      out.push({ key: u.Key, uploadId: u.UploadId, initiated: u.Initiated instanceof Date ? u.Initiated.toISOString() : null });
    }
    if (!res.IsTruncated) break;
    keyMarker = res.NextKeyMarker;
    uploadIdMarker = res.NextUploadIdMarker;
    if (!keyMarker && !uploadIdMarker) break;
  }
  return out;
}
