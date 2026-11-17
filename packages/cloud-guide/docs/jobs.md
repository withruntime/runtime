# Jobs

A job runs its command on a schedule: each run boots a fresh machine, runs [`run`](./reference/jobs#jobsettings) to its end, and is billed for that time alone. [`POST /v2/jobs`](./reference/jobs#create-a-job) takes a [JobCreate](./reference/jobs#jobcreate):

| Field | What it sets |
| --- | --- |
| [`schedule`](./reference/jobs#jobsettings) | When it runs. A cron line with [`cron`](./reference/jobs#jobschedule) and [`timezone`](./reference/jobs#jobschedule), or one time with [`at`](./reference/jobs#jobschedule). |
| [`run`](./reference/jobs#jobsettings) | The command each run runs; the run ends when it ends. |
| [`retry`](./reference/jobs#jobsettings) | How a failed run is run again; never when omitted. |
| [`secrets`](./reference/jobs#jobsettings) | Which of its org's secrets each run gets; every one whose scope admits it when omitted. |
| [`maxCost`](./reference/jobs#jobsettings) | The most one run may cost, in US dollars (`"0.50"`): a run pauses once it has cost that, as a machine at its maxCost does. |

## Schedule a job and run it now

```ts
import { Runtime } from "withruntime";

const runtime = new Runtime();
const job = await runtime.jobs.create({
  name: `nightly-${Date.now()}`,
  schedule: { cron: "0 3 * * *", timezone: "America/Denver" },
  run: { cmd: ["python3", "-c", "print(sum([125, 250, 375]))"] },
});
try {
  await job.run();
  let run;
  for (let i = 0; i < 240 && !run?.endedAt; i++) {
    await new Promise((r) => setTimeout(r, 250));
    for await (const each of runtime.jobRuns.list({ job: job.id })) run = each;
  }
  const output = await runtime.jobRuns.output(run!.id);
  console.log(run!.exitCode, JSON.stringify(output).slice(0, 200)); // 0 ... 750
  if (run!.exitCode !== 0) throw new Error(JSON.stringify(run));
} finally {
  await job.delete();
}
```

[`POST /v2/jobs/{id}:pause`](./reference/jobs#pause) stops its schedule and [`POST /v2/jobs/{id}:resume`](./reference/jobs#resume) starts it again. [`GET /v2/job-runs`](./reference/job-runs#list-jobruns) lists every run of a job.

## Next steps

- Every call on a job: [Job](./reference/jobs).
- Run a repository's checks instead: [CI](./ci).

## Give this to your agent

Paste this into your coding agent:

> Read https://withruntime.com/docs/jobs.md. Turn this project's scheduled task into a Runtime job: create it with its cron schedule, timezone and command, run it once now, and print that run's exit code and output.
>
> This page as Markdown: https://withruntime.com/docs/jobs.md
