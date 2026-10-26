# SSH and editors

Log in to a sandbox over SSH, open it in VS Code or a JetBrains IDE, and reach
any port in it from your own machine.

All of it goes through Runtime's API, authenticated with your key, over one
WebSocket per connection. The sandbox opens no port to the internet, and a key
that may run commands in a sandbox is the only thing that can connect.

## Log in

```bash no-run
runtime sandboxes ssh <id>                  # a shell
runtime sandboxes ssh <id> -- make test     # one command; exits with its code
```

`<id>` is the sandbox's id or its name. The first time, the CLI makes an SSH key
for this machine in `~/.config/runtime-cloud/ssh`. It sends only the public
half, into the one login it opens. You log in as `runtime`, the user commands
run as, with the same environment, the proxy settings and `sudo`.

A sandbox whose image has no SSH server, such as a custom image, gets one:
`runtime sandboxes ssh` installs `openssh-server` once and says so first.

## Open it in VS Code, Cursor or Windsurf

```bash no-run
runtime sandboxes code <id>                         # VS Code, at /workspace
runtime sandboxes code <id> --editor cursor         # Cursor
runtime sandboxes code <id> --editor windsurf --path /srv/app
```

One command opens the sandbox's folder in your editor over SSH. It makes sure
the sandbox has an SSH server, adds the `*.runtime` entry below to your SSH
config the first time, and starts the editor on the sandbox. Without the
editor's `code`, `cursor` or `windsurf` command on your PATH, it opens the
editor's link instead; `--print` only prints that link, to open on another
machine that has the entry. The editor needs its Remote - SSH extension, and
its first connection installs the editor's server in the sandbox, which needs
HTTPS out to the editor's download site. A paused sandbox wakes when the editor
connects.

## VS Code, JetBrains and plain ssh

Run this once on your machine:

```bash no-run
runtime sandboxes ssh config --install
```

It writes a `Host *.runtime` entry and includes it from `~/.ssh/config`, so
every sandbox is the host `<id>.runtime`, or `<name>.runtime`, to anything that
uses OpenSSH:

- **ssh, scp and rsync:** `ssh web.runtime`, `scp app.tar web.runtime:`.
- **VS Code, Cursor and Windsurf:** install the Remote - SSH extension, run
  **Remote-SSH: Connect to Host**, and enter `<id>.runtime`, or use
  `runtime sandboxes code` above.
- **JetBrains Gateway:** add an SSH connection to host `<id>.runtime`, user
  `runtime`, authenticating with the OpenSSH config and agent.

`runtime sandboxes ssh config` without `--install` prints the entry to paste yourself.
The entry skips host key checks on purpose. Each login gets a fresh host key.
The connection already goes to the sandbox you named, through Runtime's
authenticated API.

## Forward ports

```bash no-run
runtime sandboxes port-forward <id> 5432              # localhost:5432 here is 5432 in the sandbox
runtime sandboxes port-forward <id> 3000 15432:5432   # several at once, local:remote
```

Any TCP port works, not only HTTP: a database, Redis, a debugger, a dev server
that uses WebSockets. The server in the sandbox can listen on `127.0.0.1`, `::1`
or every address. Start it with `runtime sandboxes spawn <id> -- <command>` (or
`sbx.spawn()`), which keeps it running. A process started by `exec` ends with
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
`tunnel.connect(5432)` and `tunnel.ssh(publicKey)` each give a stream. It
reaches this one sandbox from your code. It is not the WireGuard tunnel that
joins your own network to your sandboxes
([private networks](./networking#private-networks)).

## Limits

- Connecting to a paused sandbox wakes it, as any command does. An open
  connection keeps it running. A sandbox is never idle while one is open. With
  no time limit, it runs as long as the session does, while credit lasts. A
  sandbox created with `timeoutSeconds` still ends the connection at its limit.
  Extend it for a long session.
- An organization has at most 16 SSH logins and port forwards open at the same time. It
  gets two more for each sandbox it holds that is not stopped, up to 292. One
  port forward carries at most 64 connections at the same time. Each lasts at most 24
  hours. Open it again to go on.
- Port 10800 is the sandbox's own outbound proxy and is not forwarded.
