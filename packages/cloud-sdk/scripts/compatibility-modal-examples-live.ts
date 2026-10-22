/** Modal's own documented sandbox examples, TypeScript and Python, run
 * against real Runtime sandboxes with nothing changed but the import. The
 * programs are copies of Modal's: tests/fixtures/modal/*.ts (modal-client's
 * js/examples at js/v0.11.1, the version withruntime/modal pins) and
 * sdks/python/tests/fixtures/modal/*.py (modal.com/docs/guide/sandbox* and
 * modal-examples' 13_sandboxes), each naming its source and the day it was
 * read. Each runs in its own process on what a customer installs: the
 * compiled package under Node, and the Python package under python3.
 *
 *   bun scripts/compatibility-modal-examples-live.ts --run            # all of them
 *   bun scripts/compatibility-modal-examples-live.ts --run --only fs  # names containing "fs"
 *
 * An example passes when it exits 0 and prints what Modal's own example says
 * it prints; one the adapter refuses passes when it stops with a
 * CompatibilityError naming Runtime's alternative. Costs are kept tiny: three
 * examples at a time, and every sandbox they create gets a five-minute limit
 * and a two-cent cap (the create request is amended on its way out), is
 * recorded, and is deleted when its example ends, with every snapshot taken
 * of it. It never touches a sandbox, snapshot or volume it did not create, and
 * no volume is created (the adapter refuses Modal's elastic volumes). Uses
 * RUNTIME_API_KEY. Not part of `bun test` or CI. */
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Runtime } from "../src/index";

const here = fileURLToPath(new URL("..", import.meta.url));
const repo = join(here, "..", "..");
const jsFixtures = join(here, "tests/fixtures/modal");
const pyFixtures = join(repo, "sdks/python/tests/fixtures/modal");
const onlyAt = process.argv.indexOf("--only");
const only = onlyAt >= 0 ? process.argv[onlyAt + 1] : undefined;

/** What an example must show: lines of its output (stdout and stderr
 * together); the CompatibilityError it must stop with, which names what
 * Runtime offers instead; or another error it stops with as on Modal (a
 * Volume the example never made, a name already taken). */
