---
launch: containers
---

# Containers

A container runs one OCI image's own process, from Docker Hub or any
registry, on a microVM of its own with its own kernel. Give an image, the
vCPUs and the memory; Runtime pins the image's digest, runs its entrypoint
and command the way Docker would, and keeps the process up.

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

- **The image** is any OCI image reference. The answer's `image` is the digest
  it resolved to, and a retry with the same `idempotencyKey` runs that digest,
  wherever the tag has moved since. The first container of an image builds
  it, once, for every later container: until the build is done the create
  answers `image_building` (409) with `retryAfterMs`, nothing created or
  billed. Retry with the same key.
- **The process** follows Docker's rules. `entrypoint` replaces the image's
  Entrypoint and drops its Cmd; `command` replaces Cmd and keeps the
  entrypoint. `env` adds to the image's environment; `workingDir` and `user`
  replace the image's.
- **Environment values are never answered**, the image's or yours: a
  container answers its environment's names, `envNames`.
- **A serving port**: an image that exposes one TCP port serves on it; one
  that exposes several needs `port`.
- **On exit** it restarts if it serves a port and stops otherwise; `onExit`
  (`restart` or `stop`) says otherwise.
- **It never sleeps** unless `sleep: true`, which lets it pause after {{idle-pause}}
  with nothing happening, memory kept.
- **Its size** is 1 to 16 vCPUs and 128 MiB to 64 GiB of memory, as a sandbox's.

A container's `state` is `waiting`, `running`, `sleeping`, `stopped` or
`failed`, and `deleting` then `deleted` after a delete. A failed one's
`error` says why its machine stopped. `get` with `waitFor` waits up to 60
seconds for a state.

## Change and delete

`update` renames a container (`name: null` clears it) or replaces its labels;
what it runs never changes. To run something else, create a new container
and delete the old one. `delete` stops the process and deletes the machine and
its disk. Lists filter by name, labels and state.

## What it costs

A container is billed as a sandbox of its size: active CPU and memory while
it runs, at the [sandbox rates](./pricing#containers). Containers have no
price of their own, and need credit on the account.

## Limits

An account with credit keeps up to 20 containers; one past them is refused
`quota_exceeded`, which names `container.count`. Without credit a create is
refused `payment_required` before anything is built ([limits](./limits)).
