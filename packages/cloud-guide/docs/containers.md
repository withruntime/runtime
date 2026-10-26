---
launch: containers
---

# Containers

A container runs the process of one OCI image, from Docker Hub or any
registry. It runs on a microVM of its own, with its own kernel. You give an
image, the vCPUs and the memory. Runtime pins the image's digest, runs its
entrypoint and command as Docker would, and keeps the process up.

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const web = await runtime.containers.create({
  image: "nginx:1.27-alpine",
  vcpu: 1,
  memoryMiB: 512,
  name: "web",
});
console.log(web.id, web.state, web.image);
```

```bash no-run
npx withruntime containers create nginx:1.27-alpine --vcpu 1 --memory 512 --name web
npx withruntime containers ls
```

## What runs

- **The image** is any OCI image reference. The response's `image` is the digest
  it resolved to. A retry with the same `idempotencyKey` runs that digest, even
  if the tag has moved since. The first container of an image builds it once,
  for every later container. Until the build is done, the create returns
  `image_building` (409) with `retryAfterMs`. Nothing is created or billed.
  Retry with the same key.
- **The process** follows Docker's rules. `entrypoint` replaces the image's
  Entrypoint and drops its Cmd; `command` replaces Cmd and keeps the
  entrypoint. `env` adds to the image's environment; `workingDir` and `user`
  replace the image's.
- **Environment values are never returned**, the image's or yours. A container
  returns its environment's names, `envNames`.
- **A serving port**: an image that exposes one TCP port serves on that port.
  One that exposes several needs `port`.
- **On exit**, it restarts if it serves a port and stops otherwise. `onExit`
  (`restart` or `stop`) overrides this.
- **It never sleeps** unless `sleep: true` is set. With it, the container pauses
  after {{idle-pause}} with no activity. Memory is kept.
- **Its size** is 1 to 16 vCPUs and 128 MiB to 64 GiB of memory, as a sandbox's.

A container's `state` is `waiting`, `running`, `sleeping`, `stopped` or
`failed`. After a delete it is `deleting`, then `deleted`. A failed one's
`error` says why its machine stopped. `get` with `waitFor` waits up to 60
seconds for a state.

## Change and delete

`update` renames a container (`name: null` clears it) or replaces its labels.
What it runs never changes. To run something else, create a new container
and delete the old one. `delete` stops the process and deletes the machine and
its disk. Lists filter by name, labels and state.

A key reaches the same containers that a sandbox of its would reach. A key
scoped to a compartment reaches that compartment's containers. A key that
another key made reaches the containers that key made. An account-wide key
reaches every container. A container that belongs to another key returns
`not_found`.

## Stop, restart and sleep

A container's id works with the sandbox routes. `POST /v1/sandboxes/{id}:stop`
stops it and keeps its disk. `POST /v1/sandboxes/{id}:restart` boots it again
from that disk and starts its process, with the same image, command and
environment. A container created with `sleep: true` can also be paused with
`POST /v1/sandboxes/{id}:pause` and woken with `POST /v1/sandboxes/{id}:wake`,
and a request to one of its previews wakes it.

## What it costs

A container is billed as a sandbox of its size: active CPU and memory while
it runs, at the [sandbox rates](./pricing#containers). Containers have no
price of their own, and need credit on the account.

## Limits

An account with credit keeps up to 20 containers. A container beyond that is
refused `quota_exceeded`, and the error names `container.count`. Without credit,
a create is refused `payment_required` before anything is built
([limits](./limits)).
