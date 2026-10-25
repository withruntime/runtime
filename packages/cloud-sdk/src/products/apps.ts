import { ConnectionError, RuntimeError } from "../errors.js";
import { Sandbox } from "../sandbox.js";
import type { SandboxInfo } from "../types.js";
import { timeoutSignal, type RequestOptions, type Transport } from "../transport.js";
import {
  enc,
  following,
  resource,
  type ResourceDeleteOptions,
  type ResourceGetOptions,
  type ResourceListQuery,
  type ResourceWaitOptions,
} from "./resources.js";

/** On the client as runtime.apps for Apps' private beta: an account outside
 * it is refused with product_in_beta. Plain request builders over Transport:
 * nothing runs at import, no dependency beyond this package. A deployment's
 * completion follows its own record, not the app's state. */
export type AppState = "waiting" | "live" | "failed" | "deleting" | "deleted";
/** What Runtime does when a new version's errors or speed get clearly worse
 * in its first 15 minutes: tell the owners (alert, the default), go back to
 * the previous version and tell them (rollback), or neither (off). */
export type ReleaseWatch = "rollback" | "alert" | "off";
export type AppSettings = {
  minCopies: number;
  maxCopies: number;
  concurrency: number;
  spares: number;
  vcpu: number;
  memoryMiB: number;
  port: number;
  healthPath?: string;
  releaseWatch: ReleaseWatch;
  /** Cloudflare's CDN in front of the App's addresses (its runtimehost.com
   * address and its custom domains). On by default; false sends visitors
   * straight to Runtime's routers, with nothing cached. */
  cdn: boolean;
  /** A live copy out of every router's rotation this long is replaced. */
  healthFailSeconds: number;
};
/** One read-write volume of this account (POST /v1/volumes), mounted at path
 * in the App's one copy. */
export type AppVolume = {
  volumeId: string;
  /** Under /data, /mnt, /state, /storage or /volumes, with no . or .. segments. */
  path: string;
};
export type StatefulSettings = {
  volume: AppVolume | null;
  /** Seconds a stopped copy has after SIGTERM to exit. */
  stopGraceSeconds: number;
};
/** How an App's new version goes live: every copy together (at_once, the
 * default), or staged: one copy of it beside the live version's, then about
 * 10%, 50% and all of them, each stage judged on its visitors' errors and
 * speed before the next. A stage that does worse goes back: its copies
 * finish their requests and stop, then the deploy fails (deploy_stage_failed)
 * and the live version never stops serving. */
export type ReleaseStages = "at_once" | "staged";
export type ReleaseSettings = {
  releaseStages: ReleaseStages;
  /** 60 to 3600 seconds; defaults to 300. How long each stage runs once its
   * copies serve before it is judged. */
  releaseSoakSeconds: number;
};
/** An App's staged release under way, or its last. */
export type StagedRelease = {
  version: number;
  /** The version live when it began, serving beside it. */
  from: number;
  /** rolling: its stages go live; back: a stage did worse and its copies
   * leave; done: every copy runs it; failed: it went back (or its copies
   * failed their health check) and the version failed; ended: another
   * deploy or a rollback took its place. */
  state: "rolling" | "back" | "done" | "failed" | "ended";
  stage: number;
  stages: number;
  /** Copies of the new version the stage serves beside the old version's. */
  copies: number;
  /** Copies the release walks to. */
  of: number;
  soakSeconds: number;
  /** Its last step, in words. */
  detail: string;
  startedAt: number;
  updatedAt: number;
};
export type App = AppSettings &
  StatefulSettings &
  ReleaseSettings & {
    id: string;
    name: string | null;
    /** Its address for life, its name then its account's:
     * `https://shop-3f9a1c2e7b04d915-acme1.runtimehost.com/`. A rename leaves it as it is; its
     * id's address (`https://<id without dashes>.runtimehost.com/`) answers
     * too. */
    url: string;
    labels: Record<string, string>;
    state: AppState;
    createdAt: number;
    updatedAt: number;
    deletedAt: number | null;
    error: { code: string; message: string } | null;
    liveVersion: number | null;
    previousVersion: number | null;
    /** Its staged release under way, or its last; null before its first. */
    stagedRelease: StagedRelease | null;
    /** While a copy waits for room in its region: its account's lane, its
     * place in line (1 is next), how many wait ahead by lane, and why.
     * Higher lanes get room first. Absent while nothing of it waits. */
    line?: AppLine;
  };
