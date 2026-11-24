# Images and builds

An image is the disk a machine boots: [`POST /v2/images`](./reference/images#create-a-image) makes one, and [`image`](./reference/sandboxes#sandboxcreate) boots any product from it. A build runs on a machine of its own:

The machine an image's build runs on: Docker's own builder (BuildKit), its run `runtime-image-build`, deleted once its image is made. Made by an image's create, and billed as any machine is, for the CPU it uses and the memory it holds while it builds.

| Build machine | Value |
| --- | --- |
| vCPUs | 2 |
| Memory | 4 GB |
| Disk | 16 GB, or its image's size when larger |

[`build`](./reference/images#imagecreate) names the build machine's own sizes; each one it names overrides a default above.

[`POST /v2/images`](./reference/images#create-a-image) takes one source:

| Field | What it builds |
| --- | --- |
| [`recipe`](./reference/images#imagecreate) | Packages, files and commands, rendered into a Dockerfile. Not with `files` or `context`. |
| [`dockerfile`](./reference/images#imagecreate) | A Dockerfile: multi-stage builds, `ARG`, `COPY --from`, heredocs. `COPY` reads `files`. |
| [`image`](./reference/images#imagecreate) | An OCI image to use as it is: `python:3.12-slim`, `ghcr.io/org/app:1`. A private one is named by its digest, `repo@sha256:<64 hex digits>`, with `pullSecret`. |

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

## Import a private image

A private image is named by its digest, with the secret that holds its registry's login:

| Field | |
| --- | --- |
| [`image`](./reference/images#imagecreate) | An OCI image to use as it is: `python:3.12-slim`, `ghcr.io/org/app:1`. A private one is named by its digest, `repo@sha256:<64 hex digits>`, with `pullSecret`. |
| [`pullSecret`](./reference/images#imagecreate) | The secret holding the registry login that pulls a private `image`: a hidden secret with header `Authorization`, format `Basic {value}`, its value the base64 of `username:token`, as its hosts the registry's token service (`auth.docker.io` for Docker Hub, the registry's own name for `ghcr.io`, `quay.io` and others), and as its scope `{"none": true}`, so no machine's requests carry it. Runtime's egress proxy signs in with it for this import's build machine alone, which never holds the login or a token. The caller needs the `secrets:use` permission. |

Store the login once as a [secret](./secrets). Use a read-only access token, not your password. Its value is `username:token` in base64. Give it the scope `{"none": true}`, so that no machine's requests carry it. Imports refuse a login with any other scope:

```bash
curl -X PUT https://api.withruntime.com/v2/secrets/REGISTRY_DOCKER_IO \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"value": "'"$(printf '%s' "$DOCKER_USER:$DOCKER_TOKEN" | base64)"'",
       "hosts": ["auth.docker.io"], "header": "Authorization", "format": "Basic {value}",
       "policies": {"rules": [{"methods": ["GET"], "paths": ["/token"]}]},
       "scope": {"none": true}}'
```

Then import the image by its digest:

```bash
curl -X POST https://api.withruntime.com/v2/images \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "app", "image": "klym/app@sha256:<64 hex digits>", "pullSecret": "REGISTRY_DOCKER_IO"}'
```

Runtime's egress proxy signs in to the registry for the build itself. It asks the registry's token service for a token that pulls only the named repository, and adds that token only to the build machine's pulls by digest. The build machine never holds the login or the token, does not use a registry mirror for the image, and accepts no exec, file or link call while it builds. The proxy sends the login only to the token service the secret names, and only for the registry the image is on. A registry login moved from 1.0 is stored this way already, as `REGISTRY_<host>`.

## Next steps

- Every call on an image: [Image](./reference/images).
- Keep a running machine's memory and disk instead: [snapshots](./snapshots).

## Give this to your agent

Paste this into your coding agent:

> Read https://withruntime.com/docs/images.md. Build a Runtime image for this project with its system and language packages (a recipe, or its Dockerfile), wait until it is ready, then create a sandbox from it and run the project's tests there.
>
> This page as Markdown: https://withruntime.com/docs/images.md
