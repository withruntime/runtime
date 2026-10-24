/* eslint-disable @typescript-eslint/no-explicit-any -- the fake keeps loose records, as the API answers them. */
import { expect, test } from "bun:test";
import type { Runtime } from "../../src/client.js";
import { NotFoundError } from "../../src/errors.js";
import {
  dockerfileFor,
  machinesApi,
  restartOf,
  serveMachinesApi,
  supervised,
} from "../../src/fly/index.js";

/* Fly Machines API calls as Fly's docs write them, answered by a fake of the
   few SDK calls `withruntime/fly` makes. scripts/compatibility-fly-live.ts
   makes the same calls on the real API. */

type Proc = { id: string; state: string; command: string; cwd: string };
class FakeSandbox {
  state = "running";
  procs: Proc[] = [];
  deleted = false;
  calls: string[];
  info: Record<string, any>;
  constructor(
    readonly id: string,
    input: Record<string, any>,
    calls: string[],
    main?: string,
  ) {
    this.calls = calls;
    this.info = {
      labels: { ...input.labels },
      region: "us-east",
      vcpu: input.vcpu,
      memoryMiB: input.memoryMiB,
      cpu: input.cpu,
      createdAt: "2026-10-15T00:00:00.000Z",
      envNames: Object.keys(input.env ?? {}),
      ...(main ? { start: { state: "started", processId: main } } : {}),
    };
    if (main) this.procs.push({ id: main, state: "running", command: "main", cwd: "/" });
  }
  processes = {
    get: async (id: string) => {
      const found = this.procs.find((p) => p.id === id);
      if (!found)
        throw new NotFoundError({ message: "no", code: "process_not_found", status: 404 });
      return { ...found, kill: async (signal: string) => void this.calls.push(`kill ${signal}`) };
    },
    list: async () => this.procs,
  };
  async update(change: Record<string, any>) {
    this.calls.push(`update ${Object.keys(change).join(",")}`);
    if (change.labels) this.info.labels = change.labels;
    if (change.env)
      this.info.envNames = [
        ...this.info.envNames.filter((n: string) => change.env[n] !== null),
        ...Object.keys(change.env).filter(
          (n) => change.env[n] !== null && !this.info.envNames.includes(n),
        ),
      ];
    return this;
  }
  async stop() {
    this.calls.push("stop");
    this.state = "stopped";
    this.procs.forEach((p) => (p.state = "killed"));
    return this;
  }
  async pause() {
    this.calls.push("pause");
    this.state = "paused";
    return this;
  }
  async wake() {
    this.calls.push("wake");
    this.state = "running";
    return this;
  }
  async restart() {
    this.calls.push("restart");
    this.state = "running";
    return this;
  }
  async spawn(command: string[]) {
    this.calls.push(`spawn ${command.join(" ")}`);
    const proc = {
      id: `p${this.procs.length + 1}`,
      state: "running",
      command: command.join(" "),
      cwd: "/",
    };
    this.procs.push(proc);
    return proc;
  }
  async delete() {
    this.calls.push("delete");
    this.deleted = true;
    return {};
  }
  async refresh() {
    if (this.deleted)
      throw new NotFoundError({ message: "gone", code: "sandbox_not_found", status: 404 });
    return this;
  }
  async exec(argv: string[], options: { timeoutMs?: number; stdin?: string } = {}) {
    this.calls.push(`exec ${JSON.stringify(argv)} ${options.timeoutMs ?? ""}`);
    if (argv.includes("sleep 99"))
      return { exitCode: null, stdout: "", stderr: "", timedOut: true };
    return {
      exitCode: argv.includes("exit 3") ? 3 : 0,
      stdout: `ran ${argv.at(-1)}\n`,
      stderr: "",
      timedOut: false,
    };
  }
}

