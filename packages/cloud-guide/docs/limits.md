# Limits

Every limit an account is held to, in one place. An account that holds credit
is charged for what it keeps: the limits it has are what runs at once and what
it stores, which are the fleet's room, and ceilings against a runaway agent
that no one using Runtime normally meets. An account without credit has
smaller limits, which adding credit raises at once.

Your own account's limits, with how much of each you use, are on the
[Limits page of the console](https://withruntime.com/account/limits). A key
reads the same numbers from `GET /v1/limits` (`runtime.limits.get()` in the
SDK), in its `account` list: each row's `limit` (such as
`sandbox.memory_mib`), `max` and `used`, so an agent can see a limit coming
before a create is refused, and hold back new work while it is near. A key
limited to a compartment, or a worker key another key made, sees only its own
sandboxes, so its `account` is null.

## When you meet one

A create past a limit is refused with `quota_exceeded` (429 with `Retry-After: 5` and `retryable: true` for a limit on what runs at once; 409 with `retryable: false` for one on what is kept, which clears only when you delete one) and costs
nothing. The message names the limit and its number, and the error's
`details` say the same for code:

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

Sending it again helps only once something the limit counts has ended. Delete or stop something the limit counts, add credit
if the account has none, or write to support@withruntime.com with the limit
(`details.limit`) and the number you need: any limit below can be raised for
an account, usually the same day ([feedback and support](./feedback-and-support)).
Raise sandboxes at once with the vCPUs, memory and disk across running
sandboxes, so the larger count fits. A raised limit is the account's own: it
starts at what auto top-up gives ({{auto-sandboxes}} at once, and twice the
vCPUs, memory and disk) and replaces auto top-up's doubling, so it stays the
same with auto top-up on or off and is never below what auto top-up would
give. It shows on the Limits page and in `GET /v1/limits` at once.

**Raise a limit for a burst: book room.** For many sandboxes at once for a
few hours (a batch of evals, rollouts or browser runs), book the room ahead:
in the window your sandbox limits rise by what you booked and creates are
never refused for room or limits up to it, confirmed or declined at once with
no one to write to ([book room for a burst](./reservations)).

## Waiting in line for room

A create or a wake refused because its region is short of room
(`503 no_capacity`, not a limit) holds a place in the region's line while it
is asked again; the SDKs ask again with the same `Idempotency-Key` for up to
two minutes by default. The room that frees goes first to the highest lane
waiting for it: Enterprise, then Scale, Pro Max, Pro and Free, from the
account's [plan](./plans), and Runtime's own work after every customer's.
The refusal says where it stands:

```text
no capacity; in line at place 2: the region's room goes to higher lanes first: 1 waiting ahead (pro 1); this account's lane is free
```

Its `details.line` says the same for code: `lane`, `place` (1 is next),
`ahead` (how many wait ahead of it, by lane) and `words`. The console shows
the message where it creates or wakes a sandbox.

<!-- launch: apps -->

An App that needs a copy no server has room for waits in the same line. While
it waits, the App's `line` (in `GET /v1/apps/{id}` and the list) says its
`lane`, `place`, `ahead` and `words`, and its page in the console says the
same. An account's Apps waiting in one region share its one place in the
lane: the App that took it shows it.

<!-- /launch: apps -->

<!-- launch: ci -->

CI/CD's checks get machines by the same lanes, and a job waiting for one
says where it stands on its page, such as
`short of room: waiting for room, 1 ahead (pro 1); this lane is free`.

<!-- /launch: ci -->

- Nothing already running is stopped for a higher lane, and room your
  account [booked](./reservations) is yours whoever waits.
- A lower lane waits only for room a higher one waiting could use, and an
  account's waits hold others back for three minutes at most in any
  fifteen, in each lane and region.
- A place not asked for again within 15 seconds holds no one, and an account
  holds one place per lane in a region, however many requests it sends.

## What an account holds and runs

`details.limit` names each row. Counts are per region, except sandboxes kept;
the two storage limits count every region together.

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

<!-- launch: agents -->

| Limit (`details.limit`)                             | Without credit | With credit |
| --------------------------------------------------- | -------------- | ----------- |
| Agents (`agent.count`)                              | 20             | 20          |
| Agent sessions open at once (`agent-session.count`) | 50             | 50          |
| Agent triggers (`agent-trigger.count`)              | 100            | 100         |

