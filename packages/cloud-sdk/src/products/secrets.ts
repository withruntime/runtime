import { NotFoundError, RuntimeError } from "../errors.js";
import type { RequestOptions, Transport } from "../transport.js";
import { switchedOff } from "./jobs.js";

/** Which requests to a secret's hosts carry it: `methods` (every method when
 * absent) and `paths`, each exact (`/v1/chat/completions`) or a prefix ending
 * in `/*` (`/repos/acme/*`), written canonically: starting with `/`, no `.` or
 * `..` segments, no `;` or `\`, no encoded slash. A request whose path could be
 * read two ways gets no secret that has rules. Needs credit on the account. */
export type SecretRule = { methods?: string[]; paths: string[] };
/** A secret your sandboxes use without seeing it. Every sandbox of your
 * organization has an environment variable of the secret's name holding
 * `placeholder`; the egress proxy puts the value into HTTPS requests to
 * `hosts` (in the URL and headers), or sets `header` on every such request.
 * The value is never returned. */
export type Secret = {
  name: string;
  hosts: string[];
  header?: string;
  format?: string;
  rules?: SecretRule[];
  placeholder: string;
  valueBytes: number;
  createdAt: string;
  updatedAt: string;
};
export type SetSecret = {
  /** Visible ASCII and spaces, at most 8 KiB for sandboxes (64 KiB of UTF-8
   * for a jobs-only secret). Stored sealed; the sandboxes' copy is never
   * returned. */
  value: string;
  /** Where the value may go: `api.openai.com`, `*.github.com`. 1 to 16.
   * Required unless `jobs` is true. */
  hosts?: string[];
  /** Set this header on every request to the hosts, replacing the sandbox's own. */
  header?: string;
  /** With `header`: its value, `{value}` where the secret goes. Default `{value}`. */
  format?: string;
  /** Only requests a rule allows carry the value. Needs credit on the account. 1 to 16.
   * Absent: every request to the hosts; replacing a secret without rules
   * clears them. */
  rules?: SecretRule[];
  /** Also keep a copy for scheduled jobs, which a job puts into its run's
   * environment (`jobs.create({ secrets: [...] })`). Unlike the sandboxes'
   * copy, the jobs copy is yours rather than the account's, versioned, and can
   * be read back with `reveal`. Setting it again rotates it. */
  jobs?: boolean;
};
/** The jobs copy of a secret: metadata only, never the value. Times are Unix
 * milliseconds. Owned by the person whose key stored it. */
export type JobSecret = {
  id: string;
  name: string;
  ownerId: string;
  createdBy: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};
/** One secret by name, and where its value may go: to sandboxes through the
 * egress proxy (`sandboxes`), into scheduled jobs' environments (`jobs`), or
 * both. */
export type SecretUse = { name: string; sandboxes: Secret | null; jobs: JobSecret | null };

/** A write that reached one copy of a secret and not the other: `stored`
 * names what took effect. Calling again with the same arguments is safe. */
export class SecretPartlyStoredError extends RuntimeError {}

const unavailable = (error: unknown) =>
  error instanceof RuntimeError && (error.code === "unavailable" || error.status === 503);

