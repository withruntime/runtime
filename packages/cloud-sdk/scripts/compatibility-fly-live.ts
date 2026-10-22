/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment -- answers are read as Fly clients read JSON. */
/** Fly Machines API calls, as Fly's docs write them, against Runtime's
 * answer to them (`withruntime/fly`), on the real Runtime API. Run with a
 * Runtime key: `RUNTIME_API_KEY=rtcloud_... bun scripts/compatibility-fly-live.ts --run`.
 * It makes its own machines in an app of its own and deletes every one. */
import { Runtime } from "../src/index.js";
import { serveMachinesApi } from "../src/fly/index.js";

if (!process.argv.includes("--run")) throw new Error("Pass --run: this makes real sandboxes.");
if (!process.env.RUNTIME_API_KEY) throw new Error("Set RUNTIME_API_KEY to a Runtime key.");

// The server's own login answers each call, as `npx withruntime fly-api` does.
const served = await serveMachinesApi({ port: 0, client: new Runtime() });
const app = `fly-live-${crypto.randomUUID().slice(0, 8)}`;
const base = `${served.url}/v1/apps/${app}/machines`;
const made: string[] = [];
const failures: string[] = [];

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const started = performance.now();
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: "Bearer fo1_a_fly_token_runtime_never_sends",
      "content-type": "application/json",
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const ms = Math.round(performance.now() - started);
  return { status: response.status, body: text ? JSON.parse(text) : undefined, ms };
}
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(name);
}

