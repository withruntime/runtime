# The sandbox environment

Every sandbox is a Firecracker microVM with its own Linux kernel and disk, with Python, Node.js, Bun, git and a compiler ready to use.

This page says what is in the image, who you are inside it, and what it can
reach. Anything missing installs in one command, or once for every sandbox in a
[custom image](./javascript#custom-images).

## What is installed

The image is Ubuntu 24.04.5 LTS (noble) for amd64, on a 6.18 kernel.

| Kind              | What                                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| Python            | Python 3.12 (`python3` and `python`), `pip` and `pip3`, `venv`, and uv 0.12.17 (`uv`, `uvx`)                   |
| Python data tools | NumPy 1.26.4, pandas 2.1.4 and matplotlib 3.6.3, included in the current default image                         |
| JavaScript        | Node.js 24.21.0 (`node`, `npm`, `npx`), with `pnpm` and `yarn` through Corepack; Bun 1.4.0 (`bun`)             |
| Build             | `gcc`, `g++`, `make` (build-essential)                                                                         |
| Source and fetch  | `git`, `curl`, `wget`, `ssh`, `zip`, `unzip`, `xz`                                                             |
| Search and data   | `rg` (ripgrep), `fd`, `jq`, `sqlite3`                                                                          |
| System            | `sudo`, `adduser` and `useradd`, `chronyd`, `sshd` (for [SSH and editors](./editors)), `ip`, `iptables-legacy` |
| Agent sandboxing  | `bwrap` (bubblewrap), which Codex runs its commands under: in the default image from its next build            |

**Anything else installs the usual way:** `sudo apt-get install -y ...`,
`pip install ...`, `npm install ...`, `uv pip install ...`. A new sandbox has
no apt package lists yet, so run `sudo apt-get update` once before the first
`apt-get install`. To start every
sandbox with your dependencies already there, build a [custom image](./images).

- **bubblewrap:** until the default image carries `bwrap`,
  `sudo apt-get update && sudo apt-get install -y bubblewrap` adds it; Codex
  and other agents that sandbox their own commands with it then work as on any
  Linux machine.
- **Java, Go and Rust:** install Ubuntu's packages with `sudo apt-get install`,
  or a newer release with the language's own installer, such as `rustup` for
  Rust. To have one in every sandbox, build a custom image whose recipe installs
  it, or start the image from a public image that already has it.
- **Docker:** `sudo enable-docker` installs Docker Engine, Buildx and Compose,
  and the first `docker` command runs it for you. See [Docker](#docker) below.
- **A Dockerfile:** run it with Docker in a sandbox, or build it as a custom
  image and start sandboxes from it; multi-stage builds, `COPY --from`, heredocs
  and `.dockerignore` work as in Docker.
- **Browsers:** they stay out of the image so its disk stays small. Playwright's
  Chromium installs in two commands:

```bash no-run
sudo npx playwright install-deps chromium
npx playwright install chromium
```

## Who you are

- Commands run as the user `runtime` (uid 1000), with `bash`, and `USER` and
  `LOGNAME` say so.
- `HOME` is `/workspace`, which is also the default working directory. Files
  there belong to you.
- `sudo` works without a password: you are root inside your own sandbox. To run
  a command as root without typing `sudo`, give it `user: "root"` (exec,
  background processes and terminals; `--root` in the CLI). Root
  cannot change what the sandbox may reach, how much CPU and memory it has, or
  what it costs; those are enforced on the host, outside the sandbox.
- `PATH` starts with `/workspace/.local/bin`, then `/usr/local/bin`, `/usr/bin`
  and `/bin`. `LANG` is `C.UTF-8`.
- Variables you set with `env` at create (or change with `:update`) are in
  every command, background process, terminal, SSH session and the image's
  start command, for the sandbox's whole life, under each command's own `env`
  ([API](./api#sandboxes)). Their values are never shown back. `:update`
  works on a paused or stopped sandbox too. A change reaches commands and
  processes started after it; a program already running, also through a pause
  and wake, keeps the values it started with, so restart it to pick one up.

`pip install` works without a virtual environment. As `runtime` it installs to
`/workspace/.local` (whose `bin` is first on `PATH`); under `sudo` it installs to
`/usr/local`. The image's `/etc/pip.conf` sets `break-system-packages`, so the
Ubuntu rule against installing into the system Python (PEP 668) does not stop
you. Use `python3 -m venv` or `uv` when you want isolation.

`npm install -g` and `bun add -g` put their commands in `/workspace/.local/bin`
too, so a tool such as `claude` or `codex` runs by name as soon as it is
installed, with or without `sudo` for npm. `pnpm` and `yarn` fetch the version
a project's `packageManager` names the first time they run.

## The machine's identity

A sandbox starts in milliseconds because it is not booted: it is a copy of a
machine that booted once. Most of what a machine calls its own identity is
made new for each copy, but not all of it.

- `/etc/machine-id` is the sandbox's own, made when it first starts and kept
  for its whole life: through pauses, wakes, stops and restarts. A fork, or a
  sandbox created from a snapshot, gets a new one. Use it when a program needs
  an ID for the machine it runs on.
- `/dev/urandom`, `getrandom` and every program started in the sandbox get
  fresh randomness. Programs already running when a fork or snapshot was taken
  keep their own state; see [randomness in copies](./storage#randomness-in-copies).
- The kernel's boot ID (`/proc/sys/kernel/random/boot_id`) and boot time
  (`uptime`, `btime` in `/proc/stat`) belong to the machine that booted, so
  sandboxes made from the same image can share them. The kernel cannot change
  them without a reboot, and `restart` gives a sandbox its own. Do not use the
  boot ID to tell sandboxes apart.
- The hostname is `runtime-guest` in every sandbox.

## Disk, CPU and memory

- **Disk:** `diskMiB` includes the system image and installed packages. The
  current default 4 GiB sandbox had about 2.5 GiB available in a measurement
  on 24 September 2026; ask for more when you install a lot. The smallest disk
  is 3072 MiB, the size of the image file.
- **Disk speed:** a sandbox shares its server's drives with the sandboxes
  beside it, in proportion, with no fixed ceiling of its own. It gets at least
  about {{disk-floor}} each way, and up to about {{disk-up-to}} when its
  neighbours are quiet. One busy sandbox cannot starve the others, and a pause
  writes its memory ahead of everyone's traffic, so it stays quick on a busy
  server.
- **CPU:** shared by default, with a guaranteed floor (`cpuFloorMillis`, 50
  thousandths of a vCPU unless you ask for more) and bursts up to `vcpu` cores.
  `cpu: "reserved"` is that same floor set to every vCPU (`vcpu` x 1000).
  You pay for the CPU the sandbox uses. Up to 16 vCPUs on a paid sandbox, 2 without
  credit.
- **Processor:** AMD EPYC (x86-64, Zen). AVX, AVX2 and FMA are guaranteed on
  every server, so code that requires them (MuJoCo, for one) can count on them.
  A paused sandbox or a snapshot only wakes on a server that shows it the same
  processor features, so a running process never loses one. AVX-512 is not
  offered.
- **Memory:** what you ask for, up to 64 GiB on a paid sandbox and 4 GiB
  without credit.

### When a program runs out of memory

A sandbox that runs out of memory stays up: Linux's out-of-memory killer ends
the program using the most, and the rest keeps running. Your programs share
the sandbox's memory less a reserve for its own services (a sixteenth of it,
128 MiB at least and 256 MiB at most), so while they fill it, commands, file
reads and kills still answer. A program ended that
way exits with -9 (137 from a shell) and often prints nothing. Runtime says
why: the command's result, its process (read, get or list) and the stream's
`exit` event carry `outOfMemory`:

```json
{
  "exitCode": -9,
  "outOfMemory": {
    "code": "out_of_memory",
    "processesKilled": 1,
    "memoryMiB": 512,
    "message": "The sandbox ran out of its 512 MiB of memory, and Linux's out-of-memory killer ended 1 process of this command.",
    "hint": "Give the program more memory: create the sandbox with memoryMiB 1024 or more, or resize this one while it is paused (POST /v1/sandboxes/{id}:resize with memoryMiB). Or make the program use less."
  }
}
```

`processesKilled` counts the program and anything it started, so a shell whose
child was killed says so too. A result without `outOfMemory` was not ended for
memory. Each such command also sends the account event `sandbox.out_of_memory`
([observability](./observability#events)), so your backend hears of it after
the sandbox is gone. `check: true` (`check=True` in Python) raises
`CommandError` with the code `out_of_memory` and the hint. The CLI prints the
message and the hint after the command's output, and `runtime sandboxes ps`
marks the process "(out of memory)".

See [pricing](./pricing) for what each costs.

## The network

A sandbox has no network card. Everything outbound goes through a proxy on the
host, and the image sets the environment every tool needs to find it:

```text
HTTP_PROXY=http://127.0.0.1:10800   http_proxy=http://127.0.0.1:10800
HTTPS_PROXY=http://127.0.0.1:10800  https_proxy=http://127.0.0.1:10800
NO_PROXY=localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16
NODE_USE_ENV_PROXY=1
```

The private ranges in `NO_PROXY` are your own Docker containers, reached
directly.

`sudo` keeps these. Programs that ignore proxy settings work too: names resolve
inside the sandbox, and their TCP connections go to the same proxy on their
own. In a paid sandbox, `git clone git@github.com:...`, `psql`, database
drivers, gRPC and `ssh` need no setup. A sandbox without credit reaches ports 443 and 80
only, so there clone over HTTPS (`git clone https://github.com/...`).

A paid sandbox reaches any public host on any port, once your account has made
a purchase. A sandbox without credit reaches ports 443 and 80. For both, private and
internal addresses are refused, mail ports (25, 465 and 587) are closed unless
support enables them for your account, and a few ports are never reachable:
telnet, Windows RPC, NetBIOS and SMB, and IRC. TCP leaves the sandbox, and a
paid sandbox also sends UDP to any public address and port
([outbound UDP](./networking#outbound-udp)); DNS is answered inside it.

**Bandwidth.** Downloads are fast for everyone; uploads are limited, more
strictly without credit, because uploads are what spam and floods use. Downloads
have no speed limit: each server's link is shared between the sandboxes using
it, and while it is full a paid sandbox gets {{paid-share}} a sandbox without credit's share.
A sandbox paid for with credit uploads at up to {{paid-upload}}; after its first {{paid-upload-burst}}
at that speed it uploads at {{paid-upload-sustained}}, and earns the burst back at that rate
while it sends less. A sandbox without credit uploads at up to {{trial-upload}}. A paid sandbox
(any account with credit, bought or given) can move {{paid-daily-transfer}} a day, in and out together,
in a 24-hour window that starts with its first byte; an account without credit {{trial-daily-transfer}} a
day shared by all its sandboxes, each sandbox's bytes counting until its own
window ends, even once it is deleted. Past the daily amount, open connections close
and new requests get `429 Too Many Requests` with `X-Runtime-Egress:
quota-exhausted` (`quota-exhausted:account` for the shared amount of an
account without credit), until the window ends. Credit added to an account without credit moves its
running sandboxes to the paid amount, with what they have used kept.
Inbound traffic is free; each account's first {{outbound-allowance}} out a month is free, then
{{outbound-rate}} per GB (10⁹ bytes) ([pricing](./pricing#network-products)).

**Connections.** A sandbox of an account that keeps a top-up holds up to 512
outbound connections open at once for each vCPU, up to 4,096; any other holds 64.
Every sandbox opens up to 20 new connections a second, after a first 128 at once
(40 without a kept top-up), and starts reaching up to 120 different hosts and
ports a minute. So an agent can hold hundreds of connections to the APIs it
uses, while a scan stays slow. Past a rate, a new connection waits up to 30
seconds for its turn rather than failing: 500 opened at once to one host all
connect within about 20 seconds. Past a limit, a new connection gets
`503 Service Unavailable` with `Retry-After: 1` and the limit in
`X-Runtime-Egress`, such as `too many open connections (512 of 512)` or
`too many new connections (20 a second)`, never a reset; first, though, a
connection silent for a minute or more is closed to make room. Each limit a
sandbox meets also sends the account event `sandbox.network.limited`, at most
once an hour per limit ([observability](./observability#events)), and
`GET /v1/sandboxes/{id}/network` shows a sandbox's limits. Reuse connections
(HTTP keep-alive pools) rather than opening one per request.

Each sandbox has its own rules, set at create (`network`) or at any time after,
applied at once, to open connections too:

```ts check
import { Sandbox } from "withruntime";

await using sbx = await Sandbox.create({
  network: { internet: true, allow: ["pypi.org", "*.pythonhosted.org"] },
});
await sbx.network.set({ internet: true, deny: ["example.com"] });
await sbx.network.set({ internet: false });
console.log(await sbx.network.get());
```

- `internet: false` refuses every outbound connection. With an `allow` list it
  is allow-list only: the sandbox reaches the listed destinations and nothing
  else, stored and shown as `internet: true` with that list, at create and on
  `network.set` alike.
- `allow` narrows the sandbox to a list, on every port it may use: domains,
  `*.domain` for every name under one, addresses or CIDR ranges.
- `deny` always wins.
- `connect` adds `host:port` pairs beyond the web ports, such as your own
  database or `github.com:22`, when `allow` narrows a paid sandbox and the pair
  is not in it.
- `sbx.network.get()` says `openPorts: true` for a sandbox that reaches every
  port.
- A sandbox without credit, on the
  [free usage](./included-usage#without-credit), reaches ports 80 and 443
  only. A `connect` rule on it is refused with `connect_not_allowed` (403),
  whose message says which limit it met. Once the account has a kept top-up,
  its paid sandboxes reach every port; topping up is the account owner's
  decision.

To give code in a sandbox an API key it can use but never read, store it as a
secret: see [Security](./security#secrets-sandboxes-never-see).

The rules apply to root inside the sandbox too.

### Runtime's API from inside a sandbox

Code in a sandbox can call Runtime's API, so an agent in one sandbox can start,
run and stop others. Inside a sandbox the API is at `http://runtime.internal`,
and every Runtime SDK (JavaScript, Python, Go, Java and Ruby) uses it on its
own: calls for
`https://api.withruntime.com` go there, and an API origin you set yourself is
left as it is. Give the sandbox a key as usual, as a secret or in `env`:

```ts check
import { Runtime } from "withruntime";

// Inside a sandbox, with RUNTIME_API_KEY set.
const runtime = new Runtime();
await using child = await runtime.sandboxes.create();
console.log((await child.exec("echo hello from a child")).stdout);
```

Any HTTP client works the same way, through the proxy settings above:

```bash no-run
curl -H "Authorization: Bearer $RUNTIME_API_KEY" http://runtime.internal/v1/me
```

- The sandbox's host sends each request on to `https://api.withruntime.com`
  over HTTPS. The hop from your code to the host is plain HTTP, but it never
  crosses a network: it runs over the sandbox's own private channel to its
  host, which no other sandbox can reach.
- It is the same API with the same key: your account's limits, roles and
  rate limits apply, and errors carry the same request ids.
- Paths under `/v1/` are served, and `/mcp` for
  [Runtime's MCP server](./mcp).
- In a Docker container inside the sandbox, set
  `RUNTIME_API_URL=http://runtime.internal`.
- A sandbox holds up to {{api-requests-per-sandbox}} API requests open at once.
  Past that, a request gets `429` with `X-Runtime-Egress: api-busy`; retry it.
  API requests count toward the sandbox's new-connection rate, bandwidth and
  daily amount, and are never charged as outbound traffic.
- The sandbox's own rules apply: with `internet: false` and no `allow` list, or an `allow` list
  that leaves out `api.withruntime.com`, requests are refused with
  `X-Runtime-Egress: internet-off` or `rule-not-allowed`.

Nothing on the internet can connect in to a sandbox. There are these ways in,
all yours to open:

- A preview: an HTTPS address for one port that you share on purpose, private
  with a token by default, and never indexed by search engines. See
  [JavaScript](./javascript#share-a-port) or `npx withruntime sandboxes preview`.
- A connection from your own computer: `runtime sandboxes ssh` and
  `runtime sandboxes port-forward` reach any port on the sandbox's loopback
  through Runtime's API, with your key, and need nothing set up. See
  [SSH and editors](./editors).
- For an account with a kept top-up, a custom domain, a public TCP port,
  or a WireGuard tunnel from your own network into your sandboxes (`runtime networks wireguard`, the private
  network). See [networking](./networking).

A sandbox with none of these accepts no connections from anyone but you.
What a sandbox created from 5 October 2026 sends back through a preview, a custom
domain or a TCP port counts as outbound traffic, and what visitors send in is
free ([pricing](./pricing#network-products)).

Start a server that should keep answering with `spawn` (`runtime sandboxes spawn`,
`sbx.spawn`), not with `exec`: everything an `exec` starts, `nohup … &`
included, ends when its command does.

## Docker

```bash no-run
sudo enable-docker          # once per sandbox; the first docker command runs it too
docker run --rm hello-world
docker compose up -d
```

- `enable-docker` installs Docker Engine, Buildx and Compose from Ubuntu's
  archive and starts them. `docker` then works as the sandbox user, without
  `sudo`.
- Docker starts on the first `docker` command after a boot, so a sandbox that
  runs no containers spends nothing on it.
- Images and containers live on the sandbox's disk. Give a sandbox that runs
  containers more than the default, such as `diskMiB: 8192`.
- Containers reach the web with no proxy settings: their connections out go
  through the sandbox's relay, as a program in the sandbox that ignores
  `HTTP_PROXY` does. Docker Hub images come through Google's public mirror,
  `mirror.gcr.io`, first.
- Compose services, and containers on one Docker network, reach each other by
  name, as anywhere.
- A published port (`-p 8080:80`) listens inside the sandbox, so
  `runtime sandboxes port-forward <id> 8080` brings it to your machine and a preview
  shares it.
- To start every sandbox with Docker installed, build a custom image whose
  recipe runs it: `commands: ["enable-docker --no-start"]`.

## FUSE filesystems

FUSE is built into the kernel and `/dev/fuse` is in every sandbox, so sshfs,
rclone, bindfs, s3fs, gcsfuse, squashfuse or your own FUSE program mount as
the sandbox user, no `sudo` needed:

```bash no-run
sudo apt-get update && sudo apt-get install -y fuse3 sshfs
mkdir -p ~/remote && sshfs me@example.com:/srv ~/remote
fusermount3 -u ~/remote
```

- **`allow_other`** (letting other users, such as root or a container, see the
  mount) is refused until you add `user_allow_other` to `/etc/fuse.conf`, or
  mount with `sudo`.
- **A bucket:** for S3, R2 or Google Cloud Storage, use
  [Mount your own bucket](./storage#mount-your-own-bucket), which keeps the
  key out of the sandbox.
- **Lifetime:** a mount is a process in the sandbox. It lasts through a pause
  and a wake, and ends when the sandbox stops.

## Time and lifetime

- The clock is kept on the host's clock, and set again after every wake.
- A sandbox runs while it works and pauses itself when idle
  (`idlePauseSeconds`), until you stop it or credit or the
  [free usage](./included-usage) runs out; then it pauses or stops as `onTimeout` says. It
  has no time limit unless `timeoutSeconds` sets one (60 to 86,400), which
  `extend` moves. A pause keeps its memory and processes.
- A stop keeps the disk, billed as [paused storage](./pricing#paused-storage),
  until you delete the sandbox; `restart` starts it again with its memory
  gone. It is still not a backup; copy out what you need to keep.
- A deleted sandbox is gone: `DELETE /v1/sandboxes/{id}`, `sandbox.delete()` or
  `runtime sandboxes rm <id>` stops it and deletes its disk and paused memory in
  any state. Its snapshots stay.

### Pause, stop or delete

|                             | Pause                                                                  | Stop                                                                   | Delete                               |
| --------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------ |
| Memory and running programs | Kept                                                                   | Gone                                                                   | Gone                                 |
| Files on its disk           | Kept                                                                   | Kept                                                                   | Gone                                 |
| Comes back with             | `wake`: it carries on where it was                                     | `restart`: it boots fresh from its disk                                | Nothing; create a new one            |
| Happens on its own          | When idle, and by default when its time, credit or free usage runs out | When its time, credit or free usage runs out, with `onTimeout: "stop"` | The same, with `onTimeout: "delete"` |
| Billed                      | [Paused storage](./pricing#paused-storage) for its memory and disk     | Paused storage for its disk                                            | Nothing; its snapshots stay billed   |

Pause when you will come back to the same work and want its programs still
running. Stop when only the files matter. Delete when you are done.