type Expect = { prints: string[] } | { refuses: string } | { stops: string };
const REFUSED = "CompatibilityError";
const JS: Record<string, Expect> = {
  "sandbox.ts": { prints: ["output: this is input that should be mirrored by cat"] },
  "sandbox-exec.ts": { refuses: "SecretService.fromName" },
  "sandbox-fs.ts": {
    prints: [
      "readText: Hello from sandbox.filesystem!",
      "readBytes: Uint8Array(5) [ 72, 101, 108, 108, 111 ]",
      "stat: name=hello.txt, size=31",
      "nested  (directory)",
      "top.txt  (file)",
      "copy round-trip: Uploaded via copyFromLocal",
      "remove: cleaned up",
      // Alpine has no python3; the watch runs on Runtime's own Python.
      "Create  /tmp/watch-demo/file5.txt",
    ],
  },
  "sandbox-named.ts": {
    prints: [
      "Trying to create one more Sandbox with the same name throws:",
      "hello, named Sandbox",
      "Sandbox terminated",
    ],
  },
  "sandbox-poll.ts": {
    prints: [
      "Poll result while running: null",
      "exit code: 42",
      "Poll result after completion: 42",
    ],
  },
  "sandbox-secrets.ts": { refuses: "SecretService.fromName" },
  "sandbox-tunnels.ts": {
    prints: ["Directory listing for /", "Successfully connected to the tunneled server!"],
  },
  "sandbox-network-policy.ts": {
    prints: ["wget example.com (blocked): exit= 1", "wget example.com (allowed): exit= 0"],
  },
  "sandbox-filesystem-snapshot.ts": {
    prints: ["File data read in second Sandbox: This file was created in the first Sandbox"],
  },
  "sandbox-prewarm.ts": { prints: ["image id:", "Sandbox:"] },
  // A secret in a build step: a Runtime build would keep its value.
  "image-building.ts": { refuses: "Image.dockerfileCommands secrets" },
  "sandbox-agent.ts": { refuses: "SecretService.fromName" },
  "sandbox-cloud-bucket.ts": { refuses: "SecretService.fromName" },
  "sandbox-private-image.ts": { refuses: "SecretService.fromName" },
  "sandbox-proxy.ts": { refuses: "ProxyService.fromName" },
  "sandbox-connect-token.ts": { refuses: "Sandbox.createConnectToken" },
  "sandbox-directory-snapshot.ts": { refuses: "Sandbox.snapshotDirectory" },
  "sandbox-directory-snapshot-csek.ts": { refuses: "Sandbox.snapshotDirectory" },
  "sandbox-exit-snapshot.ts": { refuses: "enable_exit_snapshot" },
  "sandbox-volume.ts": { refuses: "createIfMissing" },
  "sandbox-volume-ephemeral.ts": { refuses: "VolumeService.ephemeral" },
  "sandbox-sidecar.ts": { refuses: "SidecarService.create" },
  "sandbox-sidecar-directory-snapshot.ts": { refuses: "SidecarService.create" },
  "sandbox-sidecar-identity-token.ts": { refuses: "SidecarService.create" },
  "sandbox-sidecar-volume.ts": { refuses: "VolumeService.ephemeral" },
  "sandbox-sidecar-cloud-bucket.ts": { refuses: "SecretService.fromName" },
};
const PY: Record<string, Expect> = {
  guide_sandboxes_create: { prints: ["hello"] },
  guide_sandboxes_configuration: { refuses: "Runtime volumes have a fixed size" },
  guide_sandboxes_timeout: { prints: [] },
  guide_sandboxes_tcp_probe: { prints: [] },
  guide_sandboxes_exec_probe: { prints: [] },
  guide_sandboxes_returncode: { prints: ["42", "137"] },
  guide_sandboxes_runtime_vm: { prints: ["Linux"] },
  guide_sandboxes_docker: { prints: ["hello from Docker"] },
  guide_sandboxes_env: { prints: ["hello"] },
  guide_sandboxes_publish_image: { prints: [] },
  guide_sandboxes_build_logs: { prints: [] },
  guide_sandboxes_entrypoint: { prints: [] },
  guide_sandboxes_from_id: { prints: ["hello"] },
  guide_sandboxes_name_taken: { stops: "AlreadyExistsError" },
  guide_sandboxes_from_name: { prints: [] },
  guide_sandboxes_tags: { prints: [] },
  guide_sandboxes_detach: { prints: [] },
  guide_spawn_exec: { prints: ["hello", "2", "foo 10"] },
  guide_spawn_stdin: { prints: [] },
  guide_spawn_output: { prints: ["hello"] },
  guide_spawn_stream: { prints: ["foo 1", "foo 10"] },
  guide_spawn_stream_types: { prints: ["foo", "bar"] },
  guide_networking_block: { prints: [] },
  guide_networking_cidr_allowlist: { prints: [] },
  guide_networking_domain_allowlist: { prints: [] },
  guide_networking_update_policy: { prints: [] },
  guide_networking_inbound_cidr: { refuses: "inbound_cidr_allowlist" },
  guide_networking_connect_token: { refuses: "previews.create(port)" },
  guide_networking_tunnels: { prints: ["Directory listing for /"] },
  guide_networking_custom_domain: { refuses: "custom_domain" },
  guide_files_text: { prints: ["Hello World!"] },
  guide_files_copy: { prints: ["Hello World!"] },
  guide_files_listing: { prints: ["answer.txt file 3", "debug.log file 11", "42"] },
  guide_files_volume: { refuses: "Runtime volumes have a fixed size" },
  guide_files_volume_sub_path: { refuses: "Runtime mounts a whole volume" },
  guide_files_volume_sync: { stops: "Volume 'my-v2-volume' not found" },
  guide_snapshots_filesystem: { prints: [] },
  guide_snapshots_fork: { prints: [] },
  guide_snapshots_directory: { refuses: "Runtime snapshots a whole disk" },
  guide_snapshots_memory: { prints: ["<!DOCTYPE HTML>"] },
  guide_snapshots_persisting: { refuses: "modal.Dict is not a sandbox" },
  example_safe_code_execution: {
    prints: [
      "hello from bash",
      "hello from python",
      "hello from nodejs",
      "hello from ruby",
      "hello from php",
      "The sum of the random numbers is:",
      "Line 10:",
    ],
  },
  example_simple_code_interpreter: {
    prints: ["hello, world!", "The result is: 15", "Execution Error: division by zero"],
  },
  example_jupyter_sandbox: { prints: ["Jupyter is up and running!"] },
  example_sandbox_agent: { refuses: "Runtime secrets are used without being seen" },
  example_sidecar_redis: { refuses: "join both to a private network" },
  example_sidecar_agent: { refuses: "modal.Server is not a sandbox" },
};
/** Modal's examples that are not run, and why. */
export const SKIPPED: Record<string, string> = {
  "js/examples/sandbox-gpu.ts": "needs a GPU, which Runtime does not offer",
  "js/examples/cls-call.ts, cls-call-with-options.ts, cls-routing-region.ts":
    "call deployed Modal Functions (Cls), not sandboxes",
  "js/examples/function-call.ts, function-spawn.ts, function-current-stats.ts":
    "call deployed Modal Functions, not sandboxes",
  "js/examples/custom-client.ts, telemetry.ts": "call deployed Modal Functions, not sandboxes",
  "13_sandboxes/sandbox_secret_injection.py, sidecar_secrets_injection.py, sidecar_traffic_routing.py":
    "deploy a Modal web Function the sandbox calls",
  "13_sandboxes/opencode_server.py":
    "copies the reader's own ~/.config/opencode and ~/.modal.toml into the image",
  "13_sandboxes/sandbox_pool.py": "runs as deployed Modal Functions with a Modal Queue",
  "13_sandboxes/harbor_evals.py": "runs through the Harbor library's own Modal environment",
  "13_sandboxes/codelangchain, cua": "run as deployed Modal Functions with an LLM API key",
  "docs/guide/sandboxes, block 21": "a fragment that uses a Sandbox the block never creates",
  "docs/guide/sandbox-networking, block 20": "uses my_image and my_http2_server.py, never defined",
  "docs/guide/sandbox-files, block 15":
    "copies /home/user/my_dir, a folder on the writer's machine",
  "docs/guide/sandbox-snapshots, blocks 1, 11, 17, 19":
    "fragments that use a Sandbox the block never creates, or wait days",
};

