import { NotFoundError, RuntimeError } from "../errors.js";
import type { RequestOptions, Transport } from "../transport.js";
import { switchedOff } from "./jobs.js";

/** Which requests to a secret's hosts carry it: `methods` (every method when
 * absent) and `paths`, each exact (`/v1/chat/completions`) or a prefix ending
 * in `/*` (`/repos/acme/*`), written canonically: starting with `/`, no `.` or
 * `..` segments, no `;` or `\`, no encoded slash. A request whose path could be
 * read two ways gets no secret that has rules. Needs credit on the account. */
export type SecretRule = { methods?: string[]; paths: string[] };
/** Which sandboxes get a secret: those whose labels hold every pair of any one
 * selector in `labels` (including sandboxes created or labelled later), those
 * named in `sandboxes`, and every copy of the Apps named in `apps`. Any other
 * sandbox of the organization sees no placeholder, and its requests never
 * carry the value. Absent on a secret: every sandbox of the organization. */
export type SecretScope = {
  /** 1 to 8 selectors of 1 to 8 key/value pairs: `[{ role: "hub" }]`. */
  labels?: Array<Record<string, string>>;
  /** 1 to 100 sandbox ids of the organization. */
  sandboxes?: string[];
  /** 1 to 100 App or Function ids: every copy of each, of any version,
   * including copies later deploys, restarts and scaling make. A deploy names
   * the secrets its copies see (`apps.deploy(id, { secrets: [...] })`). */
  apps?: string[];
};
/** A GitHub App the servers act as. The secret's value is the App's private
 * key (PEM); the servers make its installation tokens themselves, each for an
 * hour. The key goes into no request, and each request the rules allow carries
 * the current token: `Authorization: Bearer` to the API, and git's
 * `x-access-token` to git over HTTPS. Takes no `header` or `format`. */
export type SecretGithubApp = {
  /** The App's id. */
  id: number;
  /** The installation's id: where the App is installed. */
  installation: number;
  /** The repositories each token reaches, by name. Absent: every repository of
   * the installation. */
  repositories?: string[];
  /** What each token may do, at most what the App holds: `{ contents: "write" }`.
   * Absent: all the App's permissions. */
  permissions?: Record<string, "read" | "write" | "admin">;
  /** The App's API on GitHub Enterprise Server (`https://<host>/api/v3`); one
   * of `hosts`. Default `https://api.github.com`. */
  api?: string;
};
/** What a git push over HTTPS carrying the secret may update. A push to any
 * other ref, a tag, or a delete is refused before it leaves the server, in
 * git's own words (`! [remote rejected]`). */
export type SecretGit = {
  /** The branches a push may update: `refs/heads/` then a name, with `*` only
   * at the end for any name that begins so, and `{label.<key>}` for the
   * sandbox's own label of that key (a sandbox without it pushes nothing it
   * names): `["refs/heads/task/{label.task}", "refs/heads/task/{label.task}--*"]`.
   * Empty: no push at all. */
  push: string[];
};
/** Each sandbox's hour with the secret, the far end's reserve, GraphQL's
 * mutations and shared copies. */
export type SecretApiPolicy = {
  /** The most requests each sandbox makes with the secret in an hour; past it,
   * 429 with `Retry-After`. */
  callsPerHour?: number;
  /** The most writes (any method but GET, HEAD and OPTIONS; a GraphQL
   * mutation) each sandbox makes in an hour. 0: none. */
  writesPerHour?: number;
  /** Calls the far end keeps for others: none is sent while its
   * `x-ratelimit-remaining` says this many or fewer are left, until its reset. */
  keep?: number;
  /** Reads (GET over HTTP/2) answered from the server's copy while the far end
   * answers 304 to its ETag, shared by every sandbox the secret reaches on that
   * server; past a sandbox's hour, from the copy unasked. Answers carry
   * `x-runtime-copy`. */
  copies?: boolean;
  /** With `copies`: 1 to 300 seconds a copy is answered without asking the far
   * end, GraphQL queries included. */
  fresh?: number;
  /** A GraphQL query always goes; a mutation only when every one is listed. */
  graphql?: {
    /** Default `/graphql`. */
    path?: string;
    /** The mutations a request may make; any other is refused with 403. */
    mutations: string[];
  };
};
/** A secret your sandboxes use without seeing it. Every sandbox of your
 * organization has an environment variable of the secret's name (or `env`)
 * holding `placeholder`; the egress proxy sets `header` on every HTTPS request to
 * `hosts`, or, without `header`, replaces the placeholder in a credential
 * header (Authorization, x-api-key, x-goog-api-key, api-key, xi-api-key,
 * x-subscription-token, private-token). Never in the URL or another header.
 * The value is never returned. */
