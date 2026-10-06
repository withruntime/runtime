# The sandbox environment

Every sandbox is a Firecracker microVM with its own Linux kernel and disk, with Python, Node.js, Bun, git and a compiler ready to use.

This page says what is in the image, who you are inside it, and what it can
reach. Anything missing installs in one command, or once for every sandbox in a
[custom image](./javascript#custom-images).

## What is installed

The image is Ubuntu 24.04.5 LTS (noble) for amd64, on a 6.1 kernel.

| Kind              | What                                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| Python            | Python 3.12 (`python3` and `python`), `pip` and `pip3`, `venv`, and uv 0.12.17 (`uv`, `uvx`)                   |
| Python data tools | NumPy 1.26.4, pandas 2.1.4 and matplotlib 3.6.3, included in the current default image                         |
| JavaScript        | Node.js 24.21.0 (`node`, `npm`, `npx`), with `pnpm` and `yarn` through Corepack; Bun 1.4.0 (`bun`)             |
| Build             | `gcc`, `g++`, `make` (build-essential)                                                                         |
| Source and fetch  | `git`, `curl`, `wget`, `ssh`, `zip`, `unzip`, `xz`                                                             |
| Search and data   | `rg` (ripgrep), `fd`, `jq`, `sqlite3`                                                                          |
| System            | `sudo`, `adduser` and `useradd`, `chronyd`, `sshd` (for [SSH and editors](./editors)), `ip`, `iptables-legacy` |

**Anything else installs the usual way:** `sudo apt-get install -y ...`,
`pip install ...`, `npm install ...`, `uv pip install ...`. To start every
sandbox with your dependencies already there, build a [custom image](./images).

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
- `sudo` works without a password: you are root inside your own sandbox. Root
  cannot change what the sandbox may reach, how much CPU and memory it has, or
  what it costs; those are enforced on the host, outside the sandbox.
- `PATH` starts with `/workspace/.local/bin`, then `/usr/local/bin`, `/usr/bin`
  and `/bin`. `LANG` is `C.UTF-8`.
- Variables you set with `env` at create (or change with `:update`) are in
  every command, background process, terminal, SSH session and the image's
  start command, for the sandbox's whole life, under each command's own `env`
  ([API](./api#sandboxes)). Their values are never shown back.

`pip install` works without a virtual environment. As `runtime` it installs to
`/workspace/.local` (whose `bin` is first on `PATH`); under `sudo` it installs to
`/usr/local`. The image's `/etc/pip.conf` sets `break-system-packages`, so the
Ubuntu rule against installing into the system Python (PEP 668) does not stop
you. Use `python3 -m venv` or `uv` when you want isolation.

`npm install -g` and `bun add -g` put their commands in `/workspace/.local/bin`
too, so a tool such as `claude` or `codex` runs by name as soon as it is
installed, with or without `sudo` for npm. `pnpm` and `yarn` fetch the version
a project's `packageManager` names the first time they run.

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
- **Processor:** AMD EPYC 7371, 16 cores (x86-64, Zen).
- **Memory:** what you ask for, up to 64 GiB on a paid sandbox and 4 GiB
  without credit.

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

- `internet: false` refuses every outbound connection.
- `allow` narrows the sandbox to a list, on every port it may use: domains,
  `*.domain` for every name under one, addresses or CIDR ranges.
- `deny` always wins.
- `connect` adds `host:port` pairs beyond the web ports, such as your own
  database or `github.com:22`, when `allow` narrows a paid sandbox and the pair
  is not in it.
- `sbx.network.get()` says `openPorts: true` for a sandbox that reaches every
  port.

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
- The sandbox's own rules apply: with `internet: false`, or an `allow` list
  that leaves out `api.withruntime.com`, requests are refused with
  `X-Runtime-Egress: internet-off` or `rule-not-allowed`.

Nothing on the internet can connect in to a sandbox. There are these ways in,
all yours to open:

- A preview: an HTTPS address for one port that you share on purpose, private
  with a token by default. See [JavaScript](./javascript#share-a-port) or
  `npx withruntime sandbox preview`.
- A connection from your own computer: `runtime sandbox ssh` and
  `runtime sandbox port-forward` reach any port on the sandbox's loopback
  through Runtime's API, with your key, and need nothing set up. See
  [SSH and editors](./editors).
- For an account with a kept top-up, a custom domain, a public TCP port,
  or a WireGuard tunnel from your own network into your sandboxes (`runtime tunnel`, the private
  network). See [networking](./networking).

A sandbox with none of these accepts no connections from anyone but you.
What a sandbox created from 5 October 2026 sends back through a preview, a custom
domain or a TCP port counts as outbound traffic, and what visitors send in is
free ([pricing](./pricing#network-products)).

Start a server that should keep answering with `spawn` (`runtime sandbox spawn`,
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
- Containers reach the web through the sandbox's proxy. Each one gets
  `HTTP_PROXY` and `HTTPS_PROXY` set to `http://172.17.0.1:10800`, and so does
  every `docker build` step. Docker Hub images come through Google's public
  mirror, `mirror.gcr.io`, first.
- Compose services reach each other by name, as anywhere. An HTTP client that
  honours `HTTP_PROXY` sends a call to another service through the proxy unless
  that name is in `NO_PROXY`, so list the names a service calls in its
  `environment`, under both spellings: `NO_PROXY: localhost,api,db` and
  `no_proxy: localhost,api,db`.
- A published port (`-p 8080:80`) listens inside the sandbox, so
  `runtime sandbox port-forward <id> 8080` brings it to your machine and a preview
  shares it.
- To start every sandbox with Docker installed, build a custom image whose
  recipe runs it: `commands: ["enable-docker --no-start"]`.

## Time and lifetime

- The clock is kept on the host's clock, and set again after every wake.
- A sandbox runs while it works and pauses itself when idle
  (`idlePauseSeconds`), until you stop it or credit or the
  [included usage](./included-usage) runs out; then it pauses or stops as `onTimeout` says. It
  has no time limit unless `timeoutSeconds` sets one (60 to 86,400), which
  `extend` moves. A pause keeps its memory and processes.
- A stop keeps the disk, billed as [paused storage](./pricing#paused-storage),
  until you delete the sandbox; `restart` starts it again with its memory
  gone. It is still not a backup; copy out what you need to keep.
- A deleted sandbox is gone: `DELETE /v1/sandboxes/{id}`, `sandbox.delete()` or
  `runtime sandbox rm <id>` stops it and deletes its disk and paused memory in
  any state. Its snapshots stay.
