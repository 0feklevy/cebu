/**
 * Test helper: a fake `send` on every S3 client an adapter owns.
 *
 * The commands handed to it are the REAL command objects, so an assertion about `CopySourceRange`
 * or `CopySource` is an assertion about what would go on the wire — a hand-rolled S3 double could
 * not tell a `CopySourceRange` from a `Range`.
 *
 * EVERY client, not just the first: the Supabase adapter carries a second one for server-side
 * copies (it needs a socket-inactivity allowance sized for a copy rather than for a request that
 * answers at once), and a harness that stubbed only `client` would let real `CopyObject`s escape to
 * the network. Each call records WHICH client it went through, so "the copy went out on the copy
 * client" is a thing a test can state.
 *
 * Not a *.test.ts file, so vitest does not collect it as a suite.
 */

import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CopyObjectCommand,
  CreateMultipartUploadCommand, DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand,
  HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, UploadPartCopyCommand,
} from '@aws-sdk/client-s3';


const KINDS: Array<[string, unknown]> = [
  ['CopyObject', CopyObjectCommand], ['HeadObject', HeadObjectCommand],
  ['GetObject', GetObjectCommand], ['PutObject', PutObjectCommand],
  ['DeleteObject', DeleteObjectCommand], ['DeleteObjects', DeleteObjectsCommand],
  ['ListObjectsV2', ListObjectsV2Command],
  ['CreateMultipartUpload', CreateMultipartUploadCommand], ['UploadPartCopy', UploadPartCopyCommand],
  ['CompleteMultipartUpload', CompleteMultipartUploadCommand],
  ['AbortMultipartUpload', AbortMultipartUploadCommand],
];

/** One recorded command: what it was, what it carried, and which of the adapter's clients sent it. */
export interface FakeS3Call {
  name: string;
  input: any;
  /** The adapter's own property name for the client this went out on, e.g. `client`/`copyClient`. */
  client: string;
}

export interface FakeS3 {
  calls: FakeS3Call[];
  names(): string[];
  of(name: string): any[];
  /** The client property name each call of `name` went out on, in order. */
  clientsFor(name: string): string[];
}

/** The S3-client-shaped own properties of an adapter, by property name. */
export function s3ClientsOf(adapter: unknown): Array<[string, { send: unknown }]> {
  return Object.entries(adapter as Record<string, unknown>).filter(
    (entry): entry is [string, { send: unknown }] => typeof (entry[1] as { send?: unknown })?.send === 'function',
  );
}

export function fakeS3(adapter: unknown, react: (name: string, input: any) => unknown): FakeS3 {
  const calls: FakeS3Call[] = [];
  const clients = s3ClientsOf(adapter);
  if (clients.length === 0) throw new Error('fakeS3: the adapter owns no S3 client to stub');
  for (const [property, client] of clients) {
    (client as any).send = async (cmd: any) => {
      const hit = KINDS.find(([, C]) => cmd instanceof (C as any));
      const name = hit ? hit[0] : String(cmd?.constructor?.name);
      calls.push({ name, input: cmd.input, client: property });
      return react(name, cmd.input);
    };
  }
  return {
    calls,
    names: (): string[] => calls.map((c) => c.name),
    of: (name: string): any[] => calls.filter((c) => c.name === name).map((c) => c.input),
    clientsFor: (name: string): string[] => calls.filter((c) => c.name === name).map((c) => c.client),
  };
}