export type AppLine = {
  lane: string;
  place: number;
  ahead: Record<string, number>;
  words: string;
};
export type RuntimeFunction = Omit<
  App,
  "minCopies" | keyof StatefulSettings | keyof ReleaseSettings | "stagedRelease"
> & {
  minCopies: 0;
  /** 250 to 5000 ms: at most how long a copy stays awake after its last request ends. */
  sleepAfterMs: number;
};
export type CreateFunction = {
  /** Up to 128 letters, digits, dots, dashes or underscores; alphanumeric first. */
  name?: string;
  /** At most 32 entries, each value at most 256 characters. */
  labels?: Record<string, string>;
  /** Required, 1 to 1000. Bounds the number of awake copies. */
  maxCopies: number;
  /** Required, 1 to 16. */
  vcpu: number;
  /** Required, 128 to 65536 MiB. */
  memoryMiB: number;
  /** 1 to 10000; defaults to 100. */
  concurrency?: number;
  /** 0 to 16; defaults to 2. */
  spares?: number;
  /** 1 to 65535; defaults to 8080. */
  port?: number;
  /** Starts with /, no whitespace, at most 256 characters.
   * Omit to check whether the port accepts connections. */
  healthPath?: string;
  /** Defaults to "alert"; "rollback" is opted into. */
  releaseWatch?: ReleaseWatch;
  /** Cloudflare's CDN in front of the address and custom domains; defaults to
   * true. false sends visitors straight to Runtime's routers, nothing cached. */
  cdn?: boolean;
  /** 10 to 3600; defaults to 60. A live copy failing its health check this
   * long is replaced, and the version's history says so. */
  healthFailSeconds?: number;
  /** Only Apps can keep copies awake. Omit this field, including zero. */
  minCopies?: never;
  /** 250 to 5000 ms; defaults to 1000. How long a copy stays awake after its
   * last request ends before it goes back to sleep, at most (copies whose
   * requests come closer together than this stay awake between them; a lone
   * first request may sleep sooner, from 250 ms). Awake time with no
   * request in flight is not billed. */
  sleepAfterMs?: number;
};
export type CreateApp = Omit<CreateFunction, "minCopies" | "sleepAfterMs"> & {
  /** Defaults to 0, or 1 with a volume. No greater than maxCopies. */
  minCopies?: number;
  /** Only Functions sleep on this rule; an App is refused it. */
  sleepAfterMs?: never;
  /** Needs maxCopies 1, minCopies 1 and spares 0 (spares defaults to 0 with a
   * volume), placed on the volume's server. Deploys, rollbacks and restarts
   * then stop the old copy before the new one boots fresh with the volume:
   * an image's start, or a build's files with its start command (a build
   * deployed here saves its files rather than its memory). The deploy record
   * says the downtime. */
  volume?: AppVolume;
  /** 0 to 900; defaults to 30. */
  stopGraceSeconds?: number;
  /** Defaults to "at_once"; see ReleaseStages. */
  releaseStages?: ReleaseStages;
  /** 60 to 3600; defaults to 300. */
  releaseSoakSeconds?: number;
};
export type UpdateApp = Partial<AppSettings & StatefulSettings & ReleaseSettings> & {
  name?: string | null;
  labels?: Record<string, string>;
  /** Only Functions sleep on this rule; an App is refused it. */
  sleepAfterMs?: never;
};
export type UpdateFunction = Omit<
  UpdateApp,
  "minCopies" | "sleepAfterMs" | keyof StatefulSettings | keyof ReleaseSettings
