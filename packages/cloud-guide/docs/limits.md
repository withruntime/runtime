# Limits

Every limit an account is held to, in one place. An account with credit pays
for what it keeps. Its limits cover what runs at the same time and what it
stores. They reflect the room the fleet has, and they act as ceilings against a
runaway agent. Most customers never reach them. An account without credit has
smaller limits. Adding credit raises them immediately.

You can see your account's limits, and how much of each you use, on the
[Limits page of the console](https://withruntime.com/account/limits). A key
reads the same numbers from `GET /v1/limits` (`runtime.limits.get()` in the
SDK). They are in its `account` list, with each row's `limit` (such as
`sandbox.memory_mib`), `max` and `used`. An agent can check a limit before a
create is refused, and hold back new work when it nears the limit. A key
limited to a compartment, or a worker key another key made, sees only its own
sandboxes. Its `account` is null.

## When you meet one

A create past a limit is refused with `quota_exceeded`. A limit on what runs at
the same time returns 429 with `Retry-After: 5` and `retryable: true`. A limit
on what is kept returns 409 with `retryable: false`. It clears only when you
delete one. The refused create costs nothing.

The message names the limit and its number. The error's `details` give the same
information in code:

```json
{
  "error": {
    "code": "quota_exceeded",
    "status": 429,
    "message": "This account holds up to 5 volumes. Delete one you no longer need, or write to support@withruntime.com to raise the limit.",
    "details": {
      "limit": "volume.count",
      "max": 5,
      "raise": "Write to support@withruntime.com to raise it.",
      "docs": "https://withruntime.com/docs/limits"
    },
    "retryable": true
  }
}
```

Retrying helps only after something the limit counts has ended. Delete or stop
something the limit counts. Add credit if the account has none. Or write to
support@withruntime.com with the limit (`details.limit`) and the number you
need. Support can raise any limit below for an account, usually the same day
([feedback and support](./feedback-and-support)).
Raising the sandbox count immediately also raises the vCPUs, memory and disk
across running sandboxes, so the larger count fits. A raised limit belongs to
the account. It starts at what auto top-up gives: {{auto-sandboxes}} sandboxes,
and twice the vCPUs, memory and disk. It replaces auto top-up's doubling, so it
stays the same with auto top-up on or off. It is never below what auto top-up
would give. It shows on the Limits page and in `GET /v1/limits` immediately.

**Raise a limit for a burst: book room.** For many sandboxes at the same time,
for a few hours (a batch of evals, rollouts or browser runs), book the room
ahead. During that window, your sandbox limits rise by what you booked. Creates
up to that amount are never refused for room or limits. Runtime confirms or
declines the booking immediately, without a need to write to support
([book room for a burst](./reservations)).

## Waiting in line for room

A create or a wake refused because its region is short of room
(`503 no_capacity`, not a limit) takes a place in the region's line. The request
is retried while it waits. By default, the SDKs retry with the same
`Idempotency-Key` for up to two minutes. Freed room goes first to the highest
lane waiting for it: Enterprise, then Scale, Pro Max, Pro and Free, based on the
account's [plan](./plans). Runtime's own work comes after every customer's. The
refusal says where the request stands:

```text
no capacity; in line at place 2: the region's room goes to higher lanes first: 1 waiting ahead (pro 1); this account's lane is free
```

The error's `details.line` gives the same information in code: `lane`, `place`
(1 is next), `ahead` (how many wait ahead of it, by lane) and `words`. The
console shows the message where you create or wake a sandbox.

<!-- launch: apps -->

An App that needs a copy when no server has room waits in the same line. While
it waits, the App's `line` (in `GET /v1/apps/{id}` and the list) shows its
`lane`, `place`, `ahead` and `words`. Its page in the console shows the same.
An account's Apps waiting in one region share its one place in the lane. The
App that holds the place shows it.

<!-- /launch: apps -->

<!-- launch: ci -->

CI/CD checks get machines through the same lanes. A job waiting for a machine
shows its place on its page, such as
`short of room: waiting for room, 1 ahead (pro 1); this lane is free`.

<!-- /launch: ci -->

- Nothing already running stops for a higher lane. Room your account
  [booked](./reservations) stays yours, whoever waits.
- A lower lane waits only for room that a higher waiting lane could use. An
  account's waits hold others back for three minutes at most in any fifteen, in
  each lane and region.
