# The runtime CLI

The CLI drives every Runtime Cloud product from a terminal or a script.

It comes with the JavaScript SDK, needs Node 22.12 or later and answers
`runtime --version` in about 40 ms, 15 ms more than Node alone. Its one dependency,
`undici`, loads only when a proxy applies. Run it without installing, or install
it once; npx spends about a quarter of a second of its own on every call, so an
agent that runs many commands saves that by installing:

```bash no-run
printf '%s\n' 'print(sum([125, 250, 375]))' > invoice.py
npx withruntime sandboxes run -- python3 - < invoice.py   # without installing
npm install --global withruntime                   # then the command is runtime
runtime sandboxes run -- python3 - < invoice.py
```

The examples below use `runtime`, the installed command; without installing,
write `npx withruntime` in its place. Commands read `runtime <product> <command>`,
with account commands at the top. `runtime` on its own says whether this machine
is connected and what to run first.

Each product is one plural word, the same in the CLI, the API, the SDKs and
MCP: `runtime sandboxes`, `runtime images`, `runtime ips`, `runtime networks`.
The singular is a typing shortcut for the same product (`runtime sandbox ls`).
The words renamed on 6 October 2026, `runtime address` (now `runtime ips`),
`runtime network` (now `runtime networks`) and `runtime tunnel` (now
`runtime networks wireguard`), keep working for 30 days after the rename
ships, each use printing the new command, and then fail with `name_retired` and
a hint naming it.

## One command in a fresh sandbox

```bash
printf '%s\n' 'print(sum([125, 250, 375]))' > invoice.py
runtime sandboxes run -- python3 - < invoice.py
runtime sandboxes run --keep --vcpu 2 -- nproc   # keeps it, and prints how to run more
```

`run` creates a sandbox, runs the command, prints its output, deletes the
sandbox and exits with the command's exit code. It takes the same options as
`sandbox create`, with one difference: `--timeout <seconds>` limits the command,
as it does for `exec` (exit code 124 when it runs out), not the sandbox.
`--keep` leaves the sandbox running for more commands.

## Connect once

Any command connects this machine the first time it needs to, so there is no
separate step. To connect ahead of time:

```bash no-run
runtime login                 # opens your browser; approve Connect agent
runtime login --no-browser    # prints a link and a code for another device, and exits
runtime login --wait          # waits for an approval already asked for
runtime login --with-key      # or paste a key from withruntime.com/account/keys
runtime login --agent-name "CI deploy bot"   # the name the approval page and the account show
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

A CI runner has no browser, so it runs on a key. With a key already on this
machine (saved by `login`, or `RUNTIME_API_KEY`), `runtime keys create` uses it
to make the new one at once, with no browser. `--browser` asks for browser
approval instead.

```bash no-run
runtime keys create --name ci                    # full access, until revoked
runtime keys create --name ci --daily-limit 25   # at most $25 in any 24 hours
runtime keys create --name monitor --read-only   # sees everything, changes nothing
runtime keys create --name web --account-wide    # uses every sandbox in the account
runtime keys create --name watcher --sandbox <id> --actions get,create --daily-limit 2  # one sandbox: look and restart
runtime keys create --name ci --daily-limit 25 --browser | gh secret set RUNTIME_API_KEY
```

With `--browser` it prints a link and a code, like `login`. An owner, admin or
developer of the account opens the link, checks the code, sees the key's name,
access and limit, and chooses **Create key**. Without it, the key that is on the
machine must be a full-access key made by an owner or admin, and the new key
never has more than that key ([run a swarm](./teams#run-a-swarm)).

The key is printed once, alone on standard output, with everything else on
standard error, so it pipes straight into a secret store. `--json` prints it as
one JSON object instead. Store it now: Runtime keeps only a hash of it. Give it
to your jobs as `RUNTIME_API_KEY`.

- With `--browser`, the command waits up to 15 minutes for the approval.
  Stopping it cancels the request, and a key approved but not yet received is
  revoked.
- These are the keys page's own options, and there are no others. A key lasts
  until revoked. Daily limits are in dollars.
- `runtime keys ls` lists this key and the keys it made, with what each spent in
  the last 24 hours. `runtime keys usage <keyId>` shows one key's spend, held
  money and running sandboxes. `runtime keys revoke <keyId>` revokes a key this
  key made.
- Change a key's daily limit, list every key and revoke them at
  [API keys](https://withruntime.com/account/keys).

## Book room for a burst or a pool

```bash no-run
runtime reservations book --sandboxes 300 --from 21:00 --to 23:00
runtime reservations book --sandboxes 50 --vcpu 4 --memory 8192 --from now --to 02:00
runtime reservations keep --sandboxes 40 --snapshot <id> --for-key
runtime reservations change <id> --snapshot <id>
runtime reservations ls
runtime reservations get <id>
runtime reservations cancel <id>
```

- The answer is at once. Booked: in the window, creates are never refused for
  room or limits up to what you booked. Sandboxes you run bill as usual;
  booked room none of them uses costs {{booked-unused-rate}} per GiB-hour, and
  the answer says the most that comes to if none run.
  Declined: the command prints why, the most that fits and the nearest window
  that fits all of them, and exits with code 1.
- `--from` and `--to` take an ISO time, `now`, or `HH:MM` on this machine's
  clock: today, or tomorrow if it has passed. A `--to` before `--from` is the
  next day. A window is at most 24 hours and starts within 14 days.
- Size defaults to 2 vCPU, 4096 MiB memory and 4096 MiB disk. `--json` prints the
  booking.

## Sandboxes

```bash
id=$(runtime sandboxes create --name demo --label team=search)
runtime sandboxes exec "${id}" -- python3 -c 'print(sum([125, 250, 375]))'
runtime sandboxes exec "${id}" --cwd /workspace --env API_TOKEN -- env
runtime sandboxes exec "${id}" --root -- apt-get install -y jq
runtime sandboxes exec "${id}" --trace-files read.json -- python3 -c 'import json'
runtime sandboxes ls
runtime sandboxes ls --state running --label team=search
runtime sandboxes get "${id}"
runtime sandboxes stop "${id}"
```

`create` prints only the id, so it composes with `$(...)`, and waits until the
sandbox is running (`--no-wait` returns at once). Its options:

- `--vcpu`, `--memory` and `--disk` in MiB; `--timeout <seconds>` (60 to 86,400,
  24 hours) sets a time limit, and `--on-timeout pause|stop|delete` what it does. Without
  `--timeout` a sandbox has none: it runs while it works and pauses when idle
- from withruntime 0.7.0: `--cpu-floor <thousandths>` for guaranteed CPU, and
  `--cpu reserved` for the highest floor, every vCPU; `--max-total-cost <usd>`
  caps its whole life
- `--name`, `--label k=v` (repeatable); `--trial` and `--paid` are accepted
  and ignored, since the free usage is spent first, then credit
- `--env K=V` (repeatable) sets a variable for every command, terminal and SSH
  session in it, for its whole life; values are never shown again. From
  withruntime 0.17.1, `--env K` alone sends `K`'s value from your own shell, so
  a secret is in no command line ([shared keys](./security#a-secret-your-sandbox-checks-on-requests-it-receives))
- network rules: `--no-internet`, `--allow <host>`, `--deny <host>` and
  `--connect <host:port>`; `--no-internet --allow <host>` reaches only the
  hosts listed
- `--secret NAME` (repeatable) lets it use only the egress secrets you name,
  of those that would otherwise reach it; `--no-secrets` gives it none.
  Without either it gets every one that reaches it. Fixed for its life: `fork`
  takes the same two options, and may only narrow the list. `get` shows it
- `--idle-pause <seconds>` pauses it after that long with nothing happening in
  it (default {{idle-pause-seconds}}; {{idle-pause-min}} to {{idle-pause-max}}, or 0 for never), and `--no-auto-wake` keeps a
  paused one paused until `wake`
- `--persistent` keeps a paid sandbox running until you stop it, idle or not,
  while credit lasts
- `--get-or-create` with `--name` prints the id of the sandbox that already has
  the name, woken if paused, instead of failing with `name_taken`

From withruntime 0.7.0, every command refuses an option it does not take,
before it sends anything, and names the one you likely meant: `--memory-mib`
gets "Did you mean --memory?". A value option followed by another flag fails
locally, for example `--name --json` answers `--name needs a value.`
Boolean options accept `=true` or `=false`; `--persistent=maybe` answers
`--persistent takes true or false.` Explicit numeric values, including zero,
reach the API for validation rather than silently using a default. `--help`
after any command prints its product's help and runs nothing.

`ls` lists the live sandboxes and the stopped ones that keep their disk; `ls --all` adds the rest and lists every
sandbox the account has had, oldest first, so the newest are last. `get`
shows its time limit, when it ends (or that it runs while it works), what
happens then (`pause` or `stop`) and, once a
sandbox has paused or ended, when, with its stop reason
([troubleshooting](./troubleshooting#a-sandbox-stopped-on-its-own) says what
each means). A refused option is named as the option you typed, such as
`--timeout`, not as the API's field (`timeoutSeconds`).

`exec` streams all of the output as it happens and exits with the command's own
exit code (124 when it timed out), so `set -e` scripts behave. `--root` runs the
command as root with no `sudo` in front, keeping its environment and `PATH`;
`spawn`, `run` and `shell` take `--root` too, and `ps` shows each process's
user. Without
`--timeout` a command may run for 24 hours; with `--json`, for 60 seconds. Everything it
starts, `nohup … &` included, ends when the command returns; start a server with
`spawn` (below) instead. Pass a secret
with `--env NAME` alone, which reads it from your shell, never written into
the command. Piped input reaches
the command, up to 1 MiB: `echo 'print(1)' | runtime sandboxes exec "${id}" -- python3 -`.
`--trace-files <file.json>` writes to that file, on your machine, every file
the command and anything it started read and wrote, as
`{"read", "written", "truncated"}`: key a test cache by what a test really
read ([which files a command read](./api#commands-and-processes)).
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
`runtime sandboxes cat`.

Background work, logs and a terminal. `logs` prints what a process has written
so far and returns, even while it runs; `-f` follows it until it exits. On a
terminal, `sandbox logs`, `job logs` and `image logs` show control characters
as `\u001b` and the like, so an escape sequence in a log cannot clear the
screen or rewrite what you read; `--raw`, a pipe or a file gets them as written:

```bash
id=$(runtime sandboxes create)
pid=$(runtime sandboxes spawn "${id}" -- python3 -m http.server 8000)
runtime sandboxes ps "${id}"
runtime sandboxes logs "${id}" "${pid}"
runtime sandboxes kill "${id}" "${pid}"
runtime sandboxes stop "${id}"
```

`runtime sandboxes stop --label team=search` stops every live sandbox with all
the labels given, and exits 1 if any of them failed to stop.
`runtime sandboxes rm --label team=search` deletes for good every sandbox with
all the labels given, stopped ones too, and exits 1 if any of them failed.

```bash no-run
runtime sandboxes shell "${id}"               # an interactive terminal, like ssh
runtime sandboxes shell "${id}" --command zsh # another program than the default bash -l
echo "ls" | runtime sandboxes shell "${id}"   # piped input runs, then the shell exits
runtime sandboxes spawn "${id}" --pty -- htop # in a terminal, for programs that need one
runtime sandboxes logs "${id}" "${pid}" -f      # follow until the process exits
```

Files. Name a sandbox path as `<id>:/path`; directories copy whole, and a
file keeps its permissions, so a script stays runnable. `files` marks a
directory `d` and a symbolic link `l`, one level deep unless `--depth` says
more:

```bash
id=$(runtime sandboxes create)
mkdir -p project && echo "print('hi')" > project/main.py
runtime sandboxes cp ./project "${id}:/workspace/project"
runtime sandboxes files "${id}" /workspace --depth 2
runtime sandboxes cat "${id}" /workspace/project/main.py
runtime sandboxes cp "${id}:/workspace/project" ./project-copy
runtime sandboxes stop "${id}"
```

`cp` and `cat` stream, so a file of any size copies without filling memory,
and both check every byte against the file's length: a copy that arrives short
is tried again, then fails with `download_incomplete` and exit 1, and never
leaves a short file under the name you gave.

A sandbox's name works wherever its id does, in every `runtime sandboxes` command
and in `--sandbox` filters, when one live sandbox has it.

Lifecycle: `pause`, `wake` (a sandbox already awake is left as it is), `restart`, `extend <id> <seconds>` (it moves a
time limit on and prints the new end; a sandbox with none needs nothing), `stop`. A paused
sandbox also wakes by itself when a command, file or terminal call or a visit
to a shared port reaches it, billed as any wake from the moment it runs.

A sandbox you come back to, by name, that pauses when idle and wakes when used:

```bash no-run
id=$(runtime sandboxes create --name dev --get-or-create --idle-pause 900)
runtime sandboxes exec "${id}" -- git -C /workspace/app pull
```

`update` changes a sandbox's settings after it is made; what you leave out
stays as it is:

```bash no-run
runtime sandboxes update "${id}" --idle-pause 0 --auto-wake off
runtime sandboxes update "${id}" --persistent on --max-total-cost 50   # dollars
runtime sandboxes update "${id}" --name dev-2 --label team=search
runtime sandboxes update "${id}" --env MODE=drain --unset-env QUEUE_URL
```

`runtime sandboxes switch-image <id> web:v2 --keep-workspace` moves a sandbox to
another image, keeping its id, `/workspace` (your home), volumes, environment
and previews. Its processes restart and the rest of its old disk is lost, so
the flag is required; snapshot it first to keep everything
([images](./images#move-a-sandbox-to-a-new-version)).

`runtime sandboxes rm <id>` (or `delete`) removes a sandbox for good, in any
state: it stops it, deletes its disk and paused memory, revokes its previews
and ports, and takes it out of every list. Its snapshots stay. Running it again
prints the same.

`--persistent on` keeps it running until you stop it, idle or not, while credit
lasts, up to `--max-total-cost`, its disk billed as any sandbox's. Any stopped
sandbox keeps its disk, so `restart` starts it again, and stays in `runtime ls`
and `runtime sandboxes ls`; `rm` deletes it. `--persistent off` makes it an ordinary sandbox
again; `rm` removes it for good. `get` shows the automatic wake,
idle pause and persistence settings.

Watch a directory. `watch` prints each change as it happens (create, write,
remove, rename, chmod) until Ctrl-C:

```bash no-run
runtime sandboxes watch "${id}" /workspace --recursive --exclude node_modules --exclude '.git/**'
runtime sandboxes watch "${id}" /workspace/src --events create,write --include '**/*.py'
```

Make a link to one file that anyone can open with no API key. By default it
downloads the file and lasts an hour; `--put` makes one that takes an upload.
`--expires` takes `90s`, `10m`, `1h` or `7d` (60 seconds to 7 days):

```bash no-run
runtime sandboxes link "${id}" /workspace/report.csv --filename report.csv --expires 10m
runtime sandboxes link "${id}" /workspace/incoming.bin --put --max-bytes 10485760
runtime sandboxes link "${id}" /workspace/out --archive        # a folder, as a .tar.gz
runtime sandboxes link revoke "${id}"                          # ends every link of the sandbox
```

It wakes a paused sandbox unless you pass `--no-wake`, which answers
`sandbox_paused` instead. A link ends when it expires, when `link revoke` runs,
when the key that made it is revoked or when the sandbox is deleted
([links in the API guide](./api#file-links)).

## Code, previews, network rules and the desktop

```bash no-run
runtime sandboxes run-code "${id}" analysis.py --out-dir charts   # a notebook cell; charts saved as PNG
runtime sandboxes run-code "${id}" model.R                        # R, by the file's extension
runtime sandboxes run-code "${id}" - --lang go < main.go          # Python, JavaScript, TypeScript, R, Java, Bash or Go
runtime sandboxes run-code "${id}" step2.py --context "${ctx}"   # a context you made, not the language's default
runtime sandboxes preview "${id}" 3000                           # an HTTPS address for a port, private with a token
runtime sandboxes preview "${id}" 3000 --public                  # public, no token: paid sandboxes only
runtime sandboxes previews "${id}"
runtime sandboxes preview rotate "${id}" 3000                   # withruntime 0.7.0: refuse every token so far
runtime sandboxes unshare "${id}" 3000
runtime sandboxes session create "${id}" --origin https://app.example.com --ttl 900   # a token a web page uses; printed once
runtime sandboxes session ls "${id}"
runtime sandboxes session revoke "${id}" "${session}"
runtime sandboxes network "${id}"                                # show its rules
runtime sandboxes network "${id}" --allow pypi.org --allow '*.pythonhosted.org'
runtime sandboxes network "${id}" --no-internet
runtime sandboxes network "${id}" --internet                     # the internet back on
runtime sandboxes desktop "${id}" start                          # prints a link to watch it
runtime sandboxes desktop "${id}" open https://example.com
runtime sandboxes desktop "${id}" screenshot screen.png
runtime sandboxes desktop "${id}" record start --fps 10 --max-mib 256 --max-seconds 600   # prints the recording id
runtime sandboxes desktop "${id}" record stop "${rec}"
runtime sandboxes desktop "${id}" record fetch "${rec}" demo.mp4
runtime sandboxes browser "${id}" start                          # Chromium; prints its private CDP address. Heavy apps need a sandbox made with --memory 2048
runtime sandboxes browser "${id}" start --headed --width 1280 --height 800   # on the desktop, to watch
runtime sandboxes browser "${id}" stop
```

A session lets your own web page reach one sandbox's commands, files and
previews directly, for {{session-default}} unless `--ttl` says otherwise and
{{session-max}} at most; see [a sandbox from a browser](./javascript#a-sandbox-from-a-browser).

The desktop and the browser come ready on every server: the first `desktop
start` in a sandbox installs nothing on its disk and takes about a second. The first recording
installs ffmpeg. A recording is an MP4 on the sandbox's own disk: it never
grows past `--max-mib` or runs past `--max-seconds`, stops before the disk fills, and a sandbox keeps at
most 8 GiB of them.

## MCP servers in a sandbox

Start well-known MCP servers inside a sandbox and connect your agent to them.
Secret settings name a [Runtime secret](#secrets), so the server never holds
the value:

```bash no-run
runtime sandboxes mcp catalog                                       # what can run: licence, settings, hosts
runtime secrets set GITHUB_TOKEN --host api.github.com < token.txt
runtime sandboxes mcp "${id}" start github fetch --secret github.GITHUB_PERSONAL_ACCESS_TOKEN=GITHUB_TOKEN
runtime sandboxes mcp "${id}" start github --secret github.GITHUB_PERSONAL_ACCESS_TOKEN=GITHUB_TOKEN \
  --option github.toolsets=repos,issues --replace                 # a catalog option; --replace stops the running set first