export function secrets(t: Transport) {
  const off = switchedOff("Secrets for jobs");
  const store = <T>(call: Parameters<Transport["json"]>[0]) => t.json<T>(call).catch(off);
  const path = (name: string) => `/v1/egress-secrets/${encodeURIComponent(name)}`;
  const jobPath = (id: string) => `/v1/secrets/${encodeURIComponent(id)}`;
  /** Every jobs copy this key's person owns, deleted ones included. */
  async function jobCopies(options?: RequestOptions): Promise<JobSecret[]> {
    const all: JobSecret[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await store<JobSecret[]>({
        method: "GET",
        path: "/v1/secrets",
        query: { limit: 100, ...(after ? { after } : {}) },
        ...options,
      });
      all.push(...page);
      if (page.length < 100) return all;
      after = page.at(-1)!.id;
    }
  }
  const liveCopy = async (name: string, options?: RequestOptions) =>
    (await jobCopies(options)).find((s) => s.name === name && s.deletedAt === null);
  const list = async (options?: RequestOptions) =>
    (
      await t.json<{ secrets: Secret[] }>({
        method: "GET",
        path: "/v1/egress-secrets",
        ...options,
      })
    ).secrets;
  const key = (options: RequestOptions | undefined, part: string): RequestOptions | undefined =>
    options?.idempotencyKey
      ? { ...options, idempotencyKey: `${options.idempotencyKey}:${part}`.slice(0, 128) }
      : options;
  async function setJobCopy(name: string, value: string, options?: RequestOptions) {
    const copies = await jobCopies(options);
    const live = copies.find((s) => s.name === name && s.deletedAt === null);
    if (live)
      return store<JobSecret>({
        method: "POST",
        path: `${jobPath(live.id)}:rotate`,
        body: { value, expectedVersion: live.version },
        ...options,
      });
    if (copies.some((s) => s.name === name))
      throw new RuntimeError({
        message: `A jobs secret named ${name} was deleted, and a deleted name cannot be used again.`,
        code: "name_conflict",
        status: 409,
        hint: "Store it under another name.",
        details: { field: "name" },
      });
    return store<JobSecret>({
      method: "POST",
      path: "/v1/secrets",
      body: { name, value },
      ...options,
    });
  }
  async function all(options?: RequestOptions): Promise<SecretUse[]> {
    const [forSandboxes, forJobs] = await Promise.all([
      list(options),
      jobCopies(options).catch((error: unknown) => {
        if (unavailable(error)) return [] as JobSecret[];
        throw error;
      }),
    ]);
    const byName = new Map<string, SecretUse>();
    for (const s of forSandboxes) byName.set(s.name, { name: s.name, sandboxes: s, jobs: null });
    for (const j of forJobs.filter((j) => j.deletedAt === null))
      byName.set(j.name, {
        name: j.name,
        sandboxes: byName.get(j.name)?.sandboxes ?? null,
        jobs: j,
      });
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  function set(
    name: string,
    input: SetSecret & { hosts: string[] },
    options?: RequestOptions,
  ): Promise<Secret & { enforced: boolean; jobs?: JobSecret }>;
  function set(
    name: string,
    input: SetSecret & { jobs: true },
    options?: RequestOptions,
  ): Promise<{ name: string; jobs: JobSecret } & Partial<Secret & { enforced: boolean }>>;
  async function set(name: string, input: SetSecret, options?: RequestOptions) {
    const { jobs, value, ...egress } = input;
    if (!egress.hosts?.length && !jobs)
      throw new RuntimeError({
        message:
          "Say where the value may go: hosts for sandboxes, jobs: true for scheduled jobs, or both.",
        code: "invalid_request",
        status: 0,
        details: { field: "hosts" },
      });
    let sandboxes: (Secret & { enforced: boolean }) | undefined;
    if (egress.hosts?.length)
      sandboxes = await t.json<Secret & { enforced: boolean }>({
        method: "PUT",
        path: path(name),
        body: { value, ...egress },
        ...(jobs ? key(options, "sandboxes") : options),
      });
    if (!jobs) return sandboxes!;
    try {
      const copy = await setJobCopy(name, value, key(options, "jobs"));
      return { ...(sandboxes ?? { name }), jobs: copy };
    } catch (error) {
      if (!sandboxes) throw error;
      const cause = error instanceof RuntimeError ? error : undefined;
      throw new SecretPartlyStoredError({
        message: `Stored ${name} for sandboxes, but not for jobs: ${cause?.message ?? String(error)}`,
        code: cause?.code ?? "partly_stored",
        status: cause?.status ?? 0,
        hint: "Run the same call again: storing it for sandboxes again changes nothing, and the jobs copy is stored or rotated.",
        details: { stored: ["sandboxes"], field: "jobs" },
        ...(cause?.requestId ? { requestId: cause.requestId } : {}),
        cause: error,
      });
    }
  }
  return {
    /** Store or replace a secret. With `hosts`, sandboxes see a placeholder
     * and the egress proxy puts the value into HTTPS requests to them
     * (replacing keeps the placeholder). With `jobs: true`, a copy scheduled
     * jobs can put into their environment; setting it again rotates it. Both
     * at once store both; if only the first lands, `SecretPartlyStoredError`
     * says so and the same call again finishes it. */
    set,
    /** The sandboxes' secrets: names, hosts and placeholders. Never values.
     * `all()` includes the jobs copies. */
    list,
    /** Every secret by name, with where its value may go. */
    all,
    /** One secret by name, with where its value may go. */
    get: async (name: string, options?: RequestOptions): Promise<SecretUse> => {
      const found = (await all(options)).find((s) => s.name === name);
      if (!found)
        throw new NotFoundError({
          message: `No secret named ${name}.`,
          code: "not_found",
          status: 404,
          hint: "List them with runtime.secrets.all().",
        });
      return found;
    },
    /** Replace the jobs copy's value with a new version. Runs already bound to
     * the old version are refused it. Only the jobs copy has versions; to
     * change the sandboxes' copy, `set` it again. */
    rotate: async (name: string, value: string, options?: RequestOptions) => {
      const live = await liveCopy(name, options);
      if (!live)
        throw new NotFoundError({
          message: `${name} has no copy for jobs to rotate.`,
          code: "not_found",
          status: 404,
          hint: "Store one with set(name, { value, jobs: true }). The sandboxes' copy is replaced by set, not rotated.",
        });
      return store<JobSecret>({
        method: "POST",
        path: `${jobPath(live.id)}:rotate`,
        body: { value, expectedVersion: live.version },
        ...options,
      });
    },
    /** Read the jobs copy's value back (needs the key's secrets_reveal
     * permission). The sandboxes' copy can never be read back. */
    reveal: async (name: string, query: { version?: number } = {}, options?: RequestOptions) => {
      const live = await liveCopy(name, options);
      if (!live)
        throw new NotFoundError({
          message: `${name} has no copy for jobs; the sandboxes' copy of a secret can never be read back.`,
          code: "not_found",
          status: 404,
        });
      return store<{ id: string; version: number; value: string }>({
        method: "POST",
        path: `${jobPath(live.id)}:reveal`,
        body: query,
        ...options,
      });
    },
    /** Delete a secret everywhere it is kept: the sandboxes' value is erased
     * and its placeholder stops working, and the jobs copy stops being given
     * to runs (its name stays taken). */
    delete: async (name: string, options?: RequestOptions) => {
      const live = await liveCopy(name, options).catch((error: unknown) => {
        if (unavailable(error)) return undefined;
        throw error;
      });
      let removed: { name: string; deleted: true; enforced: boolean } | undefined;
      try {
        removed = await t.json<{ name: string; deleted: true; enforced: boolean }>({
          method: "DELETE",
          path: path(name),
          ...(live ? key(options, "sandboxes") : options),
        });
      } catch (error) {
        if (!(live && error instanceof NotFoundError)) throw error;
      }
      if (live)
        await store<JobSecret>({
          method: "POST",
          path: `${jobPath(live.id)}:delete`,
          body: { expectedVersion: live.version },
          ...key(options, "jobs"),
        });
      return {
        name,
        deleted: true as const,
        enforced: removed?.enforced ?? true,
        from: [...(removed ? ["sandboxes" as const] : []), ...(live ? ["jobs" as const] : [])],
      };
    },
  };
}
