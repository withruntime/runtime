/* `withruntime/fly`: Fly.io's Machines API (api.machines.dev, OpenAPI at
   docs.fly.io/api/machines/openapi.json) answered by Runtime sandboxes, so
   code written for Fly Machines in any language moves by changing one
   address. `machinesApi()` is a fetch handler for the /v1 routes;
   `serveMachinesApi()` (and `npx withruntime fly-api`) serves it on a port.

   How the words map:
   - an app is a label (`fly.app`) on its machines; apps hold nothing else.
   - a machine is a sandbox started from a Runtime image of the Machine's
     `config.image`, built once per image and `init` as `FROM <image>` with
     Fly's entrypoint and cmd rules, and `files` copied in. The image's start
     command is the Machine's main process.
   - states: running is started, paused is suspended, stopped is stopped. A
     main process that has ended makes the machine stopped (and destroyed with
     `auto_destroy`) the next time it is read, as on Fly.
   - stop keeps the disk (Fly resets the root disk); start of a stopped one
     restarts it from that disk; suspend pauses with memory, of any size.
   - an idle machine pauses itself after a minute and wakes on the next
     request, like Fly's `autostop: "suspend"`, billing only storage.
   - the restart policy is kept by a supervisor in the machine: the main
     process runs under a small shell loop that starts it again when it exits
     (`always`, or `on-failure` up to `max_retries`, 10 by default, within
     five minutes), as flyd does, and lets the machine stop otherwise.
   Anything Fly does that this cannot keep (services, mounts, checks, other
   regions) answers 400 naming Runtime's alternative, never accepted and
   ignored. */
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { NotFoundError, RuntimeError } from "../errors.js";
import type { Runtime } from "../client.js";
import type { Sandbox } from "../sandbox.js";
import type { ImageFile } from "../products/images.js";
import { client, type ClientOptions } from "../compat/core.js";

export type MachineState =
  | "created"
  | "starting"
  | "started"
  | "stopping"
  | "stopped"
  | "suspending"
  | "suspended"
  | "destroying"
  | "destroyed";

export type GuestConfig = {
  cpu_kind?: "shared" | "performance";
  cpus?: number;
  memory_mb?: number;
  [key: string]: unknown;
};
export type InitConfig = {
  exec?: string[];
  entrypoint?: string[];
  cmd?: string[];
  [key: string]: unknown;
};
export type MachineFile = { guest_path: string; raw_value?: string; [key: string]: unknown };
export type MachineConfig = {
  image: string;
  env?: Record<string, string>;
  guest?: GuestConfig;
  init?: InitConfig;
  metadata?: Record<string, string>;
  files?: MachineFile[];
  auto_destroy?: boolean;
  restart?: { policy?: string; max_retries?: number; [key: string]: unknown };
  [key: string]: unknown;
};
export type MachineEvent = {
  id: string;
  type: string;
  status: string;
  source: string;
  timestamp: number;
};
export type Machine = {
  id: string;
  name: string;
  state: MachineState;
  region: string;
  instance_id: string;
  private_ip: string;
  config: MachineConfig;
  image_ref: { registry: string; repository: string; tag: string; digest: string };
  created_at: string;
  updated_at: string;
  events: MachineEvent[];
  host_status: "ok";
};

export type MachinesApiOptions = ClientOptions & {
  /** Where the Fly region asked for is not Runtime's: `iad` (Ashburn,
   * Virginia) is the Fly region next to Runtime's us-east servers. */
  regions?: readonly string[];
  /** Answer only requests that carry their own Runtime key, never with this
   * handler's login: set when anyone but this computer can reach it. */
  requireKey?: boolean;
};

const PROVIDER = "fly";
const APP = "fly.app";
const NAME = "fly.name";
const IMAGE = "fly.image";
const INIT = "fly.init";
/** The Runtime image the machine was made from, whose start command is its main process. */
const BUILT = "fly.built";
const MAIN = "fly.main";
const DESTROY = "fly.auto_destroy";
const LEASE = "fly.lease";
const META = "fly.meta.";
/** The restart policy, as `policy` or `policy:max_retries`. */
const RESTART = "fly.restart";
/** Where the supervisor reads the policy: the environment it started with,
 * or a file an update writes, so a change reaches a running supervisor. */
const RESTART_ENV = "RUNTIME_FLY_RESTART";
const RESTART_FILE = "/tmp/.fly-restart";
/** The main process's pid, written by the supervisor before each run. */
const PID_FILE = "/tmp/.fly-main-pid";
const POLICIES = ["no", "always", "on-failure"];
/** How long a destroyed machine still reads as destroyed. */
const DESTROYED_KEPT_MS = 10 * 60_000;
/** Fly's regions that are next to Runtime's us-east: Ashburn, Virginia. */
const NEAR = ["iad"];
/** Runtime's regions as the Fly region next to each. */
const FLY_REGION: Record<string, string> = { "us-east": "iad" };
/** The parts of a Machine config this answers in full. */
const CONFIG = ["image", "env", "guest", "init", "metadata", "files", "auto_destroy", "restart"];
/** Parts Fly's own tools send empty or default, kept only when they are. */
const EMPTY_OK = ["services", "mounts", "checks", "processes", "statics", "dns", "stop_config"];
const ALTERNATIVES: Record<string, string> = {
  services:
    "a preview of the port: sandbox.previews.create({ port }) or `runtime sandboxes preview <id> <port>`",
  mounts:
    "Runtime volumes: runtime.volumes.create(), then sandboxes.create({ volumes: [{ volumeId, path }] })",
  checks:
    "an image start check: images.build({ start: { readyPort } }) answers create when it passes",
  processes: "one main process per machine; start others with sandbox.spawn()",
  schedule: "Runtime jobs: runtime.jobs.create({ schedule })",
  statics: "a preview of a static file server",
  dns: "Runtime's default resolver",
  standbys: "Runtime fork() for a warm copy",
  containers: "one image per machine",
  volumes: "Runtime volumes",
  stop_config: "the default stop",
  memory: "a machine's whole size: POST /machines/{id} with config.guest.memory_mb",
};

class FlyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const refuse = (what: string): never => {
  const alternative = ALTERNATIVES[what];
  throw new FlyError(
    400,
    `${what} is not supported by Runtime's Fly Machines API${alternative ? `; use ${alternative}` : ""}.`,
  );
};
const json = (body: unknown, status = 200) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { "content-type": "application/json" },
  });
const ok = () => json({ ok: true });

/** A Machine's state as Fly words it, from the sandbox's. */
export function machineState(state: Sandbox["state"]): MachineState {
  switch (state) {
    case "running":
      return "started";
    case "paused":
      return "suspended";
    case "pausing":
      return "suspending";
    case "resuming":
    case "starting":
      return "starting";
    default:
      return state;
  }
}

/** The Dockerfile that makes a Fly image and `init` one Runtime image: Fly's
 * `exec` replaces both entrypoint and cmd, `entrypoint` drops the image's
 * cmd unless `cmd` is given, and `cmd` keeps the entrypoint, as Docker does. */
export function dockerfileFor(image: string, init: InitConfig = {}, files: MachineFile[] = []) {
  if (!/^[^\s"\\]+$/.test(image))
    throw new FlyError(400, `config.image ${JSON.stringify(image)} is not an image reference.`);
  const lines = [`FROM ${image}`];
  files.forEach((file, index) =>
    lines.push(`COPY fly-file-${index} ${JSON.stringify(file.guest_path)}`),
  );
  if (init.exec) lines.push(`ENTRYPOINT ${JSON.stringify(init.exec)}`, "CMD []");
  else {
    if (init.entrypoint) lines.push(`ENTRYPOINT ${JSON.stringify(init.entrypoint)}`);
    if (init.cmd) lines.push(`CMD ${JSON.stringify(init.cmd)}`);
    else if (init.entrypoint) lines.push("CMD []");
  }
  return `${lines.join("\n")}\n`;
}

/** The supervisor the main process runs under: it writes the pid it will
 * exec as (so a signal reaches the program, not the loop), runs it in the
 * foreground, and decides on its exit as flyd's restart policy does. */
const SUPERVISOR = [
  "n=0; t=0;",
  "while :; do",
  `sh -c 'echo $$ > ${PID_FILE}; exec "$@"' fly-main "$@"; code=$?;`,
  `r=$(cat ${RESTART_FILE} 2>/dev/null) || r=$${RESTART_ENV}; p=\${r%%:*}; m=\${r#*:}; [ "$m" = "$r" ] && m=10;`,
  "now=$(date +%s); [ $((now - t)) -gt 300 ] && n=0;",
  'case "$p" in always) ;; on-failure) { [ "$code" -ne 0 ] && [ "$n" -lt "$m" ]; } || exit "$code" ;; *) exit "$code" ;; esac;',
  "n=$((n + 1)); t=$now; sleep 1;",
  "done",
].join(" ");

/** The supervised form of a main process. */
export function supervised(argv: readonly string[]): string[] {
  return ["/bin/sh", "-c", SUPERVISOR, "fly-supervisor", ...argv];
}

/** A restart policy as the supervisor reads it. */
export function restartOf(restart: MachineConfig["restart"]): string {
  const policy = restart?.policy || "no";
  return policy === "on-failure" && restart?.max_retries !== undefined
    ? `${policy}:${restart.max_retries}`
    : policy;
}

function checkConfig(
  config: MachineConfig | undefined,
  region: string | undefined,
  regions: readonly string[],
) {
  if (!config || typeof config !== "object") throw new FlyError(400, "config is required.");
  if (typeof config.image !== "string" || !config.image)
    throw new FlyError(400, "config.image is required.");
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined || value === null || CONFIG.includes(key)) continue;
    const empty =
      value === false ||
      (Array.isArray(value) && value.length === 0) ||
      (typeof value === "object" && Object.keys(value).length === 0);
    if (empty && EMPTY_OK.includes(key)) continue;
    refuse(key);
  }
  const restart = config.restart ?? {};
  if (restart.policy !== undefined && !POLICIES.includes(restart.policy))
    throw new FlyError(400, `restart.policy must be one of ${POLICIES.join(", ")}.`);
  for (const key of Object.keys(restart))
    if (!["policy", "max_retries"].includes(key) && restart[key] !== undefined)
      refuse(`restart.${key}`);
  if (
    restart.max_retries !== undefined &&
    (!Number.isInteger(restart.max_retries) || restart.max_retries < 0)
  )
    throw new FlyError(400, "restart.max_retries must be a whole number.");
  const guest = config.guest ?? {};
  for (const key of Object.keys(guest))
    if (
      !["cpu_kind", "cpus", "memory_mb"].includes(key) &&
      guest[key] !== undefined &&
      guest[key] !== 0
    )
      refuse(`guest.${key}`);
  for (const key of Object.keys(config.init ?? {}))
    if (
      !["exec", "entrypoint", "cmd"].includes(key) &&
      (config.init as InitConfig)[key] !== undefined
    )
      refuse(`init.${key}`);
  for (const file of config.files ?? []) {
    if (typeof file.guest_path !== "string" || !file.guest_path.startsWith("/"))
      throw new FlyError(400, "files[].guest_path must be an absolute path.");
    if (typeof file.raw_value !== "string")
      refuse("files[].secret_name (Runtime secrets: runtime.secrets.set, then env)");
  }
  if (region && !regions.includes(region))
    throw new FlyError(
      400,
      `region ${region} is not available: Runtime runs in us-east (northern Virginia), next to Fly's ${regions.join(", ")}. Leave region out or use ${regions[0]}.`,
    );
}

