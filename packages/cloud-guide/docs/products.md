# Your Runtime Cloud account

One account owns every Runtime Cloud resource, its agent connections and its prepaid credit.

One key, one API, one SDK and one CLI reach every product, with the same
resource shape, errors, idempotency, pages and labels. The console at
withruntime.com/account shows what you can use today; an SDK method is not a
promise that another product is available.

## Products

| Product             | What it is                                                                                       | Status    |
| ------------------- | ------------------------------------------------------------------------------------------------ | --------- |
| Sandboxes           | Linux microVMs: commands, processes, terminals, files, pause and wake                            | Available |
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

The sidebar lists every product: **Home**, then **Sandboxes**, **Images** and
**Volumes**. At its foot are your credit, how long it lasts at this month's pace
and any free-trial hours left, then **Usage & billing**, **Settings** and
**Docs**. New accounts begin with a focused connection flow until their first
sandbox has started.

- **Home** is about what runs: each running or paused sandbox with a trace of
  its recent CPU, its memory and how long it has been up, with **Connect**
  (copies its SSH command) or **Wake**; what just happened across every
  product; and **Start something**.
- **New**, or ⌘K (Ctrl+K), opens one search box that goes to any page or
  resource and starts anything. Each start shows the CLI command and SDK call
  that does it, ready to copy.
- **Sandboxes** filters by state, with counts, and searches by name. Each row
  shows live CPU and memory and what the sandbox has cost this month.
- A **sandbox's page** has **Snapshot**, **Pause** or **Wake**, **Stop**, and
  **Fork** and its ID and SSH command under ⋯. Its tabs are Overview, Terminal,
  Files, Processes, Previews, Network, Metrics, Events and Settings. **Terminal**
  is a shell in the browser ([how it signs in](./security#the-browser-terminal)).
- **Images** and **Volumes** list each one with its details. An image's page
  shows every version with its tags and the build log, live while it builds; a
  volume's page shows its backups. Both give the commands that change them.
- **Usage & billing** shows your credit and how long it lasts, adds credit, and
  charts daily spend by product with an estimate for the rest of the month and
  where it went. Its ledger lists purchases, referral and switching credit,
  refunds and the free trial; a card purchase links to its Stripe receipt.
- **Settings** holds API keys, webhooks, members, single sign-on, the audit log,
  referrals and support, one tab each.

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
