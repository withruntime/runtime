# Your Runtime Cloud account

One account owns every Runtime Cloud resource, its agent connections and its prepaid credit.

One key, one API, one SDK and one CLI reach every product, with the same
resource shape, errors, idempotency, pages and labels. The console at
withruntime.com/account shows what you can use today; an SDK method is not a
promise that another product is available.

## Products

| Product             | What it is                                                                                       | Status    |
| ------------------- | ------------------------------------------------------------------------------------------------ | --------- |
| Sandboxes           | Linux microVMs: commands (kept 14 days by name), processes, terminals, files, pause and wake     | Available |
| Code interpreter    | A notebook-style session inside a sandbox in Python, JavaScript, TypeScript, R, Java, Bash or Go | Available |
| Network rules       | Per-sandbox internet, allow and deny lists; every port on paid accounts                          | Available |
| Secrets             | API keys sandboxes use without seeing, added by the egress proxy                                 | Available |
| Images              | Custom sandbox images from a recipe, any image or a Dockerfile, versioned and tagged             | Available |
| Volumes             | Persistent disks attached to sandboxes, backed up off their server daily                         | Available |
| Snapshots           | Saved sandboxes, disk and memory, to start and fork from                                         | Available |
| Previews            | An HTTPS address for a port in a sandbox, private by default                                     | Available |
| Desktop             | A Linux desktop in a sandbox, driven by clicks and keys                                          | Available |
| Metrics             | Each sandbox's measured CPU and memory over time, on its own page too                            | Available |
| Webhooks            | Signed lifecycle events POSTed to your URL, with retries and a log                               | Available |
| OpenTelemetry       | Events as logs and CPU and memory as metrics, pushed over OTLP/HTTP                              | Available |
| Bucket mounts       | Your S3, R2 or GCS bucket as a directory in a sandbox                                            | Available |
| MCP servers         | Servers from the MCP catalog run in a sandbox, at URLs your agent connects to                    | Available |
| Custom domains      | Your own hostname for a sandbox port, with HTTPS; paid accounts                                  | Available |
| TCP ports           | A public TCP port to a sandbox port; paid accounts                                               | Available |
| Dedicated addresses | A dedicated outbound IPv4 address, with IPv6; paid accounts                                      | Available |
| Private networks    | The tunnel: WireGuard from your network to your sandboxes, up to 16 peers; paid accounts         | Available |
| Identity tokens     | Signed tokens a sandbox uses to reach AWS, Google Cloud and others without stored keys           | Available |
| Single sign-on      | Sign in through your company's OIDC or SAML provider; SCIM adds and removes people; free         | Available |

**A fork or a snapshot keeps a sandbox's files, memory and running processes.**

- A snapshot stays on the server of the sandbox it came from, and forks and
  sandboxes started from it run there too. It is also copied off that server,
  so it survives losing it ([storage and backups](./storage)).
