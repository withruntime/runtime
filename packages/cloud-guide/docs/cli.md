# The runtime CLI

The CLI drives every Runtime Cloud product from a terminal or a script.

It comes with the JavaScript SDK, needs Node 22.12 or later and answers
`runtime --version` in about 40 ms, 15 ms more than Node alone. Its one dependency,
`undici`, loads only when a proxy applies. Run it without installing, or install
it once; npx spends about a quarter of a second of its own on every call, so an
agent that runs many commands saves that by installing:

```bash no-run
npx withruntime sandbox run -- python3 -c 'print(6 * 7)'   # without installing
npm install --global withruntime                   # then the command is runtime
runtime sandbox run -- python3 -c 'print(6 * 7)'
```

The examples below use `runtime`, the installed command; without installing,
write `npx withruntime` in its place. Commands read `runtime <product> <command>`,
with account commands at the top. `runtime` on its own says whether this machine
is connected and what to run first.

## One command in a fresh sandbox

```bash
runtime sandbox run -- python3 -c 'print(6 * 7)'
runtime sandbox run --keep --vcpu 2 -- nproc   # keeps it, and prints how to run more
```

`run` creates a sandbox, runs the command, prints its output, stops the sandbox
and exits with the command's exit code. It takes the same options as
`sandbox create`, with one difference: `--timeout <seconds>` limits the command,
as it does for `exec` (exit code 124 when it runs out), not the sandbox's lease.
`--keep` leaves the sandbox running for more commands.

## Connect once

Any command connects this machine the first time it needs to, so there is no
separate step. To connect ahead of time:

```bash no-run
runtime login                 # opens your browser; approve Connect agent
runtime login --no-browser    # prints a link and a code for another device, and exits
runtime login --wait          # waits for an approval already asked for
runtime login --with-key      # or paste a key from withruntime.com/account/keys
runtime whoami
```

**You never copy an API key.** The CLI receives and saves its own credential.

- At a terminal, login waits for the approval.
- Run by an agent (no terminal), it waits up to 50 seconds, then prints the link
  and code and exits with `connection_pending`. `--no-browser` exits at once.
- The request is saved: once it is approved, the same command again, or any
  other, finishes the connection with no new link. A request expires after 15
  minutes.

`--with-key` reads the key from standard input (piped, or typed without echo),
never from the command line. `RUNTIME_API_KEY` overrides the saved connection
when it is set, which is how CI and scripts run. In CI (the `CI` variable set)
or with `RUNTIME_NO_LOGIN=1`, a missing key is an error instead of a browser
approval.

## Keys for CI

A CI runner has no browser, so it runs on a key. Make one from your own terminal:

```bash no-run
runtime keys create --name ci                    # full access, until revoked
runtime keys create --name ci --daily-limit 25   # at most $25 in any 24 hours
runtime keys create --name monitor --read-only   # sees everything, changes nothing
runtime keys create --name web --account-wide    # uses every sandbox in the account
runtime keys create --name ci | gh secret set RUNTIME_API_KEY   # straight into GitHub
```

It prints a link and a code, like `login`. An owner, admin or developer of the
account opens the link, checks the code, sees the key's name, access and limit,
and chooses **Create key**.

The key is then printed once, alone on standard output, with everything else on
standard error, so it pipes straight into a secret store. `--json` prints it as
one JSON object instead. Store it now: Runtime keeps only a hash of it. Give it
to your jobs as `RUNTIME_API_KEY`.

- The command waits up to 15 minutes for the approval. Stopping it cancels the
  request, and a key approved but not yet received is revoked.
- These are the keys page's own options, and there are no others. A key lasts
  until revoked.
