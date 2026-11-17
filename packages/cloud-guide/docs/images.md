# Images and builds

An image is the disk a machine boots: [`POST /v2/images`](./reference/images#create-a-image) makes one, and [`image`](./reference/sandboxes#sandboxcreate) boots any product from it. A build runs on a machine of its own:

The machine an image's build runs on: Docker's own builder (BuildKit), its run `runtime-image-build`, deleted once its image is made. Made by an image's create, and billed as any machine is, for the CPU it uses and the memory it holds while it builds.

| Build machine | Value |
| --- | --- |
| vCPUs | 2 |
| Memory | 4 GB |
| Disk | 16 GB |

[`POST /v2/images`](./reference/images#create-a-image) takes one source:

| Field | What it builds |
| --- | --- |
| [`recipe`](./reference/images#imagecreate) | Packages, files and commands, rendered into a Dockerfile. Not with `files` or `context`. |
| [`dockerfile`](./reference/images#imagecreate) | A Dockerfile: multi-stage builds, `ARG`, `COPY --from`, heredocs. `COPY` reads `files`. |
| [`image`](./reference/images#imagecreate) | An OCI image to use as it is, from a public registry: `python:3.12-slim`, `ghcr.io/org/app:1`. |

## Build an image and boot from it

```ts
import { Runtime } from "withruntime";

const runtime = new Runtime();
const image = await runtime.images.create({ name: `example-${Date.now()}`, recipe: { pip: ["cowsay"] } });
let sandbox;
try {
  for (let i = 0; i < 400 && image.info.state !== "ready"; i++) {
    if (image.info.state === "failed") throw new Error(JSON.stringify(image.info));
    await new Promise((r) => setTimeout(r, 250));
    await image.refresh();
  }
  sandbox = await runtime.sandboxes.create({ image: image.id });
  const said = await sandbox.exec(["python3", "-m", "cowsay", "-t", "built"]);
  console.log(said.stdout);
  if (!said.stdout.includes("built")) throw new Error(said.stderr);
} finally {
  await sandbox?.delete();
  await image.delete();
}
```

Read a build's output with [`GET /v2/images/{id}/logs`](./reference/images#logs). Each build of the same [`name`](./reference/images#imagecreate) is its next version; boot `name:version` to pin one.

## Next steps

- Every call on an image: [Image](./reference/images).
- Keep a running machine's memory and disk instead: [snapshots](./snapshots).

## Give this to your agent

Paste this into your coding agent:

> Read https://withruntime.com/docs/images.md. Build a Runtime image for this project with its system and language packages (a recipe, or its Dockerfile), wait until it is ready, then create a sandbox from it and run the project's tests there.
>
> This page as Markdown: https://withruntime.com/docs/images.md