const selected = (name: string) => only === undefined || name.includes(only);
const programs = [
  ...readdirSync(jsFixtures)
    .filter((f) => f.endsWith(".ts"))
    .map((file) => ({ language: "ts" as const, name: file, file: join(jsFixtures, file) })),
  ...readdirSync(pyFixtures)
    .filter((f) => f.endsWith(".py"))
    .map((file) => ({
      language: "py" as const,
      name: file.slice(0, -3),
      file: join(pyFixtures, file),
    })),
].filter((p) => selected(p.name));
for (const p of programs)
  if (!(p.language === "ts" ? JS : PY)[p.name])
    throw new Error(`${p.name} has no expectation in this script.`);
for (const name of [...Object.keys(JS), ...Object.keys(PY)])
  if (!existsSync(join(jsFixtures, name)) && !existsSync(join(pyFixtures, `${name}.py`)))
    throw new Error(`${name} is expected but has no fixture.`);

if (!process.argv.includes("--run")) {
  console.log(
    `${programs.length} of Modal's examples would run; pass --run to create their sandboxes ` +
      "(each capped at two cents and five minutes, deleted when its example ends).\nNot run:",
  );
  for (const [what, why] of Object.entries(SKIPPED)) console.log(`  ${what}: ${why}`);
  process.exit(0);
}
if (!process.env.RUNTIME_API_KEY) throw new Error("RUNTIME_API_KEY is required.");

const RUN = crypto.randomUUID().slice(0, 8);
const CAP_MICROS = 20_000;
const LIMIT_SECONDS = 300;
const work = mkdtempSync(join(tmpdir(), "runtime-modal-examples-"));

// What a customer installs: the compiled package, not its sources.
const pkg = join(work, "withruntime");
mkdirSync(pkg);
writeFileSync(
  join(pkg, "tsconfig.json"),
  JSON.stringify({
    extends: join(here, "tsconfig.build.json"),
    compilerOptions: { outDir: join(pkg, "dist"), rootDir: join(here, "src") },
    include: [],
    files: ["index.ts", "modal/index.ts"].map((file) => join(here, "src", file)),
  }),
);
const tsc = spawnSync(
  process.execPath,
  [join(here, "node_modules/typescript/bin/tsc"), "-p", pkg],
  { cwd: here, stdio: "inherit" },
);
if (tsc.status !== 0) throw new Error("Compiling the package failed.");
cpSync(join(here, "package.json"), join(pkg, "package.json"));
symlinkSync(join(here, "node_modules"), join(pkg, "node_modules"), "dir");

