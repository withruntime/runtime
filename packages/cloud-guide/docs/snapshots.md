# Snapshots, forks and images

Installing the same packages in every new machine is slow. Prepare a machine once, then start from it.

| Call | What it does |
| --- | --- |
| [`POST /v2/sandboxes/{id}:snapshot`](./reference/sandboxes#snapshot) | Keeps a sandbox's memory and disk as they are now, a snapshot to start sandboxes from; with `image`, its disk alone as that image's next version. The sandbox runs on. Asked again with the same Idempotency-Key, it returns the same snapshot. |
| [`POST /v2/sandboxes/{id}:fork`](./reference/sandboxes#fork) | Copies a sandbox as it is now, memory and disk, into `count` copies of its own, each running on its host. Asked again with the same Idempotency-Key, it returns the same copies. |
| [`POST /v2/sandboxes`](./reference/sandboxes#create-a-sandbox) with [`from`](./reference/sandboxes#sandboxcreate) | What it starts as, by ID or name: a snapshot (a copy of it running, at its sizes, in its project, with its secrets) or an image (as `image` takes it). A name is a snapshot's when the project has one of that name, else an image's. Not with `image`. Running copies of a sandbox are `fork`'s. |
| [`GET /v2/snapshots`](./reference/snapshots#list-snapshots), [`GET /v2/snapshots/{id}`](./reference/snapshots#get-a-snapshot), [`DELETE /v2/snapshots/{id}`](./reference/snapshots#delete-a-snapshot) | Find and delete snapshots. |
| [`GET /v2/images`](./reference/images#list-images), [`GET /v2/images/{id}`](./reference/images#get-a-image) | The images a machine can boot, by [`image`](./reference/sandboxes#sandboxcreate). |

## Start from a snapshot

```ts
import { Runtime } from "withruntime";

const runtime = new Runtime();
const base = await runtime.sandboxes.create({});
let snapshotId: string | undefined;
let copyId: string | undefined;
try {
  await runtime.sandboxes.exec(base.id, { cmd: "echo prepared > /workspace/state" });
  const snapshot = await runtime.sandboxes.snapshot(base.id, { name: `example-${Date.now()}` });
  snapshotId = snapshot.id;
  const copy = await runtime.sandboxes.create({ from: snapshot.id });
  copyId = copy.id;
  const state = await runtime.sandboxes.exec(copy.id, { cmd: ["cat", "/workspace/state"] });
  console.log(state.stdout); // prepared
  if (state.stdout.trim() !== "prepared") throw new Error(state.stdout + state.stderr);
} finally {
  if (copyId) await runtime.sandboxes.delete(copyId);
  await runtime.sandboxes.delete(base.id);
  if (snapshotId) await runtime.snapshots.delete(snapshotId);
}
```

A snapshot is billed for what it stores, $0.18 per GiB-month. Deleting the machine it came from keeps it: delete snapshots you no longer use with [`DELETE /v2/snapshots/{id}`](./reference/snapshots#delete-a-snapshot).

## Fork a running machine

[`POST /v2/sandboxes/{id}:fork`](./reference/sandboxes#fork) copies a machine as it runs, with its memory and processes, into up to the number of copies [`count`](./reference/sandboxes#forkrequest) allows: How many. Use it to try several next steps of an agent from the same point, or to start many workers from one prepared machine.

## Give this to your agent

Paste this into your coding agent:

> Read https://withruntime.com/docs/snapshots.md. Prepare one Runtime machine with this project's dependencies installed, snapshot it, and change the project to start each task's machine from that snapshot instead of installing again. Delete snapshots the project no longer uses.
>
> This page as Markdown: https://withruntime.com/docs/snapshots.md