- A place not requested again within 15 seconds holds no one. An account holds
  one place per lane in a region, however many requests it sends.

## Each account's share of a server

Sandboxes of different accounts share servers, and no account can slow down
or crowd out another on the same server. This applies to every account,
Runtime's own included, and needs no setting:

- **CPU.** Under contention, a server divides its CPU between accounts
  first, then between each account's sandboxes. Each sandbox keeps the CPU
  floor it was created with (`cpuFloorMillis`, or every vCPU with
  `cpu: "reserved"`). Each account's weight is the sum of its sandboxes'
  floors plus an equal part of half the CPU that no floor holds, so an
  account with one busy sandbox is not outweighed by the number of busy
  sandboxes another account runs.
- **A ceiling on CPU.** One account's sandboxes together use at most half
  of a server's cores, even when the rest of the server is idle, so other
  accounts' commands start without waiting for a core. A single sandbox
  larger than half a server, or reserved CPU above half, keeps all of its
  vCPUs.
- **Memory and placement.** Placement books at most half of one server's
  memory and CPU floors for one account, and places the account's
  additional sandboxes on other servers. An account's first sandbox on a
  server is never refused for this, and capacity your account
  [booked](./reservations) on a server is yours whatever the share.
- **Disk I/O and network.** A server divides disk I/O and outbound network
  bandwidth between accounts by weight, then between each account's
  sandboxes. A paid sandbox weighs more than a trial one.

When the account holds its share of every server in the region that could run
a new sandbox, the create is refused with `account_share_full` (429 with
`Retry-After: 30`) and nothing is charged:

```json
{
  "error": {
    "code": "account_share_full",
    "status": 429,
    "message": "This account already uses its share of every server in us-east that could run this sandbox: no account books more than 50% of one server's memory or CPU floors, so that other accounts on it keep theirs. Stop or pause sandboxes you no longer need, or retry when some end.",
    "retryable": true
  }
}
```

Stop or pause sandboxes you no longer need, or retry after `Retry-After`.
For a large burst, [book room](./reservations) ahead.

## What an account holds and runs

`details.limit` names each row. Counts are per region, except sandboxes kept.
The two storage limits count every region together.