try {
  // A long-running machine, as the Machines API docs create one.
  const created = await call("POST", "", {
    name: "worker",
    region: "iad",
    config: {
      image: "python:3.12-slim",
      init: { cmd: ["python3", "-m", "http.server", "8080"] },
      env: { GREETING: "hello from fly config" },
      guest: { cpu_kind: "shared", cpus: 1, memory_mb: 1024 },
      metadata: { team: "agents" },
      files: [
        {
          guest_path: "/srv/note.txt",
          raw_value: Buffer.from("a file from config\n").toString("base64"),
        },
      ],
    },
  });
  check(
    "create answers a started machine",
    created.status === 200 && created.body.state === "started",
    `${created.status} ${created.body.state ?? created.body.error} in ${created.ms} ms`,
  );
  const id = created.body.id as string;
  made.push(id);
  check(
    "name, guest and metadata read back",
    created.body.name === "worker" &&
      created.body.config.guest.memory_mb === 1024 &&
      created.body.config.metadata.team === "agents",
  );

  const waited = await call("GET", `/${id}/wait?state=started&timeout=30`);
  check("wait for started", waited.status === 200 && waited.body.ok === true, `${waited.ms} ms`);

  const exec = await call("POST", `/${id}/exec`, {
    command: [
      "sh",
      "-c",
      'cat /srv/note.txt; echo $GREETING; python3 -c \'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8080/"); print("serving")\'',
    ],
    timeout: 30,
  });
  check(
    "exec sees the file, env and main process",
    exec.status === 200 &&
      exec.body.exit_code === 0 &&
      exec.body.stdout === "a file from config\nhello from fly config\nserving\n",
    `${JSON.stringify(exec.body.stdout ?? exec.body.error)} in ${exec.ms} ms`,
  );
  const failing = await call("POST", `/${id}/exec`, { cmd: "exit 3" });
  check("exec answers a failing exit code", failing.body.exit_code === 3);

  const listed = await call("GET", "?metadata.team=agents");
  check(
    "list by metadata finds it",
    listed.status === 200 && listed.body.length === 1 && listed.body[0].id === id,
  );

  const meta = await call("POST", `/${id}/metadata/stage`, { value: "live" });
  const metaRead = await call("GET", `/${id}/metadata`);
  check("metadata set and read", meta.status === 204 && metaRead.body.stage === "live");

  const lease = await call("POST", `/${id}/lease`, { ttl: 60 });
  const blocked = await call("POST", `/${id}/suspend`);
  check(
    "a lease blocks another client",
    lease.status === 200 && blocked.status === 409,
    `${blocked.status}`,
  );
  const nonce = { "fly-machine-lease-nonce": lease.body.data.nonce as string };

  const suspend = await call("POST", `/${id}/suspend`, undefined, nonce);
  const suspended = await call("GET", `/${id}/wait?state=suspended&timeout=60`);
  check(
    "suspend keeps memory",
    suspend.status === 200 && suspended.status === 200,
    `suspend ${suspend.ms} ms`,
  );
  const start = await call("POST", `/${id}/start`, undefined, nonce);
  check(
    "start of a suspended machine",
    start.status === 200 && start.body.previous_state === "suspended",
    `${start.ms} ms`,
  );
  const still = await call("POST", `/${id}/exec`, {
    command: [
      "sh",
      "-c",
      'python3 -c \'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8080/"); print("serving")\'',
    ],
  });
  check(
    "the main process survived the suspend",
    still.body.stdout === "serving\n",
    JSON.stringify(still.body),
  );

  const updated = await call(
    "POST",
    `/${id}`,
    {
      config: {
        ...created.body.config,
        env: { GREETING: "hello again" },
        metadata: { team: "agents", stage: "live" },
      },
    },
    nonce,
  );
  const after = await call("POST", `/${id}/exec`, { command: ["sh", "-c", "echo $GREETING"] });
  check(
    "update sets env and metadata",
    updated.status === 200 &&
      updated.body.config.metadata.stage === "live" &&
      after.body.stdout === "hello again\n",
    `${updated.ms} ms`,
  );
  const grown = await call(
    "POST",
    `/${id}`,
    {
      config: {
        ...updated.body.config,
        env: { GREETING: "hello again" },
        guest: { cpu_kind: "shared", cpus: 2, memory_mb: 2048 },
      },
    },
    nonce,
  );
  console.log(
    `     a size change answers ${grown.status}: ${grown.status === 200 ? "resized" : String(grown.body.error).split(";")[0]}`,
  );
  const refuse = await call("DELETE", `/${id}`, undefined, nonce);
  check("delete of a started machine needs force", refuse.status === 412);
  const stop = await call("POST", `/${id}/stop`, undefined, nonce);
  const stopped = await call("GET", `/${id}/wait?state=stopped&timeout=60`);
  check("stop", stop.status === 200 && stopped.status === 200, `${stop.ms} ms`);
  const restart = await call("POST", `/${id}/start`, undefined, nonce);
  const back = await call("POST", `/${id}/exec`, { command: ["cat", "/srv/note.txt"] });
  check(
    "start of a stopped machine",
    restart.status === 200 &&
      restart.body.previous_state === "stopped" &&
      back.body.stdout === "a file from config\n",
    `${restart.ms} ms ${JSON.stringify(restart.body)} ${JSON.stringify(back.body)}`,
  );
  const serving = await call("POST", `/${id}/exec`, {
    command: [
      "sh",
      "-c",
      'sleep 1; python3 -c \'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8080/"); print("serving")\'',
    ],
  });
  check(
    "the main process runs again after the start",
    serving.body.stdout === "serving\n",
    JSON.stringify(serving.body),
  );
  await call("DELETE", `/${id}/lease`, undefined, nonce);
  const removed = await call("DELETE", `/${id}?force=true`);
  check("delete with force", removed.status === 200);
  made.splice(made.indexOf(id), 1);

  // A one-shot job: the main process ends, and auto_destroy removes it.
  const job = await call("POST", "", {
    config: {
      image: "alpine:3.20",
      init: { exec: ["sh", "-c", "echo job done; sleep 1"] },
      auto_destroy: true,
      restart: { policy: "no" },
    },
  });
  check(
    "a job machine starts",
    job.status === 200,
    `${job.body.state ?? job.body.error} in ${job.ms} ms`,
  );
  if (job.body.id) made.push(job.body.id);
  const destroyed = await call("GET", `/${job.body.id}/wait?state=destroyed&timeout=60`);
  check(
    "its machine is destroyed when the job ends",
    destroyed.status === 200,
    `${destroyed.status} after ${destroyed.ms} ms`,
  );
  if (destroyed.status === 200) made.pop();

  const services = await call("POST", "", {
    config: {
      image: "alpine:3.20",
      services: [{ internal_port: 8080, protocol: "tcp", ports: [{ port: 443 }] }],
    },
  });
  check(
    "services are refused, naming previews",
    services.status === 400 && /preview/.test(services.body.error),
  );
  const region = await call("POST", "", { region: "ams", config: { image: "alpine:3.20" } });
  check(
    "a region Runtime lacks is refused",
    region.status === 400 && /us-east/.test(region.body.error),
  );
  const bare = await serveMachinesApi({ port: 0 });
  const fly = await fetch(`${bare.url}/v1/apps/${app}/machines`, {
    headers: { authorization: "Bearer fo1_not_a_runtime_key" },
  });
  await bare.close();
  check("a Fly token alone is refused, never forwarded", fly.status === 401);
} finally {
  for (const id of made) await call("DELETE", `/${id}?force=true`).catch(() => undefined);
  await served.close();
}
console.log(failures.length ? `${failures.length} failed` : "all passed");
process.exit(failures.length ? 1 : 0);