export type Secret = {
  name: string;
  /** The environment variable the placeholder is in, when not `name`. */
  env?: string;
  hosts: string[];
  header?: string;
  format?: string;
  rules?: SecretRule[];
  /** Absent: every sandbox of the organization. */
  only?: SecretScope;
  githubApp?: SecretGithubApp;
  git?: SecretGit;
  api?: SecretApiPolicy;
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
  /** Set this header on every request to the hosts, replacing the sandbox's
   * own; the value then goes nowhere else. Needed when the API reads its key
   * from a header that is not a credential header (see `Secret`). */
  header?: string;
  /** With `header`: its value, `{value}` where the secret goes. Default `{value}`. */
  format?: string;
  /** Only requests a rule allows carry the value. Needs credit on the account. 1 to 16.
   * Absent: every request to the hosts; replacing a secret without rules
   * clears them. */
  rules?: SecretRule[];
  /** Only these sandboxes get it. Absent when replacing a secret: the scope it
   * has stays, so a new value never widens who gets it. `{}`: every sandbox of
   * the organization again. */
  only?: SecretScope;
  /** The value is a GitHub App's private key (PEM), and the servers make the
   * App's installation tokens themselves. Takes no `header` or `format`. */
  githubApp?: SecretGithubApp;
  /** What a git push over HTTPS carrying the secret may update. Absent: the
   * secret limits no push. */
  git?: SecretGit;
  /** Each sandbox's hour with the secret, the far end's reserve, GraphQL's
   * mutations and shared copies. */
  api?: SecretApiPolicy;
  /** The environment variable sandboxes see it in, when not the secret's
   * name. Several secrets may share one, each scoped (`only`) to sandboxes no
   * other of them reaches, such as one `GITHUB_TOKEN` per repository: a write
   * that would put two in one sandbox is refused (409, conflict). The
   * secret's own name gives the name back. Absent when replacing a secret:
   * the variable it has stays. */
  env?: string;
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
  /** Agents besides `createdBy` that may use it, as `principalId`s from
   * `runtime.me()`, or `"all"`: every key of the person. A secret stored on
   * the website is `"all"`. */
  usableBy: string[] | "all";
  version: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};
/** One secret by name, and where its value may go: to sandboxes through the
 * egress proxy (`sandboxes`), into scheduled jobs' environments (`jobs`), or
 * both. */
/** A page of `secrets.list`: at most `limit` (1 to 100, default 50) secrets,
 * by name, those named after `after`. The next page's `after` is the last
 * name of this one; a page shorter than `limit` is the last. */
export type ListSecrets = { limit?: number; after?: string };
export type SecretUse = { name: string; sandboxes: Secret | null; jobs: JobSecret | null };

/** A write that reached one copy of a secret and not the other: `stored`
 * names what took effect. Calling again with the same arguments is safe. */
export class SecretPartlyStoredError extends RuntimeError {}