| Limit (`details.limit`)                                       | Without credit        | With credit                                             |
| ------------------------------------------------------------- | --------------------- | ------------------------------------------------------- |
| Sandboxes at once (`sandbox.count`)                           | {{trial-concurrency}} | {{paid-sandboxes}}, {{auto-sandboxes}} with auto top-up |
| vCPUs across running sandboxes (`sandbox.vcpu`)               | 8                     | {{account-vcpus}}, twice that with auto top-up          |
| Memory across running sandboxes (`sandbox.memory_mib`)        | 16 GiB                | {{account-memory}}, twice that with auto top-up         |
| Disk across running sandboxes (`sandbox.disk_mib`)            | 10 GiB each           | {{account-disk}}                                        |
| Sandboxes kept, running, paused or stopped (`sandbox.kept`)   | {{no-credit-kept}}    | 1,000                                                   |
| Storage kept in all (`sandbox.stored_mib`), [below](#storage) | 50 GiB                | 500 GiB                                                 |
| Snapshot storage (`snapshot.stored_mib`)                      | 20 GiB                | 250 GiB                                                 |
| Volumes (`volume.count`)                                      | 5                     | 10,000                                                  |
| Volume storage (`volume.disk_mib`)                            | 500 GiB               | Storage kept in all; charged by the GB                  |
| Volume backups (`volume-backup.count`)                        | 200                   | 10,000                                                  |
| Snapshots (`snapshot.count`)                                  | 50                    | 10,000                                                  |
| Images (`image.count`)                                        | 20                    | 10,000                                                  |
| Image storage (`image.disk_mib`)                              | 200 GiB               | Storage kept in all; charged by the GB                  |
| Jobs, active or paused (`job.count`)                          | 1,000                 | 10,000                                                  |
| Secrets (`secret.count`)                                      | 1,000                 | 10,000                                                  |
| Dedicated outbound addresses (`address.count`)                | Needs credit          | 2                                                       |
| Private networks (`tunnel.count`)                             | Needs a kept top-up   | 1                                                       |

<!-- launch: actions -->

A GitHub Actions job runs at most 6 hours without credit, and at most 24 hours
with credit or on a paid plan: `sandbox.job_seconds`, in seconds. A job sets
less with `timeout-minutes` ([GitHub Actions](./actions#limits)).

<!-- /launch: actions -->

<!-- launch: agents -->

| Limit (`details.limit`)                             | Without credit | With credit |
| --------------------------------------------------- | -------------- | ----------- |
| Agents (`agent.count`)                              | 20             | 20          |
| Agent sessions open at once (`agent-session.count`) | 50             | 50          |
| Agent triggers (`agent-trigger.count`)              | 100            | 100         |

An agent session's sandbox also counts toward the sandbox rows above. A session
tree is at most 3 levels deep, with at most `maxChildren` open children: 100
unless the agent sets it, up to 1,000 ([subagents](./agents#subagents)). A
[workflow](./agents#workflows) runs at most 1,000 sessions, 200 at once. A
trigger past the account's 100 is refused with `quota_exceeded` ("The
account's triggers are at its limit."). Remove one you no longer need first.

<!-- /launch: agents -->

<!-- launch: containers -->

**Containers** need credit on the account. With credit, an account keeps up to
20 containers (`container.count`). A create past that is refused with
`quota_exceeded`: "This account holds up to 20 containers. Delete one you no
longer need, or write to support@withruntime.com to raise the limit." Without
credit, a create is refused with `payment_required`: "Containers need credit on
the account, bought or given." A container has 1 to 16 vCPUs and 128 MiB to
64 GiB of memory ([Containers](./containers)).

<!-- /launch: containers -->

<!-- launch: browsers -->

**Browsers** and **Desktops** are sandboxes. Each counts toward the sandboxes
an account runs at the same time, and toward its memory. It is refused in the
same way as a sandbox past those limits. A browser or a desktop has 1 to 16
vCPUs and 1 to 16 GiB of memory, with at most 30 labels
([Browsers](./browsers), [Desktops](./desktops)).

<!-- /launch: browsers -->

Without credit, a sandbox has at most 2 vCPU, 4 GiB of memory and a 10 GiB
disk. An account can keep up to {{no-credit-kept}} sandboxes, running, paused or
stopped. It makes {{no-credit-daily}} in any 24 hours. It starts
{{trial-builds-a-day}} image builds a day. It holds {{no-credit-keys}} live API
keys. These refusals have codes of their own, starting `no_credit_`
([included usage](./included-usage#without-credit)). With credit, a sandbox is
up to {{max-vcpu}} vCPUs, {{max-memory}} of memory and a {{max-disk}} disk
([pricing](./pricing#how-many-at-once)). A disputed payment, a suspension or
an abuse report holds an account to {{restricted-sandboxes}} sandboxes running
at the same time.

<!-- launch: ci -->

**CI/CD** opens to an account once Runtime sets its two limits: the
repositories it connects (`ci-repository.count`), and its checks queued or
running at the same time (`check.count`). A fork's pull request waiting to run
counts toward neither. Until then, a connect is refused with `product_in_beta`:
"CI/CD is not open to this organization yet: it opens once Runtime sets the
organization's CI/CD limits. Ask Runtime support to join it." A connect past its
repository limit is refused with `quota_exceeded`: "This account is at its limit
of connected CI/CD repositories (ci-repository.count). Disconnect one it no
longer checks, or write to support@withruntime.com to raise the limit." A check
and each run of a step take at most 6 hours (`timeout:`, 21600 seconds), on a
machine of 2 to 16 vCPUs with {{ci-gib-per-vcpu}} of memory each ([CI/CD](./ci)).

<!-- /launch: ci -->

## Storage

An account's stored data is limited in GiB, not only counted. `sandbox.stored_mib`
covers everything it keeps: snapshots, images, volumes, volume backups, and
paused or stopped sandboxes. `snapshot.stored_mib` counts its snapshots alone,
both memory and disk-only. A memory snapshot keeps the sandbox's memory as well
as its disk.

What counts is the amount actually stored. Storage is billed by that same
figure ([pricing](./pricing#snapshots-images-and-volumes)). It includes a
snapshot's or backup's stored bytes, and an image's stored bytes. It also
includes a paused sandbox's memory and disk, and a stopped sandbox's kept disk,
as its server measured them. A volume counts at its size. Its server sets that
size aside in full when the volume is made. A grow not yet done counts at its
new size. Until a size is measured, it counts at the most it may store. A
capturing snapshot counts at its sandbox's measured memory and disk. A disk-only
snapshot counts at its disk alone. Otherwise it counts at the sizes asked for.
An image being built counts at its `maxImageMiB`, or else at its base image's
size. A pending backup counts at what its volume holds as last measured.
Otherwise it counts at the volume's size.

A snapshot (including a fork's), an image build, a requested backup, or a volume
made, restored or grown is refused with `quota_exceeded` when what it may store
would take the account past the limit. The message and `details` give the
limit, its size, and what the account stores now (`used`, in MiB):

```json
{
  "error": {
    "code": "quota_exceeded",
    "status": 409,
    "message": "This account keeps up to 50 GiB stored in all: snapshots, images, volumes, volume backups, and paused or stopped sandboxes, and stores 50 GiB now. Nothing you keep is deleted. Delete what you no longer need to make room, add credit if the account has none (it raises this limit), or write to support@withruntime.com to raise the limit.",
    "details": {
      "limit": "sandbox.stored_mib",
      "max": 51200,
      "used": 51200,
      "raise": "Write to support@withruntime.com to raise it.",
      "docs": "https://withruntime.com/docs/limits"
    }
  }
}
```

A storage limit never deletes or stops anything. An account past one keeps
everything it has. Its running and paused sandboxes keep working. But it does
not make anything new that stores data until it is under the limit again.
Pausing and stopping are never refused. Neither is anything Runtime does itself,
such as a daily volume backup or a server's nightly backup. An account that
already stored more than a limit when these limits began has what it stored then
as that limit. The Limits page shows it. Credit or a plan still raises it above
that.

## Limits of one sandbox or one feature

These limits keep one sandbox or one host healthy, whatever the account pays.
Each is refused with its own message. Support can raise most of them.

| Limit                                      | Number                                                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Previews one sandbox shares                | 16 ports                                                                                                   |
| TCP ports                                  | 5 a sandbox, 20 an account                                                                                 |
| Custom domains                             | 50 an account, 20 added a day                                                                              |
| Peers on a private network                 | 16                                                                                                         |
| Image registry credentials                 | 20                                                                                                         |
| Secrets with rules for sandboxes' requests | 50                                                                                                         |
| Webhooks                                   | 16                                                                                                         |
| OpenTelemetry exports                      | 3                                                                                                          |
| Watches sending file changes at once       | 16                                                                                                         |
| Image builds at once                       | 1 without credit, 4 with                                                                                   |
| Open files a process (`ulimit -n`)         | 65,536; a process raises it to 1,048,576 without root                                                      |
| New connections to one site                | 20 a second a sandbox, 100 an account on one server ([outbound traffic](./egress#connections-to-one-site)) |

<!-- launch: apps -->

## Apps

Apps need credit on the account. An App's copy is a machine, as a sandbox is,
so the account's App copies at once follow its plan's sandboxes at once:

| Limit (`details.limit`)                                                     | Free | Pro | Pro Max | Scale | Enterprise |
| --------------------------------------------------------------------------- | ---- | --- | ------- | ----- | ---------- |
| App copies at once across its Apps, frozen ones included (`instance.count`) | 2    | 100 | 250     | 500   | 2,000      |

Each add-on of 50 more sandboxes at once adds 50 App copies too. An account
with credit and no plan has 100 App copies at once and 10 Apps (`app.count`).

An account without credit cannot create an App. The refusal says to add
credit.

Each App:

| Limit                   | Number                                                                    |
| ----------------------- | ------------------------------------------------------------------------- |
| A copy's size           | 1 to {{max-vcpu}} vCPUs, 128 MiB to {{max-memory}} of memory              |
| `maxCopies`             | No more than the account's App copies at once                             |
| `concurrency`           | 1 to 10,000 requests a copy                                               |
| A request               | No total time limit; the response head within 900 s (100 s with `cdn` on) |
| `spares`                | 0 to 16                                                                   |
| Environment             | 256 names, 64 KiB of names and values                                     |
| A deploy's health check | 120 seconds                                                               |
| Saved copies            | The live and the previous version                                         |

<!-- /launch: apps -->

API requests are limited per key and per account. A request past one is refused
with `rate_limited` and a `Retry-After` ([API](./api)).
