# Changelog

What shipped in Runtime Cloud, newest first.

Runtime ships every day. Each entry is something you can use or see; the
guides hold the current terms, and [pricing](./pricing) holds the current rates.
Each day also has a page of its own at
[withruntime.com/changelog](https://withruntime.com/changelog), and every entry
arrives in the [RSS feed](https://withruntime.com/changelog/feed.xml).

## 5 October 2026

- **A hundred sandboxes at once from the first top-up, and time limits up to
  24 hours.** A paid account runs {{paid-sandboxes}} sandboxes at once as
  soon as its first top-up clears, where a new one ran 50 for its first week;
  only a disputed payment, a suspension or an abuse report holds an account to
  {{restricted-sandboxes}}. Paused and stopped sandboxes no longer count
  toward it, and an account keeps up to 1,000 in all. A time limit goes up to
  24 hours, where it stopped at one, and a sandbox it stops reads `stopReason`
  `time_limit` where it read `lease_expired`, in the API, events, webhooks and
  OpenTelemetry export: code that compares with `lease_expired` should compare
  with both. A sandbox's disk is at most {{max-disk}}, and a larger `diskMiB`
  is refused at once, naming the limit. See
  [how many at once](./pricing#how-many-at-once).
- **Scheduled jobs run on the free trial, and an account holds
  {{paid-jobs}} of them.** A job's runs spend the trial's hours first, then
  credit, as a sandbox does; a run the trial cannot take, on an account
  without credit, waits with `blockedReason` `credits`. An account holds up
  to {{paid-jobs}} jobs and {{paid-secrets}} secrets for jobs, where it held
  50 and 200. Credit, bought or given, now opens every paid feature but three:
  a kept top-up is needed only for ports beyond 80 and 443, public previews,
  and private networks and Tailscale. See [what a job costs](./jobs#what-it-costs).
- **Downloads as fast as the server's link, and TCP ports five times
  faster.** A sandbox's downloads are no longer capped: each sandbox shares
  its server's link, and when several are busy a paid account gets four times
  a trial's share. Uploads stay limited, more strictly on the trial
  ({{trial-upload}}); paid uploads are {{paid-upload}},
  {{paid-upload-sustained}} after {{paid-upload-burst}},
  {{paid-daily-transfer}} a day. A public TCP port now moves traffic at those
  paid figures, where it was 100 Mbit/s, 20 Mbit/s after 2 GiB and 50 GiB a
  day. See [sandbox environment](./sandbox-environment#the-network).
- **A snapshot of a running sandbox, in one call, at any size.** `POST
:snapshot` and `runtime_snapshot` (action `create`) take a running sandbox:
  they pause it, capture it and wake it, as a fork does, and answer once the
  capture is over. A sandbox with volumes is still refused. A copy of a disk
  snapshot takes the vCPUs, memory and disk you ask for, with a disk at least
  the saved one; a memory snapshot's copy is still the snapshot's size, and
  asking for another size answers `400`. Every sandbox can now pause, fork and
  be snapshotted, and every stop keeps the sandbox's files. See
  [snapshots and forks](./javascript#snapshots-and-forks).
- **What a sandbox serves is billed as outbound traffic, and persistence
  costs nothing extra.** For sandboxes created from today, what a sandbox
  sends back through a preview, a custom domain or a TCP port counts toward
  the account's {{outbound-allowance}} a month free, then {{outbound-rate}}
  per GB, like what it sends over its own connections; what visitors send in
  stays free. While a sandbox made from today runs, its disk past the first
  {{running-disk-included}} is billed at {{paused-storage-rate}} per decimal
  GB per 30-day month, as a paused disk is; a disk of
  {{running-disk-included}} or less never pays it. A `persistent` sandbox no
  longer pays {{volume-month}} per GiB for a reserved disk all the time: its
  disk is billed as any sandbox's, and `persistent` means only "keep it
  running". See [pricing](./pricing).

## 4 October 2026

- **Paused sandboxes, kept disks and snapshots are kept while you have
  credit.** A paused sandbox, a stopped one's disk and a snapshot stay for as
  long as the account holds credit, with no 30-day or 7-day end, unless you set
  days with `:retention` or a snapshot's `retentionDays`. When credit runs out
  they are kept seven more days, with a notice first, and a top-up keeps them
  again. A sandbox paused on the trial is kept the same way once the account
  holds credit, and its storage is billed from the end of its seven free days.
  See [paused storage](./pricing#paused-storage).
- **The trial's hours, then credit, with nothing to choose.** A sandbox runs
  on the free trial's hours first and on prepaid credit after, automatically:
  at create, when a paused sandbox wakes, and while one runs, so a running
  trial sandbox carries on on credit instead of pausing when the hours run
  out. A request's `funding` is accepted and ignored, and code that sets it
  keeps working. Once an account holds credit, its sandboxes have paid limits
  and still spend the trial's hours first, and a trial sandbox that turns paid
  while it runs gets a paid sandbox's disk share at once and, if the trial
  had slowed it, its full cores back. See [the trial](./trial#after-the-trial).
- **Public previews follow a kept purchase.** A preview can be public once
  the account has bought credit; credit given alone does not open one. While
  an account is blocked, or every purchase it made is refunded in full, its
  public previews need the token like private ones, and they open to anyone
  again once it pays. See [security](./security).
- **A stop keeps the disk; only a delete removes it.** A stopped sandbox keeps
  its files for {{paused-storage-rate}} per decimal GB per 30-day month, reads
  `diskKept: true` and starts again from them with `:restart`, its memory gone;
  deleting it removes them. `onLeaseEnd: "delete"` deletes a sandbox and its
  files when its time limit ends. A stop from a client released before today,
  or from raw HTTP without `x-runtime-client: http/2026-10-04`, keeps the disk
  free for three days, with one notice, and then deletes it. The console shows
  Restart and Delete on a stopped sandbox. See
  [paused storage](./pricing#paused-storage).
- **Ending a sandbox never waits for room.** A delete, stop or pause never
  fails for lack of room, even on a full server.

## 3 October 2026

- **A sandbox runs while it works.** There is no lease to manage any more: a
  sandbox has no time limit unless you set one, runs for as long as it is busy
  and pauses itself when idle, until you stop it or credit runs out. Nothing
  needs extending, and code that extends, sets `timeoutSeconds` or calls
  `keepAlive` keeps working: a time limit you set is still kept. `endsAt` says
  when a sandbox will stop or pause by itself, and is `null` when it never
  will. The E2B, Daytona, Vercel, Blaxel, Modal and Runloop adapters do the
  same when your code sets no timeout. See [the API](./api#sandboxes).
- **Runtime for Startups.** A venture-backed startup building with AI agents
  can apply at [withruntime.com/startups](https://withruntime.com/startups)
  for {{startup-credit}} of credit, added over {{startup-months}} months:
  over {{startup-busy-hours}} hours of a 2 vCPU, 4 GiB sandbox. An accepted
  startup's account counts as paid from the day it is accepted. See
  [pricing](./pricing).
- **Two error codes are renamed.** A command whose timeout outlasts the
  sandbox's time limit or its funded time is refused with 409
  `time_limit_too_short`, and `details.secondsLeft` says how long is left:
  `time_limit_too_short` replaces `lease_too_short`. A host that is busy
  answers 503 `busy`, safe to retry with the same key: `busy` replaces
  `fence_conflict`. Code that matched the old names should match the new
  ones. See [errors](./api#responses-and-errors).
- **More requests at once for accounts with many sandboxes.** An organization
  may have 192 requests in flight, and two more for each sandbox it holds that
  is not stopped, up to 1,024, so every sandbox can stream a command and a
  watch at once. See [limits](./api#limits).

## 2 October 2026

- **Export settled usage for a chosen period.** `runtime usage export` and
  `/v1/usage/export` cover every visible product and resource with exact
  charges in the server's CSV. The CLI follows every page; API callers can
  follow the returned cursor. Pending holds stay separate.
  See [the API](./api#export-settled-usage).
- **Archive bytes and root-owned folders.** Native SDK archive helpers return
  or unpack tar bytes, support relative exclusions and explicitly requested
  root access through passwordless guest sudo. JavaScript request cancellation reaches
  transfers and local extraction. See [files](./api#files).
- **Current MCP groups give the replacement call.** Retired aliases fail with
  the canonical group and action before doing work. ChatGPT connections get
  scoped preview links without a persistent gateway credential. See [MCP](./mcp).
- **A browser for Playwright, Puppeteer and browser-use.** `sbx.browser.start()`
  runs Chromium in a sandbox and returns a private `cdpUrl` that
  `connectOverCDP` and `puppeteer.connect` take as it is. The browser is paid
  for as its sandbox and follows the sandbox's network rules, and the desktop
  opens pages in Chromium instead of Firefox. See
  [a browser over CDP](./javascript#a-browser-over-cdp).
- **More E2B, Daytona and Vercel Sandbox code runs unchanged.** The E2B adapter
  runs commands, terminals and files as another `user`, keeps a sandbox for up
  to 24 hours, filters, sorts and resumes `Sandbox.list`, returns a command's
  whole output and works with e2b 2.52.0. The Daytona adapter opens PTY
  sessions you can attach to again, drives the desktop through `computerUse`,
  runs as a `user` from your image, keeps a sandbox past an hour and filters
  `list`. The Vercel adapter creates users and groups, keeps a sandbox past an
  hour and pages `Sandbox.list` with cursors. See [migrating](./migrate).

## 1 October 2026

- **Build images and manage volumes in the console.** Build from a Dockerfile,
  a registry image or a package recipe, start a sandbox from an image version,
  manage tags, and create, back up or restore volumes. Spending and deletion
  ask first. See [images](./images) and [storage](./storage).
- **See API calls, CPU waiting and memory stalls in the console.** Usage &
  billing shows the account's API calls and errors by operation and exports
  settled usage as a CSV file; a sandbox's Activity tab charts CPU wait and
  memory stalls. See [observability](./observability#account-api-calls).

## 30 September 2026

- **Environment variables for a whole sandbox.** Pass `env` at create, or
  change it later with an update, and every command, background process,
  terminal, SSH session and image start command gets those variables. Values
  are stored encrypted and never shown back. See [the API](./api).
- **Delete a sandbox for good.** `DELETE /v1/sandboxes/{id}`, `sbx.delete()`
  and `runtime sandbox rm` stop it, remove its disk and paused memory, revoke
  its previews and ports, and free its name. Usage and audit history stay.
- **Switch a sandbox to a new image and keep your work.** Switching keeps the
  sandbox's id, name, `/workspace`, volumes, environment, previews and ports;
  processes restart. See [images](./images).
- **Folders over plain HTTP.** Upload or download a whole folder of any size
  as a tar stream. The SDKs verify a downloaded archive before merging its
  folder contents; ordinary file downloads publish only complete files.
- **File changes to your webhooks.** A watch started with `webhook: true`
  sends `sandbox.files.changed` events, signed and retried like every webhook,
  without keeping the sandbox awake. See [observability](./observability).
- **Choose which sites may embed a preview.** `embedOrigins` lists them, and
  a private link's token is refused in any other site's frame.
- **Join your Tailscale network.** A paid sandbox can join your tailnet with
  an auth key stored as a secret. See [networking](./networking#your-tailscale-network).
- **Trial sandboxes keep going while they work.** A trial sandbox that is still
  busy when its lease ends gets its `timeoutSeconds` again, until the trial
  hours run out. See [the trial](./trial).

## 29 September 2026

- **Global installs run by name, and pnpm and yarn are ready.** In a new
  sandbox, `npm install -g` failed without `sudo`, and with it, or with
  `bun add -g`, the command installed but was not found. Now all three put
  their commands on `PATH`, so `npm install -g @anthropic-ai/claude-code`
  gives you `claude` straight away, and `pnpm` and `yarn` work through
  Corepack. See [the sandbox environment](./sandbox-environment#who-you-are).
- **Private previews work inside your own site's iframe.** Set an iframe's
  `src` to a preview's `urlWithToken`: the link keeps its token for your site
  alone, a paused sandbox shows its waking page in the frame and reloads by
  itself, and a public preview skips its warning page when it is framed. See
  [previews](./javascript).
- **Disk-only snapshots.** `mode: "disk"` on a snapshot keeps only the root
  filesystem, and a sandbox created from it boots fresh with your files and no
  saved processes. Memory snapshots stay the default. See [the API](./api).
- **Wakes read memory from memory.** A paused sandbox's memory image stays in
  the server's memory until its wake, so waking no longer reads it back from
  disk first.
- **Faster disks, shared fairly.** A sandbox's disk no longer has a fixed
  speed or a burst to run out. It shares its server's drives with the
  sandboxes beside it, in proportion: at least about {{disk-floor}} each way,
  and up to about {{disk-up-to}} when its neighbours are quiet. A busy
  neighbour slows your writes a little rather than stalling them, and a pause
  stays quick on a busy server. See
  [the sandbox environment](./sandbox-environment#disk-cpu-and-memory).

## 28 September 2026

- **A console that reports your day.** Home, Sandboxes, Images, Volumes, Usage
  & billing and Agents & API keys each open on what needs you, then today in a
  line, two charts and the list. Sandboxes describes today's runs as a whole,
  hour by hour against yesterday, by who started them and by image, and its
  list opens on what runs now, with search over every day. A sandbox's page
  says how it ended and why, draws its life from start to stop and copies what
  happened for your agent. Usage & billing shows spend by who started it and
  each key's use against its daily limit. Agents & API keys, in Settings, tells
  agents connected from a tool apart from API keys. Today is counted in your
  browser's time zone.
- **Each sandbox's commands, on its page.** A sandbox's page lists the commands
  run in it, `pytest · exit 1 · 28 s`, with failures in red and a running one
  as running: on its Activity tab while it runs, and in its life once it ends.
  Runtime keeps each command's program name, exit code and duration for 14
  days, never its arguments. See [observability](./observability#commands).
- **Scheduled jobs.** Run a command in a fresh sandbox once at a time you
  choose or on a cron schedule in your timezone, with each run's exit code and
  output kept, retries when you ask for them, and pause, resume and cancel:
  `runtime job create nightly --cron "0 3 * * *" -- python3 report.py`,
  `runtime.jobs` in the SDKs, or the `runtime_job` MCP tool. Runs are paid
  sandboxes at the sandbox rates. See [scheduled jobs](./jobs).
- **Secrets for jobs.** `runtime secrets set NAME --jobs` keeps a copy a job
  puts into its run's environment (`--secret NAME` on `runtime job create`);
  with `--host` as well, one command stores it for sandboxes and jobs alike.
  The jobs copy can be rotated and read back; the sandboxes' copy still never
  can.
- **The region is now `us-east`.** It was `us-east-vin`, the name of one
  building; a region is named for its place, so more data centres nearby can
  join it. Every sandbox, snapshot, volume, image and job moved with it and
  keeps running. Asking for `us-east-vin` now answers `invalid_region` and
  names `us-east`, and an identity token's `region` claim reads `us-east`, so
  update a trust policy that names the old one. `withruntime` 0.8.4 sends
  `us-east` as a job's default region; update with `npm i withruntime@latest`
  or `pip install -U withruntime`. A job that names a region Runtime does not
  have is now refused when you create it, rather than waiting at every run.
- **A sandbox from a browser.** A sandbox session is a short-lived token your
  own web page uses to run commands, read and write files and reach previews in
  one sandbox, with no API key and no proxy of your own. It cannot stop, extend
  or change the sandbox, lasts {{session-default}} unless you ask for up to
  {{session-max}}, can be revoked at once, and is answered only from the pages
  you list. `sbx.sessions.create({ origins })` makes one and
  `Sandbox.fromSession({ token, sandboxId })` uses it, from `withruntime`
  0.8.3; Blaxel's `sandbox.sessions` and `fromSession` now work in the
  drop-in. See [JavaScript](./javascript) and [Python](./python).
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
- **Persistence can be turned off, and a stopped persistent sandbox deleted.**
  `runtime sandbox update <id> --persistent off`, `update({ persistent: false })`
  or `:update` with `{"persistent": false}` now works as the guides said: a
  running sandbox stops paying for its disk at once, and a stopped one has its
  disk deleted and its name freed. A stopped persistent sandbox is listed by
  `runtime ls`, `runtime sandbox ls` and `GET /v1/sandboxes` with the live
  ones, since its disk is still kept and billed.
- **Agents can list images, volumes, volume backups and snapshots.** Over
  MCP, `runtime_image`, `runtime_volume`, `runtime_volume_backup` and
  `runtime_snapshot` take the action `list`, with the filters and pages of
  `GET /v1/images`, `/v1/volumes`, `/v1/volume-backups` and `/v1/snapshots`:
  `state`, `limit`, `cursor` from the last page's `nextCursor`, and `name`,
  or `volumeId` for backups and `name` and `sandboxId` for snapshots. Their
  `get` now reads one by `id`. See [MCP](./mcp).

## 27 September 2026

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

## 26 September 2026

- **Single sign-on through OIDC.** Okta, Entra ID and Google Workspace
  connections by OIDC can be saved and used, as SAML ones could. See
  [single sign-on](./single-sign-on).
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
- **Your account opens straight away.** A new account now lands in the full
  console. Home shows the setup prompt for your coding agent until the agent
  connects, and keys, billing and settings are in the menu from the first
  visit. Hide the prompt if you would rather start on your own.
- **A smaller MCP tool list.** An agent connected to Runtime's MCP server now
  reads 45 tools instead of 80, in 61,754 characters instead of 80,808, before
  its first call. A product's rarer verbs share one tool that takes an
  `action`: `runtime_volume_get` is now `runtime_volume` with
  `"action": "get"`. The first-session tools keep their names. The old names
  answered until the next release and said what replaced them; they were
  retired on 30 September 2026. See [renamed tools](./mcp#renamed-tools).

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
  paid use has settled, whichever comes first, then 100. A paid account now
  runs {{paid-sandboxes}} from its first top-up. See
  [pricing](./pricing#how-many-at-once).
- **Rules on a secret.** On a paid account, a secret can name the methods and
  paths it goes to, such as `GET /repos/acme/*`; a request no rule allows
  goes out without it. See [security](./security#secrets-sandboxes-never-see).
- **Your own upstream proxy.** A paid account can send its sandboxes' traffic,
  or only the hosts it names, through its own HTTP or HTTPS proxy, with one of
  its secrets as the proxy's password. Runtime's own checks still come first,
  and a proxy that fails refuses the connection rather than going direct. See
  [networking](./networking#your-own-upstream-proxy).
- **Custom images get `sudo`, `adduser` and `useradd`.** Every image Runtime
  builds, from a public image too, gives the sandbox user passwordless
  `sudo`, and the base image now carries `adduser` and `useradd`. A command in
  a sandbox from an image starts in the image's last `WORKDIR` (inside
  `/workspace`). Build logs number only the steps they log.
- **Close your account yourself.** An owner closes the account at
  [Close account](https://withruntime.com/account/close) or with
  `POST /v1/account:close`; `runtime account close` arrived in `withruntime` 0.7.0. See [teams](./teams).
- **Usage per run.** `GET /v1/usage` now gives each resource's name, start
  time, size and billed running time. In `withruntime` 0.7.0,
  `runtime usage --csv` exports one row per resource to the microdollar.

## 24 September 2026

- **Disk bursts.** A sandbox now writes at about 250 MB/s for up to 30 seconds
  before settling at about 40 MB/s, so installs, builds and test runs finish
  sooner. In a measurement a sandbox wrote at 200 MB/s instead of 38 (now up
  to about {{disk-up-to}}, with no burst to run out). See
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
- **Terminals.** An organization may hold 64 terminals open, 12 in one sandbox
  (it was 8).
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