> & {
  minCopies?: never;
  /** 250 to 5000 ms; see CreateFunction.sleepAfterMs. */
  sleepAfterMs?: number;
};
export type DeployState = "building" | "warming" | "switching" | "live" | "failed" | "superseded";
export type AppDowntime = { stopMs: number; bootMs: number; totalMs: number };
export type AppDeploy = {
  id: string;
  version: number;
  url: string;
  /** The account secrets whose placeholders its copies see; absent when none. */
  secrets?: string[];
  /** A restart's: the version it started afresh. */
  restartOf?: number;
  /** A stop-then-start's (an App with a volume), once live. */
  downtime?: AppDowntime;
} & (
  | { state: "building" | "warming" | "switching" | "live"; error?: never }
  | {
      state: "failed" | "superseded";
      error: {
        code:
          | "deploy_build_failed"
          | "deploy_health_failed"
          | "deploy_stop_failed"
          | "deploy_stage_failed"
          | "deploy_switch_failed"
          | "deploy_superseded";
        message: string;
        hint: string;
        lastOutput: string;
      };
    }
);
/** `image`: an image of this account (id, name, name:tag or name@version),
 * ready; the version records its id. */
export type DeployApp = ({ image: string; build?: never } | { build: string; image?: never }) & {
  env?: Record<string, string>;
  /** Carry the last deploy's environment, still sealed. With env, that
   * environment with env's names set: change one value without sending the rest
   * (needs a key that may reveal the App's secrets, secrets_reveal; else 403).
   * For a build: only one a push to the production branch made, from the
   * repository the environment came with. For an image: only from a key that
   * may reveal the App's secrets, and only an environment named with an image
   * deploy. Otherwise refused with keep_env_refused (409). */
  keepEnv?: boolean;
  /** Account secrets whose placeholders every copy of this version sees, each
   * in the environment variable of its name; the egress proxy puts the value
   * into the copy's requests to the secret's hosts, so the value never enters
   * a copy. Each a secret of the whole account or one scoped to this App
   * (`secrets.scope(name, { apps: [id] })`), and not also in `env`. Naming
   * any needs a key that may reveal secrets. Absent: the last deploy's stay
   * (refused for a key that may only deploy an image); `[]` names none. */
  secrets?: string[];
  port?: number;
  healthPath?: string;
  /** Return live, failed or superseded, including its URL/version or failure details. */
  wait?: boolean;
};
export type AppVersion = {
  version: number;
  live: boolean;
  previous: boolean;
  saved: boolean;
  /** Its deploy's id, for GET /v1/apps/{id}/deploys/{deploy}. */
  deploy: string;
  /** The build it was deployed from, or null for an image. */
  build: string | null;
  /** saved: copies start from a saved server; cold: they boot fresh (an
   * image, or a build's files) and start its process. */
  boot: "saved" | "cold";
  restartOf: number | null;
  /** Live copies replaced for failing their health check or exiting. */
  replacements: { at: number; reason: "health" | "exited"; downtimeMs?: number }[];
  downtime: AppDowntime | null;
};
export type AppCopy = {
  id: string;
  version: number;
  region: string;
  state: "starting" | "serving" | "draining" | "frozen" | "parked";
  since: number;
};
/** One copy's commands, processes and files, as a sandbox's: `exec`,
 * `execStream`, `processes`, `files` (write, read, upload, download, ...).
 * Only an owner's or admin's key reaches into a copy (403 otherwise): it holds
 * the App's environment, its secrets included. */
export type AppCopyMachine = Pick<Sandbox, "id" | "exec" | "execStream" | "processes" | "files">;
export type AppCopyOptions = RequestOptions & {
  /** A copy id from `copies()`. Omitted: a serving copy of the live version,
   * or any serving copy while a deploy switches. */
  copy?: string;
};
/** One line a copy printed. */
export type AppLogLine = {
  /** Unix milliseconds, within a second of when the copy printed it. */
  at: number;
  stream: "stdout" | "stderr";
  /** The copy that printed it. */
  copy: string | null;
  /** Its version, as versions() lists them. */
  version: number | null;
  text: string;
};
/** The newest lines of a window, oldest first. */
export type AppLogPage = { lines: AppLogLine[]; nextCursor: string | null; hasMore: boolean };
/** A follow's events: each line once, and a gap where the log store dropped
 * lines before they could be read. */
