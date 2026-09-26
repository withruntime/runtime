# SSH and editors

Log in to a sandbox over SSH, open it in VS Code or a JetBrains IDE, and reach
any port in it from your own machine.

All of it goes through Runtime's API, authenticated with your key, over one
WebSocket per connection. The sandbox opens no port to the internet, and a key
that may run commands in a sandbox is the only thing that can connect.

## Log in

```bash no-run
runtime sandbox ssh <id>                  # a shell
runtime sandbox ssh <id> -- make test     # one command; exits with its code
```

`<id>` is the sandbox's id or its name. The first time, the CLI makes an SSH key
for this machine in `~/.config/runtime-cloud/ssh` and sends only its public
half, into the one login it opens. You log in as `runtime`, the user commands
run as, with the same environment, the proxy settings and `sudo`.

A sandbox whose image has no SSH server, such as a custom image, gets one:
`runtime sandbox ssh` installs `openssh-server` once and says so first.

## VS Code, JetBrains and plain ssh

Run this once on your machine:

```bash no-run
runtime sandbox ssh config --install
```

It writes a `Host *.runtime` entry and includes it from `~/.ssh/config`, so
every sandbox is the host `<id>.runtime`, or `<name>.runtime`, to anything that
uses OpenSSH:

- **ssh, scp and rsync:** `ssh web.runtime`, `scp app.tar web.runtime:`.
- **VS Code:** install the Remote - SSH extension, run **Remote-SSH: Connect
  to Host**, and enter `<id>.runtime`.
- **JetBrains Gateway:** add an SSH connection to host `<id>.runtime`, user
  `runtime`, authenticating with the OpenSSH config and agent.

`runtime sandbox ssh config` without `--install` prints the entry to paste yourself.
The entry skips host key checks on purpose: each login gets a fresh host key,
and the connection already goes to the sandbox you named, through Runtime's
authenticated API.

## Forward ports

```bash no-run
runtime sandbox port-forward <id> 5432              # localhost:5432 here is 5432 in the sandbox
runtime sandbox port-forward <id> 3000 15432:5432   # several at once, local:remote
```

Any TCP port works, not only HTTP: a database, Redis, a debugger, a dev server
that uses WebSockets. The server in the sandbox can listen on `127.0.0.1`, `::1`
or every address. Start it with `runtime sandbox spawn <id> -- <command>` (or
`sbx.spawn()`), which keeps it running; a process started by `exec` ends with
its command. The forward listens on `127.0.0.1` unless you pass `--address`,
runs until Ctrl-C, and says so when nothing listens on the port.

From code, the SDKs do the same:

```ts check
import { Sandbox } from "withruntime";

await using sbx = await Sandbox.create();
await sbx.spawn("python3 -m http.server 8000");
const forward = await sbx.forwardPort(8000, { localPort: 0 });
console.log(`http://127.0.0.1:${forward.localPort}/`);
await forward.close();
```

```python check
from withruntime import Sandbox

with Sandbox.create() as sbx:
    sbx.spawn("python3 -m http.server 8000")
    with sbx.forward_port(8000, local_port=0) as forward:
        print(f"http://127.0.0.1:{forward.local_port}/")
```

`sbx.tunnel()` in JavaScript opens one connection at a time instead:
`tunnel.connect(5432)` and `tunnel.ssh(publicKey)` each give a stream.

## Limits

- Connecting to a paused sandbox wakes it, as any command does. An open
  connection does not keep a sandbox running: when its lease pauses or stops
  it, the connection ends. Extend the lease for a long session.
- An organization has at most 16 SSH logins and port forwards open at once,
  and one port forward carries at most 64 connections at once. Each lasts at
  most 24 hours; open it again to go on.
- Port 10800 is the sandbox's own outbound proxy and is not forwarded.
