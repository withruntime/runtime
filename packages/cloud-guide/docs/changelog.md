# Changelog

What shipped in Runtime Cloud, newest first.

Runtime ships every day. Each entry is something you can use or see; the
guides hold the current terms, and [pricing](./pricing) holds the current rates.
Each day, and each entry, also has a page of its own at
[withruntime.com/changelog](https://withruntime.com/changelog), and every entry
arrives in the [RSS feed](https://withruntime.com/changelog/feed.xml).

## 25 October 2026

- **Faster fork starts on a busy server.** When a fork's copy starts on a
  server other than its source's, its snapshot is now sent immediately, beside
  any copies Runtime makes in the background. Previously such a start could
  wait several minutes in `starting` behind those copies.
- **Snapshots and forks of long-paused sandboxes.**
  `POST /v1/sandboxes/{id}:snapshot` and `POST /v1/sandboxes/{id}:fork` no
  longer return 409 `snapshot_unsupported` for a sandbox paused long enough for
  its disk to move to cold storage. The sandbox is restored from its stored copy
  first (up to 120 s) and is paused again afterward, including when the request
  fails. A paused sandbox's disk now moves to cold storage one hour after its
  last use, and only once its stored copy is verified.
- **A sandbox can run as root by default.** Create it with `user: "root"`
  (`--user root` in the CLI, `user=` in Python, `.user("root")` in Java,
  `User: "root"` in Go), or set it later with `:update`, and its commands,
  background processes and terminals run as root, through its passwordless
  `sudo`, with no `sudo` in front of each one. A call can still name
  `user: "sandbox"`. Forks and copies of its snapshots run as root too; files
  written through the files API and SSH logins stay the sandbox user's. A
  sandbox's details include its `user`. See
  [who you are](./sandbox-environment#who-you-are).
- **A fork's copies start on another server when the source's is full.**
  A fork used to start its copies only on its source's server, and answered
  `no_capacity` when that server had no room, even after pausing the source
  and taking its snapshot. Now its snapshot is copied to a server with room
  and the copies start there, as a create from a kept snapshot already did.
  And a time limit (`timeoutSeconds`) set on a sandbox that is still starting
  or waking is taken at once, rather than answered `busy`.
- **Fork copies on another server no longer wait minutes for the snapshot.**
  A fork copy that starts on a server other than its source's could stay
  `starting` for several minutes when that server was already receiving other
  snapshot copies, or when the source sandbox ran on one of the newest
  servers. The copy now starts as soon as the receiving server can take the
  snapshot, and snapshots on every server can be copied.
- **Secrets list in pages.** `runtime_secrets` action `list` takes `limit`
  (1 to 100) and `after`, as its MCP schema said it did; so do
  `GET /v1/egress-secrets` (its answer's `next` is the next page's `after`),
  every SDK's `secrets.list` and `runtime secrets ls --limit --after`. The
  `runtime_secrets` tool now names which action takes each field, and a field
  sent to the wrong action says which one takes it.
- **Forks start on another server when the source server is full.**
  Previously, a fork could start only on the source sandbox's server and
  returned `no_capacity` when that server was full, even after pausing the
  source and taking its snapshot. The snapshot is now copied to a server with
  available capacity and the forks start there, the same way a sandbox is
  created from a saved snapshot. Setting `timeoutSeconds` on a sandbox that is
  starting or waking now takes effect immediately instead of returning `busy`.
- **Pagination for secrets.** The `list` action of the `runtime_secrets` MCP
  tool now supports pagination with `limit` (1 to 100) and `after`, as its
  schema documents. Pagination is also supported by `GET /v1/egress-secrets`
  (pass the response's `next` value as `after` to get the next page),
  `secrets.list` in every SDK, and `runtime secrets ls --limit --after`. The
  `runtime_secrets` schema now states which action accepts each field, and a
  field sent to the wrong action returns an error that names the correct one.

## 24 October 2026

- **Internet off with an allow list reaches the list.** A sandbox created or
  set with `network: {internet: false, allow: [...]}` was refused every
  connection (`X-Runtime-Egress: internet-off`), though its rules showed the
  list. Internet off with an `allow` list is now allow-list only: the sandbox
  reaches the listed destinations and nothing else, and its rules are stored
  and shown as `internet: true` with that list, on create and on
  `network.set` alike, in the API, every SDK, the CLI, MCP and the console.
  Internet off with no `allow` list still reaches nothing. See
  [the network](./sandbox-environment#the-network).
- **Starts from a snapshot taken on another server are up to 1.8 s faster.**
  A sandbox started from a snapshot taken on another server trusts that
  server's outbound certificate in about 4 ms. In an image with certificate
  hooks (Java's keystore, say) it ran Debian's whole `update-ca-certificates`
  and took 0.7 to 1.8 s of the start. Snapshots taken from now on start this
  way; an older one does once it is taken again.
- **A wake its server has no disk for is answered at once.** A paused
  sandbox whose server had no disk left for it was asked again for about 20
  seconds before it was refused `no_capacity` ("its host has no disk left").
  Nothing on that server was going to give the disk back, so the answer now
  comes at once. A wake short of CPU or memory still waits for room as
  before.
- **A fork short of room refuses before it pauses its source.** A fork on a
  server with no room left for memory images could give up after a fixed
  minute while its source's image was still being written, and leave the
  source unable to wake. A fork now books the room its source's wake needs
  before it pauses anything: a server without it answers `503 no_capacity`
  at once, naming the room, with the source still running. And a fork waits
  while its source's image is still being written.
- **A command's record says how it ended.** A command whose answer was lost
  on the way back (its connection cut, or its sandbox stopped or paused under
  it) is kept as "its answer was lost" (outcome `unknown`), where it left no
  record. One still running when its sandbox is stopped or deleted shows
  `ended by the sandbox's stop` (or `delete`), not running for ever. A
  command that timed out keeps the time limit it ran under. And `bwrap`
  (bubblewrap), which Codex runs its commands under, is in the default image
  from its next build. See [commands and processes](./api#commands-and-processes).
- **Volume backups go first, and one that can't start says so.** A volume
  backup's copy off its server goes ahead of Runtime's own copies there,
  never behind one, and `copyStartedAt` says when it began. A backup whose
  copy hasn't begun 15 minutes after you asked fails with `errorCode`
  `backup_stalled` rather than staying `pending`, unless other backups on its
  server are moving up the line. The volume is unchanged; back it up again.
  See [volume backups](./storage#limits-and-price).
- **An image build is never left queued for good.** A build, a snapshot or a
  volume placed on a server that had just joined could wait with nothing
  working on it: a build `queued`, a snapshot `capturing`. Work no server
  has taken up within six minutes now starts that server's storage work, and
  goes on.
- **Pauses, wakes, restarts and stops are in the audit log.** Each pause,
  wake, restart and stop of a sandbox is an audit log entry
  (`resource.paused`, `resource.woken`, `resource.restarted`,
  `resource.stopped`) with who asked; one Runtime did itself says why: it
  sat idle, it reached its time limit, credit ran out or a spending limit was
  hit. A volume inside the free 10 GiB, and a job on an account without
  credit, now read `funding: trial`, not `paid`. See
  [the audit log](./teams#audit-log).
- **Support chat asks you to sign in.** The Help chat on withruntime.com is
  for signed-in accounts: signed out, it asks you to sign in and brings you
  back to the page, and `POST /api/support/chat` answers `401`. Without an
  account, write to support@withruntime.com. `runtime_support`,
  `npx withruntime support` and **Support** in the console are unchanged.
  See [get support](./feedback-and-support#get-support).
- **A sandbox's page in the console loads again.** A sandbox's page could
  fail to load: the server and the browser wrote its chart's and events'
  dates differently (`Sep 23 at 10:30` against `Sep 23, 10:30`), and the
  browser threw the page away. Both now write them the same way.

<!-- launch: containers -->

- **Containers answer every key that reaches their sandboxes.** A key that
  isn't account-wide was refused `403` on `/v1/containers`. A key now
  reaches the containers a sandbox of its would reach: a compartment's key
  its compartment's, a key another key made its own, and an account-wide key
  every one. Another's container answers `not_found`. See
  [containers](./containers).

<!-- /launch: containers -->

<!-- launch: actions -->

- **JavaScript actions get every input on Runtime's runners.** With the
  runner's cache on, an input with a dash in its name (`github-token`,
  `node-version`, `cache-dependency-path`) never reached a JavaScript action,
  so `actions/github-script` failed "Input required and not supplied". Every
  input now arrives. See [GitHub Actions](./actions).

<!-- /launch: actions -->

- **Volume backups on your own schedule.** A volume can be backed up every N
  minutes (15 or more) or on a cron in UTC instead of daily, and keep its
  backups by counts: the last N, and the newest in each of the newest N hours,
  days, weeks, months and years. The newest ready backup is always kept.
  Set it with `schedule` and `keep` on the backup policy, in every SDK, the
  console, MCP, `/v1/volumes/{id}:backup-policy` and the CLI:
  `runtime volumes backup-policy <id> --every 60 --keep hourly=24,daily=7`.
  `schedule: null` goes back to daily, and `daily` and `retentionDays` work
  as before. See [volume backups](./storage#volume-backups).

<!-- launch: apps -->

- **An App's new version can go live in stages.** Set
  `releaseStages: "staged"` on an App and each new version starts on one
  copy beside the live version's, then about 10%, 50% and all of its copies,
  each stage running `releaseSoakSeconds` (60 to 3600, 300 by default) and
  judged on its visitors' errors and speed before the next. A stage that does
  worse goes back: its copies finish their requests and stop, then the deploy
  fails with `deploy_stage_failed` and the numbers, and the live version
  never stops serving. In the API, every SDK, the CLI
  (`--release staged --soak 300`), MCP and the console's App settings;
  `stagedRelease` on an App follows each stage. See
  [staged releases](./api#staged-releases).

<!-- /launch: apps -->

- **Sandboxes start from your larger images with no disk to name.** A sandbox
  created from an image of yours larger than the default 4 GiB disk, with no
  `diskMiB`, was refused `disk_too_small`. An image of up to 8 GiB now gets
  an 8 GiB disk, within the {{running-disk-included}} a running sandbox's disk
  includes, and starts from the image's started copy of that size. A larger
  image is still refused, now naming the `diskMiB` to ask for; a `diskMiB` you
  name is kept. See [images](./images).

<!-- launch: agents -->

- **Webhook triggers start and join sessions.** A webhook trigger's calls now
  reach your agent: `POST /v1/agents/triggers/{id}/calls` with the trigger's
  secret as a Bearer token, never an API key, and a body of
  `{text, key?, labels?}`, any JSON or plain text. A call with an open
  session's key joins it; the answer says `201 started`, `200 joined`,
  `200 noted` or `202 held`, and `Idempotency-Key` makes a retry the same
  call. Each trigger has rules (`priority`, `maxStartsPerHour`, `onEnded`,
  `notify`, and a webhook's `key`, such as `"{alert.id}"`), set in place with
  `PATCH /v1/agents/triggers/{id}`. A call no session can take is held, never
  dropped: whoever added the trigger hears of it by email or the
  `agent.call.held` webhook event, and starts or dismisses it with
  `runtime agents triggers held`. In every SDK, the CLI and MCP. See
  [triggers](./agents#triggers).
- **An account holds up to 100 agent triggers.** A trigger past the
  account's 100 is refused `quota_exceeded`; remove one you no longer need
  first. See [limits](./limits#what-an-account-holds-and-runs).

- **Agents ask with options, into one inbox.** An agent's `ask` takes a
  question, why, options, the one it recommends, a step and an expiry.
  Asks of one agent's sessions sharing a memory, with the same step are one row, and one
  answer wakes every session asking; an ask closes by itself when its sessions end,
  when it is withdrawn, or at its expiry, taking its recommended option.
  Answer them in the console's Agents › Asks, with `GET /v1/agents/asks`,
  every SDK's `agents.asks`, `runtime agents asks` and `answer`, or the MCP
  tools. See [asks and the inbox](./agents#asks-and-the-inbox).

<!-- /launch: agents -->

- **Upload links take the 5 GiB they say.** An upload link (`files:link` with
  `method: "PUT"`) refused a body over 64 MB as too large; it now takes up to
  its `maxBytes`, 5 GiB at most, in one request, streamed into the sandbox,
  with nothing to split. A sandbox can open a file link too, to download or
  upload with no key. See [file links](./api#file-links).
- **The usage export says how far it is final, in every SDK and the CLI.**
  `runtime usage export` ends by saying on stderr how far the range is final:
  no more charges will settle before that time. The Python, Go, Ruby and Java
  SDKs gain the export (`usage_export`, `UsageExport`, `usageExport`), with
  `finalThrough` on each page and `final` on each row. See
  [export settled usage](./api#export-settled-usage).
- **E2B's client works in the drop-in.** `new E2B({ apiKey }).Sandbox` in
  JavaScript, and now `E2B(api_key=...).Sandbox` in Python, create and connect
  with the client's key. The client's `Template`, `Volume` and `Secret` refuse
  before anything happens, naming what to use instead: a Runtime image, Runtime
  volumes or a Runtime secret. See [migrating](./migrate).

<!-- launch: ci -->

- **Run a check again from code.** `POST /v1/ci/checks/{id}:rerun`,
  `runtime ci rerun <checkId>`, the MCP tool's `check_rerun` and
  `ci.checks.rerun` in every SDK run a check again as GitHub's Re-run does:
  a new check of the same commit, and for a pull request, of its head as it
  would land now. The same keys may as cancel. See
  [read checks, jobs and logs](./ci#read-checks-jobs-and-logs).
- **A build step keyed by what it compiles.** A step that only compiles (a
  compiler, its lints, its doc tests) says `compiles: true`, and is keyed by
  what compiling reads: Rust's sources and manifests, its path dependencies
  and what it includes, never the scripts its tests import. A change to those
  scripts no longer builds it again. See [passed before](./ci#passed-before).
- **A check taken over finishes on its own result.** A check whose runner
  was replaced while it ran could fail "push again to check it whole" when
  its new plan reached files no ended job had run. The new runner now adds
  jobs for what is left and runs them.

- **CI/CD runs any agent as a step, and code review is one agent.** An
  `agent` step starts a session of one of your Runtime Agents with the
  change (its diff, and what your repository's members asked for) beside
  the tests, and waits for pass, or block with each finding's file, line,
  who is hurt and the fix: a reviewer, an agent that checks the docs were
  updated, or one holding your own rules: the `review` template (a stock
  reviewer) or the `judge` template (your instructions alone decide what
  blocks), both asking Claude with no tools. `review:` stays as its short form,
  so no file changes. The reviewer is now the `review` agent template anyone
  can create, and any agent can take a `pool` of Claude accounts, each
  session on the one with the most usage left. In the API, every SDK, the
  CLI (`runtime agents create --template review --pool ...`) and the MCP
  tool. See [agent steps](./ci#agent-steps).
- **See each step of a release as it is taken.** A repository whose releases
  CI/CD runs keeps every step, one line each: a migration's copy test and
  apply, each deploy ref moved, each server's canary and release, the
  website's deploy and promote, and every wait with why. Read them in the
  console's CI/CD → Releases, or with `GET /v1/ci/releases`, every SDK's
  `ci.releases.list` and the MCP tool's `releases`. See
  [follow a release](./ci#follow-a-release).
- **A key that may not read a repository's checks says so.** An owner's key
  that is not account-wide lists every connected repository but reads the
  checks only of those its own agent connected. Asked for another's checks,
  it answered an empty page, and 404 for each check, as if there were none.
  It is now refused with 403 naming the repository, its 404s name the
  repositories it lists and reads nothing of, and each refusal says how to
  read them all: switch the key to account-wide on the API keys page. An
  owner's full key that cancels a check it does not read is answered with
  the check's id and state, not 404. The CLI takes `runtime ci checks` and `runtime ci check <id>` beside `ls` and
  `get`. See [read checks, jobs and logs](./ci#read-checks-jobs-and-logs).

## 22 October 2026

- **A failed check's log keeps what matters.** A long failed log keeps its
  first error, every line that says a test failed (`panicked`, `FAILED`,
  `error[`) with the lines around it, and its end, not only its last few
  thousand characters. A link to a check or job opens it in whichever of
  your accounts holds it and that your sign-in may enter. See
  [read checks, jobs and logs](./ci#read-checks-jobs-and-logs).

<!-- /launch: ci -->

## 21 October 2026

- **Previews are never indexed.** Every answer on a preview address, private
  or public, carries `X-Robots-Tag: noindex, nofollow`, and each preview
  address serves Runtime's own `robots.txt`, so no preview shows up in search.
  A custom domain serves your site's own headers and `robots.txt`; use one for
  a site that should be found. See
  [search engines](./networking#search-engines).

- **First in line by plan when room is short.** When a region is short of
  room, the room that frees goes first to the highest lane waiting for it:
  Enterprise, then Scale, Pro Max, Pro and Free, from the account's plan,
  and Runtime's own work after every customer's. Until an account chooses a
  plan, paying accounts go before trials. A create or wake refused
  `no_capacity` keeps its place while it is sent again with the same
  `Idempotency-Key`, as the SDKs do, and the refusal says its place, how
  many wait ahead and its lane, also in `details.line`. Nothing already
  running is stopped for a higher lane. See
  [waiting in line for room](./limits#waiting-in-line-for-room).

<!-- launch: apps -->

- **Apps wait in line for room by plan too.** An App that needs a copy no
  server has room for waits in its region's line by its account's lane, as
  creates and wakes do. See
  [waiting in line for room](./limits#waiting-in-line-for-room).

<!-- /launch: apps -->

<!-- launch: ci -->

- **CI/CD's checks get machines by plan (private beta).** When machines are
  short, a higher lane's checks are taken and given machines first, and a
  waiting job says where it stands, such as
  `short of room: waiting for room, 1 ahead (pro 1); this lane is free`.
  See [price and limits](./ci#price-and-limits).

<!-- /launch: ci -->

<!-- launch: ci -->

- **CI/CD reviews each change with AI, beside its tests (private beta).** A
  `review` step asks a Runtime Agent on your own Claude accounts to read the
  diff, the description and what was asked for, from the same moment the
  tests start, and pass or block the change with each finding's file, line
  and fix. The model has no tools and none of your secrets. Each review takes
  the account with the most usage left and moves to the next when one runs
  out; a check waits only when every account is out, and never fails for it.
  The verdict is on the job in the API, the SDKs, `runtime ci logs` and the
  console. See [agent steps](./ci#agent-steps). Agent session keys starting
  `ci-review:` are now CI/CD's own: starting a session with one is refused
  with `invalid_request`.
- **A push to the production branch checks first, on as many machines as
  it has jobs.** Its check takes machines before any pull request's: while
  it is short, the others ask for none and give back each machine they have
  nothing left to run on, so it starts within seconds of room freeing. It
  is no longer held to 8 machines, and a pull request's check no longer to
  8 by default: each holds as many as it has jobs ready, up to the
  account's 256 at once. A gate waiting for room waits until it comes,
  never failing. See [Read checks, jobs and logs](./ci#read-checks-jobs-and-logs).
- **CI/CD keeps only the snapshots a check can still use.** When a push to
  the production branch changes the setup, the machine size or a `cache`
  file, the warm snapshots of the old key are deleted an hour later, not
  kept their 7 days, and a check's copy of its machine is deleted when the
  check ends, however it ended, not a day later. They leave your snapshot
  list and your storage bill then. See [A warm start](./ci#a-warm-start).
- **A CI/CD check runs only what the change reaches, and never fails for
  want of machines.** A split step's `affected` command now runs before the
  plan, on the check's first machine: a step it reaches none of has no job
  (before, each of its parts passed with nothing to run), its parts are
  dealt from the files it reaches, and a change that reaches nothing shows
  one passing job, `nothing reached`. Parts left to Runtime are no more than the machines a check runs
  at once. A check with no machine to run on waits for one, never failing
  for it, until machines come or it is cancelled. See
  [Split test files](./ci#split-test-files).
- **A CI/CD check runs only what the change reaches, keeps each result by
  its content, and never fails for want of machines.** Runtime reads what
  each test file reads from your repository (its imports, the files its code
  names, the scripts it runs) and keys its result by exactly those files'
  contents: a test file a change can't make fail keeps the pass it had on
  the production branch, or in another pull request of the repository by
  someone with write access, and runs on no machine. A part or step with nothing left to run
  passes at once, on no machine. Parts left to Runtime are no more than the
  machines a check runs at once. A check with no machine to run on waits for
  one, never failing for it, until machines come or it is cancelled. A
  split's `affected` command is no longer read: remove it. See
  [Passed before](./ci#passed-before).
- **No flaky test hides in CI/CD (private beta).** Every run of every test
  is kept by commit and content key. A test that passed and failed on the
  same inputs on your production branch is quarantined at once: it still
  runs and reports, and blocks nothing. It is handed to an owner from
  `CODEOWNERS` or its last change, with 48 hours to fix or delete it, and
  ends only once it passes 100 times in parallel forks. A pull request's
  new or changed tests run 20 times before it can pass. See the flakes in
  the console, `runtime ci flakes`, `GET /v1/ci/flakes` and every SDK.
  `quarantine: { clean_runs: N }` is no longer accepted: until you remove
  it from your config, every check fails with an error that names it. See
  [Flaky tests](./ci#flaky-tests).

- **Every file `cache` matches keys CI/CD's warm machine (private beta).** A check's warm
  snapshot was keyed by only the first 32 files its `cache` patterns
  matched, so a change to any file past those kept the old snapshot, with
  what it had installed. Now every matching file is in the key. A repository
  matching more than 32 sets up a new warm machine once, on its next push to
  the production branch. See [A warm start](./ci#a-warm-start).

- **CI/CD tells GitHub one check run per check.** A check shows as one run,
  `runtime`, in progress and then its conclusion, linked to the check in the
  console; a failed one names each failed job, its log's last line and a link
  to it. GitHub hears a check only when its state changes: at most two calls
  of your installation's hourly GitHub budget a check, where a check of 42
  jobs made 170. Every read of GitHub is conditional, so one that has not
  changed costs nothing of the budget. When the budget runs low, telling
  GitHub waits first and a verdict never waits on it. Each job, its state,
  why it waits and its log are in the console and the API. Runs per job
  (`runtime / <step>`, `runtime / test (1/2)`) are no longer made: a branch
  rule that requires one waits for it forever, so require `runtime`
  instead. See [What GitHub shows](./ci#what-github-shows).
- **A pull request's next push starts on its own machines.** A check's
  machines are its pull request's own, left paused by its last push with
  their build caches (all woken on its first ask, in a second or two), then
  the warm pool's, then the rest in one batch fork, or all at once from the
  warm snapshot. With `keep:` in `runtime.yml` (1 to 16; off unless set), a
  pull request keeps that many machines paused for its next push, billed as paused
  sandboxes at {{paused-storage-rate}} per decimal GB per 30-day month, and
  deleted when it merges or closes, or a day after its last push. Only the
  same pull request's next push runs on them, and only a writer's own
  branch's pull request keeps any: never a fork's, a push to the production
  branch, nor a gate. Past the account's 2 machine starts a second or 256 at
  once, a check waits in line with the reason on its jobs; it no longer
  falls back to a full setup. Each check's `machines` says where they came
  from and how soon, in the API, the SDKs, `runtime ci get` and the console.
  See [A pull request's machines](./ci#a-pull-requests-machines).

<!-- /launch: ci -->

- **A slow upload is given the time to arrive.** A request's 110 seconds to
  answer now start once its body has arrived, so a chunk of a large upload
  over a slow or busy link is no longer cut while its bytes are still coming
  in, and answered `503 api_unavailable` as if the API were at fault. A body
  may take up to about 280 seconds to arrive. One still arriving after that
  is answered `408 request_timeout` with the bytes received so far; the SDKs
  and the CLI get `503 body_stalled` and send it again by themselves. Many
  uploads at once over one slow link share it: send fewer at once. See
  [files](./api#files).
- **30 days to top up.** When credit runs out in an account that has bought
  credit or saved a card, its stopped and paused sandboxes' disks are kept 30
  days, not seven, with a notice first and a warning the day before, and
  adding credit in that time keeps them. Other stored items, and every item
  in an account that has done neither, keep their seven days. See
  [when your balance runs out](./pricing#when-your-balance-runs-out).
- **Many copies of a large snapshot at once can be asked to retry.** A copy
  of a snapshot that saved memory, and a wake, load all of that memory within
  seconds, and a server now counts each one at all of it from its start, not
  a quarter. A burst of copies or wakes bigger than one server's memory no
  longer overfills it: the ones past its room wait while it makes room, and
  if none comes in time answer `503 host_memory_pressure` with
  `Retry-After`. Send them again after it, with the same `Idempotency-Key`,
  as the SDKs do. See [errors](./api#responses-and-errors).

<!-- launch: apps -->

- **Apps and Functions deployed from an image go live again.** On 19
  October every deploy from an image failed while warming, with "warming the
  image stopped 3 times without an answer". Such a version stays failed:
  deploy it again. The App's owner, the agent or API key that created it,
  now needs `write_file` on sandboxes beside `create`, `list`, `get`, `stop`
  and `exec`; without one of them the deploy fails at once with
  `deploy_build_failed` and "Runtime's machine that saves this version was
  refused", in place of three silent retries. See
  [Deploys, health checks and rollback](./apps#deploys-health-checks-and-rollback).

<!-- /launch: apps -->

- **A scheduled job keeps data between runs on a volume.** A job's
  `compute.volumes` attaches up to four of your volumes to every run, each at
  a path, as a sandbox create does: read-write, one run at a time, so each run
  reads what the last one wrote, or a read-only `snapshot` copy. In the CLI,
  `runtime jobs create ... --volume <id>:/data`, and for a job you already
  have, `runtime jobs update <job> --volume <id>:/data` or `--no-volumes`; in
  the SDKs' next release. A run that waits for its volume says so with
  `blockedReason` `volume`. See
  [Keep data between runs](./jobs#keep-data-between-runs).
- **A full region answers 503, and an account at its limit 429.** No room
  for a sandbox, a fork, a restart, a wake, a build or a volume,
  `no_capacity`, is now `503 Service Unavailable` with `Retry-After: 1`.
  The account at a limit on what runs at once, `quota_exceeded` or
  `no_credit_running_limit`, is now `429 Too Many Requests` with
  `Retry-After: 5`. All three were `409 Conflict`, which a client that
  retries only 5xx and 429 gave up on. Such a client now retries them with
  no change. The body is the same, so code that reads `error.code` keeps
  working. In the SDKs' next release the error's
  class follows the status: `no_capacity` is a
  `ServiceUnavailableError`, and the two limits are a `RateLimitError`, not a
  `ConflictError`. The SDKs still wait them out on create, wake and restart,
  and return them at once elsewhere, as before. See
  [errors](./api#responses-and-errors).
- **Every error says whether to retry it, and its status means what HTTP
  says.** Each error now has `retryable`, `true` or `false`; a retryable one
  always carries a `Retry-After` header, and no other does. Each code has one
  status, listed with every code in [Responses and errors](./api#responses-and-errors)
  and in the OpenAPI document's `x-error-codes`. Codes are unchanged, so code
  that reads `code` keeps working; a check on the status may need a look:
  - 409 is now only a state you change first, or one that clears by itself
    (`snapshot_not_ready`, `image_not_ready`, `volume_releasing`, ... are
    retryable).
  - Your own limits that clear by themselves are 429, always with
    `Retry-After`: `quota_exceeded` on what runs at once (`details.limit`
    such as `sandbox.count` or `sandbox.memory_mib`), the `no_credit_*`
    limits on what runs, `process_limit`, `transfer_limit`, `guest_busy`,
    `build_in_progress` and the daily caps.
  - A count that falls only when you delete something is 409, with
    `retryable: false` and no `Retry-After`, so no retry library retries
    it: `no_credit_kept_limit`, `limit_reached` (keys, invitations,
    compartments) and `quota_exceeded` on what is kept (volumes, snapshots,
    images, secrets, `sandbox.kept`). Delete one, or raise the limit.
  - A full region or host is 503 with `Retry-After`: `no_capacity`,
    `host_capacity`, `own_share_full`.
  - A product switched off on a deployment is 501, not 503, so no client
    retries it.
  - A fault of ours that a retry does not fix is 500 (`operation_failed`,
    `price_unavailable`, and `watch_failed`: Runtime's own file watcher in a
    sandbox); a service behind the API is 502 or 504.
  - A request that cannot be done as asked is 422: `disk_too_small`,
    `idempotency_conflict`, `no_credit_size_limit`, a program in your sandbox
    that failed (`interpreter_failed`, `tunnel_unavailable`).
- **The SDKs read `retryable`** (in the same versions). They retry an answer
  that says `retryable: true` after its `Retry-After`, and never one that says
  `false`. A create, wake or restart waits out room and the account's limits
  for its own wait for room (two minutes by default; `0` returns at once), and
  a fork returns them at once. An answer whose wait is over a minute (a daily
  cap) is returned at once, with `retryAfterMs`. The Go, Ruby and Java SDKs now
  also resend a call refused `guest_busy`, `busy` or `rate_limited` until its
  deadline, as JavaScript and Python do. The CLI's `--json` errors carry
  `retryable` and `retryAfterMs`.
- **A pause succeeds when its server's snapshot space is full.** Saving a
  snapshot now leaves the room each server keeps for pausing the sandboxes it
  runs. When that room is short, the server makes room while the pause
  waits, up to about a minute: it compresses saved memory images, moves kept
  snapshots to other servers, and copies paused sandboxes to storage and
  shrinks them. If there is still no room, the sandbox is paused all the
  same: the server holds its memory and saves it once there is room, and a
  wake meanwhile resumes it at once. Such a pause used to fail. Only a
  sandbox too near the end of its time to save its memory later is not
  paused: the pause fails with `no_capacity` (503, retryable) and the sandbox
  keeps running, its memory intact. A snapshot the server has no room for is
  refused with `host_capacity` (503); retry it later. See
  [pause, wake, extend](./javascript#pause-wake-extend).
- **Accounts without credit hold up to 10 API keys.** A new key past ten is
  refused with `no_credit_key_limit` (409) and says how to make room: revoke a
  key you no longer use, or add credit, after which there is no limit. Every
  key an account already holds keeps working, and keys Runtime makes for the
  console, its terminals and image builds are not counted. See
  [free usage](./included-usage#without-credit).

<!-- launch: apps -->

- **Apps with a volume, and restart (private beta).** An App can mount one of
  your volumes with `volume: {volumeId, path}`. It runs one copy on the
  volume's server. Each deploy, rollback and restart stops that copy (SIGTERM,
  then `stopGraceSeconds`) before the next boots fresh with the volume, and
  the deploy record says the downtime. `POST /v1/apps/{id}:restart` and
  `POST /v1/functions/{id}:restart` start any App's or Function's live
  version afresh as a deploy of its own (`runtime_apps_restart` and
  `runtime_functions_restart` in MCP). A live copy of an App or a Function
  failing its health check for `healthFailSeconds` (60 by default) is
  replaced, and its version's history shows it. In the JavaScript SDK
  0.30.0, the Python SDK 0.29.0, `runtime apps restart` and
  `runtime functions restart`; outside the beta these calls are refused
  with `product_in_beta`.
- **An App with `minCopies: 0` answers its first request from a frozen copy.**
  When nobody calls it, it keeps one copy frozen, free, rather than none, so
  the first request waits for that copy to wake, not for a new one to start:
  milliseconds within 30 minutes of the last request, a few hundred
  milliseconds after that. Each server keeps up to the App's `spares` frozen
  copies in memory and parks the rest. The server a copy runs on wakes it, so a
  wake never waits on Runtime's central scheduler, even when that is down. See
  [How copies scale](./apps#how-copies-scale).

<!-- /launch: apps -->

## 20 October 2026

- **`runtime.apps` in the TypeScript SDK, for the Apps private beta.**
  `withruntime`'s next release (`npm i withruntime@latest`) has
  `runtime.apps`: create an App, deploy an image to it, follow the deploy,
  roll back, and list its versions and copies. Apps is a private beta for now: an account outside it gets
  `product_in_beta` (403), with a hint to ask support to join.
- **Book room for a burst.** Book room for up to 10,000 sandboxes of one size
  for a window of up to 24 hours, starting now or within 14 days, and be told
  at once whether you have it. In the window your creates are never refused
  `no_capacity` or `quota_exceeded` up to what you booked; sandboxes you run
  bill as usual. A decline says why, the most that fit and the nearest window that
  takes them all. In the API (`POST /v1/reservations`), the JavaScript,
  Python, Go, Ruby and Java SDKs (`runtime.reservations`), the CLI
  (`withruntime reservations book`) and MCP. See
  [Book room for a burst](./reservations).
- **Booked room left unused costs a little.** Room a booking holds that none
  of your sandboxes uses now costs a quarter of the memory rate,
  {{booked-unused-rate}} per GiB-hour, with no CPU charge; sandboxes you run
  bill as usual. 300 sandboxes of 2 GiB booked for 2 hours cost at most
  {{booked-unused-example}} if none run, and nothing if you cancel at least an
  hour before the start. A booking's answer, the CLI and the console's Booked
  room card say the most it can cost. See [What it costs](./reservations#what-it-costs).
- **Standing room for a pool.** Keep room for a pool of sandboxes until you
  cancel it: name the snapshots it forks from and the room is held on the
  servers holding them, so a sandbox replaced after each use is never
  refused for room or limits. `forKey` keeps it for one key's sandboxes, and
  `inUse` says how much of it runs now. Room none of them uses costs a
  quarter of the memory rate, {{booked-unused-rate}} per GiB-hour. See
  [standing room](./reservations#standing-room-for-a-pool).
- **Audit log entries older than 400 days are now removed.** The audit log
  has always promised to keep each entry for at least 400 days; until now it
  kept every entry forever. From this release, entries past 400 days are
  deleted, oldest first, and none younger is ever touched. See
  [the audit log](./teams#audit-log).
- **Node trusts HTTPS from a sandbox's first command.** A sandbox with
  egress secrets checks its HTTPS with Runtime's own certificate authority,
  and Node, which keeps its own roots, learns it from `NODE_EXTRA_CA_CERTS`.
  A sandbox's or a scheduled job's first commands, in its first few seconds,
  could start without that variable, and Node refused every HTTPS call with
  `SELF_SIGNED_CERT_IN_CHAIN`. They now have it from the start. See
  [networking](./networking).
- **The CLI says when a certificate is not trusted.** Behind a proxy or
  firewall that inspects TLS with its own authority, every call failed as
  "No answer from Runtime". It now says the certificate presented is not one
  your machine trusts, with its code, and to point `NODE_EXTRA_CA_CERTS` at
  the proxy's certificate.
- **`runtime images build -f` reads the Dockerfile as `docker build` does.**
  `runtime images build . -f apps/web/Dockerfile` builds a monorepo's app with
  the repository as its context: `-f` is read from where you run the command,
  and a path inside the folder still works. See [images](./images).
- **Apps and Functions: what Cloudflare's cache serves is outbound traffic
  (private beta).** Once Cloudflare's cache serves Apps and Functions, the
  bytes it serves for an App's or a Function's addresses and custom domains,
  without reaching it, are charged as outbound traffic, the same as a
  sandbox's: from the account's {{outbound-allowance}} a month free first, then
  {{outbound-rate}} per decimal GB. They are read from Cloudflare's analytics
  an hour at a time, charged once per hour, and shown in `GET /v1/usage` under
  `outbound`. An App or Function made without credit sends for free and uses
  none of the allowance.
- **Storing several secrets at once no longer fails.** Writing egress
  secrets (`PUT` or `DELETE /v1/egress-secrets/{name}`) or the upstream proxy
  from parallel jobs of one account used to fail with 503 busy for all but
  one of them. Now the writes wait in line and each one succeeds. See
  [the API](./api).
- **A copy of a snapshot starts even when its servers are full.** When the
  servers holding a snapshot have no room, or `spreadFrom` rules them out, the
  create now starts on another server, the snapshot copied there straight
  from a server that holds it, instead of answering `no_capacity`. This works
  from the moment the snapshot is `ready`, even before its compression ends.
  See [keeping copies on several servers](./api#keeping-copies-on-several-servers).
- **A wake waits for room instead of failing.** When a paused sandbox's host
  is short of room only because of work Runtime runs at the lowest priority
  there (such as Runtime's own CI), waking it now pauses that work and waits
  up to 20 seconds for the room, rather than answering `no_capacity` at once.
  Requests that wake a sandbox by themselves do the same. See
  [a paused sandbox will not wake](./troubleshooting#a-paused-sandbox-will-not-wake).
- **Sandbox desktop, browser, MCP servers and mounts in the console.** A
  sandbox's page now lets you open its desktop and watch it live, record it,
  start or stop its browser, and see or stop its code contexts, MCP servers,
  bucket mounts, file watches and tailnet, each stop asked first. Networking
  gains the switch for your sandboxes to
  [reach each other by name](./networking#reach-your-other-sandboxes-by-name).
- **Faster website on phones.** Pages on withruntime.com no longer download
  two extra font files, 140 KB, to look for a single character such as "10⁹"
  or "✓": the home page loads about a third lighter on a phone, and the
  pricing, comparison and blog pages about a fifth lighter. See
  [pricing](./pricing).
- **Clearer page titles in search results.** Guides now show titles that
  say what they cover, such as "Python SDK for agent sandboxes" or "Custom
  sandbox images from any Dockerfile", so they are easier to find. See
  [the Python SDK](./python).
- **CI/CD leaves no run "Waiting" on GitHub after its check ended.** A
  check restarted midway, or one whose tests were split into a different
  number of parts, could leave old `runtime / …` runs queued or in progress
  on the commit for good, though the check itself had passed, failed or been
  cancelled. Within a few minutes of a check's end, every run of it GitHub still
  shows open is now ended: a job's run with its job's result, an extra
  `runtime` run with the check's own, and a run of a job the check no longer
  has as Cancelled, "Not run: its check ended before this run of the job
  began." Another check of the same commit keeps its runs as they are.
- **Pull requests start from a copy of your production branch that is
  closer to its newest commit.** The ready-made machine each check starts from
  now moves to a production push's commit while that push's own check runs,
  not after it ends, so a pull request checked a few minutes later has fewer
  files to catch up on.
- **A CI/CD check that can no longer finish now fails, with the reason.**
  Before, a check whose runner stopped, or whose job hung, could show "in
  progress" on GitHub for hours. Now it fails within minutes of the point it
  can no longer finish, saying why: a job sent nothing for longer than its
  30-minute limit, no
  machine came for its jobs in 45 minutes, no runner has held it for 30
  minutes, or it waited an hour to start. Re-run it on GitHub to check the
  commit again.
- **Choose what happens when an App release gets worse (private beta).** An
  App or Function now has `releaseWatch`: when a new version's errors or speed
  get clearly worse in its first 15 minutes, `alert` (the default) tells the
  account's owners, `rollback` also goes back to the previous version by
  itself, and `off` does neither. Each release judged worse posts an
  `app-release-worse` notice to `GET /v1/notices` for every owner, shown on
  Usage & billing and emailed to them. Set it on create or update from the
  API, the MCP tools, or the JavaScript 0.24.0, Python 0.22.0, Go 0.11.0, Ruby
  0.10.0 and Java 0.10.0 SDKs. Only an account-wide key made on the website
  turns it off: a key in a compartment, a key made by another key and a
  sandbox's own session key may choose `alert` or `rollback`, and `off` is
  refused with `403 forbidden` ([compartments](./security#compartments),
  [run a swarm](./teams#run-a-swarm)).

<!-- launch: ci -->

- **CI/CD runs your own automation's pushes (private beta).** A repository
  can now trust GitHub Apps: list each App's login (`my-bot[bot]`) in
  `trustedApps` with `POST /v1/ci/repositories/{id}:update`. Pushes by those
  Apps then run as code from someone who can write, and their checks that
  are waiting now run. Only a full key made by an owner or admin sets the
  list. A push by any other App still waits,
  and its `runtime` check on GitHub says which App and how to trust it. See
  [CI/CD](./ci#trust-your-own-automations-app).

<!-- /launch: ci -->

- **A job tells you when it fails, runs your image, and changes in place.**
  A job's `alert` posts to your webhook, signed with a jobs secret, or emails
  you once runs fail in a row, with the run's reason, exit code and last lines
  of output, and once more when a run succeeds again. Your account's webhooks
  hear `job.run.failed` and `job.recovered`. `--image` starts each run from an
  image of yours, and `runtime jobs update` (`PATCH /v1/jobs/{id}`) changes a
  job's command, image, size, secrets, alert, timeout or retries and keeps its
  history. In `withruntime` 0.29.0 for JavaScript and the CLI, and 0.28.0 for
  Python. See [alerts](./jobs#alerts).
- **Every App has a readable address (private beta).** Every App and
  Function, those you have and every new one, answers at its name, 16 random characters, then its
  account's handle: `https://shop-3f9a1c2e7b04d915-acme1.runtimehost.com/` for the App
  `shop` of the account Acme, in `url` on the App and its deploys, in the API,
  the console and every SDK. It is kept for life: a rename leaves it, and a
  handle is never another account's, even after an account closes. Every App
  keeps its id's address too.
- **A disk snapshot of a sandbox that is writing no longer fails.** A
  `mode: "disk"` snapshot of a running sandbox used to fail with "could not
  confirm that its writes reached its disk" whenever a program in it was
  writing. Its pause now waits for the sandbox to write out what it still
  held in memory before the snapshot is taken. That takes milliseconds when
  the sandbox is quiet and can take a few seconds while it writes. Memory
  snapshots are as fast as before. See [the API guide](./api).
- **A trust center for your security review.** [withruntime.com/trust](https://withruntime.com/trust)
  gathers what a security team asks a vendor for on one page: the public
  documents, where data lives, how sandboxes are kept apart, encryption,
  sign-in, availability and recovery, every subprocessor, and how to report
  a vulnerability. A filled-in questionnaire is on request from security@.
  See [security and compliance](./trust).

<!-- launch: apps -->

- **A paying account's stopped disks are kept.** In an account with credit or
  a card saved, a stop from an older client, the end of its time limit or a
  crash no longer deletes the disk after three days: it is kept like any
  other stop, billed as [paused storage](./pricing#paused-storage), until you
  delete it. Disks already counting down their free days are kept the same
  way, and stay free until those days end; storage is billed only from then.
  An account that adds credit or saves a card while its disk counts down
  keeps that disk too. An account with neither still has the three free
  days, one notice, then the deletion.
- **A paying account's stopped disks are kept.** In an account with credit,
  a card saved or a past purchase, a stop from an older client, the end of
  its time limit or a crash no longer deletes the disk after three days: it
  is kept like any other stop, billed as
  [paused storage](./pricing#paused-storage), until you delete it. If the
  account's credit runs out, that disk is still kept at least 30 days from
  the stop, with the usual notices. Disks already counting down their free
  days are kept the same way, and stay free until those days end; storage is
  billed only from then. An account that adds credit or saves a card while
  its disk counts down keeps that disk too. An account with none of these
  still has the three free days, one notice, then the deletion.
- **An App can trust every `x-runtime-*` header it reads (private beta).**
  The router removes every `x-runtime-*` header a visitor sends, on HTTP/1.1
  and HTTP/2, before it adds its own: the visitor's address, country, city
  and the request's id. A visitor can no longer make up a header in that
  namespace and have it reach an App. See
  [what an App's requests carry](./api#what-an-apps-requests-carry).
- **Scraping accounts move to the scraper addresses by themselves.** An
  account whose sandboxes ask for their own address from many sandboxes, keep
  reaching a site that blocks by address, or open thousands of connections to
  one site now sends from the addresses kept for scrapers without anyone
  marking it, and goes back to the shared ones after a quiet day. Its
  sandboxes keep their internet throughout. See
  [Shared addresses](./egress#shared-addresses-and-per-address-limits).
- **A sandbox whose wake failed on our side recovers by itself.** When the
  machine holding a paused sandbox could not hand it back, every command used
  to answer `operation_failed` until you stopped it. Now the sandbox is
  checked again every five minutes: once the machine lets it go, it is paused
  again and your next command wakes it, from its disk if its memory could not
  be kept (`memoryRestored: false`). See
  [A sandbox stays resuming](./troubleshooting#a-sandbox-stays-resuming-or-its-operation-never-finishes).
- **An account that never paid is suspended for clear abuse.** Mining, a port
  scan or a sweep of addresses, or mail sent straight to many mail servers now
  suspends an account that has never paid, as trying one internal address
  after another already did; its sandboxes are paused with their files kept.
  An account that has paid is still never suspended for it: only the one
  sandbox loses its network and is paused. See
  [security](./security#network-access).
- **Secrets for different sandboxes can share one variable.** A secret can
  now name `env`, the environment variable its sandboxes see it in, when that
  is not its name: keep one GitHub token per repository, each scoped to that
  repository's sandboxes, and every sandbox and App copy sees its own as
  `GITHUB_TOKEN`. Set it with
  `runtime secrets set GITHUB_TOKEN_WEB --host api.github.com --only-label repo=web --env GITHUB_TOKEN`,
  `env` in every SDK and the API, or the Variable field on the console's
  Secrets page. A store or scope change that would give one sandbox two
  secrets of the same variable is refused. Before, a secret's
  name was always its variable, so each token needed a name of its own. See
  [Secrets sandboxes never see](./security#secrets-sandboxes-never-see).

<!-- /launch: apps -->

## 19 October 2026

<!-- launch: ci -->

- **CI/CD's checks, jobs and logs to read (private beta).** Every check of a
  connected repository, newest first, with its jobs by state
  (`GET /v1/ci/checks`); a check with its jobs in plan order
  (`/v1/ci/checks/{id}`); a job with the tail of its log and the sandboxes it
  ran in, where a failure's may be kept paused to look into
  (`/v1/ci/jobs/{id}`); and a repository's test files with their quarantine
  (`/v1/ci/tests`). In every SDK as `ci`, in the CLI as `runtime ci`, as the
  `runtime_ci` MCP tools, and in the console under CI/CD.

<!-- /launch: ci -->

- **Fly Machines API on Runtime.** Code written for Fly's Machines API now
  runs on Runtime by changing one address: run `npx withruntime fly-api` and
  point `FLY_API_HOSTNAME` (or fly-go's `FLY_FLAPS_BASE_URL`) at it. Each
  Machine is a sandbox; `init`, `env`, `files`, metadata, leases and the
  restart policy work, and what isn't supported is refused with Runtime's
  alternative. Node services can serve it themselves with `machinesApi()` from
  `withruntime/fly`. See [switching from Fly Machines](./fly-alternative#from-machines).
- **Every router serves the same routes, and a copy stops only once none
  sends it visitors.** An App's or a balancer's change counts served only once
  every Runtime router serves it, so a deploy's old copies stop only after no
  router can still send them a visit. A router that has never had its route
  table yet answers `router_not_ready` (503, `Retry-After: 1`) instead of
  `no_route`. See [Networking](./networking#what-a-visitor-can-get).
- **Functions in the CLI and the console (private beta).** `runtime functions`
  creates, deploys, lists, reads, updates, rolls back and deletes Functions,
  and lists their releases, versions and copies, as `runtime apps` does for
  Apps. In the console, Functions has a list of its own beside Apps, and each
  Function a page with its calls, errors, releases, copies and logs, with
  deploy and rollback. Outside the beta these are refused with
  `product_in_beta`. See the [CLI](./cli).
- **Snapshots kept while you have credit have no end date.** A snapshot taken
  without `retentionDays` used to be deleted a year after it was taken, even
  with credit on the account. Now it is kept for as long as you have credit,
  as the 4 October entry said. See [pricing](./pricing).
- **The Vercel-compatible snapshot's `expiresAt`.** For a snapshot kept while
  you have credit it now reports a year from now, moving on with each read,
  instead of a year after the snapshot was made, a date that would pass while
  the snapshot was still kept. In the JavaScript SDK's next release.
- **The data processing addendum, privacy policy and subprocessors page say
  more, and say what is true today.** A new subprocessor is listed at least 30
  days before it starts, and you may object within those 30 days; email
  legal@withruntime.com to be told when the list changes. A breach affecting
  your data is reported to your account's owners within 72 hours, with what
  happened, who and what it touches and what we are doing. Closing an
  organization destroys its key first, then deletes its data, and the
  addendum gives every step's time limit, including each server's own nightly
  backup, gone within 44 days. Once we hold a SOC 2 report, it is shared under
  a confidentiality agreement as our answer to audit requests. The addendum
  lists the security measures we run now. Anthropic, which runs the AI model
  that answers support, and Slack, which carries our team's alerts and support
  drafts, are now on the subprocessors page. See
  [security and compliance](./trust).
- **Keep-alive ends when its sandbox is deleted.** In every SDK, a sandbox's
  keep-alive (`keepAlive`, `keep_alive`, `KeepAlive`) now ends at the first
  answer that the sandbox is gone, as when it was deleted by id from another
  handle or another process. Before, it went on reading the deleted sandbox
  once a minute for as long as the program ran.

- **Storage is limited in GiB, not only counted.** An account keeps up to
  500 GiB in all with credit (50 GiB without): snapshots, images, volumes,
  volume backups and paused or stopped sandboxes, measured as they are
  billed; snapshots up to 250 GiB of it (20 GiB without). Past a limit nothing
  is deleted or stopped: a new snapshot, image, backup or volume is refused
  with `quota_exceeded`, naming the limit, until there is room. An account
  that already stored more than a limit when it began has what it stored then
  as that limit. Both are on the Limits page and in `GET /v1/limits`. See
  [limits](./limits#storage).
- **Requests in flight grow to your sandbox quota.** An account's requests
  in flight grew by six for each sandbox it holds only up to 1,024 (138
  sandboxes). Now an account whose sandbox quota support raised past 138
  keeps growing, six for each running sandbox up to that quota: 2,592 for
  400 running, so each can stream four commands and two watches at once.
  Watch streams, SSH logins, port forwards and terminals grow with it. See
  [limits](./api#limits).
- **A command may run 15,360 processes and threads.** One command and
  everything it starts may hold up to 15,360 processes and threads together,
  of a sandbox's 16,384; it was 1,024. Test runs that start many processes,
  Java and parallel builds on a sandbox with several vCPUs no longer fail to
  start a thread. A sandbox gets it the next time it starts; a custom image,
  once it is built again. See [limits](./api#limits).
- **Started copies are kept for images in use.** A server keeps an image's
  started copies (the ones a sandbox starts from in about half a second)
  while sandboxes are created from that image there. Once none has been for
  2 days, the copies go. The first sandbox after that gap boots the image (a
  few seconds), and the ones after it start from copies again. Before, every
  image version kept its copies on every server it reached, used or not. See
  [Images](./images).

- **See which files a command read.** Run a command with `traceFiles: true`
  and its answer lists every file and folder it, and anything it started,
  opened, and every file it wrote; other programs on the sandbox never show
  up. Key a test cache by those files and rerun only the tests whose files
  changed. Background processes, every SDK and `runtime sandboxes exec
--trace-files` have it too. See
  [commands and processes](./api#commands-and-processes).
- **A paying account's stopped sandboxes keep their disk 30 days.** When a
  sandbox stops to clean up (a stop from an older client, the end of its time
  limit, or a crash), an account that has paid, holds credit or saved a card
  for automatic top-ups now keeps its disk free for 30 days after the stop, not
  three. Disks already waiting in such an account move to 30 days from their
  stop, never less than a day from now, and you get the deletion notice again
  before the new date. Other accounts keep three days. See
  [paused storage](./pricing#paused-storage).
- **Turn an App's CDN off (private beta).** Cloudflare's CDN sits in front of
  every App's and Function's addresses by default, with no separate fee. Set
  `cdn` to `false` when you create or update one (`--cdn off` in the CLI, `cdn`
  in the API, MCP tools and every SDK) to send visitors straight to Runtime's
  routers, with nothing cached.
- **Read and follow an App's logs (private beta).** What an App's or a
  Function's copies print to standard output and error is kept 14 days and
  read back with `GET /v1/apps/{id}/logs` (`/v1/functions/{id}/logs`), the
  `runtime_apps_logs` and `runtime_functions_logs` MCP tools,
  `runtime apps logs <app>` in the CLI, and `logs` in every SDK. Narrow it by
  `since` (a time, or `30s`, `15m`, `2h`, `7d`; an hour by default),
  `version`, `copy` and `stream`; page back with `cursor`. With `follow` it
  streams each line as it is printed, and the SDKs and the CLI reconnect by
  themselves and give each line once. A key that may read files reads the
  logs of the Apps it can see, a worker's or a compartment's key its own
  Apps' alone. Outside the beta these calls are refused with
  `product_in_beta`.
- **Sandboxes with egress secrets start under heavy load.** Creating a
  sandbox that names its egress secrets (`secrets`) checks its list again
  rather than failing at once with `secrets_unconfirmed` when the service is
  busy, and one account
  sending far more requests than its limit is slowed alone while other
  accounts' calls go through. See [Keys and secrets](./security#keys-and-secrets).
- **Request timeouts on sign-up and webhook routes.** A request to a route you
  call before you have a key (the [MCP sign-up](./mcp), GitHub's webhooks and
  install link, and an agent's reports) whose body has not all arrived after
  5 seconds is now answered `408 request_timeout` straight away: send it
  again. Before, it waited 15 seconds or more and was answered
  `503 api_unavailable` as if Runtime had failed. See [errors](./api#responses-and-errors).

- **The Prime Sandboxes drop-in follows 0.4.7.** Code written for
  `prime-sandboxes` 0.4.7 runs on `withruntime.prime`. Its new `arch` option
  on create works with `"amd64"`, and `"arm64"` gets a plain error before any
  sandbox is made, as Runtime sandboxes are x86-64. `create_lan_network` now
  takes `rules` and, as before, names Runtime's private network instead. See
  [Migrate](./migrate).
- **Workers start from their coordinator's snapshots.** A key made by a key
  can now create a sandbox from a snapshot that its maker, or any key above
  it, took and labelled `share: made-keys`. It can only start from it: it never lists,
  reads, changes or deletes it, and a snapshot without the label stays out of
  its reach. The label is never copied to sandboxes, forks or new
  snapshots made from a shared one: set it on each snapshot you share.
  Worker keys made before this release need to be made again to use it. A
  `share: made-keys` label already on a snapshot was taken off, so nothing
  became shared by itself; a `share` label of any other value is untouched.
  A snapshot of a sandbox that named its egress secrets (`secrets`) is
  never shared: workers get `snapshot_not_found` for it, while its owner
  still starts it. Sharing never crosses a compartment.
  Before, a worker key with reach `agent` was answered
  `snapshot_not_found` for every snapshot but its own. See
  [Run a swarm](./teams#run-a-swarm).
- **A scraping account no longer gets other accounts blocked.** Runtime can
  move an account whose sandboxes scrape sites to outbound addresses kept for
  scrapers, so a site that answers it with a CAPTCHA or a ban does not block
  the other accounts on the same server. The move reaches its running
  sandboxes at their next connection, they keep their internet throughout, and
  the addresses are in the same published list as the shared ones. See
  [Shared addresses](./egress#shared-addresses-and-per-address-limits).
- **MCP sandbox switch and resize refusals say what to do.** Through
  MCP, switching a sandbox's image while asking to keep more than
  `/workspace` again says what a switch keeps and how to keep everything
  (snapshot first), and a resize sent without a restart says that a resize
  always restarts, instead of naming only the field. See [MCP](./mcp).
- **Jobs secrets belong to the key that stored them.** A jobs secret stored
  by an API key can now be used only by that key, by agents you name, and by
  you. Share it with your other keys using
  `runtime secrets share NAME --agent <id>`, `--all` or `--none`
  (`secrets.share` in the SDKs, `POST /v1/secrets/{id}:share`). Secrets you
  store on the website stay every key's. A job that binds a secret another
  key stored stops at its next run until that key or you share it; if another
  of your keys could reach a secret before now, rotate it. A job created with
  a secret its key may not use is refused with `secret_not_shared`. See [secrets in a job](./jobs#secrets-in-a-job).
- **Ask support to stop our emails and get a straight answer.** Email
  support "remove me from your list" and the support agent now tells you
  which of Runtime's emails reach that address, if any, and how to stop each:
  the link at the foot of each optional email, or
  Settings, Emails in the console. It no longer
  passes the request to a person or promises a removal. See
  [Stopping Runtime's emails](./feedback-and-support#stopping-runtime-s-emails).
- **Raise how many sandboxes run at once.** Ask support for a higher count
  and it is raised for your account with the vCPUs, memory and disk to match,
  never below what auto top-up gives, whether auto top-up is on or off. See
  [when you meet one](./limits#when-you-meet-one).
- **A sandbox paused for abuse stays paused until support lifts it.** When
  the abuse checks pause or stop a sandbox for traffic only abuse makes, such
  as reaching a cryptocurrency mining pool, a wake, restart, snapshot or fork of it
  now answers `sandbox_halted` (403) saying why, instead of running it again. Its files are kept,
  and your inbox says what was seen. See [Security](./security#network-access).
- **A build on a busy server waits for room instead of failing.** When the
  server an image builds on has no room for its build machine at that moment,
  the build waits up to five minutes for room and then runs, and its log says
  it is waiting. Before, it failed at once with a fault on our side and asked
  you to build again. See [Images](./images).
- **Narrow a secret without its value.** `runtime secrets set NAME
--keep-value` with a narrower `--host` or `--allow` takes hosts, methods or
  paths away from a secret you stored, with no need to have its value at hand:
  a token that could push to a repository can be made fetch-only by anyone who
  may write secrets. Anything wider is refused, since a new place could learn
  the value. In the API, `PUT /v1/egress-secrets/{name}/rules`; in every SDK,
  `secrets.narrow` (withruntime 0.22.0 for JavaScript, 0.21.0 for Python); in the console, leave the value empty
  when you edit a secret to take hosts or rules away. The audit log records each one.
  See [Secrets sandboxes never see](./security#secrets-sandboxes-never-see).
- **Links to one file in a sandbox, with no API key.** `files:link` (API),
  `sandbox.files.downloadUrl` and `uploadUrl` (JavaScript, with `download_url`
  and `upload_url` in Python, and the same in Ruby, Go and Java) and
  `runtime sandboxes link` make a secret, expiring URL for one file. A GET downloads it
  (Range works, so videos play and downloads resume); a PUT writes it
  atomically, up to 5 GiB. A link lasts 1 hour by default and at most 7 days;
  `revokeLinks` ends every link of a sandbox, and revoking the key that made
  one, or deleting the sandbox, ends it too. E2B's `downloadUrl` and
  `uploadUrl` now work the same way. JavaScript 0.25.0, Python 0.23.0, Go 0.12.0,
  Ruby 0.10.0 and Java 0.10.0. See [files in the API guide](./api#file-links).

- **Apps, Functions and Builds in the Go, Ruby and Java SDKs (private beta).**
  Go 0.7.0 (`client.Apps`, `client.Functions`, `client.Builds`), Ruby 0.6.0
  (`client.apps`, `client.functions`, `client.builds`) and Java 0.6.0
  (`apps()`, `functions()`, `builds()`) carry every method the TypeScript SDK
  has: create, deploy from an image or a build and wait for it, roll back,
  versions and copies; builds of a connected repository with their log,
  followed as it is written. Each can also ask for the link that installs
  Runtime's GitHub App, so private repositories build. Outside the beta these
  calls are refused with `product_in_beta`.

## 18 October 2026

- **GitHub App tokens, push limits and API budgets for secrets.** A secret
  can now hold a GitHub App's private key (`githubApp`): our servers make its
  installation tokens and add them to your sandboxes' GitHub requests and git
  pushes, and the key itself goes into no request. `git.push` names the
  branches a push may update, such as `refs/heads/task/{label.task}`: each
  label's branch belongs to the first sandbox made with it, even once it is
  deleted, and that label can't change after the sandbox is made. Any
  other push is refused with git's own `[remote rejected]`, as is any API call
  that would move, merge or write to another branch. `api` caps each
  sandbox's calls and writes an hour, lists the GraphQL mutations allowed,
  and lets sandboxes share cached reads. A rule's path segment that is `*`
  alone now names any one segment. See
  [GitHub: an App's tokens, branch limits and API budgets](./security#github-an-app-s-tokens-branch-limits-and-api-budgets).
- **SDKs take a secret's GitHub App, push limits and API budgets.**
  `withruntime` 0.25.0 for JavaScript and 0.23.0 for Python, the Go SDK 0.12.0, and
  the Java and Ruby SDKs 0.11.0 set and return `githubApp`, `git` and `api`. See
  [GitHub: an App's tokens, branch limits and API budgets](./security#github-an-app-s-tokens-branch-limits-and-api-budgets).
- **Clear refusals instead of 500 errors on sandbox create.** A create
  that asks for ports beyond 80 and 443 (`network.connect`) from an account
  without a kept top-up is refused with 403 `connect_not_allowed`, saying
  what lifts it, and a `maxTotalCostMicros` below the first minutes a paid
  sandbox holds is refused with 400 `invalid_request` naming that field; both
  answered 500 before. A pause sent while a sandbox is still starting, a
  wake sent while it is pausing, and a restart sent while it is stopping now
  wait for it instead of being refused, and a file call right after a wake
  waits for the sandbox to listen instead of answering `guest_busy`. A
  persistent sandbox stopped before it ever started now reads
  `diskKept: false`, since it has no disk to restart from; it read `true`,
  and its restart was refused. See [networking](./networking),
  [limits](./limits) and [the API guide](./api).
- **API key limited to chosen sandboxes, approved in the browser.** An agent
  with no key can now ask for a key that reaches only the sandboxes it names,
  whichever key or connector made them: `runtime keys create --sandbox <id>
--actions get,exec`. An owner or admin approves it from a link, seeing each
  sandbox and what the key may do. Without `create` it cannot start, wake or
  restart them; a running one is billed as usual until its own time limit. See
  [asked for in the browser](./teams#asked-for-in-the-browser).
- **Snapshot starts no longer stop for CPU on one server.** A sandbox started
  from a snapshot whose server was short of CPU for your other sandboxes used
  to stop with `account_busy_here`. Now it starts on another server that holds
  a checked copy of the snapshot, and stops only when none of them has room
  (or after it has moved 3 times).
  See [A sandbox stopped on its own](./troubleshooting#a-sandbox-stopped-on-its-own).
- **Apps console with traffic and live releases.** Console → Apps shows each
  App as a card with its last day of requests, error rate, copies running,
  last release and this month's cost. An App's page draws its copies by
  version, a release step by step as requests move to the new version, its
  requests, errors and latency over an hour, a day or a week, its busiest
  routes, and log search by request id or any words. A failed release keeps
  its output, and the previous version rolls back in one click. See
  [custom domains on an App](./networking#on-an-app).
- **Move from Cloudflare Sandbox to Runtime.** A Worker written for
  Cloudflare's Sandbox SDK (0.x) now runs on Runtime sandboxes once you change
  its import to `withruntime/cloudflare`, delete the `containers` block from
  `wrangler.jsonc` and add a `RUNTIME_API_KEY` secret. Commands, streaming,
  files, background processes, the code interpreter, preview URLs, sessions
  and `gitCheckout` work as before. See
  [change the import](./cloudflare-sandbox-alternative#change-the-import).
- **A sandbox can name the secrets it gets.** Create a sandbox with
  `secrets: ["ANTHROPIC_API_KEY"]` (`runtime sandboxes create --secret
ANTHROPIC_API_KEY`) and it gets only that egress secret: no placeholder for
  any other, and our proxy puts no other value into its requests. An agent
  given untrusted input can no longer send a key meant for other work. `[]`
  is none; the list narrows each secret's own `only`, is fixed for the
  sandbox's life, and a fork or copy of a snapshot may only narrow it. In the
  API, the MCP tool and every SDK. See
  [secrets sandboxes never see](./security#secrets-sandboxes-never-see).
- **One deletion email a day, not one per pause.** A sandbox with
  `:retention` days of its own is a day or so from deletion after each idle
  pause, and its owners were emailed a warning on every pause, though using
  it again cancels the deletion. Warnings for dates you set this way are now
  emailed at most once a day for the account, listing every sandbox due, and
  never once a sandbox has woken or paused again since; the email says its
  own retention chose the date, and `null` keeps it while you have credit. See [pricing](./pricing#paused-storage).
- **A secret that could not be added is no longer silent.** When a request to
  a secret's host leaves your sandbox without the secret because our server
  could not add it at that moment, the sandbox now gets a
  `sandbox.secret_not_applied` event with reason `withheld`, saying the fault
  is ours and what to do. See [events](./observability#events).

<!-- launch: apps -->

- **Run a command or copy a file in an App (private beta).** `runtime apps
exec <app> -- <command>` runs a command in an App's live copy, and
  `runtime apps cp <file> <app>:/<path>` copies a file onto it or off it. Only an owner's or admin's key may reach into a copy,
  since it holds the App's secrets. See
  [Apps in the CLI](./cli#apps-private-beta).

<!-- /launch: apps -->

- **A worker's key runs its own Apps.** A key made by another key, or a key in
  a compartment, can now create, list, deploy, roll back and delete the Apps
  and Functions its own agent made, as it does sandboxes, over the API and
  MCP. Another agent's App still answers 404. Such a key deploys from an
  image only: a deploy naming a `build` answers 403 (`forbidden`, or
  `outside_compartment` in a compartment); deploy builds with an account's
  key. Such a key asks an App for at most 2 `minCopies`, 2 `spares` and 20
  `maxCopies`; a larger App is made with a key made on the website. It
  cannot give an App or Function a name one of the account's own Apps holds:
  create or rename answers 409 `name_taken`. See
  [Run a swarm](./teams#run-a-swarm).
- **MCP: `runtime_apps` action `deploy` takes its `id`.** It refused its own
  `id`, and listed no `image` or `build`, for every key; it now takes them.
  The `runtime_apps` tool also answers a worker's or compartment's key in the
  Apps beta, which it refused before.
- **Snapshots and forks in bursts no longer wait running.** A snapshot or a
  fork of a running sandbox now stops it at once, so the snapshot, or the
  fork's copies, hold the memory of the moment you asked, and then waits for
  its turn at the server's disk with the sandbox stopped. Before, it waited
  for that turn with the sandbox still running, and a burst on one server
  could take tens of seconds each, the sandbox changing all the while. A
  sandbox whose time limit or funded time ends soon, on a busy server, still
  waits running and stops at its turn, as before. See [products](./products).
- **Secret scopes in the Python, Go, Ruby and Java SDKs.** The SDKs can now
  give a secret to some sandboxes instead of all of them, as the JavaScript
  SDK can: `only` on `secrets.set` (`only=` in Python and Ruby, `Only` in Go,
  a sixth argument in Java) and `secrets.scope(name, only)` (`Scope` in Go),
  which changes who gets an existing secret without its value. Python is
  0.17.0, Go 0.6.0, Ruby 0.5.0 and Java 0.5.0. See
- **Give a secret to one App's copies.** `runtime secrets scope NAME --only-app <app id>`
  gives a secret to every copy of an App, including copies later deploys,
  restarts and scaling make; a deploy names the secrets its copies see with
  `secrets: ["NAME"]`, and a copy holds only the placeholder. An App copy's
  identity token now says which App it is (`app_id`). See
  [secrets sandboxes never see](./security#secrets-sandboxes-never-see).
- **A sandbox out of memory still answers.** When a sandbox's programs fill
  its memory, Linux now ends one of them for memory, as the guide says,
  instead of the whole sandbox slowing until commands, reads and kills time
  out. Your programs share its memory less a small reserve for the sandbox's
  own services. See
  [when a program runs out of memory](./sandbox-environment#when-a-program-runs-out-of-memory).
- **Upload stalled: a clear answer in 30 seconds, not a 503 after two minutes.**
  A request whose body stops arriving for 30 seconds, such as a chunk of a
  large upload, is now answered at once with the bytes received, where before
  it waited about two minutes and answered `503 api_unavailable`. A body that
  keeps arriving, however slowly, is never cut. The SDKs and the CLI get
  `503 body_stalled` and send it again by themselves with the same key; other
  clients get `408 request_timeout`. See
  [errors](./api#responses-and-errors).
- **Fetch a web page in under a second with a paused browser.** The guides
  show how to keep spare browsers paused, charged only for storage, and wake
  one per page: wake to page done measured 0.56 to 0.81 seconds. Python's
  guide gains its browser section. See
  [A page in under a second](./javascript#a-page-in-under-a-second).
- **Connection limit per site: 429 Too Many Requests from the egress proxy.**
  A sandbox opens up to 20 new connections a second to one site, and an
  account's sandboxes on one server up to 100 together, after a burst. Past
  it the connection is refused with `429` and a sentence naming the site.
  Downloads over open connections, installs, clones, storage, CDNs and AI APIs
  are never counted. See [connections to one site](./egress#connections-to-one-site).

- **Identity tokens from any running sandbox.** A program with no
  `RUNTIME_ID_TOKEN_REQUEST_*` variables, such as one started before they were
  set or a sandbox kept from older guest software, now gets a token too:
  `Sandbox.identityToken()` (TypeScript 0.17.3), Python's
  `Sandbox.identity_token()` (0.16.2) and `runtime sandboxes identity-token`
  ask the sandbox's host for them, and the docs show the same with curl alone.
  See [identity tokens](./identity-tokens).
- **No 429 for a busy key right after an update of Runtime.** A key whose
  account runs many sandboxes may send up to 8 times the ordinary rate. Just
  after Runtime updated its servers, its first requests met the ordinary
  rate instead, for the moment it took to recognise the key, so a burst
  sent then was answered `429 rate_limited`. Those requests now wait that
  moment, at most two seconds, and are served at the key's own rate.
- **Daytona's GPU and sort enums import from the drop-ins.** The Daytona
  drop-ins follow Daytona 0.225.0 and the Prime Sandboxes one follows 0.4.6.
  `GpuType`, `SandboxClass` and the list sort enums now import from
  `withruntime/daytona` and `withruntime.daytona`, and the sort enums sort
  `list`. A Python create that asks for a GPU type now gets a plain error,
  as TypeScript already did, instead of a CPU sandbox. Prime's new
  `lan_network_id` on create is refused before a sandbox is made, naming
  Runtime's private network. See [Migrate](./migrate).
- **Idle sandboxes now pause after 5 minutes.** A new sandbox, browser or
  sleeping container pauses after 5 minutes with nothing happening in it by
  default, where it was 1 minute before. Rates are unchanged, but an idle
  sandbox that sets no idle time now runs, and is billed for its memory, up
  to 4 more minutes before it pauses; set `idlePauseSeconds` to 60 to keep
  the old default. The shortest idle pause is now 60 seconds, not 10: a time
  of 10 to 59 seconds you set on a new sandbox, or change to, is raised to 60,
  so that sandbox runs, and is billed, until 60 seconds idle. The answer shows
  the 60 it got; 0 still turns pausing off. Sandboxes made before today keep
  the setting they have, under 60 too. See
  [pause when idle](./javascript#pause-when-idle).

## 17 October 2026

- **Browser starts in about 1 to 2 seconds in a new sandbox.** The browser
  now comes ready on the sandbox's host instead of being downloaded and
  installed on its first start, which took up to a minute: `browser.start()`
  in a brand-new sandbox now returns in about 1 to 2 seconds. A custom image
  that is not Ubuntu 24.04 x86_64 still installs it once on its first start
  (withruntime 0.17.2, and 0.16.1 for Python). See
  [A browser over CDP](./javascript#a-browser-over-cdp).
- **Give a sandbox a key without typing it into a command.** In the CLI,
  `--env NAME` with no `=` sends that variable's value from your own shell, as
  `docker run -e NAME` does, on `create`, `update`, `exec` and `run`
  (withruntime 0.17.1). The security guide now shows how to install a key
  your sandbox's server checks on incoming requests, and the same key at
  another provider, and how to rotate it with no failed request. See
  [Shared keys](./security#a-secret-your-sandbox-checks-on-requests-it-receives).
- **Swarm worker keys cannot reach scheduled jobs or their secrets.** A key
  made by another key with reach `agent` now gets `403 forbidden` on
  `/v1/secrets`, `/v1/jobs` and `/v1/job-runs`, and on the `runtime_jobs` and
  `runtime_secrets_jobs` tools, as the guide already said for secrets: a
  job's secrets belong to the person the key's agent serves, often the owner.
  See [Run a swarm](./teams#run-a-swarm).
- **A revoked worker's spend still counts against its maker's limit.** A key
  revoked, expired or retired counts what it spent in the last day toward
  the daily limit its maker's keys share, so revoking a worker that spent its
  limit and making another no longer spends that limit twice.
- **Run commands as root.** A command, background process or terminal now
  takes `user: "root"` and runs as root, with its environment, `PATH` and
  working directory kept and `HOME` set to `/root`, so nothing needs a `sudo`
  in front. The default is still the sandbox user, `runtime`, and each process
  says which it runs as. It is in the API, MCP, the JavaScript, Python, Go,
  Ruby and Java SDKs, and the CLI (`--root` on `exec`, `spawn`, `run` and
  `shell`). Coming from Freestyle, whose VMs run as root? See
  [how to switch](./freestyle-alternative#how-to-switch).
- **Keys limited to sandboxes.** A key can now be limited to a few sandboxes
  and to what it may do to them: look, start and restart, stop, run commands,
  or reach files. It is served nothing else, so a watcher that restarts one
  server holds no key to the rest of your account. Make one with
  `runtime keys create --sandbox <id> --actions get,create`, or `sandboxes` and
  `actions` in `POST /v1/keys` and `runtime.keys.create`. See
  [Teams](./teams#a-key-limited-to-sandboxes).
- **.NET programs run.** Programs built on .NET 7 or later, such as `dotnet`,
  PowerShell and GitHub's Actions runner, no longer stop as they start with
  "File size limit exceeded". Commands in a sandbox had a file-size limit as
  large as its disk, and .NET sizes an in-memory file at 2 TiB to map its code
  twice. Commands now have no file-size limit, as on any Linux machine: a file
  still cannot hold more than the disk, but sparse files and in-memory files
  larger than it work. New sandboxes get this. See
  [Sandbox environment](./sandbox-environment).
- **Wake and restart wait for room.** In the JavaScript, Python, Ruby, Go and
  Java SDKs, a sandbox's `wake` and `restart` now wait for room as `create`
  does. When the sandbox's own server is full (`no_capacity`), the SDK sends
  the call again with the same idempotency key, for up to two minutes by
  default, instead of failing in a few milliseconds. A sandbox stays on its
  server, so waiting is the only way it gets room. Set `waitForCapacityMs`
  (JavaScript) or `wait_for_capacity` (Python, Ruby) on one call; `0` fails at
  once. A fork never waits. See [JavaScript](./javascript#errors-and-retries).
- **API rate limit grows with your sandboxes.** An API key's rate now grows
  with the sandboxes its organization runs, as its requests in flight already
  did: about 170 requests a second in bursts of 675 with 40 sandboxes, up to
  400 a second in bursts of 1,600. Before, every key stayed at 50 a second
  however many sandboxes it drove, so one key running dozens of agents was
  answered `429 rate_limited` for much of its work. See
  [Limits](./api#limits).
- **Paused sandboxes keep their memory when many pause at once.** A sandbox
  told it was paused is now written to disk early enough even while many
  other sandboxes on its server are pausing too. Before, one could wait too
  long behind them, and wake from its disk alone with its memory lost. See
  [pause and wake](./javascript#pause-wake-extend).
- **Console pages no longer hang.** A console page whose data the database
  is slow to give now stops within 15 seconds and shows "This page did not
  load" with Try again, where it could spin for minutes. Nothing you run is
  affected. See [troubleshooting](./troubleshooting).
- **Relabelling a sandbox into a secret's scope takes effect at once.**
  Changing a running sandbox's labels so a scoped secret reaches it (or no
  longer does) now waits until its server holds the change, and the answer
  carries `secretsEnforced: true` (for a key that may read secrets; any
  other key's relabel takes up to 15 seconds, as before). Before, requests could go out without the
  value for up to 15 seconds after the label call returned. See
  [Security](./security#secrets-sandboxes-never-see).
- **A job run that reaches its timeout ends as a timeout.** A run whose
  timeout was as long as its paid time (a one-hour timeout, say) ended
  `unknown` or `canceled` with the reason `compute_stopped` when it ran to the
  end, with no exit code and no retry. It now ends `failed` with the reason
  `timeout`, keeps its exit code and output, and is retried when the job asks
  for retries. See [jobs](./jobs#what-a-run-is).
- **FUSE filesystems.** sshfs, rclone, s3fs, gcsfuse, bindfs or your own FUSE
  program mount in any sandbox as its own user, and a mount lasts through a
  pause and a wake. See
  [FUSE filesystems](./sandbox-environment#fuse-filesystems).

## 16 October 2026

- **Identity tokens in Python and copied programs.** Python's
  `Sandbox.identity_token()` (0.13.1) now asks again with the sandbox's
  current request token when the one a program started with is refused, as
  the TypeScript SDK does, and both SDKs (TypeScript 0.15.1) read it from the
  sandbox itself first, so a server carried into a fork gets a token naming
  its own sandbox instead of a 403. See [identity tokens](./identity-tokens).
- **Private preview link expiry.** A WebSocket, stream or download opened
  with a private preview's link now ends when that link expires, so a link
  made to last ten minutes, or one read through a sandbox session, opens
  nothing past its end. Open it again with a fresh link. See
  [private preview tokens](./api#private-preview-tokens).
- **Enterprise features on the pricing page.** The [pricing](https://withruntime.com/pricing#security-and-team-features)
  page now lists single sign-on, SCIM directory sync, roles, the audit log,
  two-step sign-in, key limits and compartments, the data processing addendum
  and the uptime promise, each free on every account with no enterprise plan
  or seat fee. See [pricing](./pricing#security-and-team-features).
- **Retrying a create refused for no room.** The API guide now says a
  request refused before it ran, such as a create answered `no_capacity`, is
  not replayed: retrying with the same `Idempotency-Key` runs it again, and
  the create reference names the refusal and its `Retry-After`. See
  [retries and idempotency](./api#retries-and-idempotency).
- **Identity tokens in long-running programs.** A program that runs for a
  long time inside a sandbox, such as a server or an agent, now keeps getting
  identity tokens after the sandbox's request token changes: the TypeScript
  SDK asks again with the sandbox's current one instead of failing with a 403.
  See [identity tokens](./identity-tokens).
- **Referral share after a refund or a lost dispute.** If every matched
  payment from someone you referred is refunded or disputed, their use no
  longer earns you a monthly share. If they lose a dispute, your share now
  starts again after one month instead of stopping for good. See
  [referrals](./referrals).
- **Someone leaving no longer deletes what they stored.** When a member is
  removed, or your directory suspends them, the disks,
  snapshots, volumes and images they made stay on the account's credit like
  anything else. Until now their storage stopped being paid for and was
  deleted seven days later, with a notice that blamed missing credit. A
  storage item still stops only when the account itself has no credit, hits
  a spending limit, or is suspended. See [teams](./teams).
- **Faster console pages.** Agents & API keys, Networking, Secrets, Webhooks,
  Two-step sign-in, Audit log, Limits, Support and Close account now download
  about a quarter less code, and Home, Usage & billing and each sandbox's page
  less too, so they open sooner on a slow connection. A mistyped address's
  "not found" page is lighter as well. See [the quickstart](./start).
- **Pay per call credits even after an interruption.** A sandbox paid for
  per call over HTTP 402 is now credited to the paying wallet's account
  within minutes, even if our server stopped right after sending your
  transfer and you never used the claim code. See
  [pay with stablecoins](./pricing#pay-with-stablecoins).
- **Pause vs stop a sandbox.** One table now shows what a pause, a stop
  and a delete each keep, how the sandbox comes back, when each happens on
  its own and what each costs. See
  [pause, stop or delete](./sandbox-environment#pause-stop-or-delete).
- **Open a sandbox in your editor in one step.** `runtime sandboxes code <id>`
  opens the sandbox in VS Code over SSH, and `--editor cursor` or
  `--editor windsurf` in Cursor or Windsurf. It sets up the SSH entry the first
  time and installs an SSH server in a sandbox without one. See
  [SSH and editors](./editors#open-it-in-vs-code-cursor-or-windsurf).
- **Blaxel session default length.** With the Blaxel drop-in,
  `sandbox.sessions.create()` with no `expiresAt` now makes a session that
  lasts a full day, as Blaxel's does, instead of a second less. See
  [moving from Blaxel](./blaxel-alternative).
- **Usage export and held credit.** The API guide now says which charges the
  usage export leaves out: credit held for work still running is not in it,
  and becomes a row once it settles. See
  [export settled usage](./api#export-settled-usage).
- **HTTP/2 to the hosts your secrets name.** A sandbox's HTTPS requests to a
  host that one of your secrets names now go over HTTP/2 when your client and
  the host both offer it, as they already did to every other host. Concurrent
  calls to that host share one connection instead of each taking one of the
  sandbox's connections, and gRPC works there too. Each request is still
  checked on its own: its host, its rules and where the value goes. See
  [security](./security).
- **A restart runs the image's start command again.** A sandbox from an
  image with a start command (a Dockerfile `CMD`, or `start` in
  `images.build`) now runs it again after a stop and `:restart`, a `:resize`,
  or a `getOrCreate` that restarts it, and reports it in `start` as a create
  does. Before, the server it started was gone until started by hand. See
  [images](./images).

- **Identity tokens in scheduled jobs, documented.** The [jobs](./jobs) and
  [identity tokens](./identity-tokens) guides now say that a job's run has
  `RUNTIME_ID_TOKEN_REQUEST_URL` and `RUNTIME_ID_TOKEN_REQUEST_TOKEN`, as any
  sandbox does, so a job can get a token for AWS, Google Cloud or your own API
  with no stored key.

## 15 October 2026

- **Hundreds of outbound connections, and a clear answer at every limit.**
  A sandbox of an account that keeps a top-up now holds 512 outbound
  connections open at once for each vCPU, up to 4,096, where every sandbox held 64. In a test, 500 HTTPS connections opened at once from a 1 vCPU sandbox
  all connected, where 436 of them were reset before. New connections a
  second (20, after a first 128 at once) and new hosts a minute (120) stay
  as they were for every sandbox; past them a connection waits its turn
  instead of being reset. Past any limit a connection gets `503` with the
  limit in `X-Runtime-Egress`, and the account event `sandbox.network.limited`
  says which limit, at most once an hour. `GET /v1/sandboxes/{id}/network`
  shows a sandbox's limits. Accounts without a kept top-up keep 64. See
  [the sandbox environment](./sandbox-environment).
- **Keep sandboxes on separate servers.** A create takes `spreadFrom`, up to
  16 ids of your sandboxes or snapshots, and starts on a server none of them
  is on. Every sandbox and snapshot now shows `placement`, an opaque tag that
  is the same when two share a server. A copy of a memory snapshot starts
  only on its snapshot's server, so keep warm sources apart and spread copies
  across their snapshots: each server starts copies at its own pace rather
  than refusing them `account_busy_here`. See [the API](./api).
- **A sandbox's time limit can be set or changed after it starts.**
  `:update` (`sandbox.update()` in the SDKs, or the CLI's
  `runtime sandboxes update --timeout`) takes `timeoutSeconds`, a new limit counted from now, sooner or
  later than before (`0` removes it), and `onTimeout`, what its end does. A
  sandbox made without a limit can now get one. E2B's `setTimeout` to an earlier
  time works under `withruntime/e2b` instead of throwing. See
  [Sandboxes in the API guide](./api#sandboxes).
- **Custom domain on an App.** An App can serve your own domain, apex or
  `www`, through every deploy and rollback. Its HTTPS certificate is issued and
  checked before you point the name at the App, so the first visitor already
  gets HTTPS, and it renews by itself at least 30 days before it expires. See
  [networking](./networking#on-an-app).
- **Referral and welcome matches always land.** A referral or welcome match
  that could not be decided the moment you paid, for a passing error on our
  side, is no longer lost: it is tried again within minutes until it is paid,
  and your payment is never held up by it. See [referrals](./referrals).
- **Which stopped sandboxes lose their disk after three days.** Pricing now
  names them by client version, not by date: a sandbox made by a JavaScript
  or Python SDK before 0.12.0, Go, Java or Ruby before 0.2.0, or raw HTTP
  without `x-runtime-client: http/2026-10-04` keeps its disk free for three
  days after it stops, then it is deleted. JavaScript 0.11.1 and 0.11.2 and
  Python 0.11.1 came out after 4 October and count as older. See
  [paused storage](./pricing#paused-storage).
- **pip install withruntime on Python 3.9.** The Python SDK now installs and
  runs on Python 3.9, the `python3` a Mac comes with, where `pip` used to
  find no version of it at all. See the [Python SDK](./python).
- **GitHub API rate limit exceeded.** Calls to GitHub's API without a token
  share GitHub's 60-an-hour limit with every sandbox sending from the same
  address. The guide now shows how to save a GitHub token as a secret that the
  network adds to each call, so tools get your own limit with no change. See
  [shared addresses and per-address limits](./egress#shared-addresses-and-per-address-limits).
- **llms-full.txt names each page.** Every guide in `llms-full.txt`, the
  docs in one file, now starts with its address, so an assistant that reads
  the one file can link you to the page a fact came from. AI assistants' search crawlers now get the home page itself
  rather than the plain-text quickstart. See [start](./start).
- **Listing sandboxes is faster.** `GET /v1/sandboxes` and every SDK's
  list answer a page about three times sooner in any account with more than
  one sandbox, and a list of only running sandboxes in an account with
  thousands of stopped ones answers in milliseconds where it read all of them.
  `GET /v1/usage` answers two to three times sooner in large accounts, and
  `GET /v1/me` no longer waits on a usage read. The answers are the same. See
  [Sandboxes](./api#sandboxes) and [Account](./api#account).
- **Refer someone, not only a company.** The referral in Billing and Home
  now reads "Refer someone", and your billing history names someone you
  referred rather than a company: anyone you bring to Runtime counts. See
  [referrals](./referrals).
- **Set up Runtime with one line for your coding agent.** A new account's
  Home now opens on the line to paste into Claude Code, Codex or Cursor,
  shown as it will be pasted, with one Copy button; starting a sandbox in the
  browser comes next, and the key and install steps by hand are folded below.
  The line is shorter everywhere: "Move this project to Runtime Cloud: read
  https://withruntime.com/llms.txt and follow it." See
  [Get started](./start).
- **Free hours card fits on every page.** The "100 free hours" card at the
  end of the changelog, pricing and about pages now holds its whole title on
  wide screens, where its second line ran past the card's edges. See
  [pricing](./pricing).
- **MCP server instructions on first connect.** When `npx withruntime mcp`
  connects through `runtime_connect`, its answer now carries Runtime's full
  instructions (limits, cleanup, safe retries), which an agent's first session
  never saw before. If your client does not show the new tools, restart it:
  the connection is saved. See [MCP](./mcp).
- **`sandboxes run` deletes its sandbox.** `npx withruntime sandboxes run`
  now deletes the sandbox when the command ends, so
  nothing is left billing for disk and an account without credit no longer
  reaches its 10 kept sandboxes after ten runs. `--keep` still keeps it. See
  [CLI](./cli).
- **Volume restored from a backup stays put.** A volume made from a backup
  can no longer be removed after it is ready by a restore attempt that
  finished late, and the nightly backups keep earlier copies whenever a night
  could not read the data they protect. See
  [Volume backups](./storage#volume-backups).
- **A paused sandbox wakes when its server can't take it.** A wake whose
  sandbox's own server is full, out of service or lost now comes back on
  another server from the sandbox's saved copy, files and memory as they were,
  where it was refused `no_capacity`. Each server is checked for this after
  every release before it takes another server's sandboxes. See
  [pause, wake, extend](./python#pause-wake-extend).
- **Free account limits for backups, feedback and support.** An account
  without credit keeps a volume backup at most seven days, like its snapshots
  and paused sandboxes; one that has never added credit files 5 feedback
  reports and sends 40 support messages a day. Adding credit lifts them. See
  [volume backups](./storage) and
  [feedback and support](./feedback-and-support).
- **Preview token expiry explained.** Each create or read of a private
  preview signs its own token with its own `tokenExpiresAt`, so a list after a
  week-long create shows a different token that ends sooner; the token you
  already hold still works until its own expiry or a rotate. See
  [private preview tokens](./api#private-preview-tokens).
- **Sandbox environment changes and running programs.** `:update` changes a
  paused or stopped sandbox's `env` too, and a program already running keeps
  the values it started with, so restart it to pick up a change. See
  [Sandbox environment](./sandbox-environment).
- **Vouch for a scheduled job.** An owner or admin can now vouch for a job on
  its page in the console. Each run's identity token then names the job, its
  version, who made it and who vouched for it, so your own API can accept a
  job's call only when a person stood behind exactly what it runs. Any change
  to the job takes the vouch off. See
  [identity tokens](./identity-tokens#what-a-token-says).

- **Code for the newest rival SDKs runs on Runtime.** The drop-ins follow
  Daytona 0.224.1, E2B 2.56, Blaxel 0.3.30 (Python 0.4.18), Freestyle 0.2.20,
  Modal 0.11.1 (Python 1.6.2), Prime Sandboxes 0.4.5 and Vercel Sandbox 3.8.0
  (Python `vercel-sandbox` 0.9.1 and `vercel` 0.12.0). New here: finding a
  stopped Modal sandbox by name (`includeTerminated`); Prime checkpoints, and
  creating a sandbox from one; input to a running Vercel command (`stdin`,
  `writeStdin`, `onStart`); Freestyle terminals that
  reconnect after a dropped connection, and `connectXterm`; Blaxel's error
  helpers, preview shorthand and `createIfExpired` tokens; a Prime background
  job that cannot start now fails instead of reading as running. Anything
  Runtime cannot do, such as another Daytona region or Prime LAN networks, is
  refused with a plain error rather than ignored. See
  [Migrate](./migrate).
- **A snapshot of a running sandbox answers sooner.** `sandbox.snapshot()` in
  every SDK now asks the server once, and the server pauses the sandbox for
  the capture and wakes it before answering, where the SDKs paused, captured
  and woke it in three calls of their own. A repeat snapshot of a 4 GiB
  sandbox took 1.19 s at the median instead of 1.96 s in Virginia. Snapshots
  and forks also see they are ready sooner on the server.
- **Images start where their base says.** A Dockerfile stage `FROM` an image
  now starts in that image's `WORKDIR`, as its `USER`, with its `CMD` and
  `ENTRYPOINT`, as on Docker: `FROM golang` builds in `/go`. An image built
  from `{image: "redis:7"}` starts redis. See
  [Custom images](./images#build-from-a-dockerfile).
- **Dockerfiles read more like Docker reads them.** An `ENV` now beats an
  `ARG` of the same name in `RUN`, an `ARG` with no value stays unset (so
  `${FOO:-default}` gives the default), quotes and `\$` keep `$` literal in
  `COPY` and `ARG`, and `COPY --chmod` takes symbolic modes such as `a+x`.
  `COPY --from` naming its own stage is refused with a clear message. See
  [Custom images](./images#build-from-a-dockerfile).
- **Containers from slow registries start.** Reading a container's image
  allows 5 seconds for each request rather than for the whole read, accepts
  `index.docker.io` and `registry.hub.docker.com` as Docker Hub, and refuses
  an image built only for arm64 at create instead of failing later.
- **Prove a volume backup restores.** The storage guide now says what a
  `ready` backup already proves, that only a restore checks every byte, and
  how to prove one: restore it, check it, and delete the restored volume,
  charged only while it exists. A restored volume counts toward your volume
  limit. See [volume backups](./storage#volume-backups).
- **Creates from a snapshot no longer fail because its servers are full.**
  When the servers keeping a disk snapshot have no room, the sandbox now
  starts on another server in the region, once a verified copy of the
  snapshot is brought there from its backup. That create takes longer (the
  copy arrives first) instead of failing with `no_capacity`. Each such
  create leaves the snapshot on one more server, so a snapshot used often
  is kept on more servers as it is used.
- **Dockerfile files are owned as Docker owns them.** `COPY` and `ADD` now
  write files owned by root unless `--chown` says otherwise, whatever the
  `USER`, and a `WORKDIR` that does not exist yet is made for the current
  `USER`. So `USER node`, `WORKDIR /app`, `COPY . .`, `RUN npm ci` builds, where
  it failed on an `/app` only root could write. See
  [Build from a Dockerfile](./images#build-from-a-dockerfile).
- **Paid accounts get 1 TiB of sandbox disk.** An account with credit now has
  1 TiB of disk across its sandboxes, up from 400 GiB. One sandbox is still
  at most 400 GiB. See [Limits](./limits).
- **An account without credit keeps 5 sandboxes.** Running, paused or
  stopped, down from 10; each is still up to 10 GiB of disk. A sandbox you
  already keep is never cut off: waking or deleting one is never refused, and
  an account keeping more than 5 makes new ones once it is under. Adding
  credit lifts the limit.
- **Morph Cloud code runs on Runtime after one import.** Change
  `from "morphcloud"` to `from "withruntime/morph"` (`withruntime` 0.16.0):
  snapshots and their cached `setup` steps, instances, `branch`, pause and
  resume, `exec` and HTTP services run as Runtime sandboxes, snapshots and
  previews. See [Switch to Runtime](./migrate).
- **Morph Cloud's Python code runs on Runtime too.** Change `morphcloud` to
  `withruntime.morph` in the imports (`withruntime` 0.14.0 on PyPI):
  `from withruntime.morph import MorphCloudClient`. The same calls work, with
  their `a`-prefixed async twins and Morph's `build` and cached `setup` chains.
- **A reference on the page that did not load.** When a page of your account
  fails to load, it now shows a reference number. Quote it when you ask for
  help, and support can find exactly what went wrong with that page. See
  [Feedback and support](./feedback-and-support).

## 14 October 2026

- **Making /workspace needs permission to write files.** `files:mkdir` on
  `/` or `/workspace` now needs a key that may write files, as on any other
  path, and a key that may only read is refused. If the path exists but is
  not a folder, it answers 409 `not_a_directory` instead of success. See
  [Files](./api#files).
- **A public preview's warning cannot be skipped from a link.** In browsers
  that do not say where a click came from, only the warning's own Continue
  button now takes a visitor past it. A link sent by someone else shows the
  warning first. See [Networking](./networking).
- **Image rebuilds get the newest base image.** A build `FROM python:3.12-slim`
  or `:latest` now starts from the image the tag names today, as
  `docker buildx build` does, instead of an earlier pull kept from a past
  build. `cache: false` (`--no-cache`) now always builds every step afresh.
  See [Faster rebuilds](./images#faster-rebuilds).
- **Comparison tables that read cleanly.** The tables on the comparison,
  blog and how-to pages are soft rounded cards again, with room around the
  text instead of a hard square outline, and Runtime's row in a price ranking
  is one even band. See [compare sandboxes](https://withruntime.com/compare).
- **Best sandbox for AI agents, compared.** A new page ranks every sandbox
  provider by the cost of the same agent job, sets their published start
  times beside ours, and names which one fits each need, GPUs and
  self-hosting included. The price index now opens on which agent sandbox is
  cheapest. See
  [Best sandbox for AI agents](https://withruntime.com/compare/best-sandbox-for-ai-agents).
- **Faster first paint on the website.** Guides, blog posts, comparisons,
  pricing and the home page now load only their own styles: a glossary page
  fetches 30 KB of them instead of 67 KB, the home page 25 KB instead of 61 KB.

- **A worker's own workers share its daily limit.** When a key with a daily
  limit makes keys, the limits of every live key under it, at any depth, now
  add up to at most its own, so a worker cannot multiply its cap by making
  workers of its own. Keys are made at most 8 deep, and a key in a
  compartment makes no keys. See [Run a swarm](./teams#run-a-swarm).

- **A wallet account's key is never lost to a failed save.** If
  `runtime_wallet_claim` cannot save the key it was just issued (a read-only
  config directory, say), it still connects and shows the key once, to keep.
- **A command on a paused sandbox starts sooner.** An exec, a file call or
  any other command sent to a paused sandbox with `autoWake` wakes it with two
  fewer steps before the command runs. A key that may run commands but not
  read the sandbox is still refused before anything wakes, as before. See
  [Wake on request](./javascript#wake-on-request).
- **Cost breakdowns you can read at a glance.** The worked sums on the
  comparison, blog and use-case pages, such as "Cost for the same job", now
  show as one card per provider with its total and a bar to scale, instead of
  text in a code box. The blog, how-to guides, glossary, pricing and changelog
  pages share the cleaner look of the sandbox page. Each page's Markdown is
  unchanged for agents. See [Runtime vs E2B](./e2b-alternative#cost-for-the-same-job).
- **MCP servers at a URL that never expires.** `public: true` on
  `sbx.mcp.start` (`public=True` in Python, `Public` in Go, `--public` in the
  CLI, `public` on `POST /v1/sandboxes/{id}/mcp` and the `runtime_sandboxes_mcp`
  tool) serves the sandbox's MCP servers at a public preview: URLs with no
  link token, so an agent is set up with them once. The `Authorization`
  header still guards every request, and stays the same at every start,
  after a restart too, until you stop the gateway. An idle sandbox pauses with
  its servers in memory and wakes on the next request. Reading the gateway
  no longer turns a public preview of its port back to private. Needs a
  kept top-up. See [MCP servers](./javascript#a-url-to-configure-an-agent-with-once).
- **The console stays fast for busy accounts.** Home, Usage & billing, a
  sandbox's own page and Networking no longer slow down as an account's
  history grows: on an account with 100,000 sandboxes in a month, Home opens
  in under a tenth of a second instead of 1.5 s, and Usage & billing in
  0.15 s instead of 1.2 s. Older pages of the audit log, and the log filtered
  to one kind of change, open as fast as its first page. See
  [the audit log](./teams#audit-log).
- **Your account's limits, from the API.** `GET /v1/limits` (and
  `runtime.limits.get()`, and the `runtime_limits_get` tool) now lists every
  limit the account is held to with what it uses of each now, the numbers a
  create past one is refused `quota_exceeded` by: sandboxes at once, their
  vCPUs and memory, volumes and the rest. An agent can watch them and hold
  back before it is refused. See [Limits](./limits).
- **Agent-only wallet accounts top up, watch their credit and recover a lost
  key.** On an account an agent opened with a wallet and no person pays for,
  an out-of-credit answer now tells the agent to add credit itself with
  `npx withruntime billing topup <usd>` (`details.addCredit.by` is `agent`).
  `GET /v1/limits` gains `credit`: the balance, the daily pace, the days it
  lasts and whether it is `ok`, `low` or `empty`. Webhooks can subscribe to
  `credit.low` and `credit.empty`. A lost key is replaced with the claim code
  (`runtime billing claim <code> --new-key`), which revokes every other key; at
  most 3 times a day, logged in the audit log, until a person takes the
  account over. See [pay with stablecoins](./pricing#pay-with-stablecoins),
  [limits](./api#limits) and [events](./observability#events).

- **Swarm worker keys stay inside their own sandboxes.** A key made by
  another key with reach `agent` now gets `403 forbidden` on the account's own
  settings, whatever its person's role: closing the account, webhooks,
  telemetry exports, the audit log, credit and billing, secrets, domains and
  networks. It still runs sandboxes, reads its own usage and makes its own
  keys; an account-wide one keeps everything. See
  [Run a swarm](./teams#run-a-swarm).
- **Code interpreter cells and terminals show in a sandbox's commands.** A
  sandbox driven only by E2B's `runCode` / `run_code` listed no commands at
  all. Each cell is now kept as its language (`python-cell · exit 1 · 2 s` for
  a cell that raised), and a terminal as its shell; never the code or what is
  typed. See [observability](./observability#commands).

- **`mkdir -p /workspace` through the files API is success.** `files:mkdir`
  (and the files tool's mkdir) on `/workspace` or `/` answered 400 "Refusing
  the root of a tree"; it now answers `created: false`, as for any folder that
  already exists. And `GET /v1/usage?key=` with something that is not a key's
  id answers 400 `invalid_request` rather than 500.

- **Wallet accounts and the welcome match.** An account an agent opened with a
  wallet, and that no person has taken over, no longer earns the welcome match
  or a referral reward on its payments. Once a person takes it over, its later
  payments earn them as usual. See
  [paying with stablecoins](./pricing#pay-with-stablecoins).
- **A key makes more keys over the API, with no browser.** For agent swarms and
  for accounts opened with a wallet. `POST /v1/keys`, `GET /v1/keys` and
  `DELETE /v1/keys/{id}`, `runtime.keys.create/list/revoke/usage` in the
  TypeScript SDK, and `runtime keys create --name worker-1 --daily-limit 5`
  with a key on the machine (`--browser` keeps the browser approval). New:
  `runtime keys ls`, `runtime keys usage <keyId>`, `runtime keys revoke <keyId>`,
  and `GET /v1/usage?key=`. Each key is its own agent, a new key never has more
  than its maker, and the daily limits of the keys a key made add up to at most
  its own. See [run a swarm](./teams#run-a-swarm).

- **The Python, Go, Java and Ruby SDKs no longer take a failure or a cut
  stream for a success.** A call that runs longer than 90 seconds gets its
  status early and its answer after; when that answer is an error (a create
  whose host was lost, say), Go, Java and Ruby now raise it, as JavaScript and
  Python did, instead of returning an empty result. A file read in Go, Java or
  Ruby is checked against the length and SHA-256 the API sends with it, read
  again if it came short, and refused rather than returned short. In Python's
  synchronous client, an event stream (a watch, a log follow) whose connection
  closed part way raises instead of ending as if it had finished. Each arrives
  with that SDK's next release.
- **Free usage is for trying Runtime, and a lower limit applies to every
  account at once.** An account that has never paid gets its 100 free hours
  (100 GiB-hours of memory and 25 vCPU-hours of active CPU) once, across the
  30 days from its opening, and then nothing until it adds credit. An account
  that has paid gets them every month, as before. Saved copies (10 GB) and
  disks (5 GB) stay monthly for every account, and the startup hours are
  unchanged. `GET /v1/usage` shows `freeUntil` on each of `allowances`: when
  the free machine time ends, or null once the account has paid. Usage &
  billing and the sign-in and offer pages say it the same way.
- **Without credit, fewer sandboxes at once, and a few new limits.** Four
  sandboxes run at once, not eight, with at most 8 vCPU and 16 GiB in all,
  not 16 and 32. An account keeps at most 10 sandboxes, running, paused or
  stopped (a create past it is refused with `no_credit_kept_limit`, 409), and
  makes at most 50 a day, in any 24 hours (`no_credit_daily_limit`, 429).
  Waking, resuming or deleting a sandbox you already keep is never refused.
  Scheduled jobs do not run without credit: a job waits with `blockedReason`
  `credits` until the account holds credit. Adding credit lifts all of these.
  Public previews and ports other than 80 and 443 were already for paid
  accounts only. The Python SDK's Inspect integration defaults to four
  sandboxes at a time.
- **Every limit is published, and an account with credit is charged, not
  capped.** With credit, an account keeps up to 10,000 volumes, snapshots,
  images, volume backups, jobs and secrets (5 volumes before), with no limit
  on the GBs of volumes and images, which its credit pays for. A
  `quota_exceeded` now names the limit and its number in its message and in
  `details` (`limit`, `max`, `raise`), including the vCPU, memory and disk
  limits that said only "quota exceeded". The [limits](./limits) guide lists
  every one, and the console's Limits page shows each with what the account
  uses.
- **A stop or delete never loses a snapshot or a sandbox's disk.** Stopping
  or deleting a sandbox while a snapshot of it is still being taken is now
  refused with `snapshot_in_progress` (409) and nothing changes, instead of
  destroying the sandbox and failing the snapshot; wait until the snapshot is
  `ready` and stop it again (see [troubleshooting](./troubleshooting)). A stop
  that comes while a paused sandbox is waking from its saved copy, or is still
  being copied to another host, or just after that copy was restored, keeps
  the copy and the disk. A resize of a sandbox that only its saved copy holds
  wakes it from that copy. A volume lost with its host keeps its newest ready
  backup past its retention, so the backup the error tells you to restore from
  is still there.
- **An agent with no shell can open and pay for an account over MCP.** Two new
  tools, `runtime_wallet_open` and `runtime_wallet_claim` (also at
  `/mcp?signup=wallet`), open an account paid in USDC: the first answers with
  an address per network, the exact amount and a claim code; the second
  connects once the payment lands. There is no free trial on this path. The
  Go, Ruby and Java SDKs gain the wallet calls, and `runtime_connect` picks up a key saved after the MCP server
  started. See [pay with stablecoins](./pricing#pay-with-stablecoins).
- **No paid-or-trial choice in the SDKs.** Free usage comes first, then
  credit, and there is nothing to choose, so the examples and options that
  showed `funding` are gone and Harbor and Inspect tell an account without
  credit to add credit for a bigger size. The option is still accepted
  (deprecated in Go and Java), so existing code runs.
- **A preview, port or private stream keeps going when you extend the time
  limit.** A long download through a private preview was cut at the end of
  the limit it began under even though you had extended the sandbox, and it
  now carries on into the new limit. A limit that really ends still cuts it.
- **Pages in the console answer faster.** Every page waits less for the
  sign-in check and makes fewer database round trips, a click from page to
  page no longer waits a fixed 0.3 seconds, and a new account's Home is
  built once, not twice.
- **A working sandbox's memory is not swapped out.** A running sandbox keeps
  its RAM in memory, and one near its own memory ceiling gives back disk cache
  before the kernel swaps its RAM.
- **A slow command start no longer holds up the sandbox's other calls.**
  Starting a command no longer blocks listing processes, reading or writing
  files and killing processes while it waits for a slot. A command that
  waits in line longer than 6 seconds is refused as busy, which is safe to
  retry, instead of ending with an unknown outcome.
- **Snapshots of badly fragmented disks no longer stall the host.** A
  snapshot of a private disk of 400,000 extents took the host's daemon
  8.2 seconds to map and now takes 0.32 seconds, with the same result. A busy
  host also keeps every running sandbox's disk use measured.
- **A short database outage no longer fails a start, stop, wake or delete.**
  A broken database connection no longer ends one of these as
  `operation_failed`, and after a database restart the first request on a
  reconnected connection is answered instead of failing with the old
  session's error.
- **A member an owner removed stays removed.** If an owner removes someone,
  or they leave, after your directory had deactivated and an invitation had
  brought them back, [single sign-on](./single-sign-on) directory sync no
  longer restores their membership when it turns them on again.
- **A wallet top-up that never reached the payment provider says so.** A
  claim whose top-up was never created no longer shows a pay-by time; it
  says to send the top-up again with the claim code.

## 13 October 2026

- **A secret can go to only some of your sandboxes.** A secret reached every
  sandbox of the account; it can now name the sandboxes that get it, by
  label or by id. `runtime secrets set NAME --host api.example.com
--only-label role=hub` (once per selector) or `--only-sandbox <id>` gives it
  to those alone, `--all-sandboxes` gives it to every sandbox again, and
  `runtime secrets scope NAME` changes who gets an existing secret without
  its value. The API takes `only` (and `PUT /v1/egress-secrets/{name}/sandboxes`),
  the SDKs `only` and `secrets.scope`, and MCP the same `only`. A new value
  keeps the scope it had. Settings → Secrets sets the scope and shows which
  sandboxes each secret reaches, and `GET /v1/egress-secrets` gives each
  scoped secret's `reaches`. See
  [secrets sandboxes never see](./security#secrets-sandboxes-never-see).
- **Every account page is drawn from one kit.** Home, Usage & billing,
  Sandboxes, Jobs, Secrets, Networking, Settings, Support and the rest are
  one column 1040px wide with the same spacing, bigger buttons, 13px text at
  AA contrast or better, and one Select, DatePicker and Input everywhere.
  Each page's loading outline is measured from the page that follows it, so
  nothing moves when it arrives.
- **Identity tokens work in a scheduled job's run.** `identity_token()` in a
  [job](./jobs) answered `identity_refused` (403) because the run read a
  token left from the sandbox's warm start. The command now gets the
  sandbox's current identity-token request token, as a command in the
  sandbox does. See [identity tokens](./identity-tokens).
- **Commands run in a sandbox at its open-connection limit.** A sandbox
  holding all of its open connections (a crawler, a server's keep-alives) had
  every command answered 503 "environment unavailable" until one closed. Its
  environment read now goes through, and everything else over the limit is
  still refused.
- **A terminal or tunnel cut by its sandbox ending says so.** When a sandbox's
  stop, pause, time limit or delete closes a terminal or a tunnel, you now
  get that reason, not `503 guest_failed`.
- **A full house names what it is waiting for.** A create from a snapshot,
  image or volume starts only on the servers that keep it. When those are
  full it answers `no_capacity` (409) saying so, with `details.keptOn` set to
  `snapshot`, `image` or `volume`, instead of saying the whole region is
  full; create without it to start anywhere in the region.
- **A custom image's creates start faster.** A create from a custom image
  goes first to a host that already ran the image at the same vCPU, memory and
  disk, where it restores from a start template instead of booting cold.
- **An email before your sandboxes are deleted.** Every account's owners are
  emailed the day-before deletion warning (it was sent only to pilots), with
  how many sandboxes and other items go and when, and a sandbox is told its
  retention started once, not again beside the warning. On an account without credit, adding credit before the deadline keeps them.
- **Deleting a sandbox the host had already removed completes.** A delete the
  host had carried out is answered as done, no longer "Guest not found" for
  good.
- **The support chat shows what it is doing.** Until the answer arrives, the
  chat says "Searching the docs…" and the like instead of bare dots. Account
  → Support is one chat window, and a short conversation lets the page scroll.
- **A quieter free hours card.** The card on Usage & billing is small: it says
  the hours are included every month for paying accounts, shows one plain
  line once they are used, and is never red.
- **Pasted secrets and plural CLI options work.** `runtime secrets set` drops
  the line breaks, bracketed-paste markers and outer spaces a pasted token
  carries, from standard input and the hidden prompt alike. `--hosts a,b` is
  `--host a --host b`, and likewise for `--allow`, `--deny` and `--connect`;
  any other plural is still refused as a typo.
- **A full snapshot count names its limit.** A snapshot refused at the
  account's count says which limit it is and that every key's snapshots
  count. See [limits](./limits).

## 12 October 2026

- **A new look for the console.** Usage & billing, Home, Settings, Close
  account, Sandboxes, Jobs, Secrets, Agents & API keys, Webhooks, Networking
  and two-step sign-in are rebuilt from one set of pieces: a near-white ground,
  white cards, pill controls and Inter. Usage & billing leads with the balance
  and the amounts to add, with auto top-up and the referral as rows, the month
  beside its products, limits as meters and the statement as a ledger. Home
  opens with one line, "All healthy." or "One thing needs you."
- **A scheduled job whose sandbox was deleted before it started runs
  again.** A run whose sandbox was deleted under it stayed "provisioning" for
  good, and a job runs once at a time, so the job never ran again. The run
  now ends as unknown (`compute_stopped`) and the next occurrence runs.
- **100 free hours every month.** Every account's free usage is now told
  in one figure: 100 free hours a month of a 1 GB machine, which is 100
  GiB-hours of memory and 25 vCPU-hours of active CPU (about 25 hours of a
  2 vCPU, 4 GB sandbox at half busy). Saved copies (10 GB) and disks (5 GB)
  are unchanged. It applies to every account.
  Usage & billing now
  shows the free hours left this month, with the memory and active CPU behind
  them, and the guides call it free usage throughout.
- **The Blaxel and Daytona drop-ins honour the create options they used to
  drop.** In `withruntime.blaxel`, `SandboxInstance.create(config, timeout=N)`
  (1 to 50 seconds, as Blaxel 0.4.13) deletes a sandbox not running in time
  and raises `SandboxCreationTimeoutError`, and `safe=True` checks the new
  sandbox answers. In `withruntime.daytona`, `create(timeout=...)` bounds the
  create, `queue_timeout` is how many minutes it waits for room (then
  `DaytonaQueueTimeoutError`), `pip_install_from_requirements` takes pip's
  index and link options, and `kvm`, a `dockerfile_commands` build context
  and `wait_for_resize_complete` are refused by name instead of ignored.
- **A busy sandbox's refusal keeps its own error.** When a call waits to
  retry `guest_busy` or a full house and its deadline ends the wait, the
  JavaScript SDK now throws that refusal, as it judged it would, instead of
  "The call was cancelled or ran past its deadline". Your own cancel still
  ends the call as a cancel.
- **Why a secret's placeholder arrived unchanged.** The troubleshooting
  guide now covers a rule's near-miss (`/ingest` is not `/ingest/`), paths
  that read two ways, clients that ignore `HTTPS_PROXY`, and what the
  sandbox's own `NO_PROXY` lists; the security guide links to it.
- **JavaScript cells with `await` keep their variables.** A `const`, `let`,
  `class` or function declared in a JavaScript or TypeScript interpreter cell
  that uses top-level `await` is there in the next cell, as in every other
  cell. Before, it ended with its cell and the next one read
  `a is not defined`. A cell run again may declare its `const` and `let`
  again, as in a browser console. See
  [code interpreter](./javascript#code-interpreter).
- **A paused sandbox that will not wake tells you what to do.** When
  `autoWake` is off, a call to a paused sandbox answers `sandbox_paused` (409)
  with "…and autoWake is off, so requests do not wake it: call wake, or update
  it with autoWake: true." The Go KeepAlive example no longer turns `autoWake`
  off, since it is on by default
  ([the API reference](./api)).
- **Clear words for an image limit below the base.** A build from Runtime's
  base (`FROM runtime`, or a recipe without a base) with a `build.maxImageMiB`
  under {{runtime-base-image-mib}}, the base's own size, is now refused when you
  send it, with the smallest value that works, instead of failing after it was
  queued.
- **Know when your usage export is final.** Every page of
  `GET /v1/usage/export` now carries `finalThrough`: no row settled before it
  can still appear or change, so a range ending at or before it is complete
  for good. Each row also says `final: true` once its sandbox or volume is
  deleted and every charge it will ever have is in the export. A volume's
  backups bill until their retention ends, so they are not final when the
  volume is. The CSV gains a last column, `final`. See
  [export settled usage](./api#export-settled-usage).
- **Compartments.** Wall a group of keys off from the rest of your account:
  choose **One compartment** when you make a key at API keys. A key in a
  compartment sees and uses only the sandboxes, snapshots, images, volumes,
  previews, ports and jobs its compartment's keys made; everything else answers
  "not found", and no other key reaches in except an account-wide one. Give one
  to each customer of your platform, or to an agent whose sandboxes nobody
  else may touch. Each compartment has its own sandbox names, so every
  customer can have its own `main` ([compartments](./security#compartments)).
- **An email when your credit is in.** Each time you buy credit, Runtime emails
  you once it lands: what you added, the welcome or referral match it earned,
  and your balance now. An automatic top-up emails everyone on the account who
  may pay. See [pricing](./pricing).
- **Delete sandboxes by label.** `runtime sandboxes rm --label team=search`,
  `sandboxes.deleteAll({ labels })` in JavaScript and
  `sandboxes.delete_all(labels=...)` in Python delete for good every sandbox
  with all the labels given, stopped ones too, the way stop by label already
  stops them. Each returns what it deleted and what failed. In the CLI's and
  each SDK's next release. See [the CLI](./cli).
- **Wallet top-ups say when they are off.** `POST /api/wallet/topups` answers
  404 with code `not_available` while wallet top-ups are switched off, instead
  of 503, so a client can tell an option not offered from an outage.
- **Storage reaches your usage export an hour sooner.** Each hour of storage (a
  paused sandbox's memory and disk, a stopped sandbox's disk, images,
  snapshots, volumes and volume backups) now settles within a minute of its
  end, usually seconds, instead of 58 minutes after it. Nothing is charged
  differently. See [export settled usage](./api#export-settled-usage).
- **A code for a new account by email.** Opening an account by email now asks
  for the six-digit code the email carries, typed on the page where you asked
  for it, instead of a link click. An address with an account gets one email
  with its link and a code, so signing in is still one click. Every address
  sees the same page, "check your email", so the page never says whether an
  address has an account. New accounts by email are not opened from
  data-centre or VPN networks, and no email comes: use Google there, or write
  to support@withruntime.com. An address gets at most five sign-in emails an
  hour, and ten wrong code tries a day; past that, its email has only the
  link.

- **A paused sandbox tells you how to reach it.** When a sandbox has paused
  and its autoWake is off, a request to it now answers `409 sandbox_paused`
  with what to do: call wake, or update the sandbox with `autoWake: true`. The
  Go keep-alive example no longer turns autoWake off, so a sandbox copied from
  it wakes on its next request. See [troubleshooting](./troubleshooting).

## 11 October 2026

- **Faster retries when a server cannot be reached.** When a connection to the
  API is refused before your request leaves, the SDKs (JavaScript, Python, Go,
  Java and Ruby) send it again at once instead of after a quarter of a second,
  so a server that just went away costs your call almost nothing. A request
  that may have reached a server waits and retries under its idempotency key as
  before, so nothing runs twice. In each SDK's next release.

## 10 October 2026

- **Auto top-up.** Usage & billing can add credit from a saved card when your
  balance falls below a line you pick, up to a monthly most you set. Each
  automatic top-up earns {{auto-bonus}} more as credit, and while it is on your
  account runs {{auto-sandboxes}} sandboxes at once instead of
  {{paid-sandboxes}}. A declined charge turns it off and never stops a running
  sandbox. Also `runtime billing auto-top-up`, the SDKs and
  `/v1/billing/auto-top-up`. See [auto top-up](./pricing#auto-top-up).
- **Jobs in the console.** A Jobs page lists every scheduled job: its schedule
  in words, its size, its last run and how it ended, its next run and this
  month's cost, with what needs you first. A job's page shows each run's state,
  start, length, exit code, cost and output, and pauses, resumes or cancels the
  job. See [scheduled jobs](./jobs).
- **Run a job now, or change its schedule.** Run now starts one run at once,
  beside the job's schedule; a paused job runs once and stays paused. Change
  schedule moves the next run to the new schedule's next time, and a run going
  finishes as it started. On the job's page, `runtime jobs trigger` and
  `runtime jobs reschedule`, the SDKs, MCP and `/v1/jobs/{id}:trigger` and
  `:reschedule`. See [jobs](./jobs).
- **Secrets in the console.** Settings → Secrets lists every secret your
  sandboxes and jobs use: the hosts each may reach, where its value goes, its
  rules, whether jobs have a copy, and who added and last changed it. Add a
  secret, replace its value or delete it there, as with `runtime secrets`.
  Values are never shown, there or anywhere. See
  [secrets sandboxes never see](./security#secrets-sandboxes-never-see).
- **Referrals pay on every payment, and for a year.** When a company signs up
  with your link, every credit it adds in its first {{referral-days}} days is
  matched for both of you, up to {{referral-max}} for each company, not only
  its first top-up. Then, for {{referral-share-months}} months, you earn
  {{referral-share}} of what it spends from credit it paid for, up to
  {{referral-cap}} a year. Your link opens an invite page with the offer and a
  way to sign up. See [referrals](./referrals).
- **Creates stay fast with a thousand sandboxes.** A create now costs the same
  beside a thousand of your account's sandboxes as beside none: what it checks
  (sandboxes at once, quotas, a server's room) is kept as a running total
  instead of counted again at each create. On a test database with one account
  on one server, a create's database work beside 1,000 sandboxes went from 11
  to 85 ms to 6.3 to 9.7 ms, and 100 creates over 8 connections from 6 to
  11.5 s to 0.5 to 0.6 s. Every limit holds exactly as before.

## 9 October 2026

- **A limit without credit says plainly how to lift it.** Every refusal an
  account meets because it has not paid (sizes, sandboxes at once, builds,
  used-up included usage, public previews, open ports and the network
  features) now answers in one shape: what was refused and the limit, what to
  do now, and that the account's owner adds credit at Usage & billing, with
  the [welcome match](./pricing#welcome-match). `details.addCredit` says the
  same for code. See [responses and errors](./api#responses-and-errors).
- **Out-of-memory kills are reported.** When Linux ends a program because its
  sandbox ran out of memory, the command's result, its process and the
  stream's `exit` event carry `outOfMemory`: the code `out_of_memory`, how
  many processes were ended, the sandbox's `memoryMiB` and a hint (1,024 MiB or
  more, or a resize while paused). Each such command also sends the event
  `sandbox.out_of_memory` to your webhooks. See
  [when a program runs out of memory](./sandbox-environment#when-a-program-runs-out-of-memory).
- **Rebuilt custom images start warm from their first sandbox.** A new build of
  an image starts at the sizes your account's other images use on that
  server, before any sandbox asks for them; only your own account's images
  count. On a test server, a rebuilt image's first 1 vCPU, 512 MiB sandbox
  started in 120 to 139 ms, where it took 2,364 ms. See
  [fast starts](./images#fast-starts).
- **Custom images behave as on Docker in three more places.** A file the image
  puts in `/tmp` is there when a sandbox starts; a string command on an image
  without bash, such as Alpine or BusyBox, runs under `/bin/sh`; and
  `0.0.0.0` and the sandbox's own addresses skip the proxy, so a server you
  start in the sandbox answers from inside it. Existing images get this at
  their next cold start, with no rebuild. See [images](./images).
- **A secret goes only into a request header.** The proxy puts a secret's value
  in the header you set for it, or, with none set, in the credential headers
  (`Authorization`, `x-api-key`, `x-goog-api-key`, `api-key`, `xi-api-key`,
  `x-subscription-token` and `private-token`), never in a URL's path or query
  or another header, where the placeholder now goes out as it is. Stored
  OpenAI, Anthropic and Gemini keys keep working; code that put a placeholder
  in a URL should send it in a header. See
  [secrets sandboxes never see](./security#secrets-sandboxes-never-see).
- **A full disk answers `no_space` with how to free it.** A command, file
  write or other call that finds the sandbox's disk full answers 409
  `no_space`, with a hint: delete files, or create a sandbox with a larger
  `diskMiB`. The sandbox keeps taking commands, so the `rm` that frees space
  runs. See
  [troubleshooting](./troubleshooting#a-command-or-a-write-answers-no-space).

## 8 October 2026

- **Runtime for Startups now speaks of startup hours.** The machine time is
  {{startup-machine}}. Storage kept free each month and the at-once limits
  are what Runtime for Startups includes; the amounts and terms are unchanged.
  `GET /v1/usage` now names its fields `startupIncluded` and `startupLimits`,
  with the same shapes.
  The old fields `pot` and `potLimits` still work for 30 days after this change ships, with a warning.
  See [included usage](./included-usage).
- **Sign up with Google in one click, and start a sandbox from Home.** "Start
  free, no card" opens Google sign-in at once, with no human check to wait for
  (a sign-in by email link still has one), and a new account's Home opens on
  a sandbox you start with one click, then the prompt to paste into your
  agent.

## 7 October 2026

- **Every credit you add in your first {{welcome-days}} days is matched, up to {{welcome-max}} in total.**
  The welcome match now covers each payment, not only the first: add $20 and
  then $500 and you get $520 more. Home, the billing page and `runtime switch`
  show how much of the {{welcome-max}} is used and left
  ([welcome match](./pricing#welcome-match)).
- **Your first top-up is matched, up to {{welcome-max}}.** Every organization's
  first top-up made within {{welcome-days}} days of signing up is matched with
  credit, up to {{welcome-max}}, with nothing to claim; Home and the billing
  page show the date it ends ([welcome match](./pricing#welcome-match)). A
  referral now matches up to {{referral-max}} on each side
  ([referrals](./referrals)); the two never stack, and the larger applies.
- **Runtime for Startups gives a startup pot.** An accepted startup gets
  {{startup-machine}}, given once and used within 12 months, with
  {{startup-saved-copies}} of saved copies and {{startup-disks}} of volumes
  kept free each month for those 12 months, {{startup-builds}} image builds
  at once, {{startup-at-once}} sandboxes at once (up to {{startup-at-once-most}} on
  request), and every paid feature. The pot is used after each month's included
  usage and before credit. Apply at
  [withruntime.com/startups](https://withruntime.com/startups).
- **One plural word names each product everywhere.** `/v1/sandboxes`,
  `runtime.sandboxes`, `runtime sandboxes` and `runtime_sandboxes`, and the
  same for every product; from SDK 0.12.0, each product can also be
  imported alone, as `withruntime/<product>`. The old words keep working for 30 days, and each use
  warns with the new name ([the API](./api)).

## 6 October 2026

- **A browser says when its sandbox is small for heavy apps.** `browser:start`
  now answers the sandbox's `memoryMiB` and, under 2 GiB, a `hint`: heavy apps
  such as Google Sheets, YouTube and StackBlitz need 2 GiB. Of 100 visits to
  ten heavy pages, 56 crashed for memory at 1 GiB, 20 at 1.5 GiB and none at
  2 GiB. 1 GiB still suits light pages and scraping, and the browser starts
  at any size. `runtime sandbox browser start` prints the hint.
- **Usage included every month, for every account, and jobs run on it.**
  Every account now gets {{free-memory}} of machine memory, {{free-cpu}} of
  active CPU, {{free-saved-copies}} of saved copies (snapshots, images,
  backups) and {{free-disks}} of volumes each calendar month, enough for
  {{included-machine}}, with no card. It renews on the 1st (UTC), is used
  before credit and is never charged. New accounts get it in place of free
  hours; an account given free hours before 6 October keeps what is left of them,
  and has the included usage as well. `GET /v1/usage` lists each product's
  share under `allowances`, and `trial` gains `offer` and `renewsAt`. A
  scheduled job's runs spend it first, then credit, as a sandbox does; a run
  it cannot take, on an account without credit, waits with `blockedReason`
  `credits`. An account holds up to {{paid-jobs}} jobs and {{paid-secrets}}
  secrets for jobs, where it held 50 and 200. Credit, bought or given, now
  opens every paid feature but three: a kept top-up is needed only for ports
  beyond 80 and 443, public previews, and private networks and Tailscale.
  Without credit, an account runs at most {{no-credit-total}} at once across
  its sandboxes and image builds, beside 2 vCPU and 4 GiB each and eight at
  once; past it, a create, wake or build is refused with 409
  `no_credit_total_limit`, whose message says what runs now. Seven codes are
  renamed, in the API, MCP, CLI and every SDK: `trial_busy` is now
  `no_credit_running_limit`, `trial_capacity` `no_credit_capacity_full`,
  `invalid_trial` `no_credit_size_limit`, `trial_domain_limit`
  `no_credit_domain_limit`, `trial_build_limit` `no_credit_build_limit`,
  `trial_exhausted` `included_usage_used_up` and `trial_unavailable`
  `included_usage_unavailable`; code that compares with an old name should
  compare with both until it updates. See [included usage](./included-usage)
  and [what a job costs](./jobs#what-it-costs).

- **Volume backups cost {{backup-rate}} per decimal GB per 30-day month.** They
  cost {{backup-rate-before}}, which is below what keeping each backup in two
  places costs us: one copy beside the servers and one with a second provider.
  A backup made from now costs the new rate. One you already have keeps
  {{backup-rate-before}} until {{backup-raise-date}}, then costs the new rate
  too; a backup on the included usage stays free. Nothing else changes, and
  nothing is charged twice: a backup's hour that runs across the date is
  charged each part at its own rate. `GET /v1/usage` shows each backup's rate now under `rates`. See
  [pricing](./pricing).

- **Leaving a block deletes the sandbox it made.** From the next release of
  the TypeScript and Python SDKs, the end of an `await using` or `with` block
  deletes a sandbox that `Sandbox.create()` made there, where it used to stop
  it and keep its disk, which bills. Create it with `keep: true` (Python
  `keep=True`) to stop it instead, as before. A sandbox the block got with
  `get()`, or one `getOrCreate()` found already there, is still only stopped.
  The drop-ins keep each rival's own block exit: `withruntime/e2b` (Python)
  kills, `withruntime/vercel` stops in TypeScript and deletes in Python.

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
- **Downloads as fast as the server's link, and TCP ports five times
  faster.** A sandbox's downloads are no longer capped: each sandbox shares
  its server's link, and when several are busy a paid account gets four times
  the share of one without credit. Uploads stay limited, more strictly without
  credit ({{trial-upload}}); paid uploads are {{paid-upload}},
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
- **More E2B code runs unchanged on `withruntime/e2b`.** In the JavaScript SDK
  0.11.2 and the Python SDK 0.11.1, a hundred commands at once run at once,
  `kill()` deletes the sandbox, a template name resolves with its team and
  tag, `commands.list` gives `cmd` and `args`, file entries carry permissions
  and owners, paths under `/home/user` come back as E2B gives them, and in
  Python every module path e2b 2.52.1 defines a public name in imports. See
  [migrating](./migrate).

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
  had slowed it, its full cores back. See [included usage](./included-usage#after-you-add-credit).
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
  for $5,000 of credit, added over 12 months (since 7 October 2026, the
  startup pot instead: {{startup-machine}}, given once, to use within 12 months).
  An accepted startup's account counts as paid from the day it is accepted.
  See [pricing](./pricing).
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
- **Request a feature from the console.** The Support page has a Request a
  feature button, which opens the feedback form on a feature request and asks
  what the feature would let you build. See
  [send feedback](./feedback-and-support#send-feedback).

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
  hours run out. See [included usage](./included-usage).

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
  credit](./pricing#welcome-match): run `runtime switch --from blaxel` before
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
  hours too; hours already used still count. See [included usage](./included-usage).
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
