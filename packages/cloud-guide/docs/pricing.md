# Understand your sandbox bill

You pay for the CPU your code uses, not the CPUs it holds: **{{cpu-rate}} per active vCPU-hour** and **{{memory-rate}} per reserved GiB-hour of memory**.

There is no plan fee. That makes Runtime **{{saving-range}} cheaper** than {{rival-count}}
other sandbox providers for an agent that spends most of its time waiting on a
model ([the comparison](#published-rate-comparison)).

- **Busy:** 2 vCPUs and 4 GiB with both CPUs working cost {{busy-hour}} an hour.
- **Waiting while it runs:** the same sandbox costs {{idle-hour}} an hour, memory
  plus the default CPU floor of {{cpu-floor}} ({{cpu-floor-share}}). After
  {{idle-pause}} with nothing happening it pauses and pays paused storage instead.
- **Memory:** {{memory-rate}} per GiB-hour is the lowest memory rate of the
  providers in [the comparison](#published-rate-comparison) that price memory on
  its own.
- **At scale:** 1,000 running hours cost {{= idle-hour * 1000}} waiting and {{=$0 busy-hour * 1000}} fully busy.

Memory is billed while compute is running. CPU is billed from the moment the
sandbox is ready: what it spends booting or restoring is ours. A GiB is 1,073,741,824 bytes, not a
decimal GB. A higher `cpuFloorMillis`, or `cpu: "reserved"`, raises the waiting
charge. Reserved CPU keeps every vCPU for the sandbox and bills it as if it
were always busy: the floor becomes all of them, so 2 reserved vCPUs and 4 GiB
cost {{busy-hour}} an hour whether the code works or waits. Each resource's
usage-pricing quote is fixed when it is made.

**Idle time is paused time.** A sandbox pauses itself after {{idle-pause}} with
nothing happening in it: no request, no command still running, no open
connection, no network traffic and no CPU use. From then it pays
[paused storage](#paused-storage) only, and the next request wakes it. Set
`idlePauseSeconds` from {{idle-pause-min}} to {{idle-pause-max}}, or 0 to keep it running; `onLeaseEnd`
pauses or stops it when its lease ends.

**Start free.** Every new account gets the [{{trial-hours}}-hour free trial](./trial), no
card. At these rates, {{trial-hours}} fully busy hours of a 2 vCPU, 4 GiB sandbox would cost
{{=$2 trial-hours * busy-hour}}.

**Then prepay.** Add credit by card at
[Usage & billing](https://withruntime.com/account/billing), any amount from {{topup-min}}
to {{topup-max}}. There is no subscription. The page shows how long your credit lasts
at this month's pace and what each product cost each day, and its ledger links
each card purchase to its Stripe receipt. Refer a company and you both get credit
equal to its first top-up, up to {{referral-max}} each ([referrals](./referrals)). Moving
from another provider? Your first top-up is matched, up to {{switching-max}}
([switching credit](#switching-credit)).

## How many at once

One paid sandbox can have up to **{{max-vcpu}} vCPUs and {{max-memory}} of memory**, at the same
per-unit rates; a trial sandbox up to 2 vCPU and 4 GiB. Fully busy, the largest
costs {{=$2 cost:runtime:16x64x3600x57600x1}} an hour.

A paid account runs **{{paid-sandboxes}} sandboxes at once**, running or paused, with up to
**{{account-vcpus}} vCPUs and {{account-memory}} of memory** across the running ones and 400 GiB of
disk. A new account earns the hundred: it runs **{{new-account-sandboxes}} sandboxes at once** until
{{new-account-days}} days after its first top-up clears, or until {{new-account-spend}} of paid use has settled,
whichever comes first. Granted credit, such as referral credit, counts toward
neither. A disputed payment, a suspension or an abuse report puts an account
back to 50. A paused sandbox holds no CPU or memory. At a busy moment a create
can still answer `no_capacity`; the SDKs wait for room, up to two minutes by
default.

An account counts as paid while it holds a top-up that was not refunded or
charged back in full, and no payment of it is in dispute. Once every top-up has
gone back, the paid-only features close again: outbound ports beyond 80 and
443, the network products, and four image builds at once.

These limits are a starting point, not a price tier. To run more, write to
support with the numbers you need ([feedback and support](./feedback-and-support)).
Past a limit, a create returns `quota_exceeded`, saying which limit and, for
a new account, when it lifts, and costs nothing. The [free trial](./trial)
runs {{trial-sandboxes}} at once.

## Paused storage

A paused sandbox keeps its files and memory for **{{paused-storage-rate}} per decimal GB per
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

A pause you ask for, or one at the end of a lease, posts an account notice with
the date its saved state is kept until. The notice is posted within about five
minutes, so a sandbox woken sooner may get none. An idle pause posts none. Every
paused sandbox gets a warning a day before its saved state is deleted. Its
storage is still charged from the moment it paused, as above.

## Snapshots, images and volumes

Storage has been charged since 23 September 2026. An item made before then is
charged only from that date.

| What you keep                                | Rate                                                                                                            | Charged on                                                                           |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [Snapshot](./javascript#snapshots-and-forks) | **{{paused-storage-rate}} per decimal GB per 30-day month**, {{snapshot-rate-micros}} microdollars per GiB-hour | The bytes the snapshot alone stores; a block two of your snapshots share counts once |
| [Image](./javascript#custom-images)          | **{{paused-storage-rate}} per decimal GB per 30-day month**, {{snapshot-rate-micros}} microdollars per GiB-hour | The whole image file, shared base image included                                     |
| [Volume](./javascript#volumes)               | **{{volume-rate-micros}} microdollars per GiB-hour**, about {{volume-month}} per GiB per 30-day month           | The full size you create it with, written or not                                     |

The snapshot and image rate is paused storage's, rounded down to whole
microdollars. The volume rate is the reserved disk rate: a volume holds its whole
size on its server from the moment you create it.

Building an image is free (on the free trial it counts toward the {{trial-hours}} hours),
and so is the snapshot a fork takes for itself and deletes. A snapshot is kept 7 days unless you choose 1 to 365. A snapshot's copy
off its server is part of the snapshot and costs nothing more. Volume backups cost **{{backup-rate}} per decimal GB per 30-day month**, charged on
`storedBytes` after a backup is copied and checked ([storage and backups](./storage)).
Every volume is backed up off its server daily unless you turn that off.

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

Inbound traffic is free. Each account's first **{{outbound-allowance}} of outbound traffic a
month** is free, and after that it costs **{{outbound-rate}} per decimal GB**. Outbound
traffic is what your sandboxes send over the connections they open to the
internet, TCP and UDP. Everything a sandbox receives, replies it serves through
previews, custom domains and TCP ports, and traffic to your own network over a
WireGuard tunnel are not counted. A trial sandbox's traffic is free and uses
none of the allowance.

The allowance is shared by all of an account's sandboxes and starts again on
the first of each month, UTC. Traffic is charged from your balance each time a
sandbox's compute settles: at each lease renewal and when it stops or pauses.
It is never held in advance and never takes the balance below zero. The rate is
fixed in each sandbox's quote, as `egress.outbound` in `rates`, and
`GET /v1/usage` answers the month so far under `outbound`: what was sent, what
the allowance covered, and what the rest cost. At {{outbound-rate}}, 1 TB past the
allowance costs {{=$0 1000 * outbound-rate}}.

A paid sandbox moves up to 500 GiB a day, in and out together, and a trial
account 5 GiB a day across all its sandboxes; [the network](./sandbox-environment#the-network) has the speeds.

A dedicated IPv4 address costs **{{address-month}} per 30-day month**. A WireGuard tunnel
costs **{{tunnel-month}} per 30-day month**, including up to 16 peers. These are prorated to
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
CPU:    1,000 × 20 / 3,600 × {{cpu-rate}} = {{=$6 1000 * 20 / 3600 * cpu-rate}}
Memory: 1,000 × 60 / 3,600 × 4 × {{memory-rate}} = {{=$6 1000 * 60 / 3600 * 4 * memory-rate}}
Total:  {{=$6 1000 * 20 / 3600 * cpu-rate + 1000 * 60 / 3600 * 4 * memory-rate}}, approximately {{cost:runtime}} per 1,000 runs
```

At 100,000 runs a month, that is {{cost:runtime:100000}}. The figure assumes the CPU floor does
not exceed measured CPU. It leaves out taxes, paid disk retention, network
charges if any, free credits and retries. Count startup and dependency setup in
running time when they are inside the billable interval.

## Published rate comparison

The same example at each provider's published rates, checked {{rivals-checked}};
each provider's comparison page gives its own date.

| Provider                                                        | CPU and memory for 1,000 runs |              Runtime saves |
| --------------------------------------------------------------- | ----------------------------: | -------------------------: |
| **Runtime**                                                     |          **{{cost:runtime}}** |                          — |
| Northflank, published CPU and memory rates (4 GB)               |           {{cost:northflank}} |      {{saving:northflank}} |
| Cloudflare Sandbox, published rates (2 vCPU, 6 GiB, 12 GB disk) |           {{cost:cloudflare}} |      {{saving:cloudflare}} |
| Fly Machines, `performance-2x` with 4 GB, `iad`                 |         {{cost:fly-machines}} |    {{saving:fly-machines}} |
| Prime Sandboxes, published rates (5 GiB disk)                   |                {{cost:prime}} |           {{saving:prime}} |
| Morph, 2 MCUs an hour                                           |                {{cost:morph}} |           {{saving:morph}} |
| Vercel Sandbox, published `iad1` rates (4 GB)                   |               {{cost:vercel}} |          {{saving:vercel}} |
| Freestyle, published rates (32 GiB disk)                        |            {{cost:freestyle}} |       {{saving:freestyle}} |
| CodeSandbox SDK, a Nano VM (2 cores, 4 GB)                      |          {{cost:codesandbox}} |     {{saving:codesandbox}} |
| E2B, published per-second rates                                 |                  {{cost:e2b}} |             {{saving:e2b}} |
| Daytona, published CPU and memory rates                         |              {{cost:daytona}} |         {{saving:daytona}} |
| Blaxel, 4 GB of memory while active                             |               {{cost:blaxel}} |          {{saving:blaxel}} |
| Fly Sprites, published rates (4 GB of memory in use)            |          {{cost:fly-sprites}} |     {{saving:fly-sprites}} |
| Modal Sandboxes, published rates (1 physical core)              |                {{cost:modal}} |           {{saving:modal}} |
| AWS Lambda MicroVMs, Arm, US East (a 4 GB baseline)             |      {{cost:lambda-microvms}} | {{saving:lambda-microvms}} |
| Runloop, a `MEDIUM` devbox (2 CPUs, 4 GB, 8 GB disk)            |              {{cost:runloop}} |         {{saving:runloop}} |

Each row's working is on its comparison page:
[E2B](./e2b-alternative), [Daytona](./daytona-alternative),
[Vercel](./vercel-sandbox-alternative), [Modal](./modal-sandbox-alternative),
[Cloudflare](./cloudflare-sandbox-alternative), [Fly.io](./fly-alternative),
[CodeSandbox](./codesandbox-alternative), [Morph](./morph-alternative),
[Northflank](./northflank-alternative), [Runloop](./runloop-alternative),
[Blaxel](./blaxel-alternative), [AWS Lambda MicroVMs](./aws-lambda-microvms-alternative),
[Freestyle](./freestyle-alternative) and [Prime Sandboxes](./prime-sandboxes-alternative).

- E2B and Daytona {{~ alike : rate:daytona:cpu / rate:e2b:cpu ; rate:daytona:memory / rate:e2b:memory}} charge {{rate:e2b:cpu}} per vCPU-hour and {{rate:e2b:memory}} per GiB-hour for every allocated vCPU.
- Vercel charges {{rate:vercel:cpu}} per active CPU-hour and {{rate:vercel:memory}} per provisioned
  GB-hour in `iad1`; other regions differ.
- Modal charges {{=$4 rate:modal:cpu * 2}} per physical core-hour and {{=$4 rate:modal:memory}} per GiB-hour, on
  whichever is higher of request and use.
- Cloudflare needs at least 3 GiB per vCPU, so its row is priced at 6 GiB.
- Northflank charges {{rate:northflank:cpu}} per allocated vCPU-hour and {{rate:northflank:memory}} per GB-hour.
  It is the one row where a job that keeps every CPU busy costs less than on
  Runtime.
- Morph charges {{rate:morph:unit}} per MCU-hour; 2 vCPUs and 4 GB is 2 MCUs.
- CodeSandbox charges 10 credits an hour at {{term:codesandbox:credit-price}} for a Nano VM.
- Blaxel charges {{=$7 rate:blaxel:memory / 3600}} per GB-second of active time, with CPU included.
- Runloop charges {{rate:runloop:cpu}} per CPU-hour, {{rate:runloop:memory}} per GB-hour and {{rate:runloop:disk}} per
  GB-hour of disk.
- AWS Lambda MicroVMs charge {{=$10 rate:lambda-microvms:cpu / 3600}} per vCPU-second and {{=$10 rate:lambda-microvms:memory / 3600}}
  per GB-second of the baseline size while a MicroVM runs, on Arm in US East.
- Freestyle charges {{rate:freestyle:cpu}} per vCPU-hour, {{rate:freestyle:memory}} per GiB-hour of memory and
  {{rate:freestyle:disk}} per GiB-hour of storage, all on the allocation.
- Prime Sandboxes charge {{part:prime:disk}} per vCPU-hour, {{rate:prime:memory}} per GiB-hour of memory
  and {{rate:prime:disk}} per GiB-hour of disk while running, rates published through
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

## Uptime promise

Paid accounts are promised {{uptime-promise}} API uptime every calendar month,
measured by the check from outside our servers that the
[status page](/status) publishes. If a month falls short, every paid account
receives {{uptime-credit}} of that month's charges back as service credit in the
first week of the next month. Nobody has to ask: it is added automatically, the
account's owners are emailed, and the billing page lists it. The full terms are
the [Uptime Promise](/legal/sla).

## Switching credit

Moving from E2B, Daytona, Vercel Sandbox, Modal, Cloudflare, Fly or Blaxel? Say so
before your first top-up, and that top-up is matched with credit, up to {{switching-max}}:

```bash check
runtime switch --from e2b
```

- Once per organization, and only before its first top-up. Your agent can do
  it for you: `POST /v1/switching`, or the `runtime_switching_record` MCP tool.
- The credit lands when the payment settles. Pay $40 and you get $40 more; pay
  $250 and you get {{switching-max}} more.
- It does not stack with a [referral](./referrals). If you signed up through a
  referral link, the referral's match applies instead, and it is never smaller.
- If the top-up is refunded or charged back, the matching credit goes back too,
  up to what is unspent, and a refund of that top-up is smaller by any matching
  credit already spent.

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
