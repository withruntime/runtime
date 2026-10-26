import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { me } from "./cli-name.js";
import type { CliKit } from "./cli.js";
import type { Runtime } from "./client.js";
import { jobNameOf } from "./jobs-code/registry.js";
import { MACHINES } from "./trigger/index.js";
import { JOB_DEFAULTS, JOB_LIMITS, type CreateJob, type Job } from "./products/jobs.js";

/* `runtime jobs deploy`: Trigger.dev tasks and Inngest functions, written
   against withruntime/trigger or withruntime/inngest, as Runtime jobs. It
   builds the project into one image (its own package manager installs its
   dependencies, Bun runs its TypeScript as it is), lists the tasks the
   project's files declare by running them in a sandbox of that image, and
   makes one job per task: a cron's on its schedule, an on-demand task's
   paused, for tasks.trigger and inngest.send to run once per payload. A job
   of the same name is updated in place, so deploying again moves changes. */

type Out = { json: boolean; write: (text: string) => void; error: (text: string) => void };

export const JOB_DEPLOY_HELP = `runtime jobs deploy [<dir>] [--name <project>] [--dry-run]

  Run Trigger.dev tasks and Inngest functions as Runtime jobs. First change the
  import: \`@trigger.dev/sdk\` (or /v3) to \`withruntime/trigger\`, or \`inngest\`
  (and its serve adapters, such as inngest/next) to \`withruntime/inngest\`.

  Each schedules.task, or Inngest function with a cron trigger, becomes a job on
  that schedule. Each task, or function with an event trigger, becomes a paused
  job that tasks.trigger(id, payload) or inngest.send(event) runs once per call.
  A task's machine, maxDuration and retry.maxAttempts (an Inngest function's
  retries and timeouts.finish) size its job.

  --name     the jobs' prefix: <name>-<task id>. Default: trigger.config's project,
             the Inngest app's id, or package.json's name
  --dry-run  list the tasks the files declare; create nothing (it still builds the image)
`;

const SKIP = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".trigger",
  "coverage",
]);
const CODE = /\.(m?[jt]sx?|cts|cjs)$/;

/** The project's files that import a drop-in, and those that still import
 * the platform's own SDK. */
