/** Morph Cloud's quickstart, branch, pause and HTTP-service calls through
 * `withruntime/morph` against the real Runtime API, timed. Creates its own
 * sandboxes (each capped at 5 cents and five minutes) and snapshots, and
 * deletes every one it made; never touches anything else.
 *
 *   bun scripts/compatibility-morph-live.ts --run */
import { Runtime } from "../src/client";
import {
  MorphCloudClient,
  InstanceStatus,
  SnapshotStatus,
  type Instance,
} from "../src/morph/index";

if (!process.argv.includes("--run")) {
  console.log("Pass --run to create up to four sandboxes, each capped at $0.05 and five minutes.");
  process.exit(0);
}
if (!process.env.RUNTIME_API_KEY)
  throw new Error("A dedicated RUNTIME_API_KEY test key is required.");
const native = new Runtime();
const sandboxes = new Set<string>();
const snapshots = new Set<string>();
const create = native.sandboxes.create.bind(native.sandboxes);
native.sandboxes.create = async (input = {}, options) => {
  const sandbox = await create(
    {
      ...input,
      timeoutSeconds: input.timeoutSeconds ?? 300,
      maxTotalCostMicros: 50_000,
      labels: { ...input.labels, "compat-run": RUN },
    },
    options,
  );
  sandboxes.add(sandbox.id);
  return sandbox;
};
const RUN = crypto.randomUUID().slice(0, 8);
const morph = new MorphCloudClient({ client: native });
const timings: Record<string, number> = {};
async function timed<T>(name: string, step: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const value = await step();
  timings[name] = Math.round(performance.now() - started);
  return value;
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
  console.log(`ok  ${message}`);
}

let failed = false;
try {
  // The quickstart: a snapshot of the base image, set up once, then started.
  const base = await timed("snapshots.create", () =>
    morph.snapshots.create({
      imageId: "morphvm-minimal",
      vcpus: 1,
      memory: 2048,
      diskSize: 4096,
      digest: `compat-${RUN}`,
    }),
  );
  snapshots.add(base.id);
  check(
    base.status === SnapshotStatus.READY && base.spec.vcpus === 1,
    "snapshots.create makes a ready 1 vCPU snapshot",
  );
  const again = await morph.snapshots.create({ digest: `compat-${RUN}` });
  check(again.id === base.id, "snapshots.create with the same digest answers the same snapshot");

  const ready = await timed("snapshot.setup", () =>
    base.setup("mkdir -p /workspace && echo set-up > /workspace/setup.txt"),
  );
  snapshots.add(ready.id);
  const cached = await timed("snapshot.setup (cached)", () =>
    base.setup("mkdir -p /workspace && echo set-up > /workspace/setup.txt"),
  );
  check(cached.id === ready.id, "setup of the same command answers the cached snapshot");

  const instance: Instance = await timed("instances.start", () =>
    morph.instances.start({ snapshotId: ready.id, metadata: { run: RUN }, ttlSeconds: 300 }),
  );
  check(instance.status === InstanceStatus.READY, "instances.start answers a ready instance");
  check(instance.ttl.ttlSeconds === 300, "the TTL is the sandbox's time limit");

  const file = await timed("exec", () => instance.exec("cat /workspace/setup.txt"));
  check(
    file.exit_code === 0 && file.stdout.trim() === "set-up",
    "setup's file is in the started instance",
  );
  const argv = await instance.exec(["python3", "-c", "print(6 * 7)"]);
  check(argv.stdout.trim() === "42", "exec of an argument list runs it");
  const streamed: string[] = [];
  await instance.exec("for i in 1 2 3; do echo $i; sleep 0.2; done", {
    onStdout: (text) => streamed.push(text),
  });
  check(streamed.join("").replace(/\s/g, "") === "123", "onStdout streams output");
  const failing = await instance.exec("exit 3");
  check(failing.exit_code === 3, "a failing command answers its exit code");

  await instance.setMetadata({ stage: "checked" });
  const listed = await morph.instances.list({ metadata: { run: RUN, stage: "checked" } });
  check(listed.length === 1 && listed[0]!.id === instance.id, "instances.list filters by metadata");
  check(listed[0]!.metadata?.stage === "checked", "metadata reads back");

  // A server kept across pause and resume, and shared over HTTP.
  await instance.native.spawn("cd /workspace && python3 -m http.server 8000");
  await instance.exec(
    "for i in $(seq 50); do curl -s localhost:8000 >/dev/null && break; sleep 0.1; done",
  );
  const service = await instance.exposeHttpService("web", 8000, "api_key");
  check(service.url.startsWith("https://"), "exposeHttpService answers an HTTPS address");
  const token = (await instance.native.previews.get(8000)).token!;
  const page = await fetch(new URL("setup.txt", service.url), {
    headers: { "x-runtime-preview-token": token },
  });
  check(
    page.status === 200 && (await page.text()).trim() === "set-up",
    "the service answers through its address",
  );
  check(
    (await morph.instances.get({ instanceId: instance.id })).networking.httpServices[0]?.name ===
      "web",
    "networking.httpServices names the service",
  );

  await timed("pause", () => instance.pause());
  check((instance.status as InstanceStatus) === InstanceStatus.PAUSED, "pause leaves it paused");
  await timed("resume", () => instance.resume());
  check((instance.status as InstanceStatus) === InstanceStatus.READY, "resume makes it ready");
  const alive = await instance.exec("curl -s localhost:8000/setup.txt");
  check(alive.stdout.trim() === "set-up", "the server kept running through pause and resume");

  const branched = await timed("branch(2)", () => instance.branch(2));
  snapshots.add(branched.snapshot.id);
  for (const copy of branched.instances) sandboxes.add(copy.id);
  check(branched.instances.length === 2, "branch(2) answers two instances");
  for (const copy of branched.instances) {
    const served = await copy.exec("curl -s localhost:8000/setup.txt");
    check(
      served.stdout.trim() === "set-up",
      `branch ${copy.id.slice(0, 8)} has the running server`,
    );
  }

  const kept = await timed("instance.snapshot", () =>
    instance.snapshot({ metadata: { kind: "kept" } }),
  );
  snapshots.add(kept.id);
  check(kept.metadata?.kind === "kept", "instance.snapshot keeps its metadata");
  check(
    (await morph.snapshots.list({ metadata: { kind: "kept" } })).some((s) => s.id === kept.id),
    "snapshots.list filters by metadata",
  );

  for (const copy of branched.instances) await copy.stop();
  await timed("stop", () => instance.stop());
  check(
    (await morph.instances.list({ metadata: { run: RUN } })).length === 0,
    "stopped instances leave the list",
  );
} catch (error) {
  failed = true;
  console.error(`FAIL ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  for (const id of sandboxes)
    await native.sandboxes.delete(id).catch((error: unknown) => {
      failed = true;
      console.error(`Cleanup of sandbox ${id} failed: ${String(error)}`);
    });
  for (const id of snapshots)
    await native.snapshots.delete(id).catch((error: unknown) => {
      failed = true;
      console.error(`Cleanup of snapshot ${id} failed: ${String(error)}`);
    });
}
console.log(JSON.stringify({ timingsMs: timings }, null, 2));
process.exitCode = failed ? 1 : 0;
