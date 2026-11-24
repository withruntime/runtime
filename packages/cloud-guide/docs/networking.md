# Networking

## Connections out

By default a machine can connect to the internet. [`PUT /v2/sandboxes/{id}/network`](./reference/sandboxes#setnetwork) replaces its rules with a [NetworkRules](./reference/sandboxes#networkrules): Replaces where a sandbox may connect out, for its next connection and within a second for its open ones: those the new rules refuse are cut.

- [`allowOutbound`](./reference/sandboxes#networkrules): The only places it may reach, each a host, `*.` and a name for every name under it, an address or a CIDR (`[` and `]` around an IPv6 address), every port when it names none; `:port` for that port alone, on a host name for a port beyond 80 and 443, which go together. `*` is every public host. Every public host when omitted; nothing when empty.
- [`denyOutbound`](./reference/sandboxes#networkrules): Places it may never reach, written as in allowOutbound with no port: a deny wins over every allow.
- [`GET /v2/sandboxes/{id}/network`](./reference/sandboxes#getnetwork) returns the rules in force.

```ts
import { Runtime } from "withruntime";

const runtime = new Runtime();
const sandbox = await runtime.sandboxes.create({});
try {
  await runtime.sandboxes.setNetwork(sandbox.id, { allowOutbound: ["pypi.org"] });
  const probe = (url: string) =>
    runtime.sandboxes.exec(sandbox.id, { cmd: ["curl", "-s", "-o", "/dev/null", "-m", "5", "-w", "%{http_code}", url] });
  const allowed = await probe("https://pypi.org/simple/");
  const refused = await probe("https://example.com/");
  console.log("pypi.org:", allowed.stdout, "example.com:", refused.stdout || `refused (exit ${refused.exitCode})`);
  if (allowed.stdout !== "200" || refused.stdout === "200") throw new Error("the rules were not applied");
} finally {
  await runtime.sandboxes.delete(sandbox.id);
}
```

Outbound traffic from a machine costs $0.03 per GB. Inbound traffic is free.

## Connections in

- HTTPS: a [preview](./web-app) shares one port at an HTTPS address, private by default.
- TCP: [`POST /v2/ports`](./reference/ports#create-a-port) opens a public TCP port to a machine.

To call an API from a machine without giving it the key, use a [secret](./secrets).

## Give this to your agent

Paste this into your coding agent:

> Read https://withruntime.com/docs/networking.md. Give this project's machines network rules that allow only the hosts its code needs, and confirm a connection to any other host is refused.
>
> This page as Markdown: https://withruntime.com/docs/networking.md