/** Secrets for jobs switched off here (501; 503 from an older server). */
const unavailable = (error: unknown) =>
  error instanceof RuntimeError &&
  (error.code === "unavailable" || error.status === 501 || error.status === 503);

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
  /** One page with `limit` or `after`; every secret, page after page, without. */
  async function list(query: ListSecrets & RequestOptions = {}): Promise<Secret[]> {
    const { limit, after, ...options } = query;
    const paged = limit !== undefined || after !== undefined;
    const all: Secret[] = [];
    let from = after;
    for (;;) {
      const params = {
        ...(limit === undefined ? {} : { limit }),
        ...(from === undefined ? {} : { after: from }),
      };
      const page = await t.json<{ secrets: Secret[]; next?: string | null }>({
        method: "GET",
        path: "/v1/egress-secrets",
        ...(Object.keys(params).length ? { query: params } : {}),
        ...options,
      });
      all.push(...page.secrets);
      if (paged || !page.next) return all;
      from = page.next;
    }
  }
  const key = (options: RequestOptions | undefined, part: string): RequestOptions | undefined =>
    options?.idempotencyKey
      ? { ...options, idempotencyKey: `${options.idempotencyKey}:${part}`.slice(0, 128) }
      : options;
  const create = (name: string, value: string, options?: RequestOptions) =>
    store<JobSecret>({ method: "POST", path: "/v1/secrets", body: { name, value }, ...options });
  const rotate = (live: JobSecret, value: string, version: number, options?: RequestOptions) =>
    store<JobSecret>({
      method: "POST",
      path: `${jobPath(live.id)}:rotate`,
      body: { value, expectedVersion: version },
      ...options,
    });
  /** Rotates the jobs copy from the version it has now. A key used before,
   * by this same call whose answer was lost, is answered by the identical
   * request again, with no second rotation: the rotate from the version
   * before, or one of `earlier` (a set's create). Until 10 October 2026 the
   * retry read the copy as it is now, changed its request, and was refused
   * as a conflict. */
  async function rotateOrReplay(
    live: JobSecret,
    value: string,
    options?: RequestOptions,
    earlier: (() => Promise<JobSecret>)[] = [],
  ) {
    try {
      return await rotate(live, value, live.version, options);
    } catch (error) {
      if (!(error instanceof RuntimeError) || error.code !== "idempotency_conflict") throw error;
      const replays = [
        ...earlier,
        ...(live.version > 1 ? [() => rotate(live, value, live.version - 1, options)] : []),
      ];
      for (const replay of replays) {
        const answer = await replay().catch((again: unknown) => {
          // Not this request's earlier send: a conflict, or its key held by
          // another request (idempotency_conflict, 422; 409 from an older
          // server).
          if (
            again instanceof RuntimeError &&
            (again.status === 409 || again.code === "idempotency_conflict")
          )
            return undefined;
          throw again;
        });
        if (answer) return answer;
      }
      throw error;
    }
  }
  async function setJobCopy(name: string, value: string, options?: RequestOptions) {
    const copies = await jobCopies(options);
    const live = copies.find((s) => s.name === name && s.deletedAt === null);
    if (live) return rotateOrReplay(live, value, options, [() => create(name, value, options)]);
    if (copies.some((s) => s.name === name))
      throw new RuntimeError({
        message: `A jobs secret named ${name} was deleted, and a deleted name cannot be used again.`,
        code: "name_conflict",
        status: 409,
        hint: "Store it under another name.",
        details: { field: "name" },
      });
    return create(name, value, options);
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
    // By code point, as the API pages them (`after` compares names so).
    return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
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
    /** Changes which sandboxes get a secret, without its value: `{}` is every
     * sandbox of the organization again. */
    scope: (name: string, only: SecretScope, options?: RequestOptions) =>
      t.json<Secret & { enforced: boolean }>({
        method: "PUT",
        path: `${path(name)}/sandboxes`,
        body: only,
        ...options,
      }),
    /** Narrows where a secret goes, without its value: `hosts` a subset of
     * its hosts, `rules` allowing only requests its rules allow now (a secret
     * without rules allows every request). Either absent stays as it is.
     * Anything wider is refused: widening needs the value, through `set`. */
    narrow: (
      name: string,
      to: { hosts?: string[]; rules?: SecretRule[] },
      options?: RequestOptions,
    ) =>
      t.json<Secret & { enforced: boolean }>({
        method: "PUT",
        path: `${path(name)}/rules`,
        body: to,
        ...options,
      }),
    /** The sandboxes' secrets: names, hosts and placeholders. Never values.
     * `list({ limit, after })` gives one page, by name; `all()` includes
     * the jobs copies. */
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
      return rotateOrReplay(live, value, options);
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
    /** Choose which of your keys may use the jobs copy besides the one that
     * stored it: agent ids (`principalId` from `me()`), `[]` for only that
     * key, or `"all"` for every key of yours. Replaces the list. Only your
     * person or the key that stored it may call this. */
    share: async (name: string, agents: string[] | "all", options?: RequestOptions) => {
      const live = await liveCopy(name, options);
      if (!live)
        throw new NotFoundError({
          message: `${name} has no copy for jobs to share.`,
          code: "not_found",
          status: 404,
          hint: "Store one with set(name, { value, jobs: true }).",
        });
      return store<JobSecret>({
        method: "POST",
        path: `${jobPath(live.id)}:share`,
        body: { agents },
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