- A sandbox with volumes cannot be snapshotted.
- To install dependencies once and start many sandboxes from them, build a
  [custom image](./javascript#custom-images) and create each sandbox from it.

Start with [getting started](./start), then check
[the sandbox environment](./sandbox-environment) and [security](./security)
against your workload.

New products join the same namespaces as they launch: `runtime.<product>` in
the SDKs, `runtime <product> <command>` in the CLI, `/v1/<products>` in the API
and `runtime_<product>_<verb>` in MCP.

## The console

The sidebar holds everything. At its top is your account: its menu switches
account and holds Refer & earn, Support, the documentation, Runtime's status and
Sign out. Under it are **Search or create**, **Home**, then **Sandboxes**,
**Images** and **Volumes**, and at its foot **Usage & billing**, with your credit
(or the free trial left) beside it, and **Settings**. New accounts begin with a
focused connection flow until their first sandbox has started.

- **Home** is today's report. **Needs you** comes first when something does: a
  sandbox that failed to start or wake, or credit or free-trial hours about to
  run out (credit five days ahead at this month's pace). Then the few things a
  person still does by hand: connect another agent, open a terminal in a
  running sandbox, make a key and start a sandbox. Then sandbox
  time today, hour by hour beside the same hour yesterday, counted in your
  browser's time zone; this month's spend by product and where it is heading;
  the last five things that happened; and the account in lines: credit and how
  long it lasts, what runs now and how many started today, your images and
  volumes, and who started today's sandboxes.
- **Agents & API keys**, the first page of **Settings**, lists every key in two
  groups: **Agents**, connected
  from an agent tool such as Claude Code, Cursor or Codex, with the tool and
  machine it connected from, and **API keys**, made for a script, CI or a
  dashboard. Each says when it last started something, what it may do and its
  daily spending limit. Beside the list are today's starts hour by hour by who
  started them and each key's spend over the last 24 hours against its limit.
  **Needs you** names a key whose
  limit is refusing its starts, and a full-access key that has started nothing
  for 30 days; nothing is revoked for you.
- **Search or create**, or ⌘K (Ctrl+K), opens one search box that goes to any
  page or resource and starts anything. Each start shows the CLI command and SDK call
  that does it, ready to copy.
- **Sandboxes** describes today's runs as a whole: how many started, how many
  failed, how long they typically live and what they cost, with starts per hour
  beside yesterday, how long the runs that ended lived, and tables by who
  started them and by image. A create Runtime refused (an image that does not
  exist, a limit, credit run out) leaves no sandbox, and is counted here too,
  with the reason and the image asked for. **Needs you** says when failures
  rise above your usual rate, when creates are being refused, or when
  sandboxes run far longer than yours usually do. The list opens on those
  running now, with today's failures one tab away and their reasons in words;
  search finds any sandbox by name or ID, from any day.
- A **sandbox's page** says how it ended, how long it lived, who started it and
  from which image, and for one that did not end by request, why and what to
  do. Its life is drawn start to stop. **Copy for my agent** copies what
  happened, ready to paste; **Start one the same** copies the command that makes
  an identical one. While it runs its tabs are Overview, Terminal, Files,
  Activity and Settings. **Terminal** is a shell in the browser
  ([how it signs in](./security#the-browser-terminal)).
- **Images** leads with a failed build and the line it broke on, and with a name
  or tag your agents keep asking for that no image has, then today's
  starts, the share from your own images and the typical start time; starts a
  day by image beside the last 14 days of builds; and a row an image with its
  starts today, start time, failures, versions kept and cost. An image nobody
  started in 30 days offers the command that deletes it. An image's page shows
  every version with its tags and the build log, live while it builds.
- **Volumes** leads with a volume nearly full or behind on its backups, then
  how many sandboxes used your volumes today; cost a day by volume beside the
  sandboxes that used each a day, for the last 14 days; and a row a volume
  with how full it is, how many used it today and who, and its last backup. A
  volume's page shows how full it is, where it is attached and its backups.
  Both give the commands that change them.
- **Usage & billing** opens on your credit, adding credit in place, with the
  referral offer at its foot. Then the month in a line, with what the same sandboxes would have cost at the provider you came
  from (E2B when we do not know) over the last 30 days, at its published rates;
  daily spend by product, with where the month is heading, beside daily spend
  by who started it; what each meter came to, with its rate, beside each key's
  spend over the last 24 hours against its daily limit. Its ledger lists
  purchases, referral and switching credit, refunds and the free trial; a card
  purchase links to its Stripe receipt.
- **Settings** holds Agents & API keys, webhooks, members, single sign-on, the
  audit log and two-step sign-in, in groups in the sidebar.

The website acts on a sandbox with the same rights as your API keys. Owners and
admins may stop, pause, wake, snapshot, fork and open a terminal in any of the
account's sandboxes; developers, in the sandboxes their own agents started.
Billing members add credit and act on no sandbox.

What Usage & billing counts:

- Spend is settled service usage, not a count of payments or reserved credit.
- Charges use integer microdollars: one million equals one US dollar.
- Daily and monthly summaries use UTC.
- `npx withruntime usage` and `GET /v1/usage` give the same figures. Each
  resource's immutable quote and the [pricing guide](./pricing) say what it
  meters.

An agent connection has its own identity and revocable credential. Keys cover
all Cloud products, including products enabled later, and last until revoked.
Browser sign-out does not revoke them. See
[security and access](./security) before connecting an agent.

An account can have several people, each an owner, admin, developer or billing
member, and keeps an audit log of changes to members, keys, credit and security
settings. See [teams and the audit log](./teams).

## Labels and names

Sandboxes, images, volumes and snapshots take a `name` and up to 32 `labels`,
and their lists filter by them:
`npx withruntime sandbox ls --label team=search`,
`GET /v1/sandboxes?label=team:search`. Use them for tenants, jobs and cost
attribution.