runtime sandboxes mcp "${id}" start fetch --public --replace         # URLs that never expire, the same header at every start
runtime sandboxes mcp "${id}"                                       # state, URLs and the header to send
runtime sandboxes mcp "${id}" stop
```

`start` prints each server's URL, the `Authorization` header every request
needs, and the `claude mcp add` line for each. With `--public` (an account
with a kept top-up) the URLs carry no link token and never expire, and the
header stays the same at every start, after a restart too, until `stop`: set
an agent up with them once. `runtime mcp` is something else:
this CLI's own MCP server, on standard input.

A preview's address is under `runtimehost.com`, the domain for everything
sandboxes serve, kept apart from Runtime's own site.

## Secrets

```bash no-run
printf %s "$OPENAI_API_KEY" | runtime secrets set OPENAI_API_KEY --host api.openai.com
runtime secrets set GITHUB_TOKEN --host api.github.com --header Authorization --format 'token {value}' < token.txt
runtime secrets set GITHUB_TOKEN --host api.github.com --allow 'GET,HEAD /repos/acme/*' < token.txt
runtime secrets set SLACK_APP_TOKEN --host slack.com --only-label role=hub < token.txt   # only sandboxes labelled role=hub
runtime secrets set DEPLOY_KEY --host api.example.com --only-sandbox "${id}" < key.txt     # only that sandbox
runtime secrets scope OPENAI_API_KEY --only-app "${app}"                                     # every copy of an App
runtime secrets set SLACK_APP_TOKEN --host slack.com --all-sandboxes < token.txt           # every sandbox again
runtime secrets set GITHUB_TOKEN_WEB --host api.github.com --only-label repo=web --env GITHUB_TOKEN < web.txt   # seen as GITHUB_TOKEN
runtime secrets scope SLACK_APP_TOKEN --only-label role=hub                                  # change who gets it, no value
runtime secrets set GITHUB_TOKEN --keep-value --allow 'GET /repos/acme/app/*'               # narrow it, no value
printf %s "$DB_PASSWORD" | runtime secrets set DB_PASSWORD --jobs
runtime secrets ls
runtime secrets ls --limit 10 --after GITHUB_TOKEN    # a page of 10, by name
runtime secrets rotate DB_PASSWORD < new-password.txt
runtime secrets reveal DB_PASSWORD
runtime secrets share DB_PASSWORD --agent "${agent}"   # or --all, or --none
runtime secrets rm OPENAI_API_KEY
```

The value is read from standard input only, so it never lands in your shell
history; typed at a terminal it is not shown. Every sandbox of the account then
has `OPENAI_API_KEY` set to a placeholder, and the proxy swaps in the value on
HTTPS requests to the hosts you named. On accounts with credit, from `withruntime`
0.7.0, `--allow` narrows that to some methods and paths, once
per rule: `--allow /v1/chat/completions` for every method,
`--allow 'GET,HEAD /repos/acme/*'` for two. With `--keep-value` (from 0.22.0), `set` reads no value
and only narrows the `--host` and `--allow` an existing secret has: anything
wider is refused, since widening needs the value. `--only-label key=value` (once per
selector) and `--only-sandbox <id>` give it to those sandboxes alone, and
`--only-app <id>` to every copy of that App, whatever its version; a new
value keeps that scope until `--all-sandboxes`. `--env VAR` puts the
placeholder in `VAR` instead of `NAME`: secrets scoped to different sandboxes
may share one, such as a `GITHUB_TOKEN` per repository, and a set that would
give one sandbox two of them is refused. `ls` shows names, hosts,
placeholders, rules and which sandboxes get each, never values. See [Security](./security#secrets-sandboxes-never-see).

`--jobs` keeps a copy that [scheduled jobs](./jobs#secrets-in-a-job) put into
their run's environment, bound with `runtime jobs create --secret NAME`; give
`--host` too and the secret goes to both. Only the jobs copy has versions
(`rotate`) and can be read back (`reveal`, with a key allowed to reveal); the
sandboxes' copy is never readable. `rm` deletes every copy.

A jobs copy stored by an API key is that key's. Your other keys need it shared
with `runtime secrets share NAME --agent <id>` (repeat the flag; an id is the
`principalId` from `runtime me`), `--all` for every key of yours, or `--none`
for only the key that stored it. It replaces the list and prints who may use it
now. A secret stored on the website stays every key's.

## Scheduled jobs

```bash no-run
runtime jobs create nightly --cron "0 3 * * *" --timezone Europe/Berlin -- python3 /workspace/report.py
runtime jobs create once --at 2026-10-01T03:00:00Z --timeout 600 --attempts 3 -- bash -lc 'make report'
runtime jobs ls
runtime jobs runs "${job}"
runtime jobs logs "${job}" -f
runtime jobs trigger "${job}"
runtime jobs reschedule "${job}" --cron "30 4 * * 1-5" --timezone Europe/Berlin
runtime jobs pause "${job}"; runtime jobs resume "${job}"; runtime jobs cancel "${job}"
runtime jobs update "${job}" --image hub:latest --alert-email -- bash -lc 'make report'
```

A job runs its command in a fresh sandbox each time, once (`--at`, an ISO time
or `now`) or on five cron fields (`--cron`, in `--timezone`, UTC unless set).
A schedule it cannot read is refused naming the field or the timezone, such as
`The minute field "61" is not a minute`.
It takes the sandbox's size flags (`--vcpu`, `--memory`, `--disk`, `--cpu`),
`--timeout` up to {{job-max-run}}, `--attempts` up to {{job-max-attempts}}
for a run that exits non-zero, `--secret NAME[=ENV_NAME]` for a secret stored
with `--jobs`, and `--max-cost` and `--max-total-cost` in dollars. `--image`
starts each run from an image of yours, and `--alert-webhook <url>`
(signed with `--alert-secret NAME`, a secret your key may reveal) or `--alert-email` tells you once
`--alert-after` runs in a row fail, and once when one succeeds again.
`runtime jobs update <id>` changes any of these, or the command after `--`, in
place. Runs are paid sandboxes at the sandbox rates. See [scheduled jobs](./jobs).

<!-- launch: apps -->

## App settings

`runtime apps create` and `runtime apps update` take `--cdn on|off`. On is the
default: Cloudflare's CDN sits in front of the App's `runtimehost.com` address
and its custom domains. Off sends visitors straight to Runtime's routers, with
nothing cached. It is part of the price of Apps and Functions. See
[App and Function CDN](./api#app-and-function-cdn).

```bash no-run
runtime apps create web --vcpu 1 --memory 512 --max-copies 8 --release staged --soak 300
runtime apps update web --release at-once
```

`--release staged` releases each new version a stage at a time: one copy
beside the live version's, then about 10%, 50% and all of them, each stage
running `--soak` seconds (60 to 3600, 300 by default) once its copies serve
and judged on its visitors' errors and speed before the next. A stage that
does worse goes back, and `runtime apps deploy` exits 1 with
`deploy_stage_failed` and the stage's numbers; the live version never stops
serving. A staged App's deploy waits through its stages. `runtime apps get`
shows `stagedRelease`. See [staged releases](./api#staged-releases).

## App logs

```bash check
runtime apps logs web                         # the newest 100 lines of the last hour
runtime apps logs web --since 2h --stream stderr --limit 500
runtime apps logs web --version 3 --copy "${copy}"
runtime apps logs web --follow                # every line as it comes, until Ctrl-C
```

`--since` is a time or a duration back from now (`30s`, `15m`, `2h`, `7d`);
lines are kept 14 days. On a terminal, control characters a copy printed show
as `\uXXXX`; `--raw` prints them as they are. `--json` prints the page, or
with `--follow` one event per line. See
[App and Function logs](./api#app-and-function-logs).
<!-- /launch: apps -->

<!-- launch: apps -->

## Apps with a volume

```bash no-run
runtime apps create db --vcpu 1 --memory 1024 --max-copies 1 --volume <volumeId>:/data
runtime apps update db --stop-grace 60 --health-fail 120
runtime apps restart db                       # the old copy stops, then the new one boots
```

The App runs one copy holding the volume; every deploy, rollback and restart
stops it before the next one starts, and `runtime apps versions` shows each
one's boot, downtime and replaced copies. See
[Apps with a volume](./api#apps-with-a-volume).
<!-- /launch: apps -->

<!-- launch: ci -->

## CI/CD

```bash no-run
runtime ci connect acme/web --config runtime.yml   # needs a full key
runtime ci checks --commit $(git rev-parse HEAD)    # its checks, newest first
runtime ci check <checkId>                          # its jobs in plan order
runtime ci cancel <checkId>                         # end it: its machines let go
runtime ci logs <jobId>                             # a job's log and its sandboxes
runtime ci tests <repoId> --quarantined             # quarantined test files
runtime ci flakes                                   # open flaky tests and their owners
runtime ci flake <flakeId>                          # one flake: its proof and runs
runtime ci releases --commit <sha>                  # a release's steps as taken
```

A failed job's sandbox may be kept paused: `runtime sandboxes wake <id>`, then
`runtime sandboxes shell <id>`. See [CI/CD](./ci).
<!-- /launch: ci -->

## SSH and port forwarding

```bash no-run
runtime sandboxes ssh "${id}"                          # a shell, as the sandbox user
runtime sandboxes ssh "${id}" -- make test             # one command; exits with its code
runtime sandboxes ssh config --install                 # `ssh <id>.runtime` from ssh, VS Code or JetBrains
runtime sandboxes code "${id}" --editor cursor          # open it in Cursor (or vscode, windsurf)
runtime sandboxes port-forward "${id}" 5432            # localhost:5432 here is port 5432 in the sandbox
runtime sandboxes port-forward "${id}" 3000 15432:5432 # several at once, local:remote
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
Sandboxes copies `runtime sandboxes ssh` with the sandbox's name. The page's
**Pause**, **Wake**, **Snapshot**, **Fork** and **Stop** do what
`runtime sandboxes pause`, `wake`, `snapshot`, `fork` and `stop` do.

