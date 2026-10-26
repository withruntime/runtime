import { Page } from "../page.js";
import type { RequestOptions, Transport } from "../transport.js";

/* Uptime checks (`/v1/uptime`), private until launch: like Apps, this file
 * joins `clientExtensions` (products/index.ts) when uptime launches, and
 * the CLI's `runtime uptime` with it. */

export type UptimeRegion = "wnam" | "enam" | "sam" | "weur" | "eeur" | "apac" | "oc" | "afr" | "me";
export type UptimeState = "applying" | "active" | "deleted";
export type UptimeHealth = "unknown" | "up" | "down";
export type StatusRange = { low: number; high: number };
export type UptimeCheck = {
  id: string;
  name: string | null;
  labels: Record<string, string>;
  /** applying until the probes have it, within a minute; then active. */
  state: UptimeState;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  /** `target_refused` while the newest knock found the target on a private
   * or Runtime address. */
  error: { code: string; message: string } | null;
  url: string;
  method: "GET" | "HEAD";
  intervalSeconds: number;
  timeoutMs: number;
  regions: UptimeRegion[];
  confirm: number;
  statuses: StatusRange[];
  bodyContains?: string;
  health: UptimeHealth;
  healthSince: number | null;
};
export type CreateUptimeCheck = {
  /** https://, http:// or tcp://host:port; its host must resolve to public
   * addresses (a Runtime App's hostname on 80 or 443 is allowed). */
  url: string;
  name?: string;
  labels?: Record<string, string>;
  /** Defaults to GET. */
  method?: "GET" | "HEAD";
  /** 30 to 3,600 per region; defaults to 60. Regions knock in turn. */
  intervalSeconds?: number;
  /** 1 to 30,000; defaults to 10,000. */
  timeoutMs?: number;
  /** Defaults to enam, wnam, weur, eeur, apac. */
  regions?: UptimeRegion[];
  /** Regions that must fail to call it down; defaults to 2 (1 with one region). */
  confirm?: number;
  /** Ranges that pass; defaults to 200 to 399. */
  statuses?: StatusRange[];
  /** Text the body must contain; GET only. */
  bodyContains?: string;
};
export type UptimeResult = {
  region: UptimeRegion;
  scheduledAt: number;
  at: number;
  ms: number;
  up: boolean;
  status: number | null;
  reason: string | null;
  timing: Record<string, unknown>;
};
export type UptimeListQuery = {
  limit?: number;
  cursor?: string;
  name?: string;
  label?: string[];
  state?: UptimeState[];
};
export type UptimeResultsQuery = { before?: number; limit?: number; region?: UptimeRegion };

const enc = encodeURIComponent;

export function uptime(t: Transport) {
  const base = "/v1/uptime";
  const list = async (
    query: UptimeListQuery = {},
    options?: RequestOptions,
  ): Promise<Page<UptimeCheck>> => {
    const page = await t.json<{ data: UptimeCheck[]; nextCursor: string | null }>({
      method: "GET",
      path: base,
      query,
      ...options,
    });
    return new Page(page.data, page.nextCursor, (cursor) => list({ ...query, cursor }, options));
  };
  return {
    create: (input: CreateUptimeCheck, options?: RequestOptions) =>
      t.json<UptimeCheck>({ method: "POST", path: base, body: input, ...options }),
    /** waitFor follows a state for up to 60 seconds; the answer says where it got. */
    get: (
      id: string,
      options: RequestOptions & { waitFor?: UptimeState; timeoutSeconds?: number } = {},
    ) => {
      const { waitFor, timeoutSeconds, ...request } = options;
      return t.json<UptimeCheck>({
        method: "GET",
        path: `${base}/${enc(id)}`,
        query: { waitFor, timeoutSeconds },
        ...request,
      });
    },
    list,
    update: (
      id: string,
      input: { name?: string | null; labels?: Record<string, string> },
      options?: RequestOptions,
    ) =>
      t.json<UptimeCheck>({
        method: "POST",
        path: `${base}/${enc(id)}:update`,
        body: input,
        ...options,
      }),
    delete: (id: string, options?: RequestOptions) =>
      t.json<UptimeCheck>({ method: "DELETE", path: `${base}/${enc(id)}`, ...options }),
    /** Knocks, newest first, kept 7 days; pass nextBefore as before for older ones. */
    results: (id: string, query: UptimeResultsQuery = {}, options?: RequestOptions) =>
      t.json<{ data: UptimeResult[]; nextBefore: number | null }>({
        method: "GET",
        path: `${base}/${enc(id)}/results`,
        query,
        ...options,
      }),
  };
}