// Every sandbox an example creates is capped, labelled and written down on
// its way out, in the request itself, so none escapes the cleanup.
const amend = `{ ...body, labels: { ...(body.labels ?? {}), "compat-run": ${JSON.stringify(RUN)} },
  maxTotalCostMicros: ${CAP_MICROS},
  timeoutSeconds: Math.min(body.timeoutSeconds ?? ${LIMIT_SECONDS}, ${LIMIT_SECONDS}) }`;
writeFileSync(
  join(work, "ledger.mjs"),
  `import { appendFileSync } from "node:fs";
const send = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if ((init.method ?? "GET") === "POST" && url.pathname === "/v1/sandboxes" && typeof init.body === "string") {
    const body = JSON.parse(init.body);
    init = { ...init, body: JSON.stringify(${amend}) };
    const response = await send(input, init);
    const answer = await response.clone().json().catch(() => ({}));
    if (answer.id) appendFileSync(process.env.RUNTIME_LIVE_LEDGER, answer.id + "\\n");
    return response;
  }
  return send(input, init);
};
`,
);
writeFileSync(
  join(work, "run_fixture.py"),
  `import os, runpy, sys
from withruntime import _sync_client, _async_client

LEDGER = os.environ["RUNTIME_LIVE_LEDGER"]

def amend(kwargs):
    body = dict(kwargs.get("body") or {})
    body["labels"] = {**(body.get("labels") or {}), "compat-run": ${JSON.stringify(RUN)}}
    body["maxTotalCostMicros"] = ${CAP_MICROS}
    body["timeoutSeconds"] = min(body.get("timeoutSeconds") or ${LIMIT_SECONDS}, ${LIMIT_SECONDS})
    return {**kwargs, "body": body}

def record(answer):
    if isinstance(answer, dict) and answer.get("id"):
        with open(LEDGER, "a") as ledger:
            ledger.write(answer["id"] + "\\n")
    return answer

sync_json = _sync_client._Transport.json
def json(self, method, path, **kwargs):
    if method == "POST" and path == "/v1/sandboxes":
        return record(sync_json(self, method, path, **amend(kwargs)))
    return sync_json(self, method, path, **kwargs)
_sync_client._Transport.json = json

async_json = _async_client._Transport.json
async def ajson(self, method, path, **kwargs):
    if method == "POST" and path == "/v1/sandboxes":
        return record(await async_json(self, method, path, **amend(kwargs)))
    return await async_json(self, method, path, **kwargs)
_async_client._Transport.json = ajson

fixture, name = sys.argv[1], os.path.basename(sys.argv[1])[:-3]
sys.argv = [fixture]
given = {}
if name.startswith("guide_"):
    # Modal's guide leaves these to its reader; its docs harness gives sb_app.
    from withruntime import modal
    given["app"] = given["my_app"] = given["sb_app"] = modal.App.lookup("docs-" + name.replace("_", "-"), create_if_missing=True)
runpy.run_path(fixture, init_globals=given, run_name="__main__")
`,
);
writeFileSync(join(work, "package.json"), JSON.stringify({ type: "module", private: true }));
mkdirSync(join(work, "node_modules"));
symlinkSync(pkg, join(work, "node_modules", "withruntime"), "dir");

// A Python with what the examples import themselves (requests).
const venv = join(work, "venv");
for (const args of [
  ["venv", "--quiet", venv],
  ["pip", "install", "--quiet", "--python", join(venv, "bin/python"), "requests"],
])
  if (spawnSync("uv", args, { stdio: "inherit" }).status !== 0)
    throw new Error(`uv ${args.join(" ")} failed`);

const native = new Runtime();
type Outcome = {
  name: string;
  ok: boolean;
  how: string;
  seconds: number;
  sandboxes: string[];
  output: string;
};

async function cleanup(ids: string[]) {
  let charged = 0;
  for (const id of ids) {
    await native.sandboxes.delete(id).catch((error: unknown) => {
      if (!String(error).includes("not_found")) console.error(`Deleting ${id}: ${String(error)}`);
    });
    for (const snapshot of await (
      await native.snapshots.list({ sandboxId: id })
    )
      .toArray()
      .catch(() => []))
      await native.snapshots.delete(snapshot.id).catch((error: unknown) => {
        console.error(`Deleting snapshot ${snapshot.id}: ${String(error)}`);
      });
    const info = await native.sandboxes
      .get(id)
      .then((s) => s.info)
      .catch(() => undefined);
    charged += info?.chargedMicros ?? 0;
  }
  return charged;
}