export type AppLogEvent =
  ({ type: "line"; cursor: string } & AppLogLine) | { type: "gap"; cursor: string };
export type AppLogOptions = {
  /** A time (2026-10-18T20:00:00Z) or a duration back from now (30s, 15m,
   * 2h, 7d). Default 1h; lines are kept 14 days. */
  since?: string;
  /** Only this version's copies. */
  version?: number;
  /** Only this copy. */
  copy?: string;
  stream?: "stdout" | "stderr";
  /** 1 to 500, default 100: a page, or the lines a follow starts with. */
  limit?: number;
  /** A page's nextCursor (the page before it), or with follow an event's
   * cursor to resume after it. */
  cursor?: string;
  /** Stream new lines as copies print them, until the signal aborts or
   * timeoutMs passes (none by default); the SDK reconnects by itself. */
  follow?: boolean;
};
type WireLogEvent =
  | { type: "line" | "gap" | "continue"; cursor: string | null; [key: string]: unknown }
  | { type: "error"; cursor: string | null; code: string; hint: string };
function logFailure(code: string, hint: string, cursor: string | null) {
  return new RuntimeError({ code, status: 0, message: hint, hint, details: { cursor } });
}
const validLogCursor = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 4096 &&
  ![...value].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
const validLine = (event: Record<string, unknown>) =>
  typeof event.text === "string" &&
  (event.stream === "stdout" || event.stream === "stderr") &&
  Number.isSafeInteger(event.at) &&
  (event.at as number) >= 0 &&
  (event.copy === null || typeof event.copy === "string") &&
  (event.version === null || Number.isSafeInteger(event.version));

export type DeployGetOptions = RequestOptions & { waitFor?: DeployState; timeoutSeconds?: number };
/** Defaults to waiting, live and failed. */
export type AppListQuery = ResourceListQuery<AppState>;
export type AppGetOptions = ResourceGetOptions<AppState>;
export type AppWaitOptions = ResourceWaitOptions;
export type AppDeleteOptions = ResourceDeleteOptions;

function copies<
  R extends Omit<App, keyof StatefulSettings | keyof ReleaseSettings | "stagedRelease">,
  C extends CreateApp | CreateFunction,
  U extends UpdateApp | UpdateFunction,
