import { Page } from "./page.js";
import type { Query, RequestOptions, Transport } from "./transport.js";

/** A sandbox's saved machine or disk, used to start new sandboxes. A verified
 * off-host copy protects it from host loss once `backedUp` is true. */
export type Snapshot = {
  id: string;
  kind: "snapshot";
  /** Absent on older servers means memory. */
  mode?: "memory" | "disk";
  status: string;
  state: "capturing" | "ready" | "failed" | "deleting" | "deleted";
  name: string | null;
  sourceSandboxId: string;
  shape: { vcpu: number; memoryMiB: number; diskMiB: number; memoryGuarantee: string };
  retentionDays: number;
  /** True while raw fork memory awaits verified compression. The snapshot
   * remains ready for starts on its current host, with no storage charge or
   * off-host copy until final publication. Absent on older servers. */
  compressionPending?: boolean;
  /** What it stores, and what storage is metered for: the bytes it alone holds. */
  storedBytes: number | null;
  /** Zero while compression is pending; final bytes once verified. */
  meteredBytes: number | null;
  /** Whether its copy off the host is made and checked. */
  backedUp: boolean;
  /** Where that copy stands. `restoring`: its host was lost and it is being
   * restored onto another; forks answer `snapshot_restoring` until it is.
   * `none` also covers temporary fork snapshots and pending compression. */
  durability: {
    state: "none" | "pending" | "durable" | "failed" | "restoring";
    durableAt: string | null;
    storedBytes: number | null;
  };
  error: string | null;
  createdAt: string;
  readyAt: string | null;
  expiresAt: string;
  [key: string]: unknown;
};
export type SnapshotOptions = {
  /** Save files for a fresh boot, or the whole machine (default). */
  mode?: "memory" | "disk";
  name?: string;
  labels?: Record<string, string>;
  retentionDays?: number;
};

const enc = encodeURIComponent;

/** `runtime.snapshots`. Take one with `sbx.snapshot()`, start from one with
 * `runtime.sandboxes.create({ snapshot: id })`, or do both with `sbx.fork()`. */
export class Snapshots {
  constructor(private readonly t: Transport) {}
  create(
    input: { sandboxId: string } & SnapshotOptions,
    options: RequestOptions = {},
  ): Promise<Snapshot> {
    const { sandboxId, ...body } = input;
    return this.t.json({
      method: "POST",
      path: `/v1/sandboxes/${enc(sandboxId)}:snapshot`,
      body,
      ...options,
    });
  }
  get(id: string, options: RequestOptions = {}): Promise<Snapshot> {
    return this.t.json({ method: "GET", path: `/v1/snapshots/${enc(id)}`, ...options });
  }
  async list(
    filter: {
      sandboxId?: string;
      name?: string;
      state?: "capturing" | "ready" | "failed" | "deleting";
      limit?: number;
    } = {},
    options: RequestOptions = {},
  ): Promise<Page<Snapshot>> {
    const query: Query = {
      sandboxId: filter.sandboxId,
      name: filter.name,
      state: filter.state,
      limit: filter.limit,
    };
    const fetchPage = async (cursor?: string): Promise<Page<Snapshot>> => {
      const body = await this.t.json<{ data: Snapshot[]; nextCursor: string | null }>({
        method: "GET",
        path: "/v1/snapshots",
        query: { ...query, cursor },
        ...options,
      });
      return new Page(body.data, body.nextCursor, (next) => fetchPage(next));
    };
    return fetchPage();
  }
  /** Replace supplied labels or name; omitted fields are preserved. Null clears the name. */
  update(
    id: string,
    input: {
      name?: string | null;
      labels?: Record<string, string>;
      ifLabels?: Record<string, string>;
    },
    options: RequestOptions = {},
  ): Promise<Snapshot> {
    return this.t.json({
      method: "POST",
      path: `/v1/snapshots/${enc(id)}:update`,
      body: input,
      ...options,
    });
  }
  async delete(id: string, options: RequestOptions = {}): Promise<void> {
    await this.t.json({
      method: "POST",
      path: `/v1/snapshots/${enc(id)}:delete`,
      body: {},
      ...options,
    });
  }
  extend(id: string, retentionDays: number, options: RequestOptions = {}): Promise<Snapshot> {
    return this.t.json({
      method: "POST",
      path: `/v1/snapshots/${enc(id)}:extend`,
      body: { retentionDays },
      ...options,
    });
  }
}