export async function scanProject(dir: string) {
  const ours: string[] = [];
  const theirs: string[] = [];
  const walk = async (at: string, depth: number): Promise<void> => {
    if (depth > 8) return;
    for (const entry of await readdir(at, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name) && !entry.name.startsWith("."))
          await walk(join(at, entry.name), depth + 1);
        continue;
      }
      if (!CODE.test(entry.name) || entry.name.endsWith(".d.ts")) continue;
      const path = join(at, entry.name);
      const text = await readFile(path, "utf8");
      const rel = relative(dir, path);
      if (/["']withruntime\/(trigger|inngest)["']/.test(text)) ours.push(rel);
      else if (/["'](@trigger\.dev\/sdk(\/v3)?|inngest)["']/.test(text)) theirs.push(rel);
    }
  };
  await walk(dir, 0);
  return { ours: ours.sort(), theirs: theirs.sort() };
}

/** The Dockerfile a project's code jobs run from: Node 22 and Bun, the
 * project's dependencies by its own lockfile, and the runner. */
/** When an on-demand task's template job is due: 1 January 9999, UTC, never
 * reached (the API takes a time up to the year 275760). */
export const TEMPLATE_AT = Date.UTC(9999, 0, 1);

export function codeDockerfile(runner: string): string {
  const b64 = Buffer.from(runner).toString("base64");
  const chunks = b64.match(/.{1,4000}/g) ?? [];
  return [
    "FROM node:22-bookworm-slim",
    "RUN npm install -g bun@1.2.23 && apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/*",
    "WORKDIR /workspace/app",
    "COPY . .",
    "RUN if [ -f bun.lock ] || [ -f bun.lockb ]; then bun install --frozen-lockfile; " +
      "elif [ -f pnpm-lock.yaml ]; then npx -y pnpm@9 install --frozen-lockfile; " +
      "elif [ -f yarn.lock ]; then npx -y yarn@1 install --frozen-lockfile; " +
      "elif [ -f package-lock.json ]; then npm ci; " +
      "elif [ -f package.json ]; then npm install; fi",
    "RUN mkdir -p .runtime",
    ...chunks.map((c) => `RUN printf %s '${c}' >> .runtime/runner.b64`),
    "RUN base64 -d .runtime/runner.b64 > .runtime/jobs-runner.ts && rm .runtime/runner.b64",
    "",
  ].join("\n");
}

const DOCKERIGNORE = "node_modules\n.git\n.env\n.env.*\ndist\n.next\n.turbo\n.trigger\ncoverage\n";

type Found = {
  kind: "trigger" | "inngest";
  id: string;
  file: string;
  schedule: { cron: string; timezone: string } | null;
  events?: string[];
  compute?: { vcpu: number; memoryMiB: number };
  maxDuration?: number;
  retry?: { maxAttempts: number };
};

async function projectName(dir: string, files: string[]): Promise<string> {
  for (const name of ["trigger.config.ts", "trigger.config.js", "trigger.config.mjs"]) {
    const text = await readFile(join(dir, name), "utf8").catch(() => "");
    const found = /project\s*:\s*["'`]([^"'`]+)["'`]/.exec(text);
    if (found) return found[1]!;
  }
  for (const file of files) {
    const text = await readFile(join(dir, file), "utf8").catch(() => "");
    const found = /new\s+Inngest\(\s*\{[^}]*\bid\s*:\s*["'`]([^"'`]+)["'`]/.exec(text);
    if (found) return found[1]!;
  }
  const pkg = await readFile(join(dir, "package.json"), "utf8").catch(() => "{}");
  const name = (JSON.parse(pkg) as { name?: string }).name?.replace(/^@[^/]+\//, "");
  return name || basename(resolve(dir));
}

export async function jobsDeployCommand(
  argv: string[],
  out: Out,
  runtime: () => Promise<Runtime>,
  kit: CliKit,
): Promise<number> {
  if (argv[0] === "help" || argv[0] === "--help") {
    out.write(out.json ? JSON.stringify({ usage: JOB_DEPLOY_HELP }) : JOB_DEPLOY_HELP);
    return 0;
  }
  const args = kit.parse(argv, ["dry-run"], ["name", "region"]);
  const dir = resolve(args.positional[0] ?? ".");
  const say = (text: string) => !out.json && out.write(text);
  const { ours, theirs } = await scanProject(dir);
  if (!ours.length)
    throw kit.usage(
      theirs.length
        ? `${theirs.join(", ")} still import Trigger.dev's or Inngest's SDK. Change \`@trigger.dev/sdk\` to \`withruntime/trigger\`, or \`inngest\` to \`withruntime/inngest\`, then deploy again.`
        : `No file under ${dir} imports withruntime/trigger or withruntime/inngest.`,
    );
  if (theirs.length)
    say(`Not deployed, still importing Trigger.dev's or Inngest's SDK: ${theirs.join(", ")}`);
  const project = kit.flag(args, "name") ?? (await projectName(dir, ours));
  const client = await runtime();
  const region = kit.flag(args, "region");

  say(`Building ${project}'s image from ${dir}...`);
  const runner = await readFile(
    fileURLToPath(new URL("./jobs-code/runner.js", import.meta.url)),
    "utf8",
  ).catch(() => readFile(fileURLToPath(new URL("./jobs-code/runner.ts", import.meta.url)), "utf8"));
  const image = await client.images.build({
    name: `jobs-${project}`.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 63),
    dockerfile: codeDockerfile(runner),
    contextDir: dir,
    dockerignore: DOCKERIGNORE,
    ...(region ? { region } : {}),
  });

  say(`Reading the tasks in ${ours.length} file${ours.length === 1 ? "" : "s"}...`);
  const sandbox = await client.sandboxes.create({
    image: image.id,
    ...(region ? { region } : {}),
  } as Parameters<typeof client.sandboxes.create>[0]);
  let found: Found[];
  let defaults = null as { maxDuration?: number; machine?: string; maxAttempts?: number } | null;
  try {
    const listed = await sandbox.exec(["bun", ".runtime/jobs-runner.ts", "discover", ...ours], {
      cwd: "/workspace/app",
      env: { RUNTIME_JOBS_PROJECT: project },
      timeoutMs: 120_000,
    });
    const line = listed.stdout.split("\n").find((l) => l.startsWith("JOBS-DISCOVERED "));
    if (!line)
      throw new Error(
        `Reading the tasks failed:\n${listed.stderr.slice(-2000) || listed.stdout.slice(-2000)}`,
      );
    for (const failed of listed.stderr.split("\n").filter((l) => l.startsWith("JOBS-FILE-FAILED ")))
      say(`  could not load ${failed.slice("JOBS-FILE-FAILED ".length)}`);
    const listedTasks = JSON.parse(line.slice("JOBS-DISCOVERED ".length)) as {
      tasks: Found[];
      triggerConfig: typeof defaults;
    };
    found = listedTasks.tasks;
    defaults = listedTasks.triggerConfig;
  } finally {
    await sandbox.delete().catch(() => undefined);
  }
  if (!found.length) throw new Error(`The files declare no task: ${ours.join(", ")}.`);

  const existing = new Map<string, Job>();
  for await (const job of await client.jobs.list({ limit: 100 }))
    if (job.state === "active" || job.state === "paused") existing.set(job.name, job);
  const results: { id: string; job: string; jobId?: string; action?: string; error?: string }[] =
    [];
  for (const task of found) {
    const name = jobNameOf(project, task.id);
    if (has(args, "dry-run")) {
      results.push({ id: task.id, job: name, action: "planned" });
      continue;
    }
    // trigger.config's defaults stand for what a Trigger.dev task leaves out.
    const fallback = task.kind === "trigger" ? (defaults as typeof defaults) : null;
    const machine = fallback?.machine ? MACHINES[fallback.machine] : undefined;
    const compute = task.compute ?? machine;
    const timeoutSeconds = Math.min(
      JOB_LIMITS.maxDurationSeconds,
      task.maxDuration ?? fallback?.maxDuration ?? JOB_DEFAULTS.timeoutSeconds,
    );
    const attempts = task.retry?.maxAttempts ?? fallback?.maxAttempts ?? 1;
    const definition = {
      image: image.id,
      command: ["bun", ".runtime/jobs-runner.ts", "run", task.file, task.kind, task.id],
      compute: {
        vcpu: compute?.vcpu ?? 1,
        memoryMiB: compute?.memoryMiB ?? 1024,
        diskMiB: Math.max(
          JOB_DEFAULTS.diskMiB,
          Math.ceil(((image.sizeMiB ?? 0) + 1024) / 1024) * 1024,
        ),
        durationSeconds: Math.min(
          JOB_LIMITS.maxDurationSeconds,
          timeoutSeconds + JOB_DEFAULTS.startSeconds,
        ),
        ...(region ? { region } : {}),
      },
      timeoutSeconds,
      retry: { maxAttempts: Math.min(5, attempts), backoffSeconds: 10 },
    };
    // A task run on demand is a template: tasks.trigger and inngest.send
    // copy it into a one-off run per payload. Its own schedule is once, at
    // TEMPLATE_AT, so it never runs by itself even before it is paused or
    // if the pause fails; it is paused too, so the console shows it waiting.
    const schedule: CreateJob["schedule"] = task.schedule
      ? { cron: task.schedule.cron, timezone: task.schedule.timezone }
      : { at: TEMPLATE_AT };
    try {
      const same = existing.get(name);
      let jobId: string;
      if (same) {
        await client.jobs.update(same.id, { ...definition, command: definition.command });
        await client.jobs.reschedule(same.id, schedule);
        jobId = same.id;
      } else {
        jobId = (await client.jobs.create({ name, schedule, ...definition })).id;
      }
      // A failed pause fails this task's line, and the deploy exits 1.
      if (!task.schedule) {
        if (same?.state !== "paused") await client.jobs.pause(jobId);
      } else if (same?.state === "paused") await client.jobs.resume(jobId);
      results.push({ id: task.id, job: name, jobId, action: same ? "updated" : "created" });
    } catch (error) {
      results.push({
        id: task.id,
        job: name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (out.json) out.write(JSON.stringify({ project, image: image.id, tasks: found, results }));
  else
    out.write(
      [
        "",
        ...found.map((task, i) => {
          const r = results[i]!;
          const when = task.schedule
            ? `${task.schedule.cron} ${task.schedule.timezone}`
            : task.events?.length
              ? `on ${task.events.join(", ")}`
              : "on demand";
          return r.error
            ? `✗ ${task.kind} ${task.id}: ${r.error}`
            : `✓ ${task.kind} ${task.id} → job ${r.job} ${r.jobId ?? ""} (${when}) ${r.action}`;
        }),
        "",
        `Run one now: ${me} jobs trigger <job id> && ${me} jobs logs <job id> -f`,
      ].join("\n"),
    );
  return results.every((r) => !r.error) ? 0 : 1;

  function has(a: typeof args, name: string) {
    return kit.has(a, name);
  }
}