>(t: Transport, plural: "apps" | "functions") {
  const shape = resource<R, C, U, AppState>(t, plural, ["failed", "deleted", "live"]);
  const { base, get } = shape;
  const getDeploy = (id: string, deployId: string, options: DeployGetOptions = {}) => {
    const { waitFor, timeoutSeconds, ...request } = options;
    return t.json<AppDeploy>({
      method: "GET",
      path: `${base}/${enc(id)}/deploys/${enc(deployId)}`,
      query: { waitFor, timeoutSeconds },
      ...request,
    });
  };
  const followDeploy = async (
    id: string,
    record: AppDeploy,
    request: RequestOptions,
    pause: () => Promise<void>,
  ) => {
    while (!["live", "failed", "superseded"].includes(record.state)) {
      record = await getDeploy(id, record.id, { ...request, waitFor: "live", timeoutSeconds: 60 });
      if (!["live", "failed", "superseded"].includes(record.state)) await pause();
    }
    return record;
  };
  const writeDeploy = (
    id: string,
    verb: "deploys" | "rollback" | "restart",
    body: unknown,
    wait: boolean,
    options: AppWaitOptions,
  ) => {
    const { pollMs, ...request } = options;
    const write = (rest: RequestOptions) =>
      t.json<AppDeploy>({
        method: "POST",
        path: verb === "restart" ? `${base}/${enc(id)}:restart` : `${base}/${enc(id)}/${verb}`,
        body,
        ...rest,
      });
    if (!wait) return write(request);
    return following(
      { ...request, pollMs, idempotencyKey: request.idempotencyKey ?? crypto.randomUUID() },
      async (rest, pause) => followDeploy(id, await write(rest), rest, pause),
    );
  };
  /** A follow: each line once, across the server's two-minute calls and
   * dropped connections, resumed from the last cursor every time. */
  async function* followLogs(
    id: string,
    query: AppLogOptions,
    options: RequestOptions = {},
  ): AsyncGenerator<AppLogEvent> {
    const { follow: _, cursor: from, ...filters } = query;
    let cursor: string | null = from ?? null;
    if (cursor !== null && !validLogCursor(cursor))
      throw logFailure("invalid_log_options", "Pass an event's cursor unchanged.", cursor);
    const seen = new Set<string>();
    let failures = 0;
    const deadline = options.timeoutMs ?? 0;
    const signal =
      deadline > 0
        ? AbortSignal.any([...(options.signal ? [options.signal] : []), timeoutSignal(deadline)])
        : options.signal;
    for (;;) {
      signal?.throwIfAborted();
      let continued = false;
      try {
        for await (const event of t.events<WireLogEvent>({
          method: "GET",
          path: `${base}/${enc(id)}/logs`,
          query: { ...filters, follow: true, ...(cursor === null ? {} : { cursor }) },
          // One call lasts about two minutes; the follow, until it is stopped.
          timeoutMs: 0,
          ...(signal ? { signal } : {}),
        })) {
          signal?.throwIfAborted();
          if (
            !event ||
            typeof event !== "object" ||
            (event.cursor !== null && !validLogCursor(event.cursor))
          )
            throw logFailure("app_log_invalid", "Resume from details.cursor.", cursor);
          if (event.type === "line") {
            if (!validLine(event) || !validLogCursor(event.cursor))
              throw logFailure("app_log_invalid", "Resume from details.cursor.", cursor);
            failures = 0;
            cursor = event.cursor;
            if (seen.has(event.cursor)) continue;
            seen.add(event.cursor);
            if (seen.size > 10_000) seen.delete(seen.values().next().value!);
            yield event as unknown as AppLogEvent;
          } else if (event.type === "gap") {
            if (!validLogCursor(event.cursor))
              throw logFailure("app_log_invalid", "Resume from details.cursor.", cursor);
            cursor = event.cursor;
            yield { type: "gap", cursor: event.cursor };
          } else if (event.type === "continue") {
            if (event.cursor !== null) cursor = event.cursor;
            continued = true;
            break;
          } else if (event.type === "error") {
            throw logFailure(
              typeof event.code === "string" && event.code ? event.code : "app_log_failed",
              typeof event.hint === "string" && event.hint
                ? event.hint
                : "Resume from details.cursor in a few seconds.",
              cursor,
            );
          }
          // An event this SDK does not know yet is passed over.
        }
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof SyntaxError)
          throw logFailure("app_log_invalid", "Resume from details.cursor.", cursor);
        // Refusals are the caller's to read; a lost connection is retried.
        if (!(error instanceof TypeError) && !(error instanceof ConnectionError)) throw error;
      }
      if (!continued && ++failures > 3)
        throw logFailure(
          "app_log_interrupted",
          "Follow again with cursor: details.cursor.",
          cursor,
        );
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        const timer = setTimeout(done, continued ? 0 : 250 * failures);
        const abort = () => {
          clearTimeout(timer);
          reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    }
  }
  function logs(
    id: string,
    query: AppLogOptions & { follow: true },
    options?: RequestOptions,
  ): AsyncGenerator<AppLogEvent>;
  function logs(
    id: string,
    query?: AppLogOptions & { follow?: false },
    options?: RequestOptions,
  ): Promise<AppLogPage>;
  function logs(
    id: string,
    query: AppLogOptions,
    options?: RequestOptions,
  ): Promise<AppLogPage> | AsyncGenerator<AppLogEvent>;
  function logs(
    id: string,
    query: AppLogOptions = {},
    options?: RequestOptions,
  ): Promise<AppLogPage> | AsyncGenerator<AppLogEvent> {
    if (query.follow) return followLogs(id, query, options);
    const { follow: _, ...page } = query;
    return t.json<AppLogPage>({
      method: "GET",
      path: `${base}/${enc(id)}/logs`,
      query: page,
      ...options,
    });
  }
  return {
    /** Create a resource waiting for its first version. Defaults belong to
     * the API, so the SDK does not override them. */
    create: shape.create,
    get,
    list: shape.list,
    deploy: (id: string, input: DeployApp, options: AppWaitOptions = {}): Promise<AppDeploy> => {
      const { wait = false, ...body } = input;
      return writeDeploy(id, "deploys", body, wait, options);
    },
    getDeploy,
    /** Resume by deploy id after a process restart, without creating another version. */
    waitDeploy: (id: string, deployId: string, options: AppWaitOptions = {}) =>
      following(options, async (request, pause) =>
        followDeploy(id, await getDeploy(id, deployId, request), request, pause),
      ),
    rollback: (id: string, options: AppDeleteOptions = {}) => {
      const { wait = false, ...request } = options;
      return writeDeploy(id, "rollback", {}, wait, request);
    },
    /** Start a fresh copy of the live version as a deploy of its own; with a
     * volume, the old copy stops first. restart_unavailable: nothing is live. */
    restart: (id: string, options: AppDeleteOptions = {}) => {
      const { wait = false, ...request } = options;
      return writeDeploy(id, "restart", {}, wait, request);
    },
    versions: (id: string, options?: RequestOptions) =>
      t.json<AppVersion[]>({ method: "GET", path: `${base}/${enc(id)}/versions`, ...options }),
    copies: (id: string, options?: RequestOptions) =>
      t.json<AppCopy[]>({ method: "GET", path: `${base}/${enc(id)}/copies`, ...options }),
    /** Reach into one copy: `(await runtime.apps.copy(id)).exec("ls /srv")`.
     * Picks the copy once, by GET .../copies; a copy the App replaces later
     * answers not found, so pick again then. */
    copy: async (id: string, options: AppCopyOptions = {}): Promise<AppCopyMachine> => {
      const { copy: wanted, ...request } = options;
      const [app, list] = await Promise.all([
        get(id, request),
        t.json<AppCopy[]>({ method: "GET", path: `${base}/${enc(id)}/copies`, ...request }),
      ]);
      return new Sandbox(t, { id: pickCopy(app, list, wanted).id } as SandboxInfo);
    },
    /** What its copies printed: a page of the newest lines, oldest first, or
     * with follow: true each new line as it is printed. */
    logs,
    update: shape.update,
    /** Follow resource state, not a deployment: an
     * older live version can survive a failed rollout of a newer version. */
    wait: (id: string, target: "live" | "deleted", options: AppWaitOptions = {}) =>
      shape.wait(id, target, options),
    delete: shape.delete,
  };
}