- Change a key's daily limit, list keys and revoke them at
  [API keys](https://withruntime.com/account/keys). No key can create, list or
  revoke keys; see [security](./security).

## Sandboxes

```bash
id=$(runtime sandbox create --name demo --label team=search)
runtime sandbox exec "${id}" -- python3 -c 'print(6 * 7)'
runtime sandbox exec "${id}" --cwd /workspace --env API_TOKEN="${API_TOKEN}" -- env
runtime sandbox ls
runtime sandbox get "${id}"
runtime sandbox stop "${id}"
```

`create` prints only the id, so it composes with `$(...)`, and waits until the
sandbox is running (`--no-wait` returns at once). Its options:

- `--vcpu`, `--memory` and `--disk` in MiB, `--timeout <seconds>`,
  `--on-timeout pause|stop`
- from withruntime 0.7.0: `--cpu reserved` and `--cpu-floor <thousandths>` for
  guaranteed CPU; `--max-cost <usd>` refuses the create if its first lease
  could cost more, and `--max-total-cost <usd>` caps its whole life
- `--trial` or `--paid`, `--name`, `--label k=v` (repeatable)
- network rules: `--no-internet`, `--allow <host>`, `--deny <host>` and
  `--connect <host:port>`
- `--idle-pause <seconds>` pauses it after that long with nothing happening in
  it (default {{idle-pause-seconds}}; {{idle-pause-min}} to {{idle-pause-max}}, or 0 for never), and `--no-auto-wake` keeps a
  paused one paused until `wake`
- `--persistent` keeps a paid sandbox running while credit lasts
- `--get-or-create` with `--name` prints the id of the sandbox that already has
  the name, woken if paused, instead of failing with `name_taken`

From withruntime 0.7.0, every command refuses an option it does not take,
before it sends anything, and names the one you likely meant: `--memory-mib`
gets "Did you mean --memory?". `--help` after any command prints its product's
help and runs nothing.

`exec` streams all of the output as it happens and exits with the command's own
exit code (124 when it timed out), so `set -e` scripts behave. Without
`--timeout` a command may run for 24 hours; with `--json`, for 60 seconds. Everything it
starts, `nohup … &` included, ends when the command returns; start a server with
`spawn` (below) instead. Pass secrets with
`--env` from a variable, never written into the command. Piped input reaches
the command, up to 1 MiB: `echo 'print(1)' | runtime sandbox exec "${id}" -- python3 -`.
A program is found on the sandbox's own `PATH`, so `python` in an image from
`python:3.12-slim` runs as it does there.

A command that writes faster than it is read keeps its latest 1 MiB. If any
output was lost, `exec` says so on standard error. From withruntime 0.7.0 it
also never exits 0 then, Ctrl-C stops the command in the sandbox too (it is sent
SIGTERM) and exits 130, and a connection that drops mid-command is picked up
again where it stopped; if it cannot be, the error names the process, to read
with `logs` or stop with `kill`. For a
large output, write it to a file in the sandbox and copy it out.

With `--json`, `exec` answers one result instead. It holds at most 64 KiB of
`stdout` and 64 KiB of `stderr` for a command with a `--timeout` of 60 seconds
or less; `stdoutTruncated` and `stderrTruncated` say whether anything was
dropped. For more, drop `--json`, or write the output to a file and read it with
`runtime sandbox cat`.

Background work, logs and a terminal. `logs` prints what a process has written
so far and returns, even while it runs; `-f` follows it until it exits:

```bash
id=$(runtime sandbox create)
pid=$(runtime sandbox spawn "${id}" -- python3 -m http.server 8000)
runtime sandbox ps "${id}"
runtime sandbox logs "${id}" "${pid}"
runtime sandbox kill "${id}" "${pid}"
runtime sandbox stop "${id}"
```

```bash no-run
runtime sandbox shell "${id}"               # an interactive terminal, like ssh
echo "ls" | runtime sandbox shell "${id}"   # piped input runs, then the shell exits
runtime sandbox logs "${id}" "${pid}" -f      # follow until the process exits
```

Files. Name a sandbox path as `<id>:/path`; directories copy whole, and a
file keeps its permissions, so a script stays runnable. `files` marks a
directory `d` and a symbolic link `l`:

```bash
id=$(runtime sandbox create)
mkdir -p project && echo "print('hi')" > project/main.py
runtime sandbox cp ./project "${id}:/workspace/project"
runtime sandbox files "${id}" /workspace --depth 2
runtime sandbox cat "${id}" /workspace/project/main.py
runtime sandbox cp "${id}:/workspace/project" ./project-copy
runtime sandbox stop "${id}"
```

`cp` and `cat` stream, so a file of any size copies without filling memory,
and both check every byte against the file's length: a copy that arrives short
is tried again, then fails with `download_incomplete` and exit 1, and never
leaves a short file under the name you gave.

A sandbox's name works wherever its id does, in every `runtime sandbox` command
and in `--sandbox` filters, when one live sandbox has it.

Lifecycle: `pause`, `wake` (a sandbox already awake is left as it is), `restart`, `extend <id> <seconds>` (it prints the
new end of the lease), `stop`. A paused
sandbox also wakes by itself when a command, file or terminal call or a visit
to a shared port reaches it, billed as any wake from the moment it runs.

A sandbox you come back to, by name, that pauses when idle and wakes when used:

```bash no-run
id=$(runtime sandbox create --name dev --get-or-create --idle-pause 900)
runtime sandbox exec "${id}" -- git -C /workspace/app pull
```

`update` changes a sandbox's settings after it is made; what you leave out
stays as it is:

```bash no-run
runtime sandbox update "${id}" --idle-pause 0 --auto-wake off
runtime sandbox update "${id}" --persistent on --max-total-cost 50   # dollars
runtime sandbox update "${id}" --name dev-2 --label team=search
```

`--persistent on` renews the lease on the server while credit lasts, up to
`--max-total-cost`, and keeps the disk after a stop, billed as reserved disk, so
`restart` starts it again. `get` shows the automatic wake, idle pause and
persistence settings.

Watch a directory. `watch` prints each change as it happens (create, write,
remove, rename, chmod) until Ctrl-C:

```bash no-run
runtime sandbox watch "${id}" /workspace --recursive --exclude node_modules --exclude '.git/**'
runtime sandbox watch "${id}" /workspace/src --events create,write --include '**/*.py'
```

## Code, previews, network rules and the desktop

```bash no-run
runtime sandbox run-code "${id}" analysis.py --out-dir charts   # a notebook cell; charts saved as PNG
runtime sandbox run-code "${id}" model.R                        # R, by the file's extension
runtime sandbox run-code "${id}" - --lang go < main.go          # Python, JavaScript, TypeScript, R, Java, Bash or Go
runtime sandbox preview "${id}" 3000 --public                  # an HTTPS address for a port
runtime sandbox previews "${id}"
runtime sandbox preview rotate "${id}" 3000                   # withruntime 0.7.0: refuse every token so far
runtime sandbox unshare "${id}" 3000
runtime sandbox session create "${id}" --origin https://app.example.com --ttl 900   # a token a web page uses; printed once
runtime sandbox session ls "${id}"
runtime sandbox session revoke "${id}" "${session}"
runtime sandbox network "${id}"                                # show its rules
runtime sandbox network "${id}" --allow pypi.org --allow '*.pythonhosted.org'
runtime sandbox network "${id}" --no-internet
runtime sandbox desktop "${id}" start                          # prints a link to watch it
runtime sandbox desktop "${id}" open https://example.com
runtime sandbox desktop "${id}" screenshot screen.png
runtime sandbox desktop "${id}" record start --fps 10 --max-mib 256   # prints the recording id
runtime sandbox desktop "${id}" record stop "${rec}"
runtime sandbox desktop "${id}" record fetch "${rec}" demo.mp4
```

A session lets your own web page reach one sandbox's commands, files and
previews directly, for {{session-default}} unless `--ttl` says otherwise and
{{session-max}} at most; see [a sandbox from a browser](./javascript#a-sandbox-from-a-browser).

The first `desktop start` in a sandbox installs the desktop, which took about
90 seconds and 1 GB of the sandbox's disk on 23 September 2026; the browser
follows in the background (about a minute and 0.5 GB more), and an `open`
before it is ready waits for it. The first recording
installs ffmpeg. A recording is an MP4 on the sandbox's own disk: it never
grows past `--max-mib`, stops before the disk fills, and a sandbox keeps at
most 8 GiB of them.

## MCP servers in a sandbox

Start well-known MCP servers inside a sandbox and connect your agent to them.
Secret settings name a [Runtime secret](#secrets), so the server never holds
the value:

```bash no-run
runtime sandbox mcp catalog                                       # what can run: licence, settings, hosts
runtime secrets set GITHUB_TOKEN --host api.github.com < token.txt
runtime sandbox mcp "${id}" start github fetch --secret github.GITHUB_PERSONAL_ACCESS_TOKEN=GITHUB_TOKEN
runtime sandbox mcp "${id}"                                       # state, URLs and the header to send
runtime sandbox mcp "${id}" stop
```

`start` prints each server's URL, the `Authorization` header every request
needs, and the `claude mcp add` line for each. `runtime mcp` is something else:
this CLI's own MCP server, on standard input.

A preview's address is under `runtimehost.com`, the domain for everything
sandboxes serve, kept apart from Runtime's own site.

## Secrets

```bash no-run
printf %s "$OPENAI_API_KEY" | runtime secrets set OPENAI_API_KEY --host api.openai.com
runtime secrets set GITHUB_TOKEN --host api.github.com --header Authorization --format 'token {value}' < token.txt
runtime secrets set GITHUB_TOKEN --host api.github.com --allow 'GET,HEAD /repos/acme/*' < token.txt
runtime secrets ls
runtime secrets rm OPENAI_API_KEY
```

The value is read from standard input only, so it never lands in your shell
history; typed at a terminal it is not shown. Every sandbox of the account then
has `OPENAI_API_KEY` set to a placeholder, and the proxy swaps in the value on
HTTPS requests to the hosts you named. On paid accounts, from `withruntime`
0.7.0, `--allow` narrows that to some methods and paths, once
per rule: `--allow /v1/chat/completions` for every method,
`--allow 'GET,HEAD /repos/acme/*'` for two. `ls` shows names, hosts,
placeholders and rules, never values. See [Security](./security#secrets-sandboxes-never-see).

## SSH and port forwarding

```bash no-run
runtime sandbox ssh "${id}"                          # a shell, as the sandbox user
runtime sandbox ssh "${id}" -- make test             # one command; exits with its code
runtime sandbox ssh config --install                 # `ssh <id>.runtime` from ssh, VS Code or JetBrains
runtime sandbox port-forward "${id}" 5432            # localhost:5432 here is port 5432 in the sandbox
runtime sandbox port-forward "${id}" 3000 15432:5432 # several at once, local:remote
```

Both go through Runtime's API with your key, so the sandbox opens no port to
the internet. A sandbox can be named by its id or its name. `ssh` makes this
machine an SSH key on first use and sends only its public half, into the one
login it opens; `ssh proxy <id>` is the `ProxyCommand` the config uses.
`port-forward` carries any TCP port on the sandbox's loopback, listens on
`127.0.0.1` unless `--address` says otherwise, and runs until Ctrl-C. Start the
server with `spawn`, which keeps it running: a process started by `exec` ends
with its command. When nothing listens on the port, `port-forward` says so. See
[SSH and editors](./editors).

Away from your terminal, the **Terminal** tab on a sandbox's page at
withruntime.com opens a shell in the browser, and **Connect** on Home and
Sandboxes copies `runtime sandbox ssh` with the sandbox's name. The page's
**Pause**, **Wake**, **Snapshot**, **Fork** and **Stop** do what
`runtime sandbox pause`, `wake`, `snapshot`, `fork` and `stop` do.

## Images, volumes and snapshots

```bash no-run
img=$(runtime image build --pip pandas --apt jq --name data)   # or a folder: runtime image build . -t app:v1, or --from python:3.12-slim
vol=$(runtime volume create --size-mib 10240 --name cache)
id=$(runtime sandbox create --image "${img}" --volume "${vol}:/data")
base=$(runtime sandbox create --image "${img}")
runtime sandbox fork "${base}" --count 3              # three running copies of it
snap=$(runtime sandbox snapshot "${base}" --name ready)
runtime sandbox create --snapshot "${snap}"           # a copy, any time later
runtime image ls; runtime volume ls; runtime snapshot ls
```

`runtime image build <folder>` builds the folder's Dockerfile (or `-f <file>`)
with the folder as its context, as `docker build` does: its `.dockerignore`
applies, the context may be 100 MiB compressed, and a rebuild uploads only what
changed. `-t app:v2` names it and tags it (each build of a name is its next
version, tagged `latest` when no tag is given), `--target`, `--build-arg K=V`
and `--no-cache` work as in Docker, and `--start <command>` with
`--ready-port <port>` sets what a sandbox from it runs and when its create
answers. `runtime image versions <name>`, `tag`, `untag`, `logs --follow` and
`rm` take an id, `name`, `name:tag` or `name@version`, and so does
`sandbox create --image`. `runtime image registry set <registry> --username <u>`
reads a token from standard input and stores it for private images. See
[custom images](./images). Images, volumes and kept snapshots are charged as
storage ([pricing](./pricing#snapshots-images-and-volumes)). A volume lives on
one server. It is backed up off that server every day and whenever you
ask, and a backup restores as a new volume ([storage and backups](./storage)). `runtime sandbox stop` has the sandbox
write out what it wrote to its volumes first; one whose lease runs out stops at
once, so `sync` after writes it must keep. `runtime sandbox mount <id>
s3://bucket/prefix /data --secret NAME`, `mounts` and `unmount` mount your own
S3, R2 or Google Cloud Storage bucket without the sandbox holding its key
([mount your own bucket](./storage#mount-your-own-bucket)).

Forks and snapshots:

- A fork or snapshot pauses a running sandbox for the moment it takes, then
  wakes it. A sandbox with volumes cannot be snapshotted. Copies and snapshots
  run on the source's server, and each kept snapshot is also copied off it.
- `fork` takes `--trial` or `--paid` as `create` does; with neither, the copies
  keep the source's funding. Copies keep the source's size and CPU, reserved or
  a raised floor, and are billed as a create with those would be. A trial copy
  must fit the trial.
- The snapshot a fork takes is deleted when the fork ends, whether every copy
  started or not, and is not billed, unless you pass `--keep-snapshot`.
- If a copy fails, the error names the copies that did start; they keep running
  until stopped. A retry with the same idempotency key answers the same error.
- If a fork stops partway and left its source paused, the source stays paused
  and an account notice says so; wake it with `runtime sandbox wake`.
- A snapshot is kept 7 days unless `--retention` gives 1 to 365.

## Scripts and agents: `--json`

Every command takes `--json` and prints one JSON value. Errors become
`{"error": {"code", "message", "hint", "requestId"}}` on standard error with a
non-zero exit.

```bash
id=$(runtime sandbox create --trial)
runtime sandbox get "${id}" --json
runtime sandbox exec "${id}" --json -- uname -a
runtime sandbox stop "${id}" --json
```

`runtime sandbox get --json` answers the sandbox as the API does:

```json
{
  "id": "0b8f3c52-6d8e-4b1f-9c67-2f4e6c1d9a10",
  "kind": "sandbox",
  "name": null,
  "labels": {},
  "state": "running",
  "region": "us-east-vin",
  "funding": "trial",
  "vcpu": 2,
  "memoryMiB": 4096,
  "diskMiB": 4096,
  "cpu": "shared",
  "cpuFloorMillis": 50,
  "timeoutSeconds": 1800,
  "onLeaseEnd": "pause"
}
```

## Account

```bash
runtime whoami
runtime usage
runtime ls
```

- `runtime usage` prints the balance, the free-trial hours left and what each
  kind of resource was charged, in dollars; `--json` gives every figure in
  integer microdollars, with each resource's rates and CPU time. From 0.7.0,
  `--csv` exports one row per resource for a spreadsheet: its name, kind, state,
  when it was made, its vCPUs and memory, how long it ran, the CPU seconds it
  used and what it was charged and still holds, in dollars to the microdollar.
  It covers the newest 100 resources.
- `runtime limits` says whether this machine's key is read-only and what its
  daily spending limit is, with what was used in the last 24 hours and what is
  left (0.3.1 and later). The member who made the key, or an owner or admin,
  sets or changes the limit at [API keys](https://withruntime.com/account/keys);
  see [security](./security).
- `runtime ls` lists everything the account runs, every product.
- `runtime compare --from <provider>` says what the sandboxes you ran in the
  last 30 days would have cost at another provider, from the same vCPUs, memory
  and running time at its published rates, and what you save a month
  (`--days` up to 90). When your first sandbox in the window is more recent
  than the window, the month is projected from the days since, and the output
  says so. Sandboxes the free trial ran are priced at the standard
  rates, and the output says how many there were. The providers are `e2b`, `daytona`, `vercel`, `modal`,
  `cloudflare`, `fly` (Sprites), `fly-machines` and the others in the
  [rate comparison](./pricing#published-rate-comparison). With no sandboxes
  yet, it prices an example and says so.
- `runtime switch --from <provider>` records the provider you are leaving. Do it
  before your first top-up: that top-up is then matched, up to {{switching-max}} of credit
  ([switching credit](./pricing#switching-credit)). `runtime switch` on its own
  shows where it stands. From withruntime 0.8.3, for E2B, Daytona, Vercel
  Sandbox and Blaxel, both commands also print the one import that runs your existing code on Runtime.
- `runtime account` lists the accounts this machine is connected to and marks
  the one in use; `runtime account switch <name>` uses another for every command
  after it, and `runtime account add` connects one more, chosen in the browser.
  See [teams](./teams).
- `runtime account close --confirm "<account name>"`, from 0.7.0, closes the
  account for good: everything stops and is deleted and every key stops working.
  It needs an owner's key for every product; see
  [closing the account](./teams#closing-the-account).
- `runtime audit` prints the account's audit log (`--action member.`,
  `--limit`, `--before <next>`), for a key made by an owner or admin.
- `runtime sso` shows the account's single sign-on: each identity provider,
  its domain and whether it is verified, and SCIM directory sync. An owner
  changes it on the website. See [single sign-on](./single-sign-on).
- `runtime sandbox identity-token --audience sts.amazonaws.com [--lifetime 600]`,
  inside a sandbox, prints an OIDC token naming it, for AWS, Google Cloud or
  your own API. It needs no API key. See [identity tokens](./identity-tokens).
- `runtime sandbox metrics <id> [--range 1h]` shows a sandbox's CPU and memory
  now and over the range (`15m`, `1h`, `6h`, `24h`, `7d`, `30d`).
- `runtime events [--sandbox <id>] [--type sandbox.stopped]` lists lifecycle
  events, newest first.
- `runtime webhooks create <url> [--events a,b]` sends signed lifecycle events
  to your URL and prints its secret once; `ls`, `test <id>`, `deliveries <id>`,
  `update <id> [--disable|--enable]`, `rotate-secret <id>`, `retry <deliveryId>`
  and `rm <id>` manage them.
- `runtime otel create <endpoint> [--header K=V]... [--signals logs,metrics]`
  pushes events and metrics to an OpenTelemetry endpoint; `ls`, `flush <id>` and
  `rm <id>` manage exports. See [metrics and webhooks](./observability).
- `runtime docs <page>` prints any page of these docs.
- `runtime mcp` serves Runtime's MCP tools on stdio for agents that want a local
  command; see [MCP](./mcp).

When something is broken, missing or confusing, say so; it goes straight to the
people building Runtime:

```bash no-run
runtime feedback "exec output lost its colours" --kind bug
```

```bash no-run
runtime support "my sandbox will not wake"
```

See [feedback and support](./feedback-and-support).

## Sign out

```bash no-run
runtime logout
```

`logout` revokes this machine's connection. It does not stop running sandboxes.

## Domains, TCP ports, addresses, the tunnel and your own proxy

Paid accounts only; see [networking](./networking).

```bash no-run
runtime domain add app.example.com <sandbox> 3000   # prints the DNS records to set
runtime domain verify app.example.com               # live once the TXT record matches
runtime port open <sandbox> 5432                    # prints address:port
runtime address reserve                             # every sandbox sends from it
runtime tunnel create
runtime tunnel peer add office --route 10.0.0.0/16  # writes runtime.conf
sudo wg-quick up ./runtime.conf
runtime network upstream-proxy set http://proxy.example.com:3128 --secret PROXY_AUTH
```

`runtime network upstream-proxy` arrived in 0.7.0. Each has
its own help: `runtime domain help`, `runtime port help`,
`runtime address help`, `runtime tunnel help`, `runtime network help`.
