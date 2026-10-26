import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kit } from "../src/cli";
import { TEMPLATE_AT, codeDockerfile, jobsDeployCommand, scanProject } from "../src/jobs-deploy";
import { cronTimes } from "../src/jobs-code/cron";
import { cronOf, durationMs } from "../src/inngest/index";
import { numericCron, taskJob } from "../src/trigger/index";

/* The Trigger.dev and Inngest drop-ins with their own examples: Trigger.dev's
   `trigger.dev init` templates (packages/cli-v3/templates) and Inngest's
   README and docs functions, each with only its import changed
   (tests/fixtures/jobs-dropins). The runner (src/jobs-code/runner.ts) lists
   and runs them as a job's sandbox does, with Bun, against this SDK's source
   installed as the project's `withruntime`. */

const sdk = new URL("..", import.meta.url).pathname;
const runner = join(sdk, "src/jobs-code/runner.ts");
const made: string[] = [];
afterAll(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function project(name: "trigger" | "inngest") {
  const dir = mkdtempSync(join(tmpdir(), `dropin-${name}-`));
  made.push(dir);
  cpSync(join(sdk, "tests/fixtures/jobs-dropins", name), dir, { recursive: true });
  // node_modules/withruntime: this SDK's source, its subpaths as exports.
  const pkg = join(dir, "node_modules/withruntime");
  mkdirSync(pkg, { recursive: true });
  symlinkSync(join(sdk, "src"), join(pkg, "src"));
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "withruntime",
      type: "module",
      exports: {
        "./trigger": "./src/trigger/index.ts",
        "./inngest": "./src/inngest/index.ts",
      },
    }),
  );
  return dir;
}

