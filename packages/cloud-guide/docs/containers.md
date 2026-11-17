# Containers

Run one OCI image from any registry, reached at an HTTPS address.

A machine that runs one OCI image from any registry under Docker on its own network (`start` `runtime-container <image>`), the port it listens on reached at its preview, as Cloud Run and Fly Machines run one.

| Default | Value |
| --- | --- |
| vCPUs | 1 |
| Memory | 1 GB |
| Disk | 4 GB |
| Image | `runtime/standard` |
| Pauses when idle | After 300 seconds |

Name the image in the `RUNTIME_CONTAINER_IMAGE` environment variable ([`env`](./reference/sandboxes#sandboxcreate)). With none, it runs `nginx:stable`. Every other field of [SandboxCreate](./reference/sandboxes#sandboxcreate) overrides a default above.

## Run an image

```ts
import { Runtime } from "withruntime";

const runtime = new Runtime();
const container = await runtime.containers.create({ env: { RUNTIME_CONTAINER_IMAGE: "traefik/whoami" } });
try {
  const preview = (await runtime.previews.create(container.id, { port: 80 })).info;
  const open = () => fetch(preview.url, { headers: { "x-runtime-preview-token": preview.token! } });
  let page = await open();
  for (let i = 0; i < 120 && page.status !== 200; i++) {
    await new Promise((r) => setTimeout(r, 250)); // the image is still being pulled
    page = await open();
  }
  console.log(page.status, (await page.text()).split("\n")[0]); // 200 Hostname: ...
  if (page.status !== 200) throw new Error(`the container answered ${page.status}`);
} finally {
  await container.delete();
}
```

## Next steps

- Every call on a container: [Container](./reference/containers).
- Boot your own image as the whole machine instead: [images](./images).

## Give this to your agent

Paste this into your coding agent:

> Read https://withruntime.com/docs/containers.md. Run this project's container image on Runtime: create a container with RUNTIME_CONTAINER_IMAGE set to the image, share the port it listens on with a preview and print its url.
>
> This page as Markdown: https://withruntime.com/docs/containers.md
