/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any -- answers are read as Fly's docs read them. */
/** Fly's own Machines API examples (tests/compat/fly-docs/machines-api-examples.sh,
 * copied verbatim from fly.io's docs) run by curl against `withruntime fly-api`,
 * on real Runtime sandboxes. The only switch is the one a customer makes:
 * FLY_API_HOSTNAME points at fly-api. FLY_API_TOKEN stays a Fly token, which
 * fly-api never sends anywhere: it answers as this computer's Runtime login.
 *
 *   RUNTIME_API_KEY=rtcloud_... bun scripts/compatibility-fly-docs-live.ts --run
 *
 * It uses the docs' app name, my-app-name, and deletes every machine it makes.
 * With Go installed it then runs Fly's Go client, fly-go, the same way. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

if (!process.argv.includes("--run")) throw new Error("Pass --run: this makes real sandboxes.");
if (!process.env.RUNTIME_API_KEY) throw new Error("Set RUNTIME_API_KEY to a Runtime key.");

const root = join(import.meta.dir, "..");
const examples = new Map<string, { url: string; script: string }>();
for (const part of readFileSync(
  join(root, "tests/compat/fly-docs/machines-api-examples.sh"),
  "utf8",
)
  .split(/^### /m)
  .slice(1)) {
  const [head = "", ...body] = part.split("\n");
  const at = head.lastIndexOf(" https://");
  examples.set(head.slice(0, at), { url: head.slice(at + 1), script: body.join("\n").trim() });
}

// `npx withruntime fly-api`, as a customer runs it.
const port = 4280 + Math.floor(Math.random() * 500);
const server = Bun.spawn(["bun", join(root, "src/cli.ts"), "fly-api", "--port", String(port)], {
  stdout: "pipe",
  stderr: "inherit",
});
const banner = await new Response(server.stdout).body!.getReader().read();
console.log(`fly-api: ${new TextDecoder().decode(banner.value).split("\n")[0]}`);
const env = {
  ...process.env,
  FLY_API_HOSTNAME: `http://127.0.0.1:${port}`,
  FLY_API_TOKEN: "FlyV1 fm2_a_fly_token_runtime_never_sends",
};

const filled: Record<string, string> = {};
const failures: string[] = [];
const rows: string[] = [];

/** Runs one docs example, with its placeholder ids filled in. */
async function example(name: string) {
  const found = examples.get(name);
  if (!found) throw new Error(`No docs example "${name}".`);
  let script = found.script;
  if (filled.machine)
    script = script.replace(/\/machines\/[0-9a-f]{12,16}/g, `/machines/${filled.machine}`);
  if (filled.instance)
    script = script.replace(/instance_id=[0-9A-Z]+/, `instance_id=${filled.instance}`);
  if (filled.nonce)
    script = script.replace(
      /fly-machine-lease-nonce: [0-9a-f]+/,
      `fly-machine-lease-nonce: ${filled.nonce}`,
    );
  const started = performance.now();
  const run = Bun.spawn(["bash", "-c", script], { env, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(run.stdout).text();
  await run.exited;
  const ms = Math.round(performance.now() - started);
  const [head = "", ...rest] = out.split(/\r?\n\r?\n/);
  const status = Number(/^HTTP\/[\d.]+ (\d+)/.exec(head)?.[1] ?? 0);
  const text = rest.join("\n\n").trim();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    /* not JSON */
  }
  return { status, body, ms, url: found.url };
}

function check(name: string, ok: boolean, detail: string) {
  rows.push(`${ok ? "ok  " : "FAIL"} ${name} (${detail})`);
  console.log(rows.at(-1));
  if (!ok) failures.push(name);
}

async function step(
  name: string,
  expect: (r: Awaited<ReturnType<typeof example>>) => boolean,
  note = (r: Awaited<ReturnType<typeof example>>) =>
    typeof r.body === "object" ? JSON.stringify(r.body).slice(0, 140) : String(r.body ?? ""),
) {
  const r = await example(name);
  check(name, expect(r), `${r.status} in ${r.ms} ms: ${note(r)}`);
  return r;
}

try {
  await step("Create a Fly App", (r) => r.status === 201);
  await step("Get app details", (r) => r.status === 200 && r.body.name === "my-app-name");

  const created = await step(
    "Create a Machine",
    (r) =>
      r.status === 200 &&
      r.body.state === "started" &&
      r.body.config.restart.policy === "always" &&
      r.body.config.auto_destroy === true &&
      r.body.image_ref.repository === "library/ubuntu",
    (r) =>
      `${r.body.id ?? r.body.error} ${r.body.state ?? ""} restart ${r.body.config?.restart?.policy}`,
  );
  filled.machine = created.body.id;
  filled.instance = created.body.instance_id;

  await step(
    "List Machines",
    (r) => r.status === 200 && r.body.some((m: any) => m.id === filled.machine),
  );
  await step(
    "List apps in an organization",
    (r) => r.status === 200 && r.body.apps.some((a: any) => a.name === "my-app-name"),
  );
  await step("Get a Machine", (r) => r.status === 200 && r.body.state === "started");

  await step("Get a Machine’s metadata", (r) => r.status === 200 && typeof r.body === "object");
  await step("Add or update Machine metadata", (r) => r.status === 204);
  await step("Get a Machine’s metadata", (r) => r.body["foo-key"] === "bar");
  await step("Delete Machine metadata", (r) => r.status === 204);

  const lease = await step(
    "Create a Machine lease",
    (r) => r.status === 200 && r.body.status === "success" && typeof r.body.data.nonce === "string",
  );
  filled.nonce = lease.body.data.nonce;
  await step("Get a Machine lease", (r) => r.status === 200 && r.body.data.nonce === filled.nonce);
  await step(
    "Release a Machine lease",
    (r) => r.status === 200 && r.body.status === "success" && r.body.data.ok === true,
  );

  await step("Suspend a Machine", (r) => r.status === 200 && r.body.ok === true);
  await step("Start a Machine", (r) => r.status === 200 && r.body.previous_state === "suspended");
  await step("Stop a Machine", (r) => r.status === 200 && r.body.ok === true);
  await step(
    "Wait for a Machine to reach a specified state",
    (r) => r.status === 200 && r.body.ok === true,
  );
  await step("Start a Machine", (r) => r.status === 200 && r.body.previous_state === "stopped");

  // Not a docs example: the docs' "restart": {"policy": "always"} kept live.
  // The main process (/bin/sleep inf) is killed and comes back by itself.
  const execIn = async (cmd: string) =>
    (await fetch(`${env.FLY_API_HOSTNAME}/v1/apps/my-app-name/machines/${filled.machine}/exec`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.FLY_API_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ cmd }),
    }).then((r) => r.json())) as { stdout: string; exit_code: number };
  const before = (await execIn("cat /tmp/.fly-main-pid")).stdout.trim();
  await execIn(`kill -9 ${before}`);
  await Bun.sleep(2500);
  const after = (
    await execIn("cat /tmp/.fly-main-pid; tr '\\0' ' ' < /proc/$(cat /tmp/.fly-main-pid)/cmdline")
  ).stdout
    .trim()
    .split("\n");
  check(
    'restart "always": a killed main process runs again',
    after[0] !== before && after[1]?.trim() === "/bin/sleep inf",
    `pid ${before} killed, now pid ${after[0]} running "${after[1]}"`,
  );

  await step(
    "Route requests away from or back to a Machine (1)",
    (r) => r.status === 400 && /preview/.test(r.body.error),
    (r) => r.body.error,
  );
  await step(
    "Route requests away from or back to a Machine (2)",
    (r) => r.status === 400 && /preview/.test(r.body.error),
    (r) => r.body.error,
  );
  // Fly's own example here is not valid JSON (no "}," after "env"), so Fly
  // refuses it too; Runtime answers 400, never a guess at what it meant.
  await step(
    "Create a Machine with services",
    (r) => r.status === 400 && /not valid JSON/.test(r.body.error),
    (r) => r.body.error,
  );
  await step(
    "Update a Machine",
    (r) => r.status === 400 && /preview/.test(r.body.error),
    (r) => r.body.error,
  );
  await step("Delete a Machine permanently", (r) => r.status === 200 && r.body.ok === true);
  delete filled.machine;
  await step("Delete a Fly App", (r) => r.status === 202);

  // Fly's own Go client, fly-go's flaps package, unchanged: its one switch is
  // FLY_FLAPS_BASE_URL (tests/compat/fly-go/main.go). Skipped without Go.
  if (Bun.which("go")) {
    const go = Bun.spawn(["go", "run", "."], {
      cwd: join(root, "tests/compat/fly-go"),
      env: { ...env, FLY_FLAPS_BASE_URL: env.FLY_API_HOSTNAME },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(go.stdout).text(),
      new Response(go.stderr).text(),
      go.exited,
    ]);
    for (const line of out.trim().split("\n")) console.log(`     fly-go ${line}`);
    check(
      "fly-go flaps client, unchanged",
      code === 0,
      code === 0 ? "every call answered" : err.trim(),
    );
  } else console.log("     fly-go skipped: no Go on this computer");
} finally {
  if (filled.machine)
    await fetch(
      `${env.FLY_API_HOSTNAME}/v1/apps/my-app-name/machines/${filled.machine}?force=true`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${env.FLY_API_TOKEN}` },
      },
    ).catch(() => undefined);
  server.kill("SIGINT");
  await server.exited;
}
console.log(failures.length ? `${failures.length} failed` : `all ${rows.length} passed`);
process.exit(failures.length ? 1 : 0);
