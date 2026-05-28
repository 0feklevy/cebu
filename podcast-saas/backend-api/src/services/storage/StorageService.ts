export interface StorageService {
  uploadFile(path: string, data: Buffer, contentType: string): Promise<string>;
  uploadStream(path: string, stream: NodeJS.ReadableStream, contentType: string): Promise<string>;
  getPresignedDownloadUrl(path: string, ttlSeconds: number): Promise<string>;
  getPresignedUploadUrl(path: string, contentType: string, ttlSeconds: number): Promise<string>;
  deleteFile(path: string): Promise<void>;
}
