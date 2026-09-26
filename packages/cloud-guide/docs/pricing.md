# Understand your sandbox bill

You pay for the CPU your code uses, not the CPUs it holds: **$0.025 per active vCPU-hour** and **$0.0075 per reserved GiB-hour of memory**.

There is no plan fee. That makes Runtime **42% to 88% cheaper** than fourteen
other sandbox providers for an agent that spends most of its time waiting on a
model ([the comparison](#published-rate-comparison)).

- **Busy:** 2 vCPUs and 4 GiB with both CPUs working cost $0.08 an hour.
- **Waiting:** the same sandbox costs $0.03125 an hour, memory plus the default
  CPU floor of 50 millicores (a twentieth of a vCPU).
- **At scale:** 1,000 running hours cost $31.25 waiting and $80 fully busy.

Memory is billed while compute is running. A GiB is 1,073,741,824 bytes, not a
decimal GB. A higher `cpuFloorMillis`, or `cpu: "reserved"`, raises the waiting
charge. Reserved CPU keeps every vCPU for the sandbox and bills it as if it
were always busy: the floor becomes all of them, so 2 reserved vCPUs and 4 GiB
cost $0.08 an hour whether the code works or waits. Each resource's
usage-pricing quote is fixed when it is made. Keep a
bounded lifetime: `onLeaseEnd` pauses or stops a sandbox for you.

**Start free.** Every new account gets the [100-hour free trial](./trial), no
card. At these rates, 100 fully busy hours of a 2 vCPU, 4 GiB sandbox would cost
$8.00.

**Then prepay.** Add credit by card at
[Usage & billing](https://withruntime.com/account/billing), any amount from $10
to $10,000. There is no subscription. The page shows how long your credit lasts
at this month's pace and what each product cost each day, and its ledger links
each card purchase to its Stripe receipt. Refer a company and you both get credit
equal to its first top-up, up to $500 each ([referrals](./referrals)). Moving
from another provider? Your first top-up is matched, up to $100
([switching credit](#switching-credit)).

## How many at once

One paid sandbox can have up to **16 vCPUs and 64 GiB of memory**, at the same
per-unit rates; a trial sandbox up to 2 vCPU and 4 GiB. Fully busy, the largest
costs $0.88 an hour.

A paid account runs **100 sandboxes at once**, running or paused, with up to
**200 vCPUs and 400 GiB of memory** across the running ones and 400 GiB of
disk. A new account earns the hundred: it runs **50 sandboxes at once** until
7 days after its first top-up clears, or until $50 of paid use has settled,
whichever comes first. Granted credit, such as referral credit, counts toward
neither. A disputed payment, a suspension or an abuse report puts an account
back to 50. A paused sandbox holds no CPU or memory. At a busy moment a create
can still answer `no_capacity`; the SDKs wait for room, up to two minutes by
default.

These limits are a starting point, not a price tier. To run more, write to
support with the numbers you need ([feedback and support](./feedback-and-support)).
Past a limit, a create returns `quota_exceeded`, saying which limit and, for
a new account, when it lifts, and costs nothing. The [free trial](./trial)
runs eight at once.

## Paused storage

A paused sandbox keeps its files and memory for **$0.08 per decimal GB per
30-day month**. Its immutable resource quote holds the actual rate.

- **What counts:** disk and memory-snapshot blocks the sandbox alone owns. Shared
  base-image blocks and snapshot safety overhead are left out. Where the
  filesystem cannot report sharing, allocated blocks are the fallback, which can
  overcount.
- **What does not:** the provisioned disk allowance, or the sum of live file
  sizes.
- **When it runs:** compute billing ends when a pause stops the sandbox's
  processors, before its memory is written to disk, and storage billing begins
  at that moment, at the size measured once the write finishes. It ends on
  confirmed resume or deletion. Compute has no one-minute minimum.

Paid retention defaults to 30 days from each successful pause and can be set to
1–365 days. Each pause replaces the previous saved state. Trial sandboxes keep
their free seven-day retention and never fall back to paid storage. The
resource's `pausedExpiresAt` and paused-storage receipt give its actual terms.

A pause posts an account notice with the date its saved state is kept until.
The notice is posted within about five minutes, so a sandbox woken sooner may
get none. Its storage is still charged from the moment it
paused, as above.

## Snapshots, images and volumes

Storage has been charged since 23 September 2026. An item made before then is
charged only from that date.

| What you keep                                | Rate                                                                     | Charged on                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| [Snapshot](./javascript#snapshots-and-forks) | **$0.08 per decimal GB per 30-day month**, 119 microdollars per GiB-hour | The bytes the snapshot alone stores; a block two of your snapshots share counts once |
| [Image](./javascript#custom-images)          | **$0.08 per decimal GB per 30-day month**, 119 microdollars per GiB-hour | The whole image file, shared base image included                                     |
| [Volume](./javascript#volumes)               | **153 microdollars per GiB-hour**, about $0.11 per GiB per 30-day month  | The full size you create it with, written or not                                     |

The snapshot and image rate is paused storage's, rounded down to whole
microdollars. The volume rate is the reserved disk rate: a volume holds its whole
size on its server from the moment you create it.

Building an image is free, and so is the snapshot a fork takes for itself and
deletes. A snapshot is kept 7 days unless you choose 1 to 365. A snapshot's copy
off its server is part of the snapshot and costs nothing more. Volume backups cost **$0.012 per decimal GB per 30-day month**, charged on
`storedBytes` after a backup is copied and checked ([storage and backups](./storage)).
Daily backups are on by default when backups are enabled in the region.

The [free trial](./trial) stores your first three images and your first 10 GiB of
volumes free, for as long as you keep them. They are never charged, even after
you add credit. Deleting one frees its place. Snapshots are not part of the
trial's free storage.

An item's rate is fixed when you make it and never changes. It is under `rates`
in `GET /v1/usage`: `storage.stored` for a snapshot, `storage.reserved` for an
image and `storage.provisioned` for a volume.

Storage is paid an hour at a time from your balance. The hold covers the most
the item can be charged for that hour; the charge is what it used, and the rest
is released.

## Network products

A dedicated IPv4 address costs **$5 per 30-day month**. A WireGuard tunnel
costs **$5 per 30-day month**, including up to 16 peers. These are prorated to
funded time, with the rate fixed in each resource's quote. Dedicated IPv6,
custom domains (up to 50) and TCP ports are included.

If credit or another spending permission prevents renewal, address and tunnel
traffic stops. The reservation stays yours until you release it; unpaid time
is never billed later. A dedicated address never silently switches to a shared
outbound address. See [networking](./networking) for funding status and access.

## When your balance runs out

Storage charges stop at zero, and your balance never goes below it. You never
owe money. Nothing is lost straight away:

- The item is kept for **seven days**. An account notice tells you the date, and
  a second notice warns you a day before it. Notices go to your account inbox
  (`runtime_notices` in MCP); there is no email yet.
- Add credit within those seven days and charging starts again from then. The
  days it went unpaid are written off: they are never charged, now or later.
- After seven days unpaid, the item is deleted. A volume that a sandbox still
  uses is deleted once that sandbox lets it go.

Paused sandboxes follow the same seven-day rule.

## Per 1,000 runs

The standard example: 2 vCPUs, 4 GiB, 60 seconds of running time per run, 20
CPU-seconds of work per run, 1,000 completed runs. A CPU-second is one core busy
for one second; two cores busy for ten seconds use 20 CPU-seconds.

```
CPU:    1,000 × 20 / 3,600 × $0.025 = $0.138889
Memory: 1,000 × 60 / 3,600 × 4 × $0.0075 = $0.500000
Total:  $0.638889, approximately $0.64 per 1,000 runs
```

At 100,000 runs a month, that is $63.89. The figure assumes the CPU floor does
not exceed measured CPU. It leaves out taxes, paid disk retention, network
charges if any, free credits and retries. Count startup and dependency setup in
running time when they are inside the billable interval.

## Published rate comparison

The same example at each provider's published rates, checked 23 September 2026
(25 September 2026 for AWS Lambda MicroVMs, Freestyle and Prime Sandboxes).

| Provider                                                        | CPU and memory for 1,000 runs | Runtime saves |
| --------------------------------------------------------------- | ----------------------------: | ------------: |
| **Runtime**                                                     |                     **$0.64** |             — |
| Northflank, published CPU and memory rates (4 GB)               |                         $1.11 |           42% |
| Cloudflare Sandbox, published rates (2 vCPU, 6 GiB, 12 GB disk) |                         $1.35 |           53% |
| Fly Machines, `performance-2x` with 4 GB, `iad`                 |                         $1.44 |           55% |
| Prime Sandboxes, published rates (5 GiB disk)                   |                         $1.52 |           58% |
| Morph, 2 MCUs an hour                                           |                         $1.67 |           62% |
| Vercel Sandbox, published `iad1` rates (4 GB)                   |                         $2.12 |           70% |
| Freestyle, published rates (32 GiB disk)                        |                         $2.25 |           72% |
| CodeSandbox SDK, a Nano VM (2 cores, 4 GB)                      |                         $2.48 |           74% |
| E2B, published per-second rates                                 |                         $2.76 |           77% |
| Daytona, published CPU and memory rates                         |                         $2.76 |           77% |
| Blaxel, 4 GB of memory while active                             |                         $2.76 |           77% |
| Fly Sprites, published rates (4 GB of memory in use)            |                         $3.31 |           81% |
| Modal Sandboxes, published rates (1 physical core)              |                         $3.97 |           84% |
| AWS Lambda MicroVMs, Arm, US East (a 4 GB baseline)             |                         $4.20 |           85% |
| Runloop, a `MEDIUM` devbox (2 CPUs, 4 GB, 8 GB disk)            |                         $5.33 |           88% |

Each row's working is on its comparison page:
[E2B](./e2b-alternative), [Daytona](./daytona-alternative),
[Vercel](./vercel-sandbox-alternative), [Modal](./modal-sandbox-alternative),
[Cloudflare](./cloudflare-sandbox-alternative), [Fly.io](./fly-alternative),
[CodeSandbox](./codesandbox-alternative), [Morph](./morph-alternative),
[Northflank](./northflank-alternative), [Runloop](./runloop-alternative),
[Blaxel](./blaxel-alternative), [AWS Lambda MicroVMs](./aws-lambda-microvms-alternative),
[Freestyle](./freestyle-alternative) and [Prime Sandboxes](./prime-sandboxes-alternative).

- E2B and Daytona charge $0.0504 per vCPU-hour and $0.0162 per GiB-hour for
  every allocated vCPU.
- Vercel charges $0.128 per active CPU-hour and $0.0212 per provisioned
  GB-hour in `iad1`; other regions differ.
- Modal charges $0.1419 per physical core-hour and $0.0240 per GiB-hour, on
  whichever is higher of request and use.
- Cloudflare needs at least 3 GiB per vCPU, so its row is priced at 6 GiB.
- Northflank charges $0.01667 per allocated vCPU-hour and $0.00833 per GB-hour.
  It is the one row where a job that keeps every CPU busy costs less than on
  Runtime.
- Morph charges $0.05 per MCU-hour; 2 vCPUs and 4 GB is 2 MCUs.
- CodeSandbox charges 10 credits an hour at $0.01486 for a Nano VM.
- Blaxel charges $0.0000115 per GB-second of active time, with CPU included.
- Runloop charges $0.108 per CPU-hour, $0.0252 per GB-hour and $0.00034236 per
  GB-hour of disk.
- AWS Lambda MicroVMs charge $0.0000276944 per vCPU-second and $0.0000036667
  per GB-second of the baseline size while a MicroVM runs, on Arm in US East.
- Freestyle charges $0.04032 per vCPU-hour, $0.0129 per GiB-hour of memory and
  $0.000086 per GiB-hour of storage, all on the allocation.
- Prime Sandboxes charge $0.02 per vCPU-hour, $0.0125 per GiB-hour of memory
  and $0.0002 per GiB-hour of disk while running, rates published through
  22 December 2026.

Plan fees, storage, network, free credits and negotiated prices are left out of
every row.

Sources: [E2B pricing](https://e2b.dev/pricing),
[Daytona pricing](https://www.daytona.io/pricing),
[Vercel Sandbox pricing](https://vercel.com/docs/sandbox/pricing),
[Modal pricing](https://modal.com/pricing),
[Cloudflare Containers pricing](https://developers.cloudflare.com/containers/pricing/),
[Fly.io pricing](https://fly.io/pricing/),
[Together Code Sandbox](https://docs.together.ai/docs/together-code-sandbox),
[Morph Cloud pricing](https://cloud.morph.so/web/pricing),
[Northflank pricing](https://northflank.com/pricing),
[Runloop pricing](https://www.runloop.ai/pricing),
[Blaxel pricing](https://blaxel.ai/pricing),
[AWS Lambda pricing](https://aws.amazon.com/lambda/pricing/),
[Freestyle pricing](https://www.freestyle.sh/pricing),
[Prime Sandboxes overview](https://docs.primeintellect.ai/sandboxes/overview).

## Switching credit

Moving from E2B, Daytona, Vercel Sandbox, Modal, Cloudflare or Fly? Say so
before your first top-up, and that top-up is matched with credit, up to $100:

```bash check
runtime switch --from e2b
```

- Once per organization, and only before its first top-up. Your agent can do
  it for you: `POST /v1/switching`, or the `runtime_switching_record` MCP tool.
- The credit lands when the payment settles. Pay $40 and you get $40 more; pay
  $250 and you get $100 more.
- It does not stack with a [referral](./referrals). If you signed up through a
  referral link, the referral's match applies instead, and it is never smaller.
- If the top-up is refunded or charged back, the matching credit goes back too,
  up to what is unspent.

`runtime switch` on its own shows whether you can still claim it and what it
paid.

## Check it on your own workload

Once you have run on Runtime, `runtime compare` prices your own sandboxes both
ways:

```bash check
runtime compare --from e2b
```

It takes your settled sandboxes from the last 30 days (`--days` up to 90). It
prices them at the rates you were quoted, and the same vCPUs, memory and
running time at the rival's published rates from the table above. Sandboxes
the free trial ran are priced at the standard rates, what the same work costs
on paid credit, and the output says how many there were. Then it says
what you save, and about how much that is a month. With no sandboxes yet it
prices an example and says so. It compares compute only: storage, network,
plan fees and free allowances are left out. The same figures come from
`GET /v1/usage/compare` and the `runtime_usage_compare` MCP tool, in
microdollars.

To compare a workload you have not moved yet, ask your agent:

“Compare my last 1,000 completed runs with Runtime. Use the same measured job
behavior, include my current discounts and required features, show all inputs,
and separate estimated savings from measured savings.”
