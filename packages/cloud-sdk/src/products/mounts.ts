import type { Sandbox } from "../sandbox.js";
import type { RequestOptions, Transport } from "../transport.js";

/** A bucket mounted in a sandbox. */
export type Mount = {
  path: string;
  provider: "s3" | "r2" | "gcs";
  bucket: string;
  prefix: string | null;
  /** The endpoint host the sandbox reaches the bucket at. */
  endpoint: string;
  /** The secret whose key the egress proxy signs with; null for a public bucket. */
  secret: string | null;
  readOnly: boolean;
  /** Whether it is mounted right now. */
  mounted: boolean;
  mountedAt?: string;
};
export type MountBucket = {
  /** s3 for Amazon S3, or any S3-compatible store with `endpoint`; r2 for
   * Cloudflare R2 (with `accountId`); gcs for Google Cloud Storage (HMAC keys). */
  provider: "s3" | "r2" | "gcs";
  bucket: string;
  /** Where it appears in the sandbox, such as /data. */
  path: string;
  prefix?: string;
  region?: string;
  endpoint?: string;
  accountId?: string;
  /** A secret stored with header `Authorization`, format
   * `AWS4-HMAC-SHA256 {value}` and value `ACCESS_KEY_ID:SECRET_KEY`, naming
   * the endpoint host. The sandbox never sees the key. Omit for a public bucket. */
  secret?: string;
  readOnly?: boolean;
};

const enc = encodeURIComponent;

/** `sbx.mounts`: your own S3, R2 or Google Cloud Storage bucket as a
 * directory in this sandbox.
 *
 *   await sbx.mounts.add({ provider: "s3", bucket: "data", region: "eu-west-1",
 *                          path: "/data", secret: "DATA_BUCKET" });
 *
 * A mount lasts through a pause and a wake, and ends when the sandbox stops. */
export function sandboxMounts(t: Transport, sandbox: Sandbox) {
  const base = () => `/v1/sandboxes/${enc(sandbox.id)}/mounts`;
  return {
    add: (input: MountBucket, options?: RequestOptions) =>
      t.json<Mount>({ method: "POST", path: base(), body: input, ...options }),
    list: async (options?: RequestOptions) =>
      (await t.json<{ data: Mount[] }>({ method: "GET", path: base(), ...options })).data,
    remove: (path: string, options?: RequestOptions) =>
      t.json<{ path: string; mounted: false }>({
        method: "POST",
        path: `${base()}:unmount`,
        body: { path },
        ...options,
      }),
  };
}