function world() {
  const calls: string[] = [];
  const sandboxes: FakeSandbox[] = [];
  const images: { id: string; name: string; dockerfile: string; files: unknown[] }[] = [];
  const runtime = {
    images: {
      list: async ({ name }: { name: string }) => ({ data: images.filter((i) => i.name === name) }),
      build: async (input: { name: string; dockerfile: string; files: unknown[] }) => {
        calls.push(`build ${input.name}`);
        const image = { id: `img${images.length + 1}`, ...input };
        images.push(image);
        return image;
      },
      // The start command an image runs: its ENTRYPOINT, as the server reads it.
      get: async (id: string) => {
        const line = images
          .find((i) => i.id === id)
          ?.dockerfile.split("\n")
          .find((l) => l.startsWith("ENTRYPOINT "));
        return {
          start: { argv: line ? (JSON.parse(line.slice(11)) as string[]) : ["sleep", "infinity"] },
        };
      },
    },
    sandboxes: {
      create: async (input: Record<string, any>) => {
        calls.push(
          `create ${JSON.stringify({ vcpu: input.vcpu, memoryMiB: input.memoryMiB, cpu: input.cpu })}`,
        );
        const sandbox = new FakeSandbox(`sbx${sandboxes.length + 1}`, input, calls, "main1");
        sandboxes.push(sandbox);
        return sandbox;
      },
      get: async (id: string) => {
        const found = sandboxes.find((s) => s.id === id && !s.deleted);
        if (!found)
          throw new NotFoundError({ message: "no", code: "sandbox_not_found", status: 404 });
        return found;
      },
      list: async ({ labels }: { labels: Record<string, string> }) =>
        sandboxes.filter(
          (s) => !s.deleted && Object.entries(labels).every(([k, v]) => s.info.labels[k] === v),
        ),
    },
  } as unknown as Runtime;
  const handle = machinesApi({ client: runtime });
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const response = await handle(
      new Request(`http://localhost:4280/v1/apps/${path}`, {
        method,
        headers: { authorization: "Bearer fo1_fly_token", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
  return { calls, sandboxes, images, call, runtime };
}

const job = { config: { image: "alpine:3.20", init: { cmd: ["sleep", "infinity"] } } };

test("create builds the image once and answers a started Machine with Fly's default size", async () => {
  const w = world();
  const first = await w.call("POST", "web/machines", {
    name: "one",
    ...job,
    config: { ...job.config, metadata: { team: "a" } },
  });
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({
    name: "one",
    state: "started",
    config: {
      image: "alpine:3.20",
      init: { cmd: ["sleep", "infinity"] },
      metadata: { team: "a" },
      guest: { cpus: 1, memory_mb: 256, cpu_kind: "shared" },
    },
    image_ref: { registry: "docker.io", repository: "alpine", tag: "3.20" },
  });
  await w.call("POST", "web/machines", job);
  // The image as Docker runs it, then its main process under the supervisor.
  expect(w.calls.filter((c) => c.startsWith("build"))).toHaveLength(2);
  expect(w.images[0]!.dockerfile).toBe('FROM alpine:3.20\nCMD ["sleep","infinity"]\n');
  expect(w.images[1]!.dockerfile).toBe(
    `FROM alpine:3.20\nENTRYPOINT ${JSON.stringify(supervised(["sleep", "infinity"]))}\nCMD []\n`,
  );
  expect(w.calls).toContain('create {"vcpu":1,"memoryMiB":256,"cpu":"shared"}');
  const perf = await w.call("POST", "web/machines", {
    config: { ...job.config, guest: { cpu_kind: "performance", cpus: 2, memory_mb: 4096 } },
  });
  expect(perf.body.config.guest).toEqual({ cpu_kind: "performance", cpus: 2, memory_mb: 4096 });
});

test("Fly's init rules become a Dockerfile, and files are copied in", () => {
  expect(dockerfileFor("img", { exec: ["/bin/app", "-v"] })).toBe(
    'FROM img\nENTRYPOINT ["/bin/app","-v"]\nCMD []\n',
  );
  expect(dockerfileFor("img", { entrypoint: ["tini", "--"] })).toBe(
    'FROM img\nENTRYPOINT ["tini","--"]\nCMD []\n',
  );
  expect(dockerfileFor("img", { entrypoint: ["tini"], cmd: ["app"] })).toBe(
    'FROM img\nENTRYPOINT ["tini"]\nCMD ["app"]\n',
  );
  expect(dockerfileFor("img", {}, [{ guest_path: "/etc/app.conf", raw_value: "eA==" }])).toBe(
    'FROM img\nCOPY fly-file-0 "/etc/app.conf"\n',
  );
  expect(() => dockerfileFor("img\nRUN rm -rf /")).toThrow("not an image reference");
});

test("list is per app and filters by metadata", async () => {
  const w = world();
  await w.call("POST", "a/machines", {
    ...job,
    config: { ...job.config, metadata: { role: "x" } },
  });
  await w.call("POST", "a/machines", job);
  await w.call("POST", "b/machines", job);
  expect((await w.call("GET", "a/machines")).body).toHaveLength(2);
  expect((await w.call("GET", "a/machines?metadata.role=x")).body).toHaveLength(1);
  expect((await w.call("GET", "")).body).toMatchObject({ total_apps: 2 });
  const other = (await w.call("GET", "b/machines")).body[0].id;
  expect((await w.call("GET", `a/machines/${other}`)).status).toBe(404);
});

test("stop, suspend and start map to stop, pause, wake and restart with the main process run again", async () => {
  const w = world();
  const { id } = (await w.call("POST", "a/machines", job)).body;
  expect((await w.call("POST", `a/machines/${id}/suspend`)).body).toEqual({ ok: true });
  expect((await w.call("GET", `a/machines/${id}`)).body.state).toBe("suspended");
  expect((await w.call("POST", `a/machines/${id}/start`)).body.previous_state).toBe("suspended");
  await w.call("POST", `a/machines/${id}/stop`);
  expect((await w.call("GET", `a/machines/${id}/wait?state=stopped&timeout=1`)).body).toEqual({
    ok: true,
    state: "stopped",
  });
  expect((await w.call("POST", `a/machines/${id}/start`)).body.previous_state).toBe("stopped");
  expect(w.calls.slice(-6)).toEqual([
    "pause",
    "wake",
    "stop",
    "restart",
    `spawn ${supervised(["sleep", "infinity"]).join(" ")}`,
    "update labels",
  ]);
  expect((await w.call("GET", `a/machines/${id}`)).body).toMatchObject({
    state: "started",
    instance_id: "p2",
  });
});

test("a restart that runs the start command itself is not run twice", async () => {
  const w = world();
  const { id } = (await w.call("POST", "a/machines", job)).body;
  await w.call("POST", `a/machines/${id}/stop`);
  const sandbox = w.sandboxes[0]!;
  sandbox.restart = async () => {
    sandbox.state = "running";
    sandbox.info.start = { state: "started", processId: "server-run" };
    return sandbox;
  };
  await w.call("POST", `a/machines/${id}/start`);
  expect(w.calls.some((c) => c.startsWith("spawn"))).toBe(false);
  expect(sandbox.info.labels["fly.main"]).toBe("server-run");
  // A start command that already ended (start.state "exited") is a main
  // process that exited: the machine reads stopped, nothing is started.
  sandbox.procs.push({ id: "server-run", state: "exited", command: "main", cwd: "/" });
  expect((await w.call("GET", `a/machines/${id}`)).body.state).toBe("stopped");
  expect(w.calls.some((c) => c.startsWith("spawn"))).toBe(false);
});

test("a main process that ends stops the machine, or destroys it with auto_destroy", async () => {
  const w = world();
  const kept = (await w.call("POST", "a/machines", job)).body.id;
  w.sandboxes[0]!.procs[0]!.state = "exited";
  expect((await w.call("GET", `a/machines/${kept}`)).body.state).toBe("stopped");
  expect(w.calls).toContain("stop");
  const gone = (
    await w.call("POST", "a/machines", { config: { ...job.config, auto_destroy: true } })
  ).body.id;
  w.sandboxes[1]!.procs[0]!.state = "exited";
  expect((await w.call("GET", `a/machines/${gone}/wait?state=destroyed&timeout=1`)).body).toEqual({
    ok: true,
    state: "destroyed",
  });
  expect(w.sandboxes[1]!.deleted).toBe(true);
});

test("delete of a started machine needs force (or fly-admin's kill)", async () => {
  const w = world();
  const { id } = (await w.call("POST", "a/machines", job)).body;
  expect((await w.call("DELETE", `a/machines/${id}`)).status).toBe(412);
  expect((await w.call("DELETE", `a/machines/${id}?kill=true`)).body).toEqual({ ok: true });
  // Fly reads a destroyed machine back as destroyed for a while.
  expect((await w.call("GET", `a/machines/${id}`)).body.state).toBe("destroyed");
  expect((await w.call("POST", `a/machines/${id}/exec`, { cmd: "true" })).status).toBe(404);
});

test("exec runs an argument list or a shell string, and a timeout is 408", async () => {
  const w = world();
  const { id } = (await w.call("POST", "a/machines", job)).body;
  expect(
    (await w.call("POST", `a/machines/${id}/exec`, { command: ["echo", "hi"], timeout: 5 })).body,
  ).toEqual({ exit_code: 0, exit_signal: 0, stdout: "ran hi\n", stderr: "" });
  expect((await w.call("POST", `a/machines/${id}/exec`, { cmd: "exit 3" })).body.exit_code).toBe(3);
  expect(w.calls).toContain('exec ["echo","hi"] 5000');
  expect(
    (await w.call("POST", `a/machines/${id}/exec`, { cmd: "sleep 99", timeout: 1 })).status,
  ).toBe(408);
});

test("metadata, update, signal and leases", async () => {
  const w = world();
  const created = (
    await w.call("POST", "a/machines", {
      ...job,
      config: { ...job.config, env: { A: "1", B: "2" } },
    })
  ).body;
  const { id } = created;
  expect((await w.call("POST", `a/machines/${id}/metadata/k`, { value: "v" })).status).toBe(204);
  expect((await w.call("GET", `a/machines/${id}/metadata`)).body).toEqual({ k: "v" });
  expect((await w.call("DELETE", `a/machines/${id}/metadata/k`)).status).toBe(204);
  const updated = await w.call("POST", `a/machines/${id}`, {
    config: { ...job.config, env: { A: "3" }, metadata: { m: "1" } },
  });
  expect(updated.body.config).toMatchObject({ env: { A: "" }, metadata: { m: "1" } });
  expect((await w.call("POST", `a/machines/${id}`, { config: { image: "other:1" } })).status).toBe(
    400,
  );
  expect((await w.call("POST", `a/machines/${id}/signal`, { signal: "SIGHUP" })).body).toEqual({
    ok: true,
  });
  // The program under the supervisor gets the signal, by the pid it wrote.
  expect(w.calls.at(-1)).toContain('"HUP"');

  const lease = (await w.call("POST", `a/machines/${id}/lease`, { ttl: 30 })).body.data;
  expect((await w.call("GET", `a/machines/${id}/lease`)).body.data.nonce).toBe(lease.nonce);
  expect((await w.call("POST", `a/machines/${id}/stop`)).status).toBe(409);
  expect((await w.call("POST", `a/machines/${id}/lease`, { ttl: 30 })).status).toBe(409);
  expect((await w.call("POST", `a/machines/${id}/exec`, { cmd: "true" })).status).toBe(200);
  const nonce = { "fly-machine-lease-nonce": lease.nonce };
  expect((await w.call("POST", `a/machines/${id}/stop`, undefined, nonce)).status).toBe(200);
  expect((await w.call("DELETE", `a/machines/${id}/lease`, undefined, nonce)).status).toBe(200);
  expect((await w.call("GET", `a/machines/${id}/lease`)).status).toBe(404);
});

test("metadata in bulk, one key, versions, the org's machines and the regions", async () => {
  const w = world();
  const { id } = (await w.call("POST", "a/machines", job)).body;
  await w.call("POST", "b/machines", job);
  expect(
    (await w.call("PATCH", `a/machines/${id}/metadata`, { metadata: { x: "1", y: "2" } })).status,
  ).toBe(204);
  expect((await w.call("GET", `a/machines/${id}/metadata/x`)).body).toEqual({ value: "1" });
  expect((await w.call("GET", `a/machines/${id}/metadata/nope`)).status).toBe(404);
  expect((await w.call("GET", `a/machines/${id}/versions`)).body[0].user_config.id).toBe(id);
  expect((await w.call("GET", `a/machines/${id}/memory`)).status).toBe(400);
  const org = await w.call("GET", "../orgs/personal/machines");
  expect(org.body.machines.map((m: { app_name: string }) => m.app_name).sort()).toEqual(["a", "b"]);
  expect((await w.call("GET", "../platform/regions")).body).toMatchObject({
    nearest: "iad",
    regions: [{ code: "iad" }],
  });
});

test("what Runtime cannot keep is refused with its alternative, before anything is made", async () => {
  const w = world();
  const refused = async (body: unknown) =>
    (await w.call("POST", "a/machines", body)).body.error as string;
  expect(await refused({ config: { ...job.config, services: [{ internal_port: 80 }] } })).toContain(
    "previews",
  );
  expect(
    await refused({ config: { ...job.config, mounts: [{ volume: "v", path: "/data" }] } }),
  ).toContain("volumes");
  expect(await refused({ config: { ...job.config, restart: { policy: "sometimes" } } })).toContain(
    "restart.policy must be one of",
  );
  expect(
    await refused({ config: { ...job.config, guest: { gpus: 1, gpu_kind: "a100" } } }),
  ).toContain("guest.gpus");
  expect(
    await refused({ config: { ...job.config, files: [{ guest_path: "/x", secret_name: "S" }] } }),
  ).toContain("secrets");
  expect(await refused({ region: "ams", ...job })).toContain("us-east");
  expect(await refused({ config: {} })).toBe("config.image is required.");
  expect(w.calls).toEqual([]);
  // What Fly's own tools send empty is no request for anything.
  expect(
    (
      await w.call("POST", "a/machines", {
        region: "iad",
        config: { ...job.config, services: [], mounts: [], checks: {} },
      })
    ).status,
  ).toBe(200);
});

test("a Fly token alone is refused, and never leaves", async () => {
  const handle = machinesApi({});
  const response = await handle(
    new Request("http://localhost/v1/apps/a/machines", {
      headers: { authorization: "Bearer fo1_secret" },
    }),
  );
  expect(response.status).toBe(401);
  expect(await response.text()).toContain("Runtime API key");
});

test("serveMachinesApi answers over HTTP, as fly-admin and fly-go call it", async () => {
  const w = world();
  const served = await serveMachinesApi({ port: 0, client: w.runtime });
  try {
    const response = await fetch(`${served.url}/v1/apps/a/machines`, {
      method: "POST",
      headers: { authorization: "Bearer fo1_x", "content-type": "application/json" },
      body: JSON.stringify(job),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(((await response.json()) as { state: string }).state).toBe("started");
  } finally {
    await served.close();
  }
});

test("the restart policy is kept: set at create, read back, changed by an update", async () => {
  const w = world();
  const created = (
    await w.call("POST", "a/machines", {
      config: { ...job.config, restart: { policy: "on-failure", max_retries: 3 } },
    })
  ).body;
  expect(created.config.restart).toEqual({ policy: "on-failure", max_retries: 3 });
  expect(created.config.env).toEqual({});
  const updated = await w.call("POST", `a/machines/${created.id}`, {
    config: { ...job.config, restart: { policy: "always" } },
  });
  expect(updated.body.config.restart).toEqual({ policy: "always" });
  // The running supervisor reads the change from its file.
  expect(w.calls).toContain(
    'exec ["sh","-c","printf %s \\"$1\\" > /tmp/.fly-restart","fly","always"] ',
  );
  expect(restartOf(undefined)).toBe("no");
});

/** The supervisor itself, run by this computer's sh: how many times it runs
 * a program that always fails, and what it exits with. */
/* The supervisor's second between runs is a `sleep 1` it runs by name: a
   `sleep` first on PATH writes down what it was asked and returns at once. */
async function supervise(policy: string, program: string) {
  const fs = await import("node:fs/promises");
  const dir = await fs.mkdtemp("/tmp/fly-sup-");
  await fs.writeFile(`${dir}/sleep`, `#!/bin/sh\necho "$@" >> ${dir}/sleeps\n`, { mode: 0o755 });
  const argv = supervised(["sh", "-c", `echo run >> ${dir}/runs; ${program}`]);
  const child = Bun.spawn(argv, {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, RUNTIME_FLY_RESTART: policy },
  });
  const code = await child.exited;
  const runs = (await Bun.file(`${dir}/runs`).text()).trim().split("\n").length;
  const sleeps = await Bun.file(`${dir}/sleeps`)
    .text()
    .then((text) => text.trim().split("\n"))
    .catch(() => []);
  return { code, runs, sleeps };
}

test("the supervisor runs a failing program again as flyd would", async () => {
  expect(await supervise("no", "exit 4")).toEqual({ code: 4, runs: 1, sleeps: [] });
  expect(await supervise("on-failure:2", "exit 5")).toEqual({
    code: 5,
    runs: 3,
    sleeps: ["1", "1"],
  });
  expect(await supervise("on-failure:2", "exit 0")).toEqual({ code: 0, runs: 1, sleeps: [] });
});

test("served beyond loopback, the login is never lent: each request needs its own key", async () => {
  const w = world();
  const served = await serveMachinesApi({ port: 0, hostname: "0.0.0.0", client: w.runtime });
  try {
    const url = served.url.replace("0.0.0.0", "127.0.0.1");
    const refused = await fetch(`${url}/v1/apps/a/machines`, {
      headers: { authorization: "Bearer fo1_a_fly_token" },
    });
    expect(refused.status).toBe(401);
    expect(await refused.text()).toContain("its own Runtime API key");
    expect(w.calls).toEqual([]);
  } finally {
    await served.close();
  }
});

test("a machine reads Fly's region code, and a body that is not JSON says so", async () => {
  const w = world();
  expect((await w.call("POST", "a/machines", job)).body.region).toBe("iad");
  const handle = machinesApi({ client: w.runtime });
  const response = await handle(
    new Request("http://localhost/v1/apps/a/machines", {
      method: "POST",
      body: '{"config": {"image": "x" "env": {}}}',
    }),
  );
  expect(response.status).toBe(400);
  expect(((await response.json()) as { error: string }).error).toContain("not valid JSON");
});

test("a machine its job destroyed during create still reads destroyed, as on Fly", async () => {
  const w = world();
  const realCreate = w.runtime.sandboxes.create.bind(w.runtime.sandboxes);
  // The job ends before create answers.
  w.runtime.sandboxes.create = (async (input: never) => {
    const made = (await realCreate(input)) as unknown as FakeSandbox;
    made.procs[0]!.state = "exited";
    return made;
  }) as never;
  const created = await w.call("POST", "a/machines", {
    config: { ...job.config, auto_destroy: true },
  });
  expect(created.body.state).toBe("destroyed");
  const id = created.body.id as string;
  expect((await w.call("GET", `a/machines/${id}/wait?state=destroyed&timeout=1`)).body).toEqual({
    ok: true,
    state: "destroyed",
  });
  expect((await w.call("GET", `a/machines/${id}`)).body.state).toBe("destroyed");
  expect((await w.call("GET", `b/machines/${id}`)).status).toBe(404);
  expect((await w.call("POST", `a/machines/${id}/start`)).status).toBe(404);
});