## Images, volumes and snapshots

```bash no-run
img=$(runtime images build --pip pandas --apt jq --name data)   # or a folder: runtime images build . -t app:v1, or --from python:3.12-slim
vol=$(runtime volumes create --size-mib 10240 --name cache)
id=$(runtime sandboxes create --image "${img}" --volume "${vol}:/data")
base=$(runtime sandboxes create --image "${img}")
runtime sandboxes fork "${base}" --count 3              # three running copies of it
runtime sandboxes fork "${base}" --no-secrets           # a copy with none of its egress secrets
snap=$(runtime sandboxes snapshot "${base}" --name ready)
runtime sandboxes create --snapshot "${snap}"           # a copy, any time later
other=$(runtime sandboxes create --spread-from "${base}")   # starts on a server "${base}" is not on
runtime images ls; runtime volumes ls; runtime snapshots ls
runtime images get data; runtime volumes get "${vol}"; runtime snapshots get "${snap}"
runtime snapshots extend "${snap}" <days>              # keep it longer
runtime snapshots rm "${snap}"; runtime volumes rm "${vol}"; runtime images rm data
```

`runtime images build <folder>` builds the folder's Dockerfile (or `-f <file>`)
with the folder as its context, as `docker build` does: its `.dockerignore`
applies, the context may be 100 MiB compressed, and a rebuild uploads only what
changed. `-t app:v2` names it and tags it (each build of a name is its next
version, tagged `latest` when no tag is given), `--target`, `--build-arg K=V`
and `--no-cache` work as in Docker, and `--start <command>` with
`--ready-port <port>` (or `--ready-command <command>`, which must exit 0) sets
what a sandbox from it runs and when its create answers. `runtime images versions <name>`, `tag`, `untag`, `logs --follow` and
`rm` take an id, `name`, `name:tag` or `name@version`, and so does
`sandbox create --image`. `runtime images registry set <registry> --username <u>`
reads a token from standard input and stores it for private images. See
[custom images](./images). Images, volumes and kept snapshots are charged as
storage ([pricing](./pricing#snapshots-images-and-volumes)). A volume lives on
one server. It is backed up off that server every day and whenever you
ask, and a backup restores as a new volume ([storage and backups](./storage)). `runtime sandboxes stop` has the sandbox
write out what it wrote to its volumes first, and so does a time limit or
credit that runs out: the sandbox's programs are frozen just before its end,
and the write after that is not charged. `runtime sandboxes mount <id>
s3://bucket/prefix /data --secret NAME`, `mounts` and `unmount` mount your own
S3, R2 or Google Cloud Storage bucket without the sandbox holding its key
(`--account-id` names an R2 bucket's Cloudflare account, `--endpoint` any other
S3-compatible store)
([mount your own bucket](./storage#mount-your-own-bucket)).

A memory snapshot can be ready, and started from, while `compressionPending`
is true; it is charged on its final compressed size. `backedUp` confirms its
off-server copy has been checked. See
[snapshot storage](./storage#snapshots-survive-their-server).

Forks and snapshots:

- A fork or snapshot pauses a running sandbox for the moment it takes, then
  wakes it. A sandbox with volumes cannot be snapshotted. Snapshots are kept
  on the source's server, and copies start there while it has room; when it is
  full, a copy starts on another server once the snapshot is copied there. Each
  kept snapshot is also copied off its server after its final compressed form
  is ready.
- Copies run on what the account's new sandboxes run on (`--trial` and `--paid`
  are accepted and ignored). Copies keep the source's size and CPU, reserved or
  a raised floor, and are billed as a create with those would be. On an account without credit, a copy must fit the limits without credit.
- The snapshot a fork takes is deleted when the fork ends, whether every copy
  started or not, and is not billed, unless you pass `--keep-snapshot`.
- If a copy fails, the error names the copies that did start; they keep running
  until stopped. A retry with the same idempotency key answers the same error.
- If a fork stops partway and left its source paused, the source stays paused
  and an account notice says so; wake it with `runtime sandboxes wake`.
- A snapshot is kept as long as you have credit, with no end date (7 days
  without credit), unless `--retention` gives 1 to 365 days.

<!-- launch: apps -->

## Apps (private beta)

Apps are open to organizations in their private beta. These commands reach
into an App's live copy, much as `sandboxes exec` and `sandboxes cp` reach a
sandbox:

```bash no-run
runtime apps ls                                          # your Apps, with their live version
runtime apps copies agents-hub                           # its copies: id, version, region, state
runtime apps exec agents-hub -- tail -n 50 /srv/app.log
runtime apps cp agents-hub:/srv/app.log ./               # a file off it
runtime apps cp ./debug.json agents-hub:/tmp/debug.json  # and onto it
runtime apps exec agents-hub --copy <copyId> -- ps aux   # one copy in particular
```

`<app>` is the App's id or its name. Without `--copy`, a command goes to a
serving copy of the live version. If no copy is serving, the command says so
and wakes nothing. A request to the App's URL wakes one. `apps exec` takes
the same `--root`, `--cwd`, `--env`, `--timeout` and `--trace-files` as
`sandboxes exec`.

A copy holds the App's secrets, so only an owner's or admin's key may reach
into one. A file written to a copy lasts only as long as that copy: a deploy
replaces every copy with new ones from the version's image. See
[the API](./api#commands-and-files-in-an-apps-copy-private-beta).
<!-- /launch: apps -->

## Scripts and agents: `--json`

Every command takes `--json` and prints one JSON value. Errors become
`{"error": {"code", "message", "hint", "requestId"}}` on standard error with a
non-zero exit.

```bash
id=$(runtime sandboxes create)
runtime sandboxes get "${id}" --json
runtime sandboxes exec "${id}" --json -- uname -a
runtime sandboxes stop "${id}" --json
```

`runtime sandboxes get --json` answers the sandbox as the API does:

```json
{
  "id": "0b8f3c52-6d8e-4b1f-9c67-2f4e6c1d9a10",
  "kind": "sandbox",
  "name": null,
  "labels": {},
  "state": "running",
  "region": "us-east",
  "vcpu": 2,
  "memoryMiB": 4096,
  "diskMiB": 4096,
  "cpu": "shared",
  "cpuFloorMillis": 50,
  "timeoutSeconds": 0,
  "endsAt": null,
  "onLeaseEnd": "pause"
}
```

## Account

```bash
runtime whoami
runtime usage
runtime ls
```

- `runtime usage` prints the balance, the free usage left and what each
  kind of resource was charged, in dollars; `--json` gives every figure in
  integer microdollars, with each resource's rates and CPU time. From 0.7.0,
  `--csv` exports one row per resource for a spreadsheet: its name, kind, state,
  when it was made, its vCPUs and memory, how long it ran, the CPU seconds it
  used, what it was charged and what running ones are about to use (`held_usd`), in dollars to the microdollar.
  It covers the newest 100 resources. For all visible resources over a date
  range, use `runtime usage export --since 2026-09-01T00:00:00Z
--until 2026-10-01T00:00:00Z > usage.csv`. This follows every page and prints
  the server's CSV with one header. It includes settled intervals at `since`
  and excludes those at `until`, by settlement time; running time not yet settled is left out.
  Amounts remain exact. When it finishes, it says on stderr how far the range
  is final: no more charges will settle before that time, and the CSV's
  `final` column says which resources can be charged nothing more.
  `--json` prints one complete server page per line.
  Each page rechecks current permissions and reads current settlements. See
  [export settled usage](./api#export-settled-usage).
- `runtime limits` says whether this machine's key is read-only and what its
  daily spending limit is, with what was used in the last 24 hours and what is
  left (0.3.1 and later), and, in versions after 0.8.4, the free usage left, as `runtime usage` does. The member who made the key, or an owner or admin,
  sets or changes the limit at [API keys](https://withruntime.com/account/keys);
  see [security](./security).
- On an account with a pilot, `runtime usage` shows its sandbox hours left,
  and in versions after 0.11.1 `runtime whoami` and `runtime limits` also say
  how many sandboxes it runs free and until when. Credit does not run a pilot's
  sandboxes; to extend a pilot or ask for more hours, write to support.
- `runtime ls` lists everything the account runs, every product.
- `runtime compare --from <provider>` says what the sandboxes you ran in the
  last 30 days would have cost at another provider, from the same vCPUs, memory
  and running time at its published rates, and what you save a month
  (`--days` up to 90). When your first sandbox in the window is more recent
  than the window, the month is projected from the days since, and the output
  says so. Sandboxes the free usage paid for are priced at the standard
  rates, and the output says how many there were. The providers are `e2b`, `daytona`, `vercel`, `modal`,
  `cloudflare`, `fly` (Sprites), `fly-machines` and the others in the
  [rate comparison](./pricing#published-rate-comparison). With no sandboxes
  yet, it prices an example and says so.
- `runtime switch --from <provider>` records the provider you are leaving, before
  you first add credit. `runtime switch` on its own shows the welcome match: credit you add within {{welcome-days}} days of signing up is matched, up to {{welcome-max}} in total
  ([welcome match](./pricing#welcome-match)), how much of it is used and left, and how long is left. From withruntime 0.8.3, for E2B, Daytona, Vercel
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
- `runtime sandboxes identity-token --audience sts.amazonaws.com [--lifetime 600]`,
  inside a sandbox, prints an OIDC token naming it, for AWS, Google Cloud or
  your own API. It needs no API key. See [identity tokens](./identity-tokens).
- `runtime sandboxes metrics <id> [--range 1h]` shows a sandbox's CPU, memory,
  CPU wait and memory stalls now and over the range (`15m`, `1h`, `6h`, `24h`,
  `7d`, `30d`). Unmeasured waiting is named rather than shown as zero.
- `runtime events [--sandbox <id>] [--type sandbox.stopped]` lists lifecycle
  events, newest first.
- `runtime webhooks create <url> [--events a,b]` sends signed lifecycle events
  to your URL and prints its secret once; `ls`, `test <id>`, `deliveries <id>`,
  `update <id> [--url <url>] [--events a,b] [--disable|--enable]`, `rotate-secret <id>`, `retry <deliveryId>`
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
runtime feedback "exec output lost its colours" --kind bug --detail "runtime sandboxes exec ... -- ls --color"
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
runtime domains add app.example.com <sandbox> 3000   # prints the DNS records to set
runtime domains verify app.example.com               # live once the TXT record matches
runtime ports open <sandbox> 5432                    # prints address:port
runtime ips reserve                             # every sandbox sends from it
runtime networks wireguard create
runtime networks wireguard peer add office --route 10.0.0.0/16  # writes runtime.conf
sudo wg-quick up ./runtime.conf
runtime networks upstream-proxy set http://proxy.example.com:3128 --secret PROXY_AUTH
runtime networks private on                          # your sandboxes reach each other as <name>.sandbox.internal
runtime networks signed-requests on                  # your sandboxes can sign requests as Runtime's agents
runtime domains ls; runtime domains get app.example.com; runtime ips ls
runtime networks wireguard get                                  # its peers and each sandbox's address
runtime networks wireguard rm                                   # the tunnel and every peer
```

`runtime networks upstream-proxy` arrived in 0.7.0. `runtime networks private on|off|status` lets
your sandboxes reach each other by name, for an account with a kept top-up.
`runtime networks signed-requests on|off|status` lets them sign their HTTP
requests as Runtime's agents, for an account with credit. Each has
its own help: `runtime domains help`, `runtime ports help`,
`runtime ips help`, `runtime networks wireguard help`, `runtime networks help`.

The WireGuard configuration contains a private key. The CLI writes it with
owner-only permissions and replaces an existing regular file atomically.
It refuses a symbolic link or a directory as the output path. If publishing
the configuration fails, the error names the protected draft to recover;
inspect the peer with `runtime networks wireguard get` before creating another one.