/** The copy `wanted` names, else a serving copy of the live version, else any
 * serving copy (a deploy may be switching). Refuses with what to do rather
 * than wake a frozen copy, which the App's own traffic does. */
export function pickCopy(
  app: Pick<App, "id" | "liveVersion">,
  list: readonly AppCopy[],
  wanted?: string,
): AppCopy {
  if (wanted) {
    const found = list.find((c) => c.id === wanted);
    if (found) return found;
    throw new RuntimeError({
      message: `App ${app.id} has no copy ${wanted}.`,
      code: "not_found",
      status: 404,
      hint: `List its copies with GET /v1/apps/${app.id}/copies (runtime apps copies ${app.id}).`,
    });
  }
  const serving = list.filter((c) => c.state === "serving");
  const found = serving.find((c) => c.version === app.liveVersion) ?? serving[0];
  if (found) return found;
  throw new RuntimeError({
    message: list.length
      ? `No copy of App ${app.id} is serving: ${list.map((c) => `${c.id} ${c.state}`).join(", ")}.`
      : `App ${app.id} has no copies.`,
    code: "invalid_state",
    status: 409,
    hint:
      app.liveVersion === null
        ? "Deploy a version first."
        : "Send a request to the App's URL to wake one, or keep one awake with minCopies: 1.",
  });
}

export function apps(t: Transport) {
  return copies<App, CreateApp, UpdateApp>(t, "apps");
}

export function functions(t: Transport) {
  return copies<RuntimeFunction, CreateFunction, UpdateFunction>(t, "functions");
}