let spentMicros = 0;
async function runOne(p: (typeof programs)[number]): Promise<Outcome> {
  const dir = mkdtempSync(join(work, `${p.name.replace(/\W/g, "-")}-`));
  const ledger = join(dir, "sandboxes.txt");
  writeFileSync(ledger, "");
  let command: string;
  let args: string[];
  if (p.language === "ts") {
    cpSync(p.file, join(work, p.name));
    command = "node";
    args = ["--import", join(work, "ledger.mjs"), join(work, p.name)];
  } else {
    command = join(venv, "bin/python");
    args = ["-B", join(work, "run_fixture.py"), p.file];
  }
  const started = performance.now();
  const output = await new Promise<string>((resolve) => {
    let text = "";
    const child = spawn(command, args, {
      cwd: dir,
      env: {
        ...process.env,
        RUNTIME_LIVE_LEDGER: ledger,
        PYTHONPATH: join(repo, "sdks/python"),
        // Modal's credentials, which must never be needed or sent.
        MODAL_TOKEN_ID: "ak-never-sent",
        MODAL_TOKEN_SECRET: "as-never-sent",
      },
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 240_000);
    child.stdout.on("data", (chunk: Buffer) => (text += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (text += chunk.toString()));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve(`${text}\n[exit ${code ?? signal}]`);
    });
  });
  const seconds = Math.round((performance.now() - started) / 100) / 10;
  const sandboxes = readFileSync(ledger, "utf8").split("\n").filter(Boolean);
  spentMicros += await cleanup(sandboxes);
  const expect = (p.language === "ts" ? JS : PY)[p.name]!;
  const exited0 = output.endsWith("[exit 0]");
  let ok: boolean;
  let how: string;
  if ("refuses" in expect) {
    ok = !exited0 && output.includes(REFUSED) && output.includes(expect.refuses);
    how = ok
      ? `refused: ${refusal(output)}`
      : "FAILED: expected a refusal naming " + expect.refuses;
  } else if ("stops" in expect) {
    ok = !exited0 && !output.includes(REFUSED) && output.includes(expect.stops);
    how = ok
      ? `stopped as on Modal: ${expect.stops}`
      : "FAILED: expected it to stop with " + expect.stops;
  } else {
    const missing = expect.prints.filter((line) => !output.includes(line));
    ok = exited0 && missing.length === 0;
    how = ok ? "passed" : `FAILED${missing.length ? `: missing ${JSON.stringify(missing)}` : ""}`;
  }
  return {
    name: `${p.language === "ts" ? "ts" : "py"} ${p.name}`,
    ok,
    how,
    seconds,
    sandboxes,
    output,
  };
}
const refusal = (output: string) =>
  ([...output.split("\n")].reverse().find((line) => line.includes(REFUSED)) ?? "")
    .replace(/^.*?CompatibilityError:? ?/, "")
    .slice(0, 240);

// Three examples at a time: at most about nine sandboxes at once.
const outcomes: Outcome[] = [];
const queue = [...programs];
await Promise.all(
  Array.from({ length: 3 }, async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      const outcome = await runOne(p);
      outcomes.push(outcome);
      console.log(
        `${outcome.ok ? "ok  " : "FAIL"} ${outcome.name} (${outcome.seconds} s; ` +
          `${outcome.sandboxes.join(", ") || "no sandbox"}): ${outcome.how}`,
      );
      if (!outcome.ok || process.argv.includes("--verbose"))
        console.log(outcome.output.replace(/^/gm, "    | "));
    }
  }),
);

// Nothing this run made is left: every sandbox it recorded has ended.
const recorded = outcomes.flatMap((o) => o.sandboxes);
const live = (
  await Promise.all(
    recorded.map((id) =>
      native.sandboxes
        .get(id)
        .then((s) => (s.state === "stopped" ? undefined : id))
        .catch(() => undefined),
    ),
  )
).filter(Boolean);
const failed = outcomes.filter((o) => !o.ok);
console.log(
  `\n${outcomes.length - failed.length} of ${outcomes.length} examples as expected; ` +
    `${recorded.length} sandboxes made, ${live.length} still live; ` +
    `charged $${(spentMicros / 1e6).toFixed(4)}.`,
);
for (const id of live) console.log(`Still live: ${id}`);
process.exit(failed.length || live.length ? 1 : 0);
