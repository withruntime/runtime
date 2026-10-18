import type { RequestOptions, Transport } from "../transport.js";
import {
  enc,
  following,
  resource,
  type ResourceDeleteOptions,
  type ResourceGetOptions,
  type ResourceListQuery,
  type ResourceWaitOptions,
} from "./resources.js";

/** Private until launch. A deployment's completion follows its own record,
 * not the app's state. */
export type AppState = "waiting" | "live" | "failed" | "deleting" | "deleted";
export type AppSettings = {
  minCopies: number;
  maxCopies: number;
  concurrency: number;
  spares: number;
  vcpu: number;
  memoryMiB: number;
  port: number;
  healthPath?: string;
};
export type App = AppSettings & {
  id: string;
  name: string | null;
  labels: Record<string, string>;
  state: AppState;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  error: { code: string; message: string } | null;
  liveVersion: number | null;
  previousVersion: number | null;
};
export type RuntimeFunction = Omit<App, "minCopies"> & { minCopies: 0 };
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
  /** Only Apps can keep copies awake. Omit this field, including zero. */
  minCopies?: never;
};
export type CreateApp = Omit<CreateFunction, "minCopies"> & {
  /** Defaults to 0. No greater than maxCopies. */
  minCopies?: number;
};
export type UpdateApp = Partial<AppSettings> & {
  name?: string | null;
  labels?: Record<string, string>;
};
export type UpdateFunction = Omit<UpdateApp, "minCopies"> & { minCopies?: never };
export type DeployState = "building" | "warming" | "switching" | "live" | "failed" | "superseded";
export type AppDeploy = {
  id: string;
  version: number;
  url: string;
} & (
  | { state: "building" | "warming" | "switching" | "live"; error?: never }
  | {
      state: "failed" | "superseded";
      error: {
        code: "deploy_build_failed" | "deploy_health_failed" | "deploy_superseded";
        message: string;
        hint: string;
        lastOutput: string;
      };
    }
);
export type DeployApp = ({ image: string; build?: never } | { build: string; image?: never }) & {
  env?: Record<string, string>;
  /** Carry the last deploy's environment, still sealed. With env, that
   * environment with env's names set: change one value without sending the rest
   * (needs a key that may reveal the App's secrets, secrets_reveal; else 403).
   * Only for a build a push to the production branch made, from the repository the
   * environment came with; otherwise refused with keep_env_refused (409). */
  keepEnv?: boolean;
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
};
export type AppCopy = {
  id: string;
  version: number;
  region: string;
  state: "starting" | "serving" | "draining" | "frozen" | "parked";
  since: number;
};
export type DeployGetOptions = RequestOptions & { waitFor?: DeployState; timeoutSeconds?: number };
/** Defaults to waiting, live and failed. */
export type AppListQuery = ResourceListQuery<AppState>;
export type AppGetOptions = ResourceGetOptions<AppState>;
export type AppWaitOptions = ResourceWaitOptions;
export type AppDeleteOptions = ResourceDeleteOptions;

function copies<R extends App, C extends CreateApp, U extends UpdateApp>(
  t: Transport,
  plural: "apps" | "functions",
) {
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
    verb: "deploys" | "rollback",
    body: unknown,
    wait: boolean,
    options: AppWaitOptions,
  ) => {
    const { pollMs, ...request } = options;
    const write = (rest: RequestOptions) =>
      t.json<AppDeploy>({ method: "POST", path: `${base}/${enc(id)}/${verb}`, body, ...rest });
    if (!wait) return write(request);
    return following(
      { ...request, pollMs, idempotencyKey: request.idempotencyKey ?? crypto.randomUUID() },
      async (rest, pause) => followDeploy(id, await write(rest), rest, pause),
    );
  };
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
    versions: (id: string, options?: RequestOptions) =>
      t.json<AppVersion[]>({ method: "GET", path: `${base}/${enc(id)}/versions`, ...options }),
    copies: (id: string, options?: RequestOptions) =>
      t.json<AppCopy[]>({ method: "GET", path: `${base}/${enc(id)}/copies`, ...options }),
    update: shape.update,
    /** Follow resource state, not a deployment: an
     * older live version can survive a failed rollout of a newer version. */
    wait: (id: string, target: "live" | "deleted", options: AppWaitOptions = {}) =>
      shape.wait(id, target, options),
    delete: shape.delete,
  };
}

export function apps(t: Transport) {
  return copies<App, CreateApp, UpdateApp>(t, "apps");
}

export function functions(t: Transport) {
  return copies<RuntimeFunction, CreateFunction, UpdateFunction>(t, "functions");
}
