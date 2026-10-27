# The sandbox environment

Every sandbox is a Firecracker microVM. It has its own Linux kernel and disk. Python, Node.js, Bun, git and a compiler are ready to use.

This page covers what is in the image, who you are inside it, and what it can reach. Anything missing installs in one command. Or you can install it once, for every sandbox, in a [custom image](./javascript#custom-images).

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
| Agent sandboxing  | `bwrap` (bubblewrap). Codex runs its commands under it. It is in the default image from its next build         |

**Anything else installs the usual way:** `sudo apt-get install -y ...`, `pip install ...`, `npm install ...`, or `uv pip install ...`. A new sandbox has no apt package lists yet. Run `sudo apt-get update` once before the first `apt-get install`. To start every sandbox with your dependencies already there, build a [custom image](./images).

- **bubblewrap:** until the default image includes `bwrap`, run `sudo apt-get update && sudo apt-get install -y bubblewrap` to add it. Codex, and other agents that sandbox their own commands with it, then work as on any Linux machine.
- **Java, Go and Rust:** install Ubuntu's packages with `sudo apt-get install`. For a newer release, use the language's own installer, such as `rustup` for Rust. To have one in every sandbox, build a custom image whose recipe installs it. Or start the image from a public image that already has it.
- **Docker:** `sudo enable-docker` installs Docker Engine, Buildx and Compose. The first `docker` command starts it for you. See [Docker](#docker) below.
- **A Dockerfile:** run it with Docker in a sandbox. Or build it as a custom image and start sandboxes from that image. Multi-stage builds, `COPY --from`, heredocs and `.dockerignore` work as in Docker.
- **Browsers:** they are not in the image, so its disk stays small. Playwright's Chromium installs in two commands:

```bash no-run
sudo npx playwright install-deps chromium
npx playwright install chromium
```

## Who you are

- Commands run as the user `runtime` (uid 1000), in `bash`. `USER` and `LOGNAME` say so.
- `HOME` is `/workspace`, which is also the default working directory. Files there belong to you.
- `sudo` works without a password. You are root inside your own sandbox. To run one command as root, without typing `sudo`, give it `user: "root"`. This works for exec, background processes and terminals. In the CLI, use `--root`. To run every command as root, create the sandbox with `user: "root"` (`--user root` in the CLI). Or set it later with `:update`. Its commands, background processes and terminals then run as root. The exception is a command that names `user: "sandbox"`. A fork, or a copy of its snapshot, also runs as root. Files written through the files API and SSH logins stay `runtime`'s. Root cannot change what the sandbox may reach. Root cannot change how much CPU and memory it has, or what it costs. The host enforces those, outside the sandbox.
- `PATH` starts with `/workspace/.local/bin`, then `/usr/local/bin`, `/usr/bin` and `/bin`. `LANG` is `C.UTF-8`.
- Variables you set with `env` at create, or change with `:update`, are in every command. They are also in every background process, terminal, SSH session and the image's start command. They stay for the sandbox's whole life, under each command's own `env` ([API](./api#sandboxes)). Their values are never shown back. `:update` works on a paused or stopped sandbox too. A change reaches commands and processes started after it. A program already running keeps the values it started with, even through a pause and wake. Restart it to pick up a change.

`pip install` works without a virtual environment. As `runtime`, it installs to `/workspace/.local`, whose `bin` is first on `PATH`. Under `sudo`, it installs to `/usr/local`. The image's `/etc/pip.conf` sets `break-system-packages`. So the Ubuntu rule against installing into the system Python (PEP 668) does not stop you. Use `python3 -m venv` or `uv` when you want isolation.

`npm install -g` and `bun add -g` put their commands in `/workspace/.local/bin` too. So a tool such as `claude` or `codex` runs by name as soon as it is installed. With npm, `sudo` is optional. `pnpm` and `yarn` fetch the version that a project's `packageManager` names. They do this the first time they run.

## The machine's identity

A sandbox is not booted when it starts. It is a copy of a machine that booted once. Most of what a machine calls its own identity is made new for each copy. Not all of it is.

- `/etc/machine-id` belongs to the sandbox. It is made when the sandbox first starts, and kept for its whole life. That includes pauses, wakes, stops and restarts. A fork, or a sandbox created from a snapshot, gets a new one. Use it when a program needs an ID for the machine it runs on.
- `/dev/urandom`, `getrandom` and every program started in the sandbox get fresh randomness. Programs already running when a fork or snapshot was taken keep their own state. See [randomness in copies](./storage#randomness-in-copies).
- The kernel's boot ID (`/proc/sys/kernel/random/boot_id`) and boot time (`uptime`, `btime` in `/proc/stat`) belong to the machine that booted. So sandboxes made from the same image can share them. The kernel cannot change them without a reboot. `restart` gives a sandbox its own. Do not use the boot ID to tell sandboxes apart.
- The hostname is `runtime-guest` in every sandbox.

## Disk, CPU and memory

- **Disk:** `diskMiB` includes the system image and installed packages. In a measurement on 24 September 2026, the current default 4 GiB sandbox had about 2.5 GiB available. If you install a lot, request a larger disk. The smallest disk is 3072 MiB, the size of the image file.
- **Disk speed:** a sandbox shares its server's drives with the sandboxes beside it, in proportion. It has no fixed ceiling of its own. It gets at least about {{disk-floor}} each way. It gets up to about {{disk-up-to}} when its neighbors are quiet. One busy sandbox cannot starve the others. A pause writes its memory ahead of everyone's traffic. So it stays quick on a busy server.
- **CPU:** shared by default. It has a guaranteed floor (`cpuFloorMillis`, 50 thousandths of a vCPU unless you ask for more). It can burst up to `vcpu` cores. `cpu: "reserved"` sets that same floor on every vCPU (`vcpu` x 1000). You pay for the CPU the sandbox uses. A paid sandbox has up to 16 vCPUs. Without credit, it has up to 2.
- **Processor:** AMD EPYC (x86-64, Zen). AVX, AVX2 and FMA are guaranteed on every server. Code that requires them, such as MuJoCo, can count on them. A paused sandbox or a snapshot wakes only on a server that shows it the same processor features. So a running process never loses one. AVX-512 is not offered.
- **Memory:** what you ask for, up to 64 GiB on a paid sandbox and 4 GiB without credit.

### When a program runs out of memory

A sandbox that runs out of memory stays up. Linux's out-of-memory killer ends the program that uses the most memory. The rest keeps running. Your programs share the sandbox's memory, minus a reserve for its own services. The reserve is a sixteenth of the memory, at least 128 MiB and at most 256 MiB. So while programs fill the memory, commands, file reads and kills still get a response. A program ended this way exits with -9 (137 from a shell). It often prints nothing. Runtime says why. The command's result, its process (read, get or list) and the stream's `exit` event carry `outOfMemory`:

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

`processesKilled` counts the program and anything it started. So a shell whose child was killed says so too. A result without `outOfMemory` was not ended for memory. Each such command also sends the account event `sandbox.out_of_memory` ([observability](./observability#events)). Your backend hears of it even after the sandbox is gone. With `check: true` (`check=True` in Python), the call raises `CommandError` with the code `out_of_memory` and the hint. The CLI prints the message and the hint after the command's output. `runtime sandboxes ps` marks the process "(out of memory)".

See [pricing](./pricing) for what each costs.

## The network

A sandbox has no network card. All outbound traffic goes through a proxy on the host. The image sets the environment variables that every tool needs to find the proxy:

```text
HTTP_PROXY=http://127.0.0.1:10800   http_proxy=http://127.0.0.1:10800
HTTPS_PROXY=http://127.0.0.1:10800  https_proxy=http://127.0.0.1:10800
NO_PROXY=localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16
NODE_USE_ENV_PROXY=1
```

The private ranges in `NO_PROXY` are your own Docker containers. They are reached directly.

`sudo` keeps these settings. Programs that ignore proxy settings also work. Names resolve inside the sandbox. Their TCP connections go to the same proxy on their own. In a paid sandbox, `git clone git@github.com:...`, `psql`, database drivers, gRPC and `ssh` need no setup. A sandbox without credit reaches ports 443 and 80 only. So there, clone over HTTPS (`git clone https://github.com/...`).

A paid sandbox reaches any public host on any port, once your account has made a purchase. A sandbox without credit reaches ports 443 and 80. For both, private and internal addresses are refused. Mail ports (25, 465 and 587) are closed unless support enables them for your account. A few ports are never reachable: telnet, Windows RPC, NetBIOS and SMB, and IRC. TCP leaves the sandbox. A paid sandbox also sends UDP to any public address and port ([outbound UDP](./networking#outbound-udp)). DNS is resolved inside the sandbox.

**Bandwidth.** Downloads are fast for everyone. Uploads are limited, and more strictly without credit, because spam and floods use uploads. Downloads have no speed limit. Each server's link is shared between the sandboxes using it. While the link is full, a paid sandbox gets {{paid-share}} a sandbox without credit's share. A sandbox paid for with credit uploads at up to {{paid-upload}}. After its first {{paid-upload-burst}} at that speed, it uploads at {{paid-upload-sustained}}. It earns the burst back at that rate while it sends less. A sandbox without credit uploads at up to {{trial-upload}}. A paid sandbox (any account with credit, bought or given) can move {{paid-daily-transfer}} a day, in and out together. The window is 24 hours, and it starts with the sandbox's first byte. An account without credit can move {{trial-daily-transfer}} a day. That amount is shared by all its sandboxes. Each sandbox's bytes count until its own window ends, even once it is deleted. Past the daily amount, open connections close. New requests get `429 Too Many Requests` with `X-Runtime-Egress: quota-exhausted`. For the shared amount of an account without credit, the header is `quota-exhausted:account`. This lasts until the window ends. Credit added to an account without credit moves its running sandboxes to the paid amount. What they have used is kept. Inbound traffic is free. Each account's first {{outbound-allowance}} out a month is free. After that, outbound traffic costs {{outbound-rate}} per GB (10⁹ bytes) ([pricing](./pricing#network-products)).

**Connections.** A sandbox of an account that keeps a top-up holds up to 512 outbound connections open at the same time for each vCPU, up to 4,096. Any other sandbox holds 64. Every sandbox opens up to 20 new connections a second. It can open a first 128 at the same time (40 without a kept top-up). A sandbox starts reaching up to 120 different hosts and ports a minute. So an agent can hold hundreds of connections to the APIs it uses. A scan stays slow. Past a rate, a new connection waits up to 30 seconds for its turn. It does not fail. For example, 500 connections opened at the same time to one host all connect within about 20 seconds. Past a limit, a new connection gets `503 Service Unavailable` with `Retry-After: 1`. The limit appears in `X-Runtime-Egress`, such as `too many open connections (512 of 512)` or `too many new connections (20 a second)`. It is never a reset. First, though, a connection silent for a minute or more is closed to make room. A sandbox holds about 1,000 outbound connections at the same time, even when its limit is higher. Past that, and whenever the sandbox cannot reach Runtime's proxy, a new connection gets `503 Service Unavailable` with `X-Runtime-Egress: proxy unreachable (<reason>)`, such as `proxy unreachable (connection reset by peer)`. Each limit a sandbox meets also sends the account event `sandbox.network.limited`, at most once an hour per limit ([observability](./observability#events)). `GET /v1/sandboxes/{id}/network` shows a sandbox's limits. Reuse connections (HTTP keep-alive pools) rather than opening one per request.

Each sandbox has its own rules. Set them at create (`network`), or at any time after. They apply immediately, to open connections too:

```ts check
import { Sandbox } from "withruntime";

await using sbx = await Sandbox.create({
  network: { internet: true, allow: ["pypi.org", "*.pythonhosted.org"] },
});
await sbx.network.set({ internet: true, deny: ["example.com"] });
await sbx.network.set({ internet: false });
console.log(await sbx.network.get());
```

- `internet: false` refuses every outbound connection. With an `allow` list, it is allow-list only. The sandbox reaches the listed destinations and nothing else. It is stored and shown as `internet: true` with that list. This holds at create and on `network.set` alike.
- `allow` narrows the sandbox to a list, on every port it may use. The list takes domains, `*.domain` for every name under one, addresses, or CIDR ranges.
- `deny` always wins.
- `connect` adds `host:port` pairs beyond the web ports, such as your own database or `github.com:22`. Use it when `allow` narrows a paid sandbox and the pair is not in the list.
- `sbx.network.get()` says `openPorts: true` for a sandbox that reaches every port.
- A sandbox without credit, on the [free usage](./included-usage#without-credit), reaches ports 80 and 443 only. A `connect` rule on it is refused with `connect_not_allowed` (403). The message says which limit it met. Once the account has a kept top-up, its paid sandboxes reach every port. Topping up is the account owner's decision.

To give code in a sandbox an API key it can use but never read, store it as a secret. See [Security](./security#secrets-sandboxes-never-see).

The rules apply to root inside the sandbox too.

### Runtime's API from inside a sandbox

Code in a sandbox can call Runtime's API. So an agent in one sandbox can start, run and stop others. Inside a sandbox, the API is at `http://runtime.internal`. Every Runtime SDK (JavaScript, Python, Go, Java and Ruby) uses it on its own. Calls for `https://api.withruntime.com` go there. An API origin you set yourself is left as it is. Give the sandbox a key as usual, as a secret or in `env`:

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

- The sandbox's host sends each request on to `https://api.withruntime.com` over HTTPS. The hop from your code to the host is plain HTTP. It never crosses a network. It runs over the sandbox's own private channel to its host, which no other sandbox can reach.
- It is the same API with the same key. Your account's limits, roles and rate limits apply. Errors carry the same request IDs.
- Paths under `/v1/` are served, and `/mcp` for [Runtime's MCP server](./mcp).
- In a Docker container inside the sandbox, set `RUNTIME_API_URL=http://runtime.internal`.
- A sandbox holds up to {{api-requests-per-sandbox}} API requests open at the same time. Past that, a request gets `429` with `X-Runtime-Egress: api-busy`. Retry it. API requests count toward the sandbox's new-connection rate, bandwidth and daily amount. They are never charged as outbound traffic.
- The sandbox's own rules apply. With `internet: false` and no `allow` list, or with an `allow` list that leaves out `api.withruntime.com`, requests are refused. The header is `X-Runtime-Egress: internet-off` or `rule-not-allowed`.

Nothing on the internet can connect in to a sandbox. These are the ways in. You open each one yourself:

- A preview: an HTTPS address for one port that you share on purpose. It is private, with a token, by default. Search engines never index it. See [JavaScript](./javascript#share-a-port) or `npx withruntime sandboxes preview`.
- A connection from your own computer. `runtime sandboxes ssh` and `runtime sandboxes port-forward` reach any port on the sandbox's loopback. They go through Runtime's API, with your key. They need nothing set up. See [SSH and editors](./editors).
- For an account with a kept top-up: a custom domain, a public TCP port, or a WireGuard tunnel from your own network into your sandboxes (`runtime networks wireguard`, the private network). See [networking](./networking).

A sandbox with none of these accepts no connections from anyone but you. For a sandbox created from 5 October 2026, what it sends back through a preview, a custom domain or a TCP port counts as outbound traffic. What visitors send in is free ([pricing](./pricing#network-products)).

To start a server that keeps responding, use `spawn` (`runtime sandboxes spawn`, `sbx.spawn`), not `exec`. Everything an `exec` starts ends when its command does. That includes `nohup … &`.

## Docker

```bash no-run
sudo enable-docker          # once per sandbox; the first docker command runs it too
docker run --rm hello-world
docker compose up -d
```

- `enable-docker` installs Docker Engine, Buildx and Compose from Ubuntu's archive, and starts them. After that, `docker` works as the sandbox user, without `sudo`.
- Docker starts on the first `docker` command after a boot. So a sandbox that runs no containers spends nothing on it.
- Images and containers live on the sandbox's disk. For a sandbox that runs containers, set more disk than the default, such as `diskMiB: 8192`.
- Containers reach the web with no proxy settings. Their outbound connections go through the sandbox's relay. This is the same path as a program in the sandbox that ignores `HTTP_PROXY`. Docker Hub images come through Google's public mirror, `mirror.gcr.io`, first.
- Compose services, and containers on one Docker network, reach each other by name, as anywhere.
- A published port (`-p 8080:80`) listens inside the sandbox. `runtime sandboxes port-forward <id> 8080` brings it to your machine. A preview shares it.
- To start every sandbox with Docker installed, build a custom image whose recipe runs it: `commands: ["enable-docker --no-start"]`.

## FUSE filesystems

FUSE is built into the kernel, and `/dev/fuse` is in every sandbox. So sshfs, rclone, bindfs, s3fs, gcsfuse, squashfuse or your own FUSE program can mount as the sandbox user. `sudo` is not needed:

```bash no-run
sudo apt-get update && sudo apt-get install -y fuse3 sshfs
mkdir -p ~/remote && sshfs me@example.com:/srv ~/remote
fusermount3 -u ~/remote
```

- **`allow_other`** lets other users, such as root or a container, see the mount. It is refused until you add `user_allow_other` to `/etc/fuse.conf`. Or mount with `sudo`.
- **A bucket:** for S3, R2 or Google Cloud Storage, use [Mount your own bucket](./storage#mount-your-own-bucket). It keeps the key out of the sandbox.
- **Lifetime:** a mount is a process in the sandbox. It lasts through a pause and a wake, and ends when the sandbox stops.

## Time and lifetime

- The clock follows the host's clock. It is set again after every wake.
- A sandbox runs while it works. It pauses itself when idle (`idlePauseSeconds`). It runs until you stop it, or until credit or the [free usage](./included-usage) runs out. Then it pauses or stops, as `onTimeout` says. It has no time limit unless `timeoutSeconds` sets one (60 to 86,400). `extend` moves that limit. A pause keeps its memory and processes.
- A stop keeps the disk. It is billed as [paused storage](./pricing#paused-storage), until you delete the sandbox. `restart` starts it again, with its memory gone. A stop is still not a backup. Copy out what you need to keep.
- A deleted sandbox is gone. `DELETE /v1/sandboxes/{id}`, `sandbox.delete()` or `runtime sandboxes rm <id>` stops it and deletes its disk and paused memory, in any state. Its snapshots stay.

### Pause, stop or delete

|                             | Pause                                                                  | Stop                                                                   | Delete                               |
| --------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------ |
| Memory and running programs | Kept                                                                   | Gone                                                                   | Gone                                 |
| Files on its disk           | Kept                                                                   | Kept                                                                   | Gone                                 |
| Comes back with             | `wake`: it carries on where it was                                     | `restart`: it boots fresh from its disk                                | Nothing; create a new one            |
| Happens on its own          | When idle, and by default when its time, credit or free usage runs out | When its time, credit or free usage runs out, with `onTimeout: "stop"` | The same, with `onTimeout: "delete"` |
| Billed                      | [Paused storage](./pricing#paused-storage) for its memory and disk     | Paused storage for its disk                                            | Nothing; its snapshots stay billed   |

Pause when you will come back to the same work and want its programs still running. Stop when only the files matter. Delete when you are done.
