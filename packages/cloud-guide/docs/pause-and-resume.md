# Pause and resume

A paused sandbox keeps its disk, its memory and its running processes, and costs only its storage, $0.18 per GB-month. Resume it and its programs carry on from where they were.

- [`POST /v2/sandboxes/{id}:pause`](./reference/sandboxes#pause) pauses it.
- [`POST /v2/sandboxes/{id}:resume`](./reference/sandboxes#resume) resumes it. Any call that needs it running, such as [`POST /v2/sandboxes/{id}:exec`](./reference/sandboxes#exec), resumes it first, so you rarely call resume yourself.
- A sandbox with nothing happening in it pauses by itself. Set how long it waits with [`idlePauseSeconds`](./reference/sandboxes#machineupdate) on [`POST /v2/sandboxes/{id}:update`](./reference/sandboxes#update): Seconds with nothing happening before it pauses, 60 to 86400; 0 never.

## A process keeps running across a pause

```ts
import { Runtime } from "withruntime";

const runtime = new Runtime();
const sandbox = await runtime.sandboxes.create({});
try {
  const counter = await runtime.sandboxes.exec(sandbox.id, { cmd: ["sleep", "600"], wait: false });
  await runtime.sandboxes.pause(sandbox.id);
  await runtime.sandboxes.resume(sandbox.id);
  const after = (await runtime.sandboxes.processOutput(sandbox.id, counter.id)).process;
  console.log("after the resume, the process is", after?.state); // running
  if (after?.state !== "running") throw new Error(`the process is ${after?.state}`);
} finally {
  await runtime.sandboxes.delete(sandbox.id);
}
```

## When to pause

- An agent waiting on a model or a person: pause it, and the next call resumes it.
- A dev environment overnight: pause it rather than delete it, and keep its installed packages and open files.
- Many short tasks from the same prepared state: keep one sandbox ready and [fork](./snapshots) it for each task.

## Give this to your agent

Paste this into your coding agent:

> Read https://withruntime.com/docs/pause-and-resume.md. Change this project so sandboxes that wait for a user or a model are paused instead of kept running or recreated, and are resumed by the next call.
>
> This page as Markdown: https://withruntime.com/docs/pause-and-resume.md