An agent session's sandbox counts toward the sandbox rows above too. A session
tree goes at most 3 levels deep with at most 20 open children
([subagents](./agents#subagents)). A trigger past the account's 100 is refused
`quota_exceeded` ("The account's triggers are at its limit."): remove one you no
longer need first.

<!-- /launch: agents -->

<!-- launch: containers -->

**Containers** need credit on the account. With credit an account keeps up
to 20 containers (`container.count`); one past them is refused
`quota_exceeded`: "This account holds up to 20 containers. Delete one you no
longer need, or write to support@withruntime.com to raise the limit." Without
credit, a create is refused `payment_required`: "Containers need credit on
the account, bought or given." A container is 1 to 16 vCPUs and 128 MiB to
64 GiB of memory ([Containers](./containers)).

<!-- /launch: containers -->

<!-- launch: browsers -->

**Browsers** and **Desktops** are sandboxes: each counts toward the sandboxes
an account runs at once and their memory, and is refused as a sandbox past
them is. A browser or a desktop is 1 to 16 vCPUs and 1 to 16 GiB of memory,
with at most 30 labels ([Browsers](./browsers), [Desktops](./desktops)).

<!-- /launch: browsers -->

Without credit, a sandbox is at most 2 vCPU, 4 GiB of memory and a 10 GiB
disk, an account keeps {{no-credit-kept}} sandboxes, running, paused or stopped,
and makes {{no-credit-daily}} in any 24 hours, it starts
{{trial-builds-a-day}} image builds a day, and it holds {{no-credit-keys}} live
API keys; these
refusals have codes of their own, starting `no_credit_`
([included usage](./included-usage#without-credit)). With credit a sandbox is
up to {{max-vcpu}} vCPUs, {{max-memory}} of memory and a {{max-disk}} disk
([pricing](./pricing#how-many-at-once)). A disputed payment, a suspension or
an abuse report holds an account to {{restricted-sandboxes}} sandboxes at
once.

<!-- launch: ci -->

**CI/CD** opens to an account once Runtime sets its two limits: the
repositories it connects (`ci-repository.count`) and its checks queued or
running at once (`check.count`); a fork's pull request waiting to run counts
toward neither. Until then a connect is refused `product_in_beta`: "CI/CD is
not open to this organization yet: it opens once Runtime sets the
organization's CI/CD limits. Ask Runtime support to join it." A connect past
its repositories is refused `quota_exceeded`: "This account is at its limit of
connected CI/CD repositories (ci-repository.count). Disconnect one it no
longer checks, or write to support@withruntime.com to raise the limit." A job runs at most 30 minutes, on a
machine of 2 to 16 vCPUs with 2 GiB of memory each ([CI/CD](./ci)).

<!-- /launch: ci -->

## Storage

What an account stores is limited in GiB, not only counted. `sandbox.stored_mib`
is everything it keeps, in all: snapshots, images, volumes, volume backups, and
paused or stopped sandboxes. `snapshot.stored_mib` is its snapshots alone, memory
and disk-only, since a memory snapshot keeps the sandbox's memory as well as
its disk.

What counts is what is really stored, the figure storage is billed by
([pricing](./pricing#snapshots-images-and-volumes)): a snapshot's or backup's stored bytes,
an image's stored bytes, a paused sandbox's memory and disk and a stopped one's
kept disk as its server measured them, and a volume's size, which its server
sets aside whole when it is made, or the new size of a grow not yet done. Until
one is measured it counts at what it may store: a capturing snapshot its
sandbox's measured memory and disk (a disk-only snapshot its disk alone), else
the sizes asked for; an image being built its `maxImageMiB`, else its base
image's size; a pending backup what its volume holds as last measured, else the
volume's size.

A snapshot (a fork's included), an image build, a backup asked for, or a volume
made, restored or grown is refused with `quota_exceeded` when what it may store
would take the account past the limit. The message and
`details` say the limit, its size and what the account stores now (`used`, in
MiB):

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

Nothing is ever deleted or stopped for a storage limit. An account past one
keeps everything it has, and its running and paused sandboxes keep working,
but it makes nothing new that stores until it is under it again. Pausing and
stopping are never refused, and neither is anything Runtime does itself, such
as a daily volume backup or a server's nightly backup. An account that already
stored more than a limit when these limits began has what it stored then as
that limit, shown on its Limits page. Credit or a plan still raise it above
that.

## Limits of one sandbox or one feature

These keep one sandbox or one host healthy, whatever the account pays. They
are refused with their own words, and support can raise most of them.

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
| New connections to one site                | 20 a second a sandbox, 100 an account on one server ([outbound traffic](./egress#connections-to-one-site)) |

<!-- launch: apps -->

## Apps

Apps need credit on the account. An account with credit has these:

| Limit (`details.limit`)                                                     | With credit |
| --------------------------------------------------------------------------- | ----------- |
| App copies at once across its Apps, frozen ones included (`instance.count`) | 20          |
| Apps (`app.count`)                                                          | 10          |

An account without credit cannot create an App; the refusal says to add
credit.

Each App:

| Limit                   | Number                                                       |
| ----------------------- | ------------------------------------------------------------ |
| A copy's size           | 1 to {{max-vcpu}} vCPUs, 128 MiB to {{max-memory}} of memory |
| `maxCopies`             | 1,000, and no more than the account's copies at once         |
| `concurrency`           | 1 to 10,000 requests a copy                                  |
| `spares`                | 0 to 16                                                      |
| Environment             | 256 names, 64 KiB of names and values                        |
| A deploy's health check | 120 seconds                                                  |
| Saved copies            | The live and the previous version                            |

<!-- /launch: apps -->

API requests are limited per key and per account; a request past one is
`rate_limited` with a `Retry-After` ([API](./api)).