/** A Fly-style name: lower-case words and a number. */
const generatedName = () => `machine-${randomBytes(4).toString("hex")}`;

export class MachinesApi {
  readonly #options: ClientOptions;
  readonly #regions: readonly string[];
  readonly #requireKey: boolean;
  readonly #clients = new Map<string, Runtime>();
  /** Machines this handler destroyed, read back as destroyed for a while, as
   * Fly answers a destroyed machine's id before forgetting it. */
  readonly #destroyed = new Map<string, { app: string; machine: Machine; at: number }>();

  constructor({ regions = NEAR, requireKey = false, ...options }: MachinesApiOptions = {}) {
    this.#options = options;
    this.#regions = regions;
    this.#requireKey = requireKey;
  }

  /** The Runtime client for a request: a Runtime key in its bearer token, or
   * this handler's own. A Fly token is never sent anywhere. */
  #runtime(request: Request): Runtime {
    const token = (request.headers.get("authorization") ?? "")
      .replace(/^(Bearer|FlyV1)\s+/i, "")
      .trim();
    if (this.#requireKey && !token.startsWith("rtcloud_"))
      throw new FlyError(
        401,
        "This Fly Machines API is reachable from other computers, so each request must carry its own Runtime API key (rtcloud_...) as the bearer token, where your Fly token went.",
      );
    const key = token.startsWith("rtcloud_") ? token : (this.#options.apiKey ?? "");
    if (!key && !this.#options.client)
      throw new FlyError(
        401,
        "Send a Runtime API key (rtcloud_...) as the bearer token, where your Fly token went.",
      );
    if (!key) return client(this.#options);
    let found = this.#clients.get(key);
    if (!found) {
      found = client({ ...this.#options, client: undefined, apiKey: key });
      this.#clients.set(key, found);
    }
    return found;
  }

  /** Answers one Machines API request. */
  fetch = async (request: Request): Promise<Response> => {
    try {
      return await this.#route(request);
    } catch (error) {
      if (error instanceof FlyError) return json({ error: error.message }, error.status);
      if (error instanceof NotFoundError) return json({ error: error.message }, 404);
      if (error instanceof RuntimeError)
        return json(
          { error: `${error.message}${error.hint ? ` ${error.hint}` : ""}` },
          error.status >= 400 ? error.status : 502,
        );
      return json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  };

  async #route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.replace(/\/+$/, "").split("/").slice(1).map(decodeURIComponent);
    if (parts[0] !== "v1") throw new FlyError(404, `No route ${url.pathname}.`);
    const method = request.method.toUpperCase();
    const body = async <T>(): Promise<T> => {
      if (method === "GET" || method === "DELETE") return {} as T;
      const text = await request.text();
      if (!text.trim()) return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch (error) {
        throw new FlyError(
          400,
          `The request body is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`,
        );
      }
    };
    const runtime = this.#runtime(request);
    const [, apps, app, machines, id, verb, key] = parts;
    if (method === "GET" && apps === "platform" && app === "regions" && !machines)
      return json({
        nearest: this.#regions[0],
        regions: this.#regions.map((code) => ({
          code,
          name: "Ashburn, Virginia (US): Runtime us-east",
          geo_region: "us",
          gateway_available: false,
          requires_paid_plan: false,
        })),
      });
    if (method === "GET" && apps === "orgs" && app && machines === "machines" && !id) {
      const machines: Record<string, unknown>[] = [];
      for (const sandbox of await this.#list(runtime)) {
        const machine = await this.#observe(sandbox);
        if (!machine) continue;
        const {
          events: _events,
          image_ref: _ref,
          host_status: _host,
          instance_id,
          ...rest
        } = machine;
        machines.push({ app_name: sandbox.info.labels[APP], ...rest, version: instance_id });
      }
      return json({ machines });
    }
    if (apps !== "apps") throw new FlyError(404, `No route ${url.pathname}.`);

    if (app === undefined) {
      if (method === "GET") return json(await this.#apps(runtime));
      if (method === "POST") {
        const { app_name } = await body<{ app_name?: string }>();
        if (!app_name) throw new FlyError(400, "app_name is required.");
        return json(undefined, 201);
      }
    }
    if (app !== undefined && machines === undefined) {
      if (method === "GET") {
        const count = (await this.#list(runtime, app)).length;
        return json({
          id: app,
          name: app,
          status: count ? "deployed" : "pending",
          organization: { name: "runtime", slug: "personal" },
        });
      }
      if (method === "DELETE") {
        for (const sandbox of await this.#list(runtime, app)) await this.#destroy(sandbox);
        return json(undefined, 202);
      }
    }
    if (machines !== "machines") throw new FlyError(404, `No route ${url.pathname}.`);
    const app_ = app!;

    if (id === undefined) {
      if (method === "GET") {
        const filter = [...url.searchParams].filter(([k]) => k.startsWith("metadata."));
        const region = url.searchParams.get("region");
        const found = await Promise.all(
          (await this.#list(runtime, app_)).map((sandbox) => this.#observe(sandbox)),
        );
        return json(
          found
            .filter((m): m is Machine => m !== undefined)
            .filter((m) => !region || m.region === region || this.#regions.includes(region))
            .filter((m) => filter.every(([k, v]) => m.config.metadata?.[k.slice(9)] === v)),
        );
      }
      if (method === "POST") return json(await this.#create(runtime, app_, await body()));
    }
    const sandbox = await this.#get(runtime, app_, id!).catch((error: unknown) => {
      if (!(error instanceof NotFoundError)) throw error;
      return undefined;
    });
    if (!sandbox) {
      const gone = this.#gone(app_, id!);
      if (gone && method === "GET" && verb === undefined) return json(gone);
      if (gone && method === "GET" && verb === "wait") {
        const wanted = (url.searchParams.get("state") ?? "started").split(",");
        if (wanted.includes("destroyed")) return json({ ok: true, state: "destroyed" });
      }
      throw new FlyError(404, "machine not found");
    }
    const lease = request.headers.get("fly-machine-lease-nonce");
    // A lease guards changes to the machine, as on Fly; exec and reads go on.
    const mutating = method !== "GET" && verb !== "lease" && verb !== "exec";
    if (mutating) this.#checkLease(sandbox, lease);

    if (verb === undefined) {
      if (method === "GET") return json(await this.#machine(sandbox));
      if (method === "POST") return json(await this.#update(runtime, sandbox, await body()));
      if (method === "DELETE") {
        // fly-admin and older clients spell force `kill`.
        const force = ["force", "kill"].some((name) => url.searchParams.get(name) === "true");
        await this.#observe(sandbox);
        if (!force && (sandbox.state === "running" || sandbox.state === "starting"))
          throw new FlyError(
            412,
            "failed_precondition: unable to destroy machine, not currently stopped or suspended; stop it first or pass force=true",
          );
        await this.#destroy(sandbox);
        return ok();
      }
    }
    switch (`${method} ${verb}`) {
      case "POST start": {
        const previous = (await this.#machine(sandbox)).state;
        if (sandbox.state === "paused") await sandbox.wake();
        else if (sandbox.state === "stopped") await this.#restart(runtime, sandbox);
        return json({ previous_state: previous, migrated: false, new_host: "" });
      }
      case "POST stop":
        await sandbox.stop();
        return ok();
      case "POST suspend":
        await sandbox.pause();
        return ok();
      case "POST restart":
        await sandbox.stop();
        await this.#restart(runtime, sandbox);
        return ok();
      case "GET wait":
        return this.#wait(sandbox, url);
      case "POST exec":
        return json(await this.#exec(sandbox, await body()));
      case "GET metadata": {
        const metadata = metadataOf(sandbox);
        if (key === undefined) return json(metadata);
        if (!(key in metadata)) throw new FlyError(404, `metadata key ${key} not found`);
        return json({ value: metadata[key] });
      }
      case "PATCH metadata":
      case "PUT metadata": {
        const { metadata = {} } = await body<{ metadata?: Record<string, string | null> }>();
        await this.#label(
          sandbox,
          Object.fromEntries(
            Object.entries(metadata).map(([k, v]) => [META + k, v === null ? null : String(v)]),
          ),
        );
        return json(undefined, 204);
      }
      case "GET versions": {
        const machine = await this.#machine(sandbox);
        return json([{ version: machine.instance_id, user_config: machine }]);
      }
      case "GET memory":
      case "PUT memory":
      case "POST memory":
        return refuse("memory");
      case "POST metadata": {
        const { value } = await body<{ value?: string }>();
        if (key === undefined || typeof value !== "string")
          throw new FlyError(400, "POST /metadata/{key} takes { value }.");
        await this.#label(sandbox, { [META + key]: value });
        return json(undefined, 204);
      }
      case "DELETE metadata":
        if (key === undefined) throw new FlyError(400, "DELETE /metadata/{key} needs a key.");
        await this.#label(sandbox, { [META + key]: null });
        return json(undefined, 204);
      case "GET lease": {
        const held = leaseOf(sandbox);
        if (!held) throw new FlyError(404, "lease not found");
        return json({ status: "success", data: held });
      }
      case "POST lease":
        return json({ status: "success", data: await this.#lease(sandbox, lease, await body()) });
      case "DELETE lease":
        this.#checkLease(sandbox, lease);
        await this.#label(sandbox, { [LEASE]: null });
        return json({ status: "success", data: { ok: true } });
      case "POST signal": {
        const { signal } = await body<{ signal?: string }>();
        const signals = [
          "SIGTERM",
          "SIGKILL",
          "SIGINT",
          "SIGHUP",
          "SIGQUIT",
          "SIGUSR1",
          "SIGUSR2",
        ] as const;
        const named = signals.find((name) => name === signal);
        if (!named) throw new FlyError(400, `signal must be one of ${signals.join(", ")}.`);
        const main = sandbox.info.labels[MAIN];
        if (!main) throw new FlyError(412, "this machine has no main process to signal");
        // The program under the supervisor, as Fly signals the main process.
        const sent = await sandbox.exec([
          "sh",
          "-c",
          `[ -s ${PID_FILE} ] && kill -s "$1" "$(cat ${PID_FILE})"`,
          "fly",
          named.slice(3),
        ]);
        if (sent.exitCode !== 0) await (await sandbox.processes.get(main)).kill(named);
        return ok();
      }
      case "GET ps":
        return json(
          (await sandbox.processes.list())
            .filter((p) => p.state === "running")
            .map((p) => ({
              command: p.command,
              directory: p.cwd,
              pid: 0,
              cpu: 0,
              rss: 0,
              rtime: 0,
              stime: 0,
              listen_sockets: [],
            })),
        );
      case "GET events":
        return json((await this.#machine(sandbox)).events);
      case "POST cordon":
      case "POST uncordon":
        return refuse("services");
    }
    throw new FlyError(404, `No route ${method} ${url.pathname}.`);
  }

  async #apps(runtime: Runtime) {
    const counts = new Map<string, number>();
    for await (const sandbox of await runtime.sandboxes.list({
      labels: { "compat.provider": PROVIDER },
      includeStopped: true,
    })) {
      const app = sandbox.info.labels[APP];
      if (app) counts.set(app, (counts.get(app) ?? 0) + 1);
    }
    return {
      total_apps: counts.size,
      apps: [...counts].map(([name, machine_count]) => ({
        id: name,
        name,
        machine_count,
        network: "default",
      })),
    };
  }

  async #list(runtime: Runtime, app?: string): Promise<Sandbox[]> {
    const found: Sandbox[] = [];
    for await (const sandbox of await runtime.sandboxes.list({
      labels: { "compat.provider": PROVIDER, ...(app === undefined ? {} : { [APP]: app }) },
      includeStopped: true,
    }))
      found.push(sandbox);
    return found;
  }

  async #get(runtime: Runtime, app: string, id: string): Promise<Sandbox> {
    const sandbox = await runtime.sandboxes.get(id);
    if (sandbox.info.labels[APP] !== app) throw new FlyError(404, "machine not found");
    return sandbox;
  }

  /** The Runtime image for a Fly image, init and files, built once: the
   * image as Docker would run it, then, when it has a main process, the same
   * with that process under the restart supervisor. */
  async #image(runtime: Runtime, config: MachineConfig): Promise<string> {
    const files = config.files ?? [];
    const dockerfile = dockerfileFor(config.image, config.init, files);
    const inline: ImageFile[] = files.map((file, index) => ({
      path: `fly-file-${index}`,
      content: file.raw_value!,
      encoding: "base64",
    }));
    const plain = await this.#build(runtime, dockerfile, inline);
    const start = (await runtime.images.get(plain)).start;
    const argv = start?.argv?.length
      ? start.argv
      : start?.command
        ? ["/bin/sh", "-c", start.command]
        : undefined;
    if (!argv || argv[3] === "fly-supervisor") return plain;
    const lines = dockerfileFor(config.image, {}, files).trimEnd().split("\n");
    lines.push(`ENTRYPOINT ${JSON.stringify(supervised(argv))}`, "CMD []");
    return this.#build(runtime, `${lines.join("\n")}\n`, inline);
  }

  async #build(runtime: Runtime, dockerfile: string, files: ImageFile[]): Promise<string> {
    const digest = createHash("sha256")
      .update(JSON.stringify([dockerfile, files]))
      .digest("hex")
      .slice(0, 20);
    const name = `fly-${digest}`;
    const ready = (await runtime.images.list({ name, state: "ready", limit: 1 })).data[0];
    if (ready) return ready.id;
    return (
      await runtime.images.build({
        name,
        dockerfile,
        files,
        labels: { "compat.provider": PROVIDER },
      })
    ).id;
  }

  async #create(
    runtime: Runtime,
    app: string,
    input: {
      name?: string;
      region?: string;
      config?: MachineConfig;
      skip_launch?: boolean;
      lease_ttl?: number;
    },
  ): Promise<Machine> {
    const config = input.config!;
    checkConfig(config, input.region, this.#regions);
    const guest = config.guest ?? {};
    const metadata = Object.entries(config.metadata ?? {});
    if (metadata.length > 20) throw new FlyError(400, "At most 20 metadata keys per machine.");
    const image = await this.#image(runtime, config);
    const init =
      config.init && Object.keys(config.init).length ? JSON.stringify(config.init) : undefined;
    const labels: Record<string, string> = {
      "compat.provider": PROVIDER,
      [APP]: app,
      [NAME]: input.name ?? generatedName(),
      [IMAGE]: config.image,
      [BUILT]: image,
      ...(init ? { [INIT]: init } : {}),
      ...(config.auto_destroy ? { [DESTROY]: "true" } : {}),
      [RESTART]: restartOf(config.restart),
      ...Object.fromEntries(metadata.map(([k, v]) => [META + k, String(v)])),
    };
    for (const [k, v] of Object.entries(labels))
      if (v.length > 256)
        throw new FlyError(400, `${k === INIT ? "config.init" : k} is longer than 256 characters.`);
    const sandbox = await runtime.sandboxes.create({
      image,
      labels,
      env: { ...config.env, [RESTART_ENV]: restartOf(config.restart) },
      // Fly's size when none is given: shared-cpu-1x with 256 MB.
      vcpu: guest.cpus ?? 1,
      memoryMiB: guest.memory_mb ?? 256,
      cpu: guest.cpu_kind === "performance" ? "reserved" : "shared",
    });
    const main = sandbox.info.start?.processId;
    if (main) await this.#label(sandbox, { [MAIN]: main });
    if (input.skip_launch) await sandbox.stop();
    if (input.lease_ttl) await this.#lease(sandbox, null, { ttl: input.lease_ttl });
    return this.#machine(sandbox);
  }

  async #update(
    runtime: Runtime,
    sandbox: Sandbox,
    input: { config?: MachineConfig; region?: string },
  ) {
    const config = input.config!;
    checkConfig(config, input.region, this.#regions);
    const labels = sandbox.info.labels;
    const init =
      config.init && Object.keys(config.init).length ? JSON.stringify(config.init) : undefined;
    if (config.image !== labels[IMAGE] || init !== labels[INIT] || config.files?.length)
      throw new FlyError(
        400,
        "Changing image, init or files is not supported by Runtime's Fly Machines API; create a new machine, or move a sandbox to another image with sandbox.switchImage().",
      );
    const guest = config.guest ?? {};
    if (
      (guest.cpus && guest.cpus !== sandbox.info.vcpu) ||
      (guest.memory_mb && guest.memory_mb !== sandbox.info.memoryMiB)
    ) {
      // A resize restarts the sandbox, and so the machine's main process.
      await sandbox.resize({
        ...(guest.cpus ? { vcpu: guest.cpus } : {}),
        ...(guest.memory_mb ? { memoryMiB: guest.memory_mb } : {}),
      });
      await this.#runMain(runtime, sandbox);
    }
    const restart = restartOf(config.restart);
    const env = { ...config.env, [RESTART_ENV]: restart };
    const removed = (sandbox.info.envNames ?? []).filter((name) => !(name in env));
    if (restart !== labels[RESTART] && sandbox.state === "running")
      await sandbox.exec(["sh", "-c", `printf %s "$1" > ${RESTART_FILE}`, "fly", restart]);
    const metadata = config.metadata ?? {};
    const labelChange: Record<string, string | null> = {
      [DESTROY]: config.auto_destroy ? "true" : null,
      [RESTART]: restart,
      ...Object.fromEntries(
        Object.keys(labels)
          .filter((k) => k.startsWith(META) && !(k.slice(META.length) in metadata))
          .map((k) => [k, null]),
      ),
      ...Object.fromEntries(Object.entries(metadata).map(([k, v]) => [META + k, String(v)])),
    };
    await sandbox.update({
      labels: mergeLabels(labels, labelChange),
      env: { ...Object.fromEntries(removed.map((name) => [name, null])), ...env },
    });
    return this.#machine(sandbox);
  }

  /** Starts a stopped machine and its main process: Fly runs the image's
   * command on every start, and a restarted sandbox runs only what it is
   * told (15 October 2026), so the image's start command is run here. */
  async #restart(runtime: Runtime, sandbox: Sandbox) {
    await sandbox.restart();
    await this.#runMain(runtime, sandbox);
  }

  /** Runs the image's start command, unless it already runs. A server that
   * runs it again on a restart or resize says so in `start` (#750): that
   * process is the main one, and nothing is started twice. */
  async #runMain(runtime: Runtime, sandbox: Sandbox) {
    const started = sandbox.info.start?.processId;
    if (started && started !== sandbox.info.labels[MAIN]) {
      await this.#label(sandbox, { [MAIN]: started });
      return;
    }
    const built = sandbox.info.labels[BUILT];
    const start = built ? (await runtime.images.get(built)).start : undefined;
    const command = start?.argv?.length ? start.argv : start?.command;
    if (!command) return;
    const shown = typeof command === "string" ? command : command.join(" ");
    const running = (await sandbox.processes.list()).find(
      (p) =>
        p.state === "running" && (p.command === shown || p.command === `/usr/bin/env ${shown}`),
    );
    const main =
      running ??
      (await sandbox.spawn(command, {
        ...(start?.cwd ? { cwd: start.cwd } : {}),
        ...(start?.env ? { env: start.env } : {}),
      }));
    await this.#label(sandbox, { [MAIN]: main.id });
  }

  async #destroy(sandbox: Sandbox) {
    await sandbox.delete();
    const now = Date.now();
    for (const [id, { at }] of this.#destroyed)
      if (now - at > DESTROYED_KEPT_MS) this.#destroyed.delete(id);
    this.#destroyed.set(sandbox.id, {
      app: sandbox.info.labels[APP] ?? "",
      machine: { ...toMachine(sandbox), state: "destroyed" },
      at: now,
    });
  }

  #gone(app: string, id: string): Machine | undefined {
    const gone = this.#destroyed.get(id);
    if (!gone || gone.app !== app || Date.now() - gone.at > DESTROYED_KEPT_MS) return undefined;
    return gone.machine;
  }

  async #label(sandbox: Sandbox, change: Record<string, string | null>) {
    await sandbox.update({ labels: mergeLabels(sandbox.info.labels, change) });
  }

  /** The machine, after acting on a main process that has ended: Fly stops a
   * machine whose process exits, and destroys it with auto_destroy.
   * Undefined when that destroyed it. */
  async #observe(sandbox: Sandbox): Promise<Machine | undefined> {
    const main = sandbox.info.labels[MAIN];
    if (main && sandbox.state === "running") {
      const process = await sandbox.processes.get(main).catch((error: unknown) => {
        if (error instanceof NotFoundError) return undefined;
        throw error;
      });
      if (process && process.state !== "running") {
        if (sandbox.info.labels[DESTROY] === "true") {
          await this.#destroy(sandbox);
          return undefined;
        }
        await sandbox.stop();
      }
    }
    return toMachine(sandbox);
  }

  async #machine(sandbox: Sandbox): Promise<Machine> {
    const machine = await this.#observe(sandbox);
    if (!machine) return { ...toMachine(sandbox), state: "destroyed" };
    return machine;
  }

