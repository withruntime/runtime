import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { me } from "./cli-name.js";
import type { CliKit } from "./cli.js";
import type { Runtime } from "./client.js";
import type { Image } from "./products/images.js";
import {
  JOB_DEFAULTS,
  JOB_LIMITS,
  type CreateJob,
  type Job,
  type JobImportJob,
  type JobImportPlan,
} from "./products/jobs.js";

/* `runtime jobs import`: Jobs' one-line switch from Google Cloud Run jobs and
   AWS Batch. The API reads the files into a plan (POST /v1/job-imports, Rust's
   engines/machine/crates/jobs-import); this builds each job's image from the
   plan's Dockerfile (FROM the container image the job ran there) and creates
   the job, or updates the job of that name, so running it again after a
   change to the files moves the change. The job runs the built image's start
   command: the container's ENTRYPOINT and CMD as the platform's command and
   args left them. */

type Out = { json: boolean; write: (text: string) => void; error: (text: string) => void };

export const JOB_IMPORT_HELP = `runtime jobs import <file>... [--from cloud-run|aws-batch] [--parameter NAME=VALUE]...
                     [--cron "<five fields>" [--timezone <zone>] | --at <time|now>] [--region us-east]
                     [--dry-run]

  Move jobs from Google Cloud Run or AWS Batch. Each job runs the same container
  image, command, environment, size, timeout and retries, on the same schedule.

  Cloud Run:  the job's YAML (gcloud run jobs describe <job> --format export), and the
              Cloud Scheduler job that runs it (gcloud scheduler jobs describe <job> --format yaml)
  AWS Batch:  the job definition (register-job-definition's JSON, describe-job-definitions'
              output, or a CloudFormation template), and the EventBridge Scheduler schedule
              or EventBridge rule that submits it

  --parameter   a CloudFormation template's value, such as AWS::Region=us-east-1
  --cron, --at  the schedule for a job no schedule in the files runs
  --dry-run     print the plan and each image's Dockerfile; build and create nothing

  A secret the job read from Secret Manager, Secrets Manager or SSM is bound from the
  jobs secret of the same name: store it first with
  printf %s "$VALUE" | runtime secrets set NAME --jobs
  Pulling from a private registry (Artifact Registry, ECR) needs its credential once:
  runtime images registry set <host> ...
`;

/** A wall-clock time in an IANA zone, as Unix milliseconds. */
export function zonedTime(local: string, timeZone: string): number {
  const found = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local.trim());
  if (!found) throw new Error(`${local} is not a time such as 2026-11-01T03:00:00`);
  const [y, mo, d, h, mi, s] = found.slice(1).map((n) => Number(n ?? 0)) as number[];
  const guess = Date.UTC(y!, mo! - 1, d!, h!, mi!, s ?? 0);
  // The zone's offset at the guess, then again at the corrected instant.
  const offset = (at: number) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(at));
    const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - at;
  };
  const first = guess - offset(guess);
  return guess - offset(first);
}

/** The command a job of a built image runs: its start command. */
export function startArgv(image: Pick<Image, "start">): string[] | undefined {
  if (image.start?.argv?.length) return image.start.argv;
  if (image.start?.command) return ["sh", "-c", image.start.command];
  return undefined;
}

function planLines(plan: JobImportPlan): string[] {
  const lines = [
    `Read ${plan.read.join(", ")} as ${plan.from === "cloud-run" ? "Cloud Run" : "AWS Batch"}.`,
  ];
  for (const job of plan.jobs) {
    const when = !job.schedule
      ? "no schedule"
      : job.schedule.kind === "cron"
        ? `${job.schedule.expression} ${job.schedule.timezone}`
        : `once at ${job.schedule.at} ${job.schedule.timezone}`;
    lines.push(
      "",
      `${job.blocked ? "✗" : "✓"} ${job.name}  ${job.sourceImage}`,
      `    ${job.compute.vcpu} vCPU, ${job.compute.memoryMib} MiB, timeout ${job.timeoutSeconds} s, ${job.retry.maxAttempts} attempt${job.retry.maxAttempts === 1 ? "" : "s"}, ${when}`,
    );
    if (job.command) lines.push(`    runs ${job.command.join(" ")}`);
    if (job.secrets.length)
      lines.push(`    secrets: ${job.secrets.map((s) => `${s.name} (from ${s.from})`).join(", ")}`);
    if (job.blocked) lines.push(`    not moved: ${job.blocked}`);
  }
  const marks = { unmapped: "left out", changed: "changed", info: "note" } as const;
  if (plan.notes.length) lines.push("");
  for (const note of plan.notes)
    lines.push(
      `  ${marks[note.level]}: ${note.job ? `${note.job}: ` : ""}${note.message} (${note.file} ${note.key})`,
    );
  return lines;
}

