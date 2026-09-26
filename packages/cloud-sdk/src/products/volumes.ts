import { Page } from "../page.js";
import type { RequestOptions, Transport } from "../transport.js";

export type VolumeState = "creating" | "ready" | "failed" | "deleting" | "deleted";
export type Volume = {
  id: string;
  kind: "volume";
  status: string;
  state: VolumeState;
  name: string | null;
  labels: Record<string, string>;
  region: string;
  sizeMiB: number;
  filesystem: "ext4";
  usedMiB: number | null;
  measuredAt: string | null;
  /** True once a backup of it has been copied off its host and checked. */
  backedUp: boolean;
  /** Daily backups, how long each is kept, and when the newest was taken. */
  backups: { daily: boolean; retentionDays: number; lastReadyAt: string | null };
  /** The backup this volume was restored from, if any. */
  restoredFrom: string | null;
  attachments: { sandboxId: string; mode: "rw" | "snapshot"; path: string; attachedAt: string }[];
  error: string | null;
  createdAt: string;
  readyAt: string | null;
};
export type CreateVolume = {
  /** Required unless restoring: a restore is the backup's size. */
  sizeMiB?: number;
  /** A ready backup to restore into the new volume, on any host in its region. */
  fromBackup?: string;
  name?: string;
  labels?: Record<string, string>;
  region?: string;
};
export type VolumeBackupState = "pending" | "ready" | "failed" | "deleting" | "deleted";
/** A point-in-time copy of a volume, kept off its host. */
export type VolumeBackup = {
  id: string;
  kind: "volume-backup";
  status: string;
  state: VolumeBackupState;
  name: string | null;
  labels: Record<string, string>;
  region: string;
  volumeId: string;
  sizeMiB: number;
  trigger: "manual" | "daily";
  retentionDays: number;
  logicalBytes: number | null;
  storedBytes: number | null;
  meteredBytes: number | null;
  error: string | null;
  createdAt: string;
  readyAt: string | null;
  expiresAt: string;
};

const enc = encodeURIComponent;

/** Persistent disks: create once, attach when creating a sandbox with
 * `volumes: [{ volumeId: v.id, path: "/data" }]`. Backed up off their host
 * daily unless that is turned off; restore one with `create({ fromBackup })`. */
export function volumes(t: Transport) {
  const get = (id: string, options?: RequestOptions) =>
    t.json<Volume>({ method: "GET", path: `/v1/volumes/${enc(id)}`, ...options });
  const list = async (
    query: { state?: VolumeState; name?: string; limit?: number; cursor?: string } = {},
    options?: RequestOptions,
  ): Promise<Page<Volume>> => {
    const page = await t.json<{ data: Volume[]; nextCursor: string | null }>({
      method: "GET",
      path: "/v1/volumes",
      query,
      ...options,
    });
    return new Page(page.data, page.nextCursor, (cursor) => list({ ...query, cursor }, options));
  };
  const backups = async (
    query: {
      volumeId?: string;
      state?: Exclude<VolumeBackupState, "deleted">;
      limit?: number;
      cursor?: string;
    } = {},
    options?: RequestOptions,
  ): Promise<Page<VolumeBackup>> => {
    const page = await t.json<{ data: VolumeBackup[]; nextCursor: string | null }>({
      method: "GET",
      path: "/v1/volume-backups",
      query,
      ...options,
    });
    return new Page(page.data, page.nextCursor, (cursor) => backups({ ...query, cursor }, options));
  };
  return {
    /** Create and wait (up to 10 s) until it is ready. With `fromBackup`, a
     * restore; it is ready once the backup is downloaded and checked. */
    create: (input: CreateVolume, options?: RequestOptions) =>
      t.json<Volume>({ method: "POST", path: "/v1/volumes", body: input, wait: 10, ...options }),
    get,
    list,
    delete: (id: string, options?: RequestOptions) =>
      t.json<Volume>({
        method: "POST",
        path: `/v1/volumes/${enc(id)}:delete`,
        body: {},
        ...options,
      }),
    /** Back a volume up now, off its host, and wait (up to a minute, or
     * `wait` seconds) for it to be ready. */
    backup: (
      id: string,
      input: { name?: string; labels?: Record<string, string>; retentionDays?: number } = {},
      options: RequestOptions & { wait?: number } = {},
    ) => {
      const { wait = 60, ...rest } = options;
      return t.json<VolumeBackup>({
        method: "POST",
        path: `/v1/volumes/${enc(id)}:backup`,
        body: input,
        wait,
        ...rest,
      });
    },
    /** Daily backups on or off, and how many days each is kept. */
    setBackupPolicy: (
      id: string,
      input: { daily?: boolean; retentionDays?: number },
      options?: RequestOptions,
    ) =>
      t.json<Volume>({
        method: "POST",
        path: `/v1/volumes/${enc(id)}:backup-policy`,
        body: input,
        ...options,
      }),
    /** Backups, newest first; `{ volumeId }` for one volume's. */
    backups,
    getBackup: (id: string, options?: RequestOptions) =>
      t.json<VolumeBackup>({ method: "GET", path: `/v1/volume-backups/${enc(id)}`, ...options }),
    deleteBackup: (id: string, options?: RequestOptions) =>
      t.json<VolumeBackup>({
        method: "POST",
        path: `/v1/volume-backups/${enc(id)}:delete`,
        body: {},
        ...options,
      }),
    /** A new volume from a backup: `create({ fromBackup: id })`. */
    restore: (
      backupId: string,
      input: { name?: string; labels?: Record<string, string> } = {},
      options?: RequestOptions,
    ) =>
      t.json<Volume>({
        method: "POST",
        path: "/v1/volumes",
        body: { ...input, fromBackup: backupId },
        wait: 10,
        ...options,
      }),
  };
}
