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
| JavaScript        | Node.js 24.21.0 (`node`, `npm`, `npx`); Bun 1.4.0 (`bun`)                                                      |
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

- Commands run as the user `runtime` (uid 1000), with `bash`.
- `HOME` is `/workspace`, which is also the default working directory. Files
  there belong to you.
- `sudo` works without a password: you are root inside your own sandbox. Root
  cannot change what the sandbox may reach, how much CPU and memory it has, or
  what it costs; those are enforced on the host, outside the sandbox.
- `PATH` starts with `/workspace/.local/bin`, then `/usr/local/bin`, `/usr/bin`
  and `/bin`. `LANG` is `C.UTF-8`.

`pip install` works without a virtual environment. As `runtime` it installs to
`/workspace/.local` (whose `bin` is first on `PATH`); under `sudo` it installs to
`/usr/local`. The image's `/etc/pip.conf` sets `break-system-packages`, so the
Ubuntu rule against installing into the system Python (PEP 668) does not stop
you. Use `python3 -m venv` or `uv` when you want isolation.

## Disk, CPU and memory

- **Disk:** `diskMiB` includes the system image and installed packages. The
  current default 4 GiB sandbox had about 2.5 GiB available in a measurement
  on 24 September 2026; ask for more when you install a lot. The smallest disk
  is 3072 MiB, the size of the image file.
- **Disk speed:** a sandbox bursts to about 250 MB/s and 20,000 operations a
  second for up to 30 seconds, then runs at about 40 MB/s and 2,000 operations
  a second, and earns its burst back over five minutes. Up to two sandboxes on
  a server burst at once. In a measurement on 24 September 2026 a sandbox wrote
  at 200 MB/s while bursting and 38 MB/s after.
- **CPU:** shared by default, with a guaranteed floor (`cpuFloorMillis`, 50
  thousandths of a vCPU unless you ask for more) and bursts up to `vcpu` cores.
  You pay for the CPU the sandbox uses. Up to 16 vCPUs on a paid sandbox, 2 on
  the trial.
- **Processor:** AMD EPYC 7371, 16 cores (x86-64, Zen).
- **Memory:** what you ask for, up to 64 GiB on a paid sandbox and 4 GiB on the
  trial.

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
drivers, gRPC and `ssh` need no setup. A trial sandbox reaches ports 443 and 80
only, so there clone over HTTPS (`git clone https://github.com/...`).

A paid sandbox reaches any public host on any port, once your account has made
a purchase. A trial sandbox reaches ports 443 and 80. For both, private and
internal addresses are refused, mail ports (25, 465 and 587) are closed unless
support enables them for your account, and a few ports are never reachable:
telnet, Windows RPC, NetBIOS and SMB, and IRC. TCP leaves the sandbox, and a
paid sandbox also sends UDP to any public address and port
([outbound UDP](./networking#outbound-udp)); DNS is answered inside it.

**Bandwidth.** A paid sandbox of an account that has made a purchase moves up
to 500 Mbit/s in each direction. After its first 10 GiB at that speed it runs
at 200 Mbit/s, and earns the burst back at that rate while it moves less. It
can move 500 GiB a day, in and out together, in a 24-hour window that starts
with its first byte. A trial sandbox gets 100 Mbit/s, 20 Mbit/s after 2 GiB, and
50 GiB a day. Past the daily amount,
open connections close and new requests get `429 Too Many Requests` with
`X-Runtime-Egress: quota-exhausted` and the reset time, until the window ends.

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

Nothing on the internet can connect in to a sandbox. There are these ways in,
all yours to open:

- A preview: an HTTPS address for one port that you share on purpose, private
  with a token by default. See [JavaScript](./javascript#share-a-port) or
  `npx withruntime sandbox preview`.
- A tunnel for your own machine: `runtime sandbox ssh` and `runtime sandbox port-forward` reach
  any port on the sandbox's loopback through Runtime's API, with your key. See
  [SSH and editors](./editors).
- For paid accounts, a custom domain, a public TCP port, or a WireGuard tunnel
  from your own network. See [networking](./networking).

A sandbox with none of these accepts no connections from anyone but you.

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
- A sandbox runs until its lease ends (`timeoutSeconds`, at most an hour ahead,
  which `extend` moves as often as you need), then pauses or stops as
  `onLeaseEnd` says. A pause keeps its memory and processes.
- A host-side lease bounds execution even if management is unavailable.
- A stopped sandbox is not a backup; copy out what you need to keep.