export async function jobsImportCommand(
  argv: string[],
  out: Out,
  runtime: () => Promise<Runtime>,
  kit: CliKit,
): Promise<number> {
  if (argv[0] === "help" || argv[0] === "--help") {
    out.write(out.json ? JSON.stringify({ usage: JOB_IMPORT_HELP }) : JOB_IMPORT_HELP);
    return 0;
  }
  const args = kit.parse(
    argv,
    ["dry-run"],
    ["from", "parameter", "cron", "timezone", "at", "region"],
  );
  if (!args.positional.length)
    throw kit.usage(`Name the files: ${me} jobs import job.yaml scheduler.yaml`);
  const from = kit.flag(args, "from");
  if (from !== undefined && from !== "cloud-run" && from !== "aws-batch")
    throw kit.usage(`--from is cloud-run or aws-batch, not ${from}.`);
  const cron = kit.flag(args, "cron");
  const at = kit.flag(args, "at");
  if (cron !== undefined && at !== undefined) throw kit.usage("Give --cron or --at, not both.");
  const files = await Promise.all(
    args.positional.map(async (path) => ({
      path: basename(path),
      text: await readFile(path, "utf8"),
    })),
  );
  const parameters = kit.pairs(args, "parameter");
  const client = await runtime();
  const plan = await client.jobs.importPlan({
    files,
    ...(from ? { from } : {}),
    ...(Object.keys(parameters).length ? { parameters } : {}),
  });
  if (!out.json) out.write(planLines(plan).join("\n"));
  if (has(args, "dry-run")) {
    if (out.json) out.write(JSON.stringify(plan));
    // The build file each job's image would be built from, whole, so what
    // runs is read before anything is built.
    else
      for (const job of plan.jobs)
        if (job.dockerfile) out.write(`\n${job.name}: its image's Dockerfile\n${job.dockerfile}`);
    return plan.importable ? 0 : 1;
  }

  const secrets = plan.jobs.some((j) => j.secrets.length) ? await client.secrets.all() : [];
  const existing: Job[] = [];
  for await (const job of await client.jobs.list({ limit: 100 }))
    if (job.state === "active" || job.state === "paused") existing.push(job);
  const results: {
    name: string;
    id?: string;
    image?: string;
    action?: string;
    refused?: string;
  }[] = [];
  for (const job of plan.jobs) {
    if (job.blocked) {
      results.push({ name: job.name, refused: job.blocked });
      continue;
    }
    try {
      results.push({
        name: job.name,
        ...(await move(client, job, { secrets, existing, cron, at, args, kit, out })),
      });
    } catch (error) {
      results.push({
        name: job.name,
        refused: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (out.json) out.write(JSON.stringify({ plan, results }));
  else
    out.write(
      [
        "",
        ...results.map((r) =>
          r.refused
            ? `✗ ${r.name}: ${r.refused}`
            : `✓ ${r.name} ${r.action} ${r.id} (image ${r.image})`,
        ),
        ...(results.some((r) => r.id)
          ? [``, `Run one now: ${me} jobs trigger <id> && ${me} jobs logs <id> -f`]
          : []),
      ].join("\n"),
    );
  return results.every((r) => r.id) ? 0 : 1;

  function has(a: typeof args, name: string) {
    return kit.has(a, name);
  }
}

async function move(
  client: Runtime,
  job: JobImportJob,
  context: {
    secrets: Awaited<ReturnType<Runtime["secrets"]["all"]>>;
    existing: Job[];
    cron: string | undefined;
    at: string | undefined;
    args: ReturnType<CliKit["parse"]>;
    kit: CliKit;
    out: Out;
  },
): Promise<{ id: string; image: string; action: string }> {
  const { kit, args } = context;
  const bindings = job.secrets.map((needed) => {
    const found = context.secrets.find((s) => s.name === needed.name)?.jobs;
    if (!found)
      throw new Error(
        `${needed.name} came from ${needed.from}; store it for jobs first: printf %s "$VALUE" | ${me} secrets set ${needed.name} --jobs`,
      );
    return { name: needed.name, secretId: found.id };
  });
  const schedule: CreateJob["schedule"] | undefined = context.cron
    ? {
        cron: context.cron,
        ...(kit.flag(args, "timezone") ? { timezone: kit.flag(args, "timezone")! } : {}),
      }
    : context.at
      ? { at: context.at === "now" ? Date.now() : Date.parse(context.at) }
      : job.schedule?.kind === "cron"
        ? { cron: job.schedule.expression, timezone: job.schedule.timezone }
        : job.schedule?.kind === "once"
          ? { at: zonedTime(job.schedule.at, job.schedule.timezone) }
          : undefined;
  if (!schedule)
    throw new Error(
      `no schedule in the files runs it: give one with --cron "<five fields>" or --at now`,
    );
  if (!context.out.json)
    context.out.write(`Building ${job.name}'s image from ${job.sourceImage}...`);
  const image = await client.images.build({
    name: `job-${job.name}`.slice(0, 63),
    dockerfile: job.dockerfile,
    ...(kit.flag(args, "region") ? { region: kit.flag(args, "region")! } : {}),
  });
  const argv = startArgv(image);
  if (!argv)
    throw new Error(
      `${job.sourceImage} names no command (no ENTRYPOINT or CMD) and the file gives none`,
    );
  const imageMiB = image.sizeMiB ?? 0;
  const diskMiB = Math.max(job.compute.diskMib ?? 4096, Math.ceil((imageMiB + 1024) / 1024) * 1024);
  const compute = {
    vcpu: job.compute.vcpu,
    memoryMiB: job.compute.memoryMib + (job.compute.memoryMib % 2),
    diskMiB,
    durationSeconds: Math.min(
      JOB_LIMITS.maxDurationSeconds,
      job.timeoutSeconds + JOB_DEFAULTS.startSeconds,
    ),
    ...(kit.flag(args, "region") ? { region: kit.flag(args, "region")! } : {}),
  };
  const same = context.existing.find((j) => j.name === job.name);
  if (same) {
    await client.jobs.update(same.id, {
      image: image.id,
      command: argv,
      compute,
      timeoutSeconds: job.timeoutSeconds,
      retry: job.retry,
      secrets: bindings,
    });
    await client.jobs.reschedule(same.id, schedule);
    return { id: same.id, image: `${image.name}@${image.version}`, action: "updated" };
  }
  const made = await client.jobs.create({
    name: job.name,
    schedule,
    image: image.id,
    command: argv,
    compute,
    timeoutSeconds: job.timeoutSeconds,
    retry: job.retry,
    ...(bindings.length ? { secrets: bindings } : {}),
  });
  return { id: made.id, image: `${image.name}@${image.version}`, action: "created" };
}
