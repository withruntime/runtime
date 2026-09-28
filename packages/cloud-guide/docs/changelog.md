# Changelog

What shipped in Runtime Cloud, newest first.

Runtime ships every day. Each entry is something you can use or see; the
guides hold the current terms, and [pricing](./pricing) holds the current rates.
Each day also has a page of its own at
[withruntime.com/changelog](https://withruntime.com/changelog), and every entry
arrives in the [RSS feed](https://withruntime.com/changelog/feed.xml).

## 28 September 2026

- **The region is now `us-east`.** It was `us-east-vin`, the name of one
  building; a region is named for its place, so more data centres nearby can
  join it. Every sandbox, snapshot, volume, image and job moved with it and
  keeps running. Asking for `us-east-vin` now answers `invalid_region` and
  names `us-east`, and an identity token's `region` claim reads `us-east`, so
  update a trust policy that names the old one. `withruntime` 0.8.4 sends
  `us-east` as a job's default region; update with `npm i withruntime@latest`
  or `pip install -U withruntime`. A job that names a region Runtime does not
  have is now refused when you create it, rather than waiting at every run.
- **Your first key and code on Home.** A new account's Home puts your code in
  one place beside the browser shell: the prompt that has your coding agent do
  the setup, and by hand **Create my key**, which makes a key and shows it
  once, with the install and a first sandbox in Python or JavaScript. Signing
  up from a page comparing Runtime with another provider opens Home on that
  switch, with the one import that changes for E2B, Daytona, Vercel Sandbox and
  Blaxel. See [Get started](./start#run-your-first-sandbox).
- **A sandbox from a browser.** A sandbox session is a short-lived token your
  own web page uses to run commands, read and write files and reach previews in
  one sandbox, with no API key and no proxy of your own. It cannot stop, extend
  or change the sandbox, lasts {{session-default}} unless you ask for up to
  {{session-max}}, can be revoked at once, and is answered only from the pages
  you list. `sbx.sessions.create({ origins })` makes one and
  `Sandbox.fromSession({ token, sandboxId })` uses it, from `withruntime`
  0.8.3; Blaxel's `sandbox.sessions` and `fromSession` now work in the
  drop-in. See [JavaScript](./javascript) and [Python](./python).
- **The one import, printed.** `runtime switch --from` and
  `runtime compare --from` print the import that moves E2B, Daytona, Vercel
  Sandbox or Blaxel code to Runtime, from `withruntime` 0.8.3.
- **Passkeys.** Sign in with a passkey, with no email link and no code, or use
  one as the second step in place of an authenticator app's code. Add them
  under Settings → Two-step sign-in, beside the app or instead of it. See
  [two-step sign-in](./security#two-step-sign-in).
- **A Go SDK.** `go get withruntime.com/go` installs one Go client for every
  Runtime product, with a `context.Context` on every call and only the standard
  library underneath. See the [Go guide](./go).
- **A Ruby SDK.** `gem install withruntime` installs one Ruby client for every
  Runtime product, with only the standard library underneath. See the
  [Ruby guide](./ruby).
- **A Java SDK.** `com.withruntime:withruntime` on Maven Central is one Java
  client for every Runtime product, for Java 17 and later with nothing beyond
  the JDK. See the [Java guide](./java).
- **Faster starts, pauses and stops.** A new sandbox runs its first command
  331 ms after the create request at the median, down from 374 ms, and
  30 of 40 creates were running in under 200 ms. A pause answers in 165 ms,
  down from 226 ms, and a snapshot is ready in 3.27 s. On the server, without
  the network to Virginia, a pause answers in 81 ms, a wake in 75 ms and a stop
  in 37 ms; the [speed](./speed) page now shows those figures beside the ones
  from a laptop.
- **Idle pause sees a download that has just started.** A background download
  or any other traffic now keeps a sandbox awake from its first second; before,
  traffic that began right after the last command could go unseen for up to
  15 seconds.

## 27 September 2026

- **Settings in the sidebar.** Open Settings and the sidebar lists its pages
  in three groups, Developers, Team and Security, with a way back to where you
  were. Referrals stay on Usage & billing and Support in the account menu.
- **Security and compliance page.** One page for a security review: where
  data lives and the certifications of the companies that hold it, isolation,
  encryption, sign-in, recovery, and how Runtime is run, with the date each
  recurring check was last done. See [security and compliance](./trust), or
  withruntime.com/trust.
- **A nightly off-site copy of the database.** Encrypted to a key held
  offline and kept 30 days in Backblaze, locked against early deletion.
- **Two-step sign-in.** Turn on a code from an authenticator app after every
  sign-in, whichever way you sign in, under Settings → Two-step sign-in. Owners
  can require it of everyone in the account. See
  [two-step sign-in](./security#two-step-sign-in).
- **Faster wakes, snapshots and stops.** A paused sandbox runs its next
  command 588 ms after the call that wakes it at the median, down from 980 ms;
  a snapshot of a running sandbox is ready in 3.49 s, down from 6.54 s; a
  preview visit to a paused sandbox answers in 0.47 s, down from 0.77 s; and a
  stop answers the moment the sandbox is frozen. See [speed](./speed).
- **An uptime promise, paid automatically.** Paid accounts are promised
  {{uptime-promise}} API uptime every calendar month, measured by the outside
  check on the [status page](https://withruntime.com/status). A month below it
  gives every paid account {{uptime-credit}} of that month's charges back as
  service credit in the first week of the next month, with no claim to file.
  The terms now give 30 days' emailed notice before we end an account without
  cause, and the liability floor is $1,000 instead of $100. See the
  [Uptime Promise](https://withruntime.com/legal/sla).
- **Idle sandboxes pause themselves.** A new sandbox pauses after 60 seconds
  with nothing happening in it, used or not (a `persistent` one only if you set
  an idle time), and pays only paused storage until
  the next request wakes it. A command or terminal still running, an open
  preview, port, SSH or tunnel connection, network traffic or CPU use keeps it
  awake. `idlePauseSeconds` now goes as low as 10 seconds, and 0 still turns it
  off. Sandboxes made before today keep their settings. See
  [pause when idle](./javascript#pause-when-idle).
- **Account-wide keys.** An owner or admin can make a key that sees and uses
  every sandbox, snapshot, image and volume in the account, whichever key made
  it, as a Blaxel workspace key does: choose **Everything in the account** at
  [API keys](https://withruntime.com/account/keys), switch an existing key from
  its row, or approve `runtime keys create --account-wide`. `getOrCreate` with
  a name another key holds then returns that sandbox. Keys made without it are
  unchanged. See [keys in a team](./teams#keys-in-a-team).
- **withruntime 0.8.2.** `runtime keys create --account-wide` makes an
  account-wide key from the command line. Large file writes send eight chunks
  at once in both SDKs, so a big upload finishes sooner: 100 MB took 11 s
  instead of 17 from a 12.6 MB/s connection.
- **Switch from Blaxel in one import.** Code written for Blaxel's sandbox SDK
  runs on Runtime after changing `@blaxel/core` to `withruntime/blaxel`
  (`withruntime` 0.8.0), or in Python `blaxel.core` to `withruntime.blaxel`
  (0.8.1). Processes, files, previews, snapshots, forks and the code interpreter
  carry over, and standby becomes a pause that keeps memory and processes until
  the next call wakes it. A switch from Blaxel now earns the [switching
  credit](./pricing#switching-credit): run `runtime switch --from blaxel` before
  your first top-up, and that top-up is matched, up to $100. See [Runtime vs
  Blaxel](./blaxel-alternative).
- **Start a sandbox from the browser.** A new account's Home offers
  **Start a sandbox** beside the agent prompt. It opens the sandbox with a
  shell running in the page, runs on the free hours, and pauses after an idle
  minute. It acts as an agent named Console, one for each member, shown
  on the API keys page like any other. See [Get started](./start#run-your-first-sandbox).
- **withruntime 0.7.2.** A directory download (`files.download`,
  `runtime sandbox cp`) can no longer write outside the folder you gave it: a
  link in the sandbox that leads outside, or a file written through one, is
  refused with `unsafe_archive`, and links that stay inside arrive intact. A
  `custom` network policy in the Vercel AI SDK harness that allows nothing now
  turns the internet off, as `deny-all` does. `runtime sandbox exec … --json --
tool --json` passes the second `--json` to the tool, and a streamed command
  that times out says 24 hours, its real limit. The Harbor and Inspect adapters
  build images with the current image builder. Update with
  `npm i withruntime@latest` or `pip install -U withruntime`.
- **A changelog page for every day, and a feed.** Each day's changes have a
  page of their own at [withruntime.com/changelog](https://withruntime.com/changelog),
  every entry has a link, and the [RSS feed](https://withruntime.com/changelog/feed.xml)
  carries each one. The glossary adds fifteen cloud terms, from
  [vCPU](https://withruntime.com/glossary/vcpu) to
  [egress fees](https://withruntime.com/glossary/egress-fees), and every price,
  limit and speed on the guides and question pages is now filled in from one
  source, so a change reaches every page at once.

## 26 September 2026

- **Security fixes across the account.** A read-only key still lists a
  sandbox's previews but no longer receives a private preview's token.
  Webhooks and telemetry exports are made, changed and deleted by an owner's or
  admin's key, and every key still lists them. A deleted or replaced private
  registry password is erased, as is every one when an account closes. Support
  asked through a read-only key sees only what that key can. See
  [security](./security) and [observability](./observability#webhooks).
- **Single sign-on through OIDC.** Okta, Entra ID and Google Workspace
  connections by OIDC can be saved and used, as SAML ones could. See
  [single sign-on](./single-sign-on).
- **Bucket mounts work again,** and a custom domain under a suffix such as
  `co.uk` is told to set A and AAAA records at its apex, not a CNAME.
- **Paid means paid and kept.** Paid-only features follow a top-up that was not
  refunded or charged back in full, and a refund of a top-up that earned
  matching credit is smaller by any of that credit already spent. See
  [pricing](./pricing).

- **Faster starts, pauses and wakes.** Runtime now keeps machines of the most
  common sandbox shapes started ahead of time, and the servers keep memory
  ready for sandboxes that start or grow at once. Measured through the public
  API: a new sandbox runs its first Python command 374 ms after the create
  request at the median (495 ms p95, down from 981 ms), a pause takes 207 ms,
  a paused sandbox runs its next command 980 ms after the call that wakes it,
  and a preview visit to one answers in 0.77 s, down from 3.99 s. See
  [speed](./speed) for every figure and the samples.
- **Outbound traffic has a price.** Inbound traffic stays free, and each
  account's first 100 GiB out a month is free. Past it, what sandboxes send to
  the internet costs $0.02 per GB, fixed in each new sandbox's quote. Replies
  served through previews, custom domains and TCP ports, traffic to your own
  network, and trial sandboxes are not charged, and sandboxes made before today
  keep free traffic for their whole life. `GET /v1/usage` shows the month so
  far under `outbound`. See [pricing](./pricing#network-products).
- **A calmer console.** Home is your whole account on three sheets: your
  sandboxes' CPU hour by hour for the last day, this month's cost by product,
  and **Worth a look**, which names sandboxes costing money while doing little
  and offers **Pause** for an idle one. Sandboxes, a sandbox's page, Images,
  Volumes and Settings are redrawn to match, and the sidebar holds everything,
  with your account and your menu in one place at its top.
- **Fast commands keep all their output.** A command that writes faster than
  it is read now waits for its reader from its first byte instead of losing
  what came before: 4 MiB written at once came back whole in every run, where
  before about half the runs lost up to three quarters of it. See
  [running commands](./javascript#run-commands).
- **withruntime 0.7.1.** Code written for E2B no longer gets lost output back
  looking whole: when part of a command's output was dropped before it was
  read, the result says `truncated` and a warning names it. `runtime login`
  now names the account it connected to. Update with
  `npm i withruntime@latest` or `pip install -U withruntime`.
- **Your account opens straight away.** A new account now lands in the full
  console. Home shows the setup prompt for your coding agent until the agent
  connects, and keys, billing and settings are in the menu from the first
  visit. Hide the prompt if you would rather start on your own.
- **A smaller MCP tool list.** An agent connected to Runtime's MCP server now
  reads 45 tools instead of 80, in 61,754 characters instead of 80,808, before
  its first call. A product's rarer verbs share one tool that takes an
  `action`: `runtime_volume_get` is now `runtime_volume` with
  `"action": "get"`. The first-session tools keep their names. The old names
  answer until the next release and say what replaces them; see
  [renamed tools](./mcp#renamed-tools).

## 25 September 2026

- **Sandboxes from a custom image start in half a second.** Once an image is
  ready, a sandbox of the default size created from it starts from a started
  copy of the image: 481 ms from create to running at the median, from 3.7 s.
  See [fast starts](./images#fast-starts).
- **A new console.** Home shows what runs now, with live CPU and memory and
  what just happened across every product. New, or ⌘K, finds any page or
  resource and starts anything, showing the command that does it. A sandbox's
  page opens a terminal in the browser and has Pause, Wake, Snapshot, Fork and
  Stop; Images and Volumes have their own pages; Usage & billing says how long
  your credit lasts and charts daily spend by product. See
  [your account](./products#the-console).
- **A 100-hour free trial.** The free trial is now 100 hours of sandbox time,
  from 50, still with no card. Accounts already on the trial get the extra
  hours too; hours already used still count. See [the free trial](./trial).
- **Sandboxes up to 16 vCPUs and 64 GiB.** A paid sandbox can now be as large
  as 16 vCPUs and 64 GiB of memory, at the same per-unit rates; a trial
  sandbox stays at 2 vCPU and 4 GiB. See [pricing](./pricing#how-many-at-once).
- **Faster network for paid sandboxes.** A paid sandbox moves up to 500 Mbit/s,
  200 Mbit/s sustained after its first 10 GiB, and 500 GiB a day. See
  [the sandbox environment](./sandbox-environment#the-network).
- **Outbound UDP to any port.** Paid sandboxes send UDP to any public address
  and port: HTTP/3 and QUIC, DNS to a resolver you choose, time sync, game and
  media servers, WireGuard and other VPN clients. Private addresses are
  refused, a sandbox sends at most 50,000 datagrams a second, and a flow that
  gets no answer after 256 datagrams is closed. Trial sandboxes send TCP only.
  See [networking](./networking#outbound-udp).
- **50 sandboxes at once for a new paid account, then 100.** A paid account
  runs up to 50 at once until 7 days after its first top-up clears or $50 of
  paid use has settled, whichever comes first, then 100. See
  [pricing](./pricing#how-many-at-once).
- **Rules on a secret.** On a paid account, a secret can name the methods and
  paths it goes to, such as `GET /repos/acme/*`; a request no rule allows
  goes out without it. See [security](./security#secrets-sandboxes-never-see).
- **Your own upstream proxy.** A paid account can send its sandboxes' traffic,
  or only the hosts it names, through its own HTTP or HTTPS proxy, with one of
  its secrets as the proxy's password. Runtime's own checks still come first,
  and a proxy that fails refuses the connection rather than going direct. See
  [networking](./networking#your-own-upstream-proxy).
- **Private preview links work for every client.** A link that carries its
  token now serves `curl`, `fetch` and WebSockets directly; only a browser's
  page load is redirected to set a cookie. The cookie lasts as long as its
  token, and a stopped sandbox's preview answers 404 (410 once deleted)
  instead of asking the client to retry forever. The MCP server's
  `runtime_sandbox_previews_rotate` refuses a preview's old tokens and returns
  a new one.
- **Previews answer again after a wake.** For a short time on 25 September, a
  preview of a sandbox that had been paused and woken answered `503 waking`
  instead of reaching its server. A visit to a paused sandbox's private
  preview now reaches the server in 3.99 s at the median. See
  [speed](./speed).
- **Long responses are no longer cut at 150 seconds.** Downloads, preview
  streams and other responses longer than two and a half minutes used to end
  there.
- **Downloads arrive whole or fail loudly.** The API now sends every file's
  length first. A download interrupted on our side is read again instead of
  ending short. In `withruntime` 0.7.0, `files.read` checks the length (and a
  small file's SHA-256), reads a short answer again and then raises
  `download_incomplete`; `files.readStream` (`read_stream` in Python) streams a
  file of any size and raises if it ends short; and `runtime sandbox cp`
  writes to a partial file and renames it only when whole.
- **Remote MCP sign-in is found automatically.** A connector that meets the
  MCP server's 401 now finds where to sign in, including clients written to
  the March 2025 MCP specification.
- **Custom images get `sudo`, `adduser` and `useradd`.** Every image Runtime
  builds, from a public image too, gives the sandbox user passwordless
  `sudo`, and the base image now carries `adduser` and `useradd`. A command in
  a sandbox from an image starts in the image's last `WORKDIR` (inside
  `/workspace`). Build logs number only the steps they log.
- **Forks and snapshot copies keep their labels.** A fork's copies, a snapshot
  and a sandbox created from it take the source's labels unless you name
  others. Names are never copied.
- **The audit log records every creation.** Each resource created writes one
  `resource.created` entry with its kind, name, labels and funding, and a
  rules change is logged only when the rules change. See
  [teams](./teams#audit-log).
- **A blocked account says so.** When a payment is disputed or under review,
  a create answers `account_blocked` (402) with the reason and what clears it,
  instead of `insufficient_funds`. In `withruntime` 0.7.0 both SDKs raise
  `AccountBlockedError`.
- **Close your account yourself.** An owner closes the account at
  [Close account](https://withruntime.com/account/close) or with
  `POST /v1/account:close`; `runtime account close` arrived in `withruntime` 0.7.0. See [teams](./teams).
- **Usage per run.** `GET /v1/usage` now gives each resource's name, start
  time, size and billed running time. In `withruntime` 0.7.0,
  `runtime usage --csv` exports one row per resource to the microdollar.
- **Adapter and CLI fixes, in `withruntime` 0.7.0.** E2B's `getHost(port)`
  answers at once, as E2B's does, instead of throwing. The AI SDK harness,
  ComputeSDK, Harbor and Inspect adapters report a timed-out command as exit
  code 124 and a signal as 128 plus its number, as a shell does. Piped input
  to `runtime sandbox shell` ends the shell when it runs out. Secret rules
  and the upstream proxy get `runtime secrets set --allow`,
  `runtime network upstream-proxy` and matching SDK methods.
- **Rotate a preview token from the CLI.** In `withruntime` 0.7.0, `runtime sandbox preview rotate <id> <port>` refuses every token
  given out for a private port and prints the new one, as
  `previews.rotate(port)` does in the SDKs.
- **The CLI refuses an option it does not take.** In `withruntime` 0.7.0, `runtime sandbox create --memory-mib 8192` stops with "Did you
  mean --memory?" and creates nothing; before, an unknown option was ignored.
  `--help` after any command prints its help instead of running it, and
  `sandbox create` and `run` take `--cpu`, `--cpu-floor`, `--max-cost` and
  `--max-total-cost`, as the SDKs do.
- **Ctrl-C on `runtime sandbox exec` stops the command in the sandbox.** It
  used to stop only the CLI, and the command ran on. A connection that drops
  mid-command is now picked up where it stopped, output skipped by a slow
  reader is always reported as lost, and `exec` by id makes one request instead
  of two, about 100 ms sooner. In the SDKs, a streamed exec that is cancelled
  stops its command. In `withruntime` 0.7.0.
- **Clearer CLI answers.** `runtime whoami` names the organization, your role
  and what you can spend; `runtime usage` shows what was used apart from what
  refunds returned; `sandbox cp` into `dir/` keeps the file's name and makes
  missing folders; a refused request no longer asks you to report it. In
  `withruntime` 0.7.0.
- **A create that waits for room says so.** When every trial slot is taken,
  `runtime sandbox create` and `run` now print why on standard error instead
  of waiting up to two minutes in silence. In the SDKs, `onCapacityWait` in
  JavaScript and `on_capacity_wait` in Python hear each wait, and
  `Sandbox.create` takes `waitForCapacityMs` as `runtime.sandboxes.create`
  does. In `withruntime` 0.7.0.
- **A misspelled create option is a TypeScript error.** In `withruntime` 0.7.0, `Sandbox.create()` accepts only the options the API takes,
  so `{ vcpus: 2 }` fails the typecheck instead of the request. The package now
  asks for Node 22.12 or later, the first release where `require("withruntime")`
  works without a flag.
- **Custom domains verify as soon as the record is published.** Verification
  used to keep answering "No TXT record" for up to half an hour after you
  added it.

## 24 September 2026

- **Disk bursts.** A sandbox now writes at about 250 MB/s for up to 30 seconds
  before settling at about 40 MB/s, so installs, builds and test runs finish
  sooner. In a measurement a sandbox wrote at 200 MB/s instead of 38. See
  [the sandbox environment](./sandbox-environment).
- **Volumes and snapshots are backed up off their server.** Every kept snapshot
  is copied off its server, encrypted with your organization's own key, and a
  volume is backed up daily and on request, then restored as a new volume
  (`runtime volume backup`, `runtime volume restore`). See
  [storage and backups](./storage).
- **Faster default starts.** In matched 20-run public-API measurements, the
  default 2 vCPU / 4 GiB memory / 4 GiB disk sandbox reached running in 207 ms median
  (620 ms p95), and took 351 ms median from create through the first Python result
  (815 ms p95). Both runs had zero errors. See [speed](./speed) for the before
  figures and scope; Python execution itself did not get faster.
- **Python data tools are ready.** The current default image includes NumPy,
  pandas and matplotlib. Imports and PNG plotting were checked in a live
  sandbox. Retained sandboxes keep their existing image.
- **Identity and file permissions.** A new sandbox on the current default image receives its current lease's
  identity-token environment before its first accepted command. File writes apply the
  requested mode, including executable scripts; the default remains 0644.

- **The code interpreter speaks seven languages.** Python, JavaScript,
  TypeScript, R, Java, Bash and Go, each keeping its state between cells (Go
  keeps its declarations and runs each cell as a program). R plots come back
  as PNG and R data frames and JavaScript arrays of objects as tables, and
  `display` returns any file as a result. R, Java and Go install themselves the
  first time you use them. See [JavaScript](./javascript#code-interpreter).
- **Watch files.** `sbx.files.watch`, `runtime sandbox watch` and
  `runtime_sandbox_files_watch` stream create, write, remove, rename and chmod events
  for a directory, with include and exclude globs, batches, a rate cap that
  says when it drops events, and a cursor that loses nothing across a pause.
- **Record the desktop.** `sbx.desktop.recordings` records the screen to MP4
  and fetches it; a recording is bounded in CPU, bit rate and size and stops
  before the disk fills.
- **MCP servers in a sandbox.** `runtime sandbox mcp` and `sbx.mcp` start
  GitHub, Postgres, a Playwright browser, filesystem, fetch and nine more MCP
  servers in a sandbox in one call, each at an authenticated URL your agent
  connects to; secret settings come from Runtime secrets, so the server never
  holds the value. `GET /v1/mcp/catalog` lists them with their licences.
- **Fixes.** A sandbox created from an image with a start command now runs it
  and waits for its ready check, as the images guide says. A program in the
  image's own `PATH` (`python` in `python:3.12-slim`) is found by `exec`. The
  desktop starts: its first start installs it, and `open` reports a missing
  browser instead of "Opened". Deleting an image no longer leaves it in
  `deleting`. An uploaded file keeps its permissions, and a written one is 644,
  not 600. The CLI, from `withruntime` 0.6.0, passes piped input to `exec`, says so and exits non-zero if
  output was lost, makes the `--out-dir` of `run-code`, and marks symbolic links
  in `files`. An egress secret's placeholder is in the environment of every
  command from the moment the secret is set, including in a sandbox made a
  second ago. A preview visited just after its sandbox paused wakes it instead
  of answering 502. A trial sandbox's network rules no longer say it may reach
  ports beyond 80 and 443.
- **Terminals.** An organization may hold 64 terminals open, 12 in one sandbox
  (it was 8).
- **Stopping a sandbox keeps what it wrote to its volumes.** A write made just
  before `runtime sandbox stop` could be lost; the sandbox now writes its
  volumes out first.
- **Mount your own bucket.** An Amazon S3, Cloudflare R2 or Google Cloud
  Storage bucket appears as a directory in a sandbox (`runtime sandbox mount`,
  `sbx.mounts.add`). The sandbox never holds the bucket's key: Runtime's egress
  proxy signs each request with it. See
  [mount your own bucket](./storage#mount-your-own-bucket).
- **Single sign-on, free on every account.** Sign in through Okta, Microsoft
  Entra ID, Google Workspace or any SAML or OIDC provider, prove your email
  domain with a DNS record, and require single sign-on for your members. See
  [single sign-on](./single-sign-on).
- **SCIM directory sync.** Your identity provider adds people, sets their roles
  through groups, and removes them the moment they leave, which revokes every
  key they made.
- **Identity tokens for code in a sandbox.** A sandbox gets a short-lived OIDC
  token naming itself, its organization and its image, and trades it for AWS or
  Google Cloud credentials with no stored key. See
  [identity tokens](./identity-tokens).
- **Custom domains, TCP ports, dedicated outbound addresses and private
  networks,** for paid accounts. Serve a sandbox's port at your own hostname
  with automatic HTTPS (`runtime domain add`), open a public TCP port to a
  database or game server (`runtime port open`), send from an address of your
  own for allow-lists (`runtime address reserve`), and reach your sandboxes from
  your own network over WireGuard (`runtime tunnel`). See
  [networking](./networking).

- **MCP tools are renamed, a breaking change.** Every tool now carries its
  product's name, as the CLI does: `runtime_exec` is `runtime_sandbox_exec`,
  `runtime_files_read` is `runtime_sandbox_files_read`,
  `runtime_sandboxes_create` is `runtime_sandbox_create`, and images, volumes
  and snapshots are `runtime_image_*`, `runtime_volume_*` and
  `runtime_snapshot_*`. Every sandbox tool names its sandbox `id`. The old
  names are gone: a call to one fails and its error names the new one. Restart
  your agent, or run `/mcp` in Claude Code, so it lists the tools again, and
  change any permission rule or prompt that names an old tool. The whole table
  is in [MCP](./mcp#renamed-tools).
- **`runtime_sandbox_exec` takes a command as a list** as well as a string; a
  list runs without a shell, as `argv` does.
- **Extending a sandbox answers with its new end.**
  `POST /v1/sandboxes/{id}:extend`, `runtime_sandbox_manage` with `extend`
  and `runtime sandbox extend` returned the expiry from before the extension;
  they now wait for the server to confirm the new lease and return it.
- **The saving a month says what it is projected from.** When your first
  sandbox in the window is more recent than the window, the `note` of
  `GET /v1/usage/compare` and `runtime_usage_compare` says how many days the
  monthly figure is projected from, and so does `runtime compare` from
  `withruntime` 0.6.0.
- **CLI fixes, in `withruntime` 0.6.0.** `runtime sandbox logs`
  without `-f` prints what the process has written so far and returns;
  `runtime usage` prints a summary in dollars (`--json` keeps every figure); a
  sandbox's name works in every `runtime sandbox` command and `--sandbox`
  filter, not only `ssh` and `port-forward`; and `runtime mcp` exits at once
  when its client stops it.
- **`runtime compare` prices the free trial at the standard rates.** Sandboxes
  the trial ran are priced at what the same work costs on paid credit, and the
  output says how many ran on the trial, so the saving it reports is the one
  you get after the trial.
- **Large command output comes back whole in the drop-ins.** `commands.run` in
  `withruntime/e2b`, and `process.exec`, `codeRun` and `findFiles` in
  `withruntime/daytona`, return all of a command's output however large it is,
  in JavaScript and Python.
- **The status page says when a window is longer than its record.** Until the
  record covers a whole window, [withruntime.com/status](https://withruntime.com/status)
  shows that window as not yet and says how much of it the record covers, and
  `/status.json` gives it `null` with `complete: false` and `covered_hours`.

## 23 September 2026

- **Switch in one import from Daytona and Vercel Sandbox too.** Code written
  for Daytona's or Vercel Sandbox's SDK runs on Runtime after changing one
  import to `withruntime/daytona` or `withruntime/vercel`, in JavaScript and
  Python, as E2B code already does with `withruntime/e2b`.
- **See what you save.** `runtime compare --from e2b` prices the sandboxes you
  actually ran at a rival's published rates and prints the monthly saving.
  Record the provider you are leaving with `runtime switch --from <provider>`
  before your first top-up, and that top-up is matched, up to $100.
- **Works inside the agent tools you use.** A sandbox client for the OpenAI
  Agents SDK, tools for the Vercel AI SDK, LangChain, CrewAI, LlamaIndex,
  Pydantic AI, Google ADK, Mastra and the Claude Agent SDK, a Claude Code plugin,
  and ready configs for Codex, Cursor, Windsurf, VS Code and Gemini CLI. See
  [frameworks](./frameworks).
- **Remote MCP with browser sign-in.** Add Runtime's MCP address to Claude.ai,
  ChatGPT or another remote client, approve it once in your browser, and it
  works with no key to paste. Each connection is listed and revocable on your
  keys page.
- **SSH, editors and port forwarding.** `runtime sandbox ssh <id>` opens a
  shell, `runtime sandbox ssh config --install` lets VS Code and JetBrains
  connect, and `runtime sandbox port-forward <id> 5432` brings any TCP port to
  your machine, all over the API with no port open to the internet.
- **Pause answers at the freeze.** A pause returns as soon as the sandbox's
  processors stop, and compute billing ends there; its memory is saved in the
  background.
- **The SDKs wait for room.** When every sandbox slot is taken, a create waits
  for one to free, for up to two minutes, instead of failing.
- **Every sandbox command lives under `runtime sandbox`.** `runtime sandbox
run`, `runtime sandbox ssh` and `runtime sandbox port-forward`, because
  sandboxes are one product of several. The old `runtime run` says where it
  went.
- **Custom images, all the way.** Build from any Dockerfile: multi-stage,
  `COPY --from`, `ARG`, heredocs, `ADD` from a URL, `FROM scratch` and
  `.dockerignore`, with a build context of up to 100 MiB sent from a folder,
  where a rebuild uploads only what changed. Pull from private registries
  (Docker Hub, GitHub, Google, Amazon ECR and others) with credentials sealed on
  arrival and never returned. Each build of a name is its next version, tags
  such as `latest` point at versions, and a sandbox starts from `name:tag`. An
  image can run a start command and have its sandbox's create wait for a ready
  port or command. Rebuilds start from the steps an earlier build shares, four
  builds run at once on a paid account, and the build log streams. See
  [custom images](./images).
- **Metrics, events and webhooks.** Each sandbox's measured CPU and memory
  over time, with `sbx.metrics()`, `runtime sandbox metrics`, MCP, and live
  charts on the sandbox's own page in your account, where owners can also stop
  it. Lifecycle events (created, running, paused, woken, stopped, start failed)
  for sandboxes, snapshots and volumes, with `GET /v1/events`. Webhooks send
  them to your URL, signed like Stripe's, retried for about three days, with a
  delivery log and a test send; `verifyWebhook` in both SDKs checks them.
  OpenTelemetry export pushes events as logs and CPU and memory as metrics to
  any OTLP/HTTP endpoint. See [metrics and webhooks](./observability).
- **Teams.** Invite people to your account as owner, admin, developer or billing
  member; each role can do what its name says and no more, and a key can never
  do more than the member who made it. A person can belong to several accounts
  and switch between them on the website or with `runtime account switch`. See
  [teams](./teams).
- **Audit log.** Every change to members, keys, connections, limits, credit,
  network rules, secrets and durable resources is recorded with who made it,
  when and from which address, kept at least 400 days. Read it at
  [Audit log](https://withruntime.com/account/audit), with `GET /v1/audit`,
  `runtime audit`, the SDKs or MCP.
- **Paid sandboxes reach every port.** Databases, `git` over ssh, gRPC and
  programs that ignore proxy settings work with no setup, on any public host.
  Trial sandboxes stay on ports 80 and 443, and your network rules narrow every
  port.
- **Secrets sandboxes never see.** `runtime secrets set OPENAI_API_KEY --host
api.openai.com` stores a key once; sandboxes see a placeholder, and the proxy
  adds the value to HTTPS requests to the hosts you named. See
  [security](./security#secrets-sandboxes-never-see).
- **Paused sandboxes wake on request.** A command, a file or terminal call, or
  a visit to a shared port wakes a paused sandbox by itself, in about half a
  second, and the call runs. `idlePauseSeconds` now pauses a sandbox after
  that long without a request, so it costs running time only while it is used.
- **Sandboxes by name.** A name is unique in the account, and
  `Sandbox.getOrCreate(name)` returns that sandbox, woken if paused, or makes
  it.
- **Long-running sandboxes from every interface.** `persistent: true` at
  create, `sandbox.update()`, `runtime sandbox update --persistent on` or the
  API keeps a paid sandbox running while credit lasts, and `keepAlive` extends
  a lease from your own process.
- **50 free hours and 100 sandboxes at once.** The free trial is now 50 hours
  (now {{trial-hours}}), up from 20, still with no card and eight sandboxes running at once. A paid
  account starts with room for 100 sandboxes, 200 vCPUs and 400 GiB of memory
  at once, and more on request. Accounts that signed up before get the 50 hours
  too.
- **Paid accounts run 20 sandboxes at once.** A paid account starts with room
  for 20 sandboxes, 64 vCPUs and 128 GiB of memory at once (now
  {{paid-sandboxes}}, {{account-vcpus}} and {{account-memory}}), and more on request.
- **The free trial runs eight sandboxes at once.** Up from three, with the same
  20 free hours (now {{trial-hours}}) and still no card.
- **Forks and snapshots for everyone.** Copy a running sandbox with its memory
  and processes, and choose whether the copies use the trial or paid credit.
- **Code written for E2B runs on Runtime.** Change `from "e2b"` to
  `from "withruntime/e2b"` (Python `withruntime.e2b`) in SDK 0.4.0, and it runs.
- **SDKs work behind proxies and inside Cloudflare Workers.** Both SDKs honour
  `HTTPS_PROXY` and `NO_PROXY`, and the JavaScript SDK runs in a Worker with
  `nodejs_compat`.
- **Keys for CI from the terminal.** `runtime keys create` gets an
  owner-approved key and prints it once, ready to pipe into a secret store.
- **First commands in a fresh sandbox are faster.** Start templates now come
  with Node, npm, Python, pip, Bun, uv and git already warm, so a first `node`
  takes 84 ms instead of 1,284 ms.
- **A public status page.** [withruntime.com/status](https://withruntime.com/status)
  checks the API from outside every two minutes and starts a real sandbox every
  ten.
- **Storage prices for snapshots, images and volumes.** Snapshots and images
  cost $0.08 per GB a month and volumes about $0.11 per GiB a month, and the
  trial keeps three images and 10 GiB of volumes free for good.
- **Read your own limits.** `runtime limits` and `runtime.limits.get()` show
  whether a key is read-only and how much of its daily limit is left.
- **Side-by-side guides.** Comparisons with E2B, Daytona, Vercel, Modal,
  Cloudflare and Fly.io, each with the cost of the same job.

## 22 September 2026

- **Custom images.** Build an image from a package list, a public image or a
  Dockerfile, and start every sandbox from it.
- **Volumes.** Persistent disks that outlive sandboxes, attached read-write to
  one or read-only to many.
- **Previews.** Give any port in a sandbox an HTTPS address at
  `runtimehost.com`, private with a token unless you make it public.
- **A desktop in any sandbox.** Start a Linux desktop and drive it with clicks,
  keys and screenshots, or watch it live.
- **Code interpreter.** A notebook-style Python or JavaScript session in a
  sandbox, with charts returned as images.
- **Network rules per sandbox.** Allow or deny hosts, turn the internet off, and
  open `host:port` pairs such as a database on a paid account.
- **Interactive terminals.** `runtime sandbox shell` opens a real terminal in a
  sandbox, and the API serves one over WebSocket.
- **Read-only keys and daily spending limits.** An owner can give an agent a
  key that changes nothing, or cap what it may spend in any 24 hours.
- **Buy credit by card.** Add any amount from $10 to $10,000, with no
  subscription.
- **Referrals.** Refer a company and you both get credit equal to its first
  top-up, up to $500 each.
- **A 20-hour free trial.** Every new account gets 20 sandbox hours (now
  {{trial-hours}}) with no card.
- **One line connects your agent.** `claude mcp add --scope user runtime -- npx -y withruntime mcp`
  (or the same for Codex and Cursor) is the whole setup; the agent asks for one
  browser approval.
- **`runtime run`.** One command creates a sandbox, runs your command, prints
  its output and stops it, connecting the machine on first use.
- **In the official MCP registry.** Runtime Cloud is listed for any MCP client
  to find.
- **The `withruntime` package.** Both SDKs publish as `withruntime` on npm and
  PyPI, and the old names still install it.
- **API 0.2.0.** One API for every product, over HTTP/2, with a public OpenAPI
  document.
- **A hundred commands at once.** One key can have 128 requests in flight, so an
  agent can fan out without refusals.
- **Idle sandboxes pause themselves.** A sandbox left on the default lease and
  never used pauses after five minutes (now any sandbox after a
  minute with nothing happening in it), so it stops paying the running rate.
- **Retries you never see.** A brief outage answers 503 with `Retry-After`, and
  both SDKs retry it with the same idempotency key.
- **Ask support anywhere.** Ask from the dashboard, with `runtime support`, or
  at support@withruntime.com.

## 21 September 2026

- **Public signup opens.** Anyone can sign up and start a sandbox on the free
  trial.

## 20 September 2026

- **Connect an agent from the browser.** An agent shows you a link and a code,
  and you approve it once.
- **Keys for every product.** An API key works across every Runtime Cloud
  product and lasts until you revoke it.
- **withruntime.com.** Runtime Cloud moves to one address.

## 19 September 2026

- **Wake in about a third of a second.** A paused sandbox comes back with its
  memory and processes in about a third of a second.

## 18 September 2026

- **Pause keeps memory.** A paused sandbox saves its running memory and wakes
  with its processes still running.
- **Pay for the CPU you use.** CPU is charged only while it is busy, and memory
  while the sandbox runs.