  /** GET /wait: until the machine is in `state` (default started), or
   * `timeout` seconds (default 60) pass: 408 then, as on Fly. */
  async #wait(sandbox: Sandbox, url: URL): Promise<Response> {
    const wanted = (url.searchParams.get("state") ?? "started").split(",") as MachineState[];
    const timeout = Math.min(Number(url.searchParams.get("timeout") ?? 60) || 60, 300);
    const deadline = Date.now() + timeout * 1000;
    for (;;) {
      let state: MachineState;
      try {
        await sandbox.refresh();
        state = (await this.#machine(sandbox)).state;
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
        state = "destroyed";
      }
      if (
        state === "destroyed" &&
        sandbox.info.labels[DESTROY] !== "true" &&
        !wanted.includes("destroyed")
      )
        throw new FlyError(404, "machine not found");
      if (wanted.includes(state)) return json({ ok: true, state });
      if (Date.now() >= deadline)
        throw new FlyError(408, `machine did not reach ${wanted.join(" or ")} in ${timeout}s`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  async #exec(
    sandbox: Sandbox,
    input: { cmd?: string; command?: string[]; timeout?: number; stdin?: string },
  ) {
    const argv = input.command?.length
      ? input.command
      : input.cmd
        ? ["sh", "-c", input.cmd]
        : undefined;
    if (!argv) throw new FlyError(400, "exec takes command (an argument list) or cmd.");
    const result = await sandbox.exec(argv, {
      ...(input.timeout ? { timeoutMs: input.timeout * 1000 } : {}),
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
    });
    if (result.timedOut) throw new FlyError(408, `exec did not finish in ${input.timeout ?? 60}s`);
    return {
      exit_code: result.exitCode ?? -1,
      exit_signal: result.exitCode === null ? 9 : 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  #checkLease(sandbox: Sandbox, nonce: string | null) {
    const held = leaseOf(sandbox);
    if (held && held.nonce !== nonce)
      throw new FlyError(
        409,
        `machine ${sandbox.id} is leased by another client until ${new Date(held.expires_at * 1000).toISOString()}`,
      );
  }

  /** A lease kept in a label, read back after it is written so two clients
   * asking at once cannot both hold it: the later write wins and the earlier
   * client's read-back sees it lost. */
  async #lease(
    sandbox: Sandbox,
    nonce: string | null,
    input: { ttl?: number; description?: string },
  ) {
    const held = leaseOf(sandbox);
    if (held && held.nonce !== nonce) this.#checkLease(sandbox, nonce);
    const ttl = Math.max(1, Math.min(input.ttl ?? 30, 3600));
    const lease = {
      nonce: held?.nonce ?? randomBytes(8).toString("hex"),
      expires_at: Math.floor(Date.now() / 1000) + ttl,
      owner: "runtime",
      description: (input.description ?? "").slice(0, 120),
      version: randomBytes(4).toString("hex"),
    };
    await this.#label(sandbox, { [LEASE]: JSON.stringify(lease) });
    await sandbox.refresh();
    if (leaseOf(sandbox)?.version !== lease.version)
      throw new FlyError(409, `machine ${sandbox.id} was leased by another client`);
    return lease;
  }
}

function mergeLabels(labels: Record<string, string>, change: Record<string, string | null>) {
  const next = { ...labels };
  for (const [k, v] of Object.entries(change)) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  return next;
}

function leaseOf(sandbox: Sandbox) {
  const raw = sandbox.info.labels[LEASE];
  if (!raw) return undefined;
  try {
    const lease = JSON.parse(raw) as {
      nonce: string;
      expires_at: number;
      owner: string;
      description: string;
      version: string;
    };
    return lease.expires_at * 1000 > Date.now() ? lease : undefined;
  } catch {
    return undefined;
  }
}

function metadataOf(sandbox: Sandbox): Record<string, string> {
  return Object.fromEntries(
    Object.entries(sandbox.info.labels)
      .filter(([k]) => k.startsWith(META))
      .map(([k, v]) => [k.slice(META.length), v]),
  );
}

function imageRef(image: string) {
  const [path = image, digest = ""] = image.split("@");
  const slash = path.indexOf("/");
  const host =
    slash > 0 && /[.:]|localhost/.test(path.slice(0, slash)) ? path.slice(0, slash) : "docker.io";
  const rest =
    host === "docker.io" && !path.startsWith("docker.io/") ? path : path.slice(slash + 1);
  const colon = rest.lastIndexOf(":");
  return {
    registry: host,
    repository: colon > 0 ? rest.slice(0, colon) : rest,
    tag: colon > 0 ? rest.slice(colon + 1) : "latest",
    digest,
  };
}

function restartConfig(label = "no"): NonNullable<MachineConfig["restart"]> {
  const [policy = "no", max] = label.split(":");
  return max === undefined ? { policy } : { policy, max_retries: Number(max) };
}

/** A sandbox as Fly's Machine object. */
export function toMachine(sandbox: Sandbox): Machine {
  const info = sandbox.info;
  const labels = info.labels;
  const init = labels[INIT] ? (JSON.parse(labels[INIT]) as InitConfig) : {};
  const metadata = metadataOf(sandbox);
  const created = Date.parse(info.createdAt);
  return {
    id: sandbox.id,
    name: labels[NAME] ?? sandbox.id,
    state: machineState(sandbox.state),
    region: FLY_REGION[info.region] ?? info.region,
    instance_id: labels[MAIN] ?? sandbox.id,
    private_ip: "",
    config: {
      image: labels[IMAGE] ?? "",
      env: Object.fromEntries(
        (info.envNames ?? []).filter((name) => name !== RESTART_ENV).map((name) => [name, ""]),
      ),
      guest: {
        cpu_kind: info.cpu === "reserved" ? "performance" : "shared",
        cpus: info.vcpu,
        memory_mb: info.memoryMiB,
      },
      init,
      metadata,
      ...(labels[DESTROY] === "true" ? { auto_destroy: true } : {}),
      restart: restartConfig(labels[RESTART]),
    },
    image_ref: imageRef(labels[IMAGE] ?? ""),
    created_at: info.createdAt,
    updated_at: info.createdAt,
    events: [
      {
        id: `${sandbox.id}-launch`,
        type: "launch",
        status: "created",
        source: "user",
        timestamp: created,
      },
    ],
    host_status: "ok",
  };
}

/** One handler for every Machines API request, for Bun.serve, Deno.serve,
 * Hono or any server that speaks fetch. */
export function machinesApi(
  options: MachinesApiOptions = {},
): (request: Request) => Promise<Response> {
  return new MachinesApi(options).fetch;
}

/** Serves the Machines API on a port of this computer (default 4280, the
 * port of Fly's own `_api.internal`), for code that reads its address from
 * FLY_API_HOSTNAME (fly-admin's `apiUrl`, fly-go's FLY_FLAPS_BASE_URL). Off
 * this computer's loopback, a request without its own Runtime key is refused,
 * so the login it runs as is never lent to the network. */
export async function serveMachinesApi(
  options: MachinesApiOptions & { port?: number; hostname?: string } = {},
): Promise<{ url: string; close(): Promise<void> }> {
  const { port = 4280, hostname = "127.0.0.1", ...rest } = options;
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(hostname);
  const handle = machinesApi({ ...rest, requireKey: rest.requireKey ?? !loopback });
  const { createServer } = await import("node:http");
  const answer = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers))
      if (typeof v === "string") headers.set(k, v);
      else if (Array.isArray(v)) headers.set(k, v.join(", "));
    const response = await handle(
      new Request(`http://${hostname}:${port}${req.url ?? "/"}`, {
        method: req.method ?? "GET",
        headers,
        ...(body && req.method !== "GET" && req.method !== "HEAD" ? { body } : {}),
      }),
    );
    const out: Record<string, string> = {};
    response.headers.forEach((value, name) => (out[name] = value));
    res.writeHead(response.status, out);
    res.end(Buffer.from(await response.arrayBuffer()));
  };
  const server = createServer((req, res) => {
    answer(req, res).catch((error: unknown) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => resolve());
  });
  const address = server.address();
  const bound = typeof address === "object" && address ? address.port : port;
  return {
    url: `http://${hostname}:${bound}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