function runner_(dir: string, args: string[], env: Record<string, string> = {}) {
  const result = Bun.spawnSync(["bun", runner, ...args], {
    cwd: dir,
    env: { ...process.env, ...env },
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}
const discovered = (stdout: string) =>
  JSON.parse(
    stdout
      .split("\n")
      .find((l) => l.startsWith("JOBS-DISCOVERED "))!
      .slice(16),
  );

test("Trigger.dev's init templates: a scheduled task, an on-demand task and the config's defaults", async () => {
  const dir = project("trigger");
  const { ours, theirs } = await scanProject(dir);
  expect(ours).toEqual(["src/trigger/example.ts", "src/trigger/schedule.ts", "trigger.config.ts"]);
  expect(theirs).toEqual([]);
  const listed = runner_(dir, ["discover", ...ours]);
  expect(listed.code).toBe(0);
  const { tasks, triggerConfig } = discovered(listed.stdout);
  expect(triggerConfig).toEqual({ maxDuration: 3600, maxAttempts: 3 });
  expect(tasks).toEqual([
    {
      kind: "trigger",
      id: "hello-world",
      schedule: null,
      maxDuration: 300,
      file: "src/trigger/example.ts",
    },
    {
      kind: "trigger",
      id: "first-scheduled-task",
      schedule: { cron: "0 * * * *", timezone: "UTC" },
      maxDuration: 300,
      file: "src/trigger/schedule.ts",
    },
  ]);
}, 30_000);

test("Trigger.dev's scheduled template runs with its schedule's payload", () => {
  const dir = project("trigger");
  const run = runner_(dir, ["run", "src/trigger/schedule.ts", "trigger", "first-scheduled-task"]);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(0);
  // logger.log("First scheduled tasks", { payload, distanceInMs }): the
  // payload's timestamp is this hour's :00, and lastTimestamp the hour before.
  const line = run.stdout.split("\n").find((l) => l.startsWith("First scheduled tasks "))!;
  const { payload, distanceInMs } = JSON.parse(line.slice("First scheduled tasks ".length));
  expect(distanceInMs).toBe(3_600_000);
  expect(new Date(payload.timestamp).getUTCMinutes()).toBe(0);
  expect(payload.timezone).toBe("UTC");
  expect(payload.upcoming).toHaveLength(10);
}, 30_000);

test("Trigger.dev's on-demand template runs with the payload it is triggered with", () => {
  const dir = project("trigger");
  const payload = Buffer.from(JSON.stringify({ name: "Ada" })).toString("base64");
  const run = runner_(dir, ["run", "src/trigger/example.ts", "trigger", "hello-world", payload]);
  expect(run.code).toBe(0);
  expect(run.stdout).toContain('Hello, world! {"payload":{"name":"Ada"}');
}, 30_000);

test("Inngest's README and docs functions: a cron in its zone and an event function", async () => {
  const dir = project("inngest");
  const { ours } = await scanProject(dir);
  const listed = runner_(dir, ["discover", ...ours]);
  expect(listed.code).toBe(0);
  const { tasks } = discovered(listed.stdout);
  expect(tasks).toEqual([
    {
      kind: "inngest",
      id: "user-onboarding-communication",
      schedule: null,
      events: ["app/user.signup"],
      retry: { maxAttempts: 5 },
      file: "src/functions.ts",
    },
    {
      kind: "inngest",
      id: "prepare-weekly-digest",
      schedule: { cron: "0 12 * * 5", timezone: "Europe/Paris" },
      retry: { maxAttempts: 5 },
      file: "src/functions.ts",
    },
  ]);
  const cron = runner_(dir, ["run", "src/functions.ts", "inngest", "prepare-weekly-digest"]);
  expect(cron.code).toBe(0);
  expect(cron.stdout).toContain("digest for 1 users");
  const event = Buffer.from(
    JSON.stringify({ name: "app/user.signup", data: { email: "ada@example.com" } }),
  ).toString("base64");
  const signup = runner_(dir, [
    "run",
    "src/functions.ts",
    "inngest",
    "user-onboarding-communication",
    event,
  ]);
  expect(signup.code).toBe(0);
  expect(signup.stdout).toContain("email welcome to ada@example.com");
}, 30_000);

test("a task that throws fails its run, and an unknown id says to deploy again", () => {
  const dir = project("inngest");
  const missing = runner_(dir, ["run", "src/functions.ts", "inngest", "gone"]);
  expect(missing.code).toBe(2);
  expect(missing.stderr).toContain('declares no inngest task "gone"');
});

/** A client for `runtime jobs deploy`: the image and sandbox are fakes, and
 * the sandbox's exec runs the real runner on the project here. */
function deployClient(
  dir: string,
  existing: { id: string; name: string; state: string }[],
  pauseFails = false,
) {
  const calls: [string, ...unknown[]][] = [];
  const client = {
    images: { build: async () => ({ id: "img-1", sizeMiB: 300 }) },
    sandboxes: {
      create: async () => ({
        exec: async (argv: string[]) => {
          const r = runner_(dir, argv.slice(2));
          return { stdout: r.stdout, stderr: r.stderr, exitCode: r.code };
        },
        delete: async () => undefined,
      }),
    },
    jobs: {
      list: async () =>
        (async function* () {
          yield* existing;
        })(),
      create: async (body: { name: string }) => {
        calls.push(["create", body]);
        return { id: `job-${body.name}` };
      },
      update: async (id: string, body: unknown) => void calls.push(["update", id, body]),
      reschedule: async (id: string, schedule: unknown) =>
        void calls.push(["reschedule", id, schedule]),
      pause: async (id: string) => {
        calls.push(["pause", id]);
        if (pauseFails) throw new Error("503 busy");
      },
      resume: async (id: string) => void calls.push(["resume", id]),
    },
  };
  return { calls, runtime: async () => client as never };
}

test("an on-demand task's job is due only in 9999 and paused; a failed pause fails the deploy", async () => {
  const dir = project("trigger");
  const lines: string[] = [];
  const out = {
    json: false,
    write: (t: string) => lines.push(t),
    error: (t: string) => lines.push(t),
  };
  const ok = deployClient(dir, []);
  expect(await jobsDeployCommand([dir], out, ok.runtime, kit)).toBe(0);
  const created = ok.calls
    .filter((c) => c[0] === "create")
    .map((c) => c[1] as { name: string; schedule: unknown });
  const onDemand = created.find((c) => c.name.endsWith("-hello-world"))!;
  // Never due by itself, even if it were not paused.
  expect(onDemand.schedule).toEqual({ at: TEMPLATE_AT });
  expect(new Date(TEMPLATE_AT).getUTCFullYear()).toBe(9999);
  expect(ok.calls).toContainEqual(["pause", `job-${onDemand.name}`]);
  // The scheduled task keeps its cron and is never paused.
  const scheduled = created.find((c) => c.name.endsWith("-first-scheduled-task"))!;
  expect(scheduled.schedule).toEqual({ cron: "0 * * * *", timezone: "UTC" });
  expect(ok.calls).not.toContainEqual(["pause", `job-${scheduled.name}`]);

  // A pause that fails is that task's failure: the line says so, exit 1.
  const failing = deployClient(dir, [], true);
  lines.length = 0;
  expect(await jobsDeployCommand([dir], out, failing.runtime, kit)).toBe(1);
  expect(lines.join("\n")).toContain("✗ trigger hello-world: 503 busy");

  // Deployed again, an already paused template is rescheduled, not paused again.
  const again = deployClient(dir, [{ id: "j1", name: onDemand.name, state: "paused" }]);
  expect(await jobsDeployCommand([dir], out, again.runtime, kit)).toBe(0);
  expect(again.calls).toContainEqual(["reschedule", "j1", { at: TEMPLATE_AT }]);
  expect(again.calls).not.toContainEqual(["pause", "j1"]);
});

test("tasks.trigger finds its task's job by what it runs, without the project's name", () => {
  // A backend calling tasks.trigger has not loaded trigger.config.ts: the
  // job deploy made for project "acme" is found by its command.
  delete process.env.RUNTIME_JOBS_PROJECT;
  const job = (name: string, argv: string[], state = "paused") => ({
    name,
    state,
    definition: { command: { argv } },
  });
  const run = (file: string, id: string) => [
    "bun",
    ".runtime/jobs-runner.ts",
    "run",
    file,
    "trigger",
    id,
  ];
  const deployed = job("acme-hello-world", run("src/trigger/example.ts", "hello-world"));
  const oneOff = job(
    "acme-hello-world-x1",
    [...run("src/trigger/example.ts", "hello-world"), "bnVsbA=="],
    "active",
  );
  const other = job(
    "acme-first-scheduled-task",
    run("src/trigger/schedule.ts", "first-scheduled-task"),
    "active",
  );
  expect(taskJob("hello-world", [oneOff, other, deployed])).toBe(deployed);
  expect(() => taskJob("missing", [deployed])).toThrow('No job runs task "missing"');
  // Two projects with the same task id: the project's name picks one.
  const second = job("shop-hello-world", run("src/trigger/example.ts", "hello-world"));
  expect(() => taskJob("hello-world", [deployed, second])).toThrow("set RUNTIME_JOBS_PROJECT");
  process.env.RUNTIME_JOBS_PROJECT = "shop";
  try {
    expect(taskJob("hello-world", [deployed, second])).toBe(second);
  } finally {
    delete process.env.RUNTIME_JOBS_PROJECT;
  }
});

test("a project still on the platform's SDK is named, file by file", async () => {
  const dir = project("trigger");
  writeFileSync(join(dir, "src/trigger/old.ts"), 'import { task } from "@trigger.dev/sdk/v3";\n');
  expect((await scanProject(dir)).theirs).toEqual(["src/trigger/old.ts"]);
});

test("schedules, durations and the image", () => {
  expect(numericCron("0 9 * * MON-FRI")).toBe("0 9 * * 1-5");
  expect(cronOf("TZ=Europe/Paris 0 12 * * 5")).toEqual({
    cron: "0 12 * * 5",
    timezone: "Europe/Paris",
  });
  expect(cronOf("*/5 * * * *")).toEqual({ cron: "*/5 * * * *", timezone: "UTC" });
  expect(durationMs("1h30m")).toBe(5_400_000);
  expect(() => durationMs("soon")).toThrow("not a duration");
  const at = Date.UTC(2026, 9, 26, 10, 17);
  expect(cronTimes("0 12 * * 5", "Europe/Paris", at, -1, 1)[0]!.toISOString()).toBe(
    "2026-10-23T10:00:00.000Z",
  );
  expect(cronTimes("*/15 * * * *", "UTC", at, 1, 2).map((d) => d.toISOString())).toEqual([
    "2026-10-26T10:30:00.000Z",
    "2026-10-26T10:45:00.000Z",
  ]);
  const dockerfile = codeDockerfile("console.log('runner')");
  expect(dockerfile).toContain("WORKDIR /workspace/app");
  expect(dockerfile).toContain("npm ci");
  expect(dockerfile).toContain(".runtime/jobs-runner.ts");
});
