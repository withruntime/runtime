# Understand your sandbox bill

You pay for the CPU your code uses, not the CPUs it holds: **{{cpu-rate}} per active vCPU-hour** and **{{memory-rate}} per reserved GiB-hour of memory**.

There is no plan fee. For an agent that spends most of its time waiting on a model, that makes Runtime **{{saving-range}} cheaper** than {{rival-count}} other sandbox providers ([the comparison](#published-rate-comparison)).

- **Busy:** 2 vCPUs and 4 GiB with both CPUs working cost {{busy-hour}} an hour.
- **Waiting while it runs:** the same sandbox costs {{idle-hour}} an hour, for memory plus the default CPU floor of {{cpu-floor}} ({{cpu-floor-share}}). After {{idle-pause}} with nothing happening, it pauses and pays for paused storage instead.
- **Memory:** {{memory-rate}} per GiB-hour is the lowest memory rate of the providers in [the comparison](#published-rate-comparison) that price memory on their own.
- **At scale:** 1,000 running hours cost {{= idle-hour * 1000}} waiting and {{=$0 busy-hour * 1000}} fully busy.

Memory is billed while compute runs. CPU is billed from the moment the sandbox is ready. Runtime pays for the CPU used while a sandbox boots or restores. A GiB is 1,073,741,824 bytes, not a decimal GB. A higher `cpuFloorMillis`, or `cpu: "reserved"`, raises the waiting charge. Reserved CPU keeps every vCPU for the sandbox and bills it as if it were always busy. The floor becomes all of them, so 2 reserved vCPUs and 4 GiB cost {{busy-hour}} an hour whether the code works or waits. The price quote for each resource is fixed when the resource is created.

**Idle time is paused time.** A sandbox pauses itself after {{idle-pause}} with nothing happening in it: no request, no command still running, no open connection, no network traffic and no CPU use. From then on, it pays only for [paused storage](#paused-storage). The next request wakes it. Set `idlePauseSeconds` from {{idle-pause-min}} to {{idle-pause-max}}, or 0 to keep it running.

**A running sandbox's disk.** The first {{running-disk-included}} of a running sandbox's disk is included. Past that, the blocks that only its disk holds are billed at the [paused-storage](#paused-storage) rate, {{paused-storage-rate}} per decimal GB per 30-day month, measured every 30 seconds while it runs. A disk of {{running-disk-included}} or less never pays this. That includes the default size and every sandbox's disk without credit. The bill shows it as "Sandbox disk". Sandboxes made before 5 October 2026 keep the terms they were quoted.

**Busy time is never cut off on a clock.** A sandbox has no time limit unless you set one with `timeoutSeconds`. A busy sandbox keeps running and pays for what it uses. It runs until you stop it, it goes idle and pauses, or its credit, a spending limit or its own `maxTotalCostMicros` runs out. `onTimeout` (`onLeaseEnd` in the SDKs) says whether it then pauses or stops. `persistent: true` keeps a sandbox running until you stop it, with no idle pause. Its disk is billed as any sandbox's disk is.

**Start free.** Every account gets [free usage](./included-usage), with no card: {{free-memory}} of memory, {{free-cpu}} of active CPU, {{free-saved-copies}} of saved copies (snapshots, images, backups) and {{free-disks}} of volumes. That is enough for {{included-machine}}. An account that has never paid gets the machine time once, across its first 30 days. An account that has paid gets it every month, renewed on the 1st (UTC). Free usage is used before credit and is never charged. An account given free hours before 5 October 2026 also keeps what is left of them.

**Then prepay.** Add credit by card at [Usage & billing](https://withruntime.com/account/billing), in any amount from {{topup-min}} to {{topup-max}}. There is no subscription. The page shows how long your credit lasts at this month's pace, and what each product cost each day. Its ledger links each card purchase to its Stripe receipt. Runtime emails you once each purchase's credit is added, with any match it earned and your balance. Credit you add within {{welcome-days}} days of signing up is matched, up to {{welcome-max}} in total ([welcome match](#welcome-match)). Refer a company, and you both get up to {{referral-max}}. After that, you get {{referral-share}} of what it spends, for {{referral-share-months}} months ([referrals](./referrals)). A venture-backed startup building with AI agents can apply to [Runtime for Startups](https://withruntime.com/startups) for {{startup-machine}}, given once: {{startup-cpu}} of active CPU and {{startup-memory}} of memory, used after the month's free usage and before credit. They never renew, so use them within 12 months. For those 12 months, Runtime for Startups also includes {{startup-saved-copies}} of saved copies and {{startup-disks}} of volumes kept free each month, on top of the month's free usage. Storage past them is charged at the published rates. For the same 12 months, an accepted startup is a paid account with no top-up. It runs {{startup-builds}} image builds at once, and up to {{startup-at-once-most}} sandboxes at once if it asks. After those 12 months, it is a paid account once it holds credit it bought.

<!-- launch: plans -->

## Plans

A plan is a monthly commitment. Its full fee is returned as usage. Every meter keeps the price on this page, so you still pay only for what runs.

|                                         | Free                 | Pro                                    | Pro Max            | Scale                  | Enterprise              |
| --------------------------------------- | -------------------- | -------------------------------------- | ------------------ | ---------------------- | ----------------------- |
| Monthly fee                             | none                 | {{pro-fee}}                            | {{pro-max-fee}}    | {{scale-fee}}          | {{enterprise-fee}}      |
| Usage included each month               | the Free tier, below | {{pro-fee}}                            | {{pro-max-fee}}    | {{scale-fee}}          | {{enterprise-fee}}      |
| First month                             |                      | usage doubled                          | usage doubled      | usage doubled          | usage doubled           |
| Yearly                                  |                      | {{pro-yearly}}, 12 months for 10       | {{pro-max-yearly}} | {{scale-yearly}}       | {{enterprise-yearly}}   |
| Sandboxes at once                       | 2                    | {{paid-sandboxes}}                     | 250                | 500                    | 2,000                   |
| vCPUs / memory across running sandboxes | 8 / 16 GiB           | {{account-vcpus}} / {{account-memory}} | 500 / 1,000 GiB    | 1,000 / 2,000 GiB      | 4,000 / 8 TiB           |
| Traffic out included                    | 10 GB                | from usage                             | from usage         | from usage             | from usage              |
| Storage kept (of it, snapshots)         | 50 GiB (20 GiB)      | 1 TiB (500 GiB)                        | 2 TiB (1 TiB)      | 4 TiB (2 TiB)          | from 8 TiB (from 4 TiB) |
| Roles and the support agent             |                      | yes                                    | yes                | yes                    | yes                     |
| Single sign-on and a year of audit log  |                      | add-ons                                | add-ons            | yes                    | yes                     |
| Support                                 | docs                 | the support agent                      | the support agent  | shared Slack, priority | dedicated Slack         |

- **Free replaces the free usage above once plans start.** Each month after the 14-day trial, it gives sandboxes 5 vCPU-hours, 2 at the same time. It also gives one App of 256 MiB that sleeps after 5 minutes idle, on a runtimehost.com address; 10,000 Function calls; 100 CI/CD runner-minutes; and 10 GB of traffic out.
- **Apps, Functions and Agents** cost {{app-cpu-rate}} per active vCPU-hour and {{app-memory-rate}} per GiB-hour. **CI/CD** costs {{ci-minute-rate}} per vCPU-minute, with {{ci-memory-per-vcpu}} of memory each, billed by the second with no minimum. Sandboxes keep the rates above.
- **Traffic out costs {{outbound-rate}} per GB,** whether it is served from the CDN's cache or not. It is drawn from the plan's usage like everything else.
- **A plan's usage is spent first each month,** then free usage and credit Runtime gave, then credit you bought. Unused plan usage ends with the month. Your credit never does.
- **The first month on a paid plan, and after an upgrade, includes twice the plan's usage.**
- **Try Pro for 14 days with no card,** once per person.
- **Pro's add-ons,** monthly: 50 more sandboxes at once $25, single sign-on $150, the audit log kept a year $50, a dedicated outbound address $25.
- **An upgrade starts immediately** and is charged for the rest of the month. A downgrade or a cancellation takes effect at the end of the month you paid for. Nothing is refunded, because the fee is already usage.
- **Limits are ceilings, not reserved room.** When the servers are full, a new sandbox is refused with `no_capacity`, whatever the plan.
- **Without a plan, nothing changes.** Every meter keeps the price on this page, so you still pay only for what runs.

Choose a plan at [Usage & billing](https://withruntime.com/account/billing).

<!-- /launch: plans -->

## How many at once

One paid sandbox can have up to **{{max-vcpu}} vCPUs and {{max-memory}} of memory**, at the same per-unit rates, and a disk of up to {{max-disk}}; a sandbox without credit up to 2 vCPU, 4 GiB and a 10 GiB disk. Fully busy, the largest sandbox costs {{=$2 cost:runtime:16x64x3600x57600x1}} an hour.

A paid account runs **{{paid-sandboxes}} sandboxes at once**. The count includes sandboxes that are starting, running, waking or pausing. Paused and stopped sandboxes do not count. The account has up to **{{account-vcpus}} vCPUs and {{account-memory}} of memory** across the running sandboxes, and {{account-disk}} of disk, from the first top-up. While [auto top-up](#auto-top-up) is on, these limits double, and the account runs {{auto-sandboxes}} sandboxes at once. A disputed payment, a suspension or an abuse report puts an account back to {{restricted-sandboxes}} sandboxes at once. A paused sandbox holds no CPU or memory. Waking one while the account already runs its limit is refused with `quota_exceeded`, and the sandbox stays paused until another sandbox pauses or stops. A paused sandbox's disk is still billed as storage. An account keeps up to 1,000 sandboxes in all, running, paused or stopped. Delete the ones you no longer need, or ask support for more. At a busy moment, a create can still return `no_capacity`. The SDKs wait for room, up to two minutes by default.

Paid features come at two levels.

- **Has credit.** An account that holds credit, bought or given, has the paid limits and every other paid feature, except three things. Those three include rules on a secret, dedicated outbound addresses and four image builds at once.
- **Kept top-up.** Three features that spammers abuse also need a kept top-up: ports beyond 80 and 443 (outbound, custom domains, TCP ports and your own upstream proxy), public previews, and private networks (WireGuard tunnels, reaching your sandboxes by name, and Tailscale). A top-up counts once it is paid, by card or in stablecoins. It counts only while it is not refunded or charged back in full, and no payment of it is in dispute. Credit Runtime gave does not count. A startup accepted to Runtime for Startups counts as having a kept top-up from the day it is accepted.

When every top-up has been refunded or charged back, the three features close again. A refusal says which level is missing: "needs credit" or "needs a kept top-up".

These limits are a starting point, not a price tier. To run more, write to support with the numbers you need ([feedback and support](./feedback-and-support)). For a burst of hundreds of sandboxes for a few hours, [book the room](./reservations). Your limits rise by what you booked for the window. Sandboxes you run are billed as usual. Booked room that none of them uses costs a quarter of the memory rate, **{{booked-unused-rate}} per GiB-hour**, with no CPU charge. It costs nothing if you cancel at least an hour before the start ([what it costs](./reservations#what-it-costs)). Every limit, with credit and without, is listed in [limits](./limits). Past a limit, a create returns `quota_exceeded`. The error says which limit was reached and, for a new account, when it lifts. The create costs nothing. An account without credit runs {{trial-sandboxes}} at once, at most {{no-credit-total}} in all, keeps at most {{no-credit-kept}} sandboxes, and makes at most {{no-credit-daily}} a day. Its scheduled jobs wait for credit ([free usage](./included-usage)).

## Paused storage

A paused sandbox keeps its files and memory for **{{paused-storage-rate}} per decimal GB per 30-day month**. The sandbox's fixed resource quote holds the actual rate. A stopped sandbox keeps its disk the same way, at the same rate, for as long as a paused one. It is kept until you delete it. Only a delete removes a disk. A sandbox made by an older client (a JavaScript or Python SDK before 0.12.0, Go, Java or Ruby before 0.2.0, or raw HTTP without `x-runtime-client: http/2026-10-04`) is kept the same way in an account with credit, a card saved or a past purchase. If its credit runs out, it is still kept at least 30 days from the stop. In an account with none of these, it is kept free for three days after it stops, with one notice a day before. Then it is deleted. The version counts, not its date. JavaScript 0.11.1 and 0.11.2 and Python 0.11.1 came out after 4 October. They still stop to clean up at the end of a `with` or `await using` block, so they are older clients.

- **What counts:** disk and memory-snapshot blocks the sandbox alone owns. Shared base-image blocks and snapshot safety overhead are left out. Where the filesystem cannot report sharing, allocated blocks are used instead. This can overcount. The same measure bills a running sandbox's disk past its first {{running-disk-included}}.
- **What does not:** the provisioned disk allowance, or the sum of live file sizes.
- **When it runs:** compute billing ends when a pause stops the sandbox's processors, before its memory is written to disk. Storage billing begins at that moment, at the size measured once the write finishes. It ends on a confirmed resume or deletion. Compute has no one-minute minimum.

A paused sandbox on a paid account is kept as long as the account has credit, until you delete it, or for 1–365 days if you set them with `:retention`. Those days count from each pause. Using the sandbox ends the count. So with `:retention` at 1, an idle pause is a day from deletion. For dates you set this way, the warning email below goes at most once a day for the account. It lists every sandbox due, and only while its deletion is still due. `null` keeps it while you have credit again. When credit runs out it is kept 30 more days in an account that has bought credit or saved a card, seven in one that has done neither. A notice is sent first. A top-up before then keeps it again. Each pause replaces the previous saved state. On an account without credit, a paused sandbox is kept seven days for free. `:retention` on a sandbox made without credit returns `retention_unavailable`. Its days cannot be set. Once the account holds credit, a sandbox paused without credit is kept as a paid one is. Its storage is billed from the end of its seven free days. The resource's `pausedExpiresAt` (null while it is kept as long as you have credit) and its paused-storage receipt give its actual terms.

A pause with an end date that you ask for, or one at the end of a time limit or of credit, posts an account notice with the date its saved state is kept until. The notice is posted within about five minutes, so a sandbox woken sooner may get none. An idle pause, and one kept as long as you have credit, posts none. Every paused sandbox with an end date gets a warning a day before its saved state is deleted. Its storage is still charged from the moment it paused, as above.

<!-- launch: agents -->

## Agents

An agent's session runs in a sandbox of its own, at Agents' own rates, the same as Apps: **{{app-cpu-rate}} per active vCPU-hour** and **{{app-memory-rate}} per GiB-hour of memory** while it runs, and [paused storage](#paused-storage) while it waits for words. Its traffic is charged as any sandbox's traffic is. There is no session fee and no seat. Your model provider bills your key.

A session's history and files are storage, counted with your saved copies. They share the free {{free-saved-copies}} a month ([free usage](./included-usage)). Past that, they are billed at {{paused-storage-rate}} per decimal GB per 30-day month, and are kept until you delete them. Each session shows its size.

Each agent has caps, on by default: $5 a session, including every session under it, and $100 a day ([budgets](./agents#budgets)).

<!-- /launch: agents -->

<!-- launch: containers -->

## Containers

A container is billed as a sandbox of its size, at the sandbox rates: **{{cpu-rate}} per active vCPU-hour** and **{{memory-rate}} per reserved GiB-hour of memory**, while it runs. Containers have no price of their own. Containers need credit on the account ([Containers](./containers)).

<!-- /launch: containers -->

<!-- launch: browsers -->

## Browsers and Desktops

A browser or a desktop is billed as its sandbox, at the sandbox rates: **{{cpu-rate}} per active vCPU-hour** and **{{memory-rate}} per reserved GiB-hour of memory**, while it runs. A paused one is billed as a paused sandbox. Browsers and Desktops have no price of their own ([Browsers](./browsers), [Desktops](./desktops)).

<!-- /launch: browsers -->

<!-- launch: apps -->

## Apps

An App's copy is billed while it is awake: **{{app-cpu-rate}} per active vCPU-hour** for the CPU it uses, never below the {{cpu-floor}} floor, and **{{app-memory-rate}} per GiB-hour of memory**. A copy that its server holds frozen between requests costs nothing for that time. The saved copies of an App's live and previous versions pay [paused storage](#paused-storage), as a snapshot does. Outbound traffic and a running disk past 10 GiB are billed as a sandbox's. There is no fee per App or per deploy.

<!-- /launch: apps -->

<!-- launch: functions -->

## Functions

A Function's copies are billed as an App's are: {{app-cpu-rate}} per active vCPU-hour and {{app-memory-rate}} per GiB-hour of memory while awake, nothing while asleep. Its saved copies are billed as paused storage. Calls cost **{{function-calls-rate}} per million**, counting every response its copies return, errors included. Each account's first {{free-function-calls}} calls in a calendar month are free. There is no fee per Function or per deploy.

<!-- /launch: functions -->

## Snapshots, images and volumes

Storage has been charged since 23 September 2026. An item made before then is charged only from that date.

| What you keep                                | Rate                                                                                                            | Charged on                                                                            |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [Snapshot](./javascript#snapshots-and-forks) | **{{paused-storage-rate}} per decimal GB per 30-day month**, {{snapshot-rate-micros}} microdollars per GiB-hour | The bytes the snapshot alone stores; a block two of your snapshots share counts once  |
| [Image](./javascript#custom-images)          | **{{paused-storage-rate}} per decimal GB per 30-day month**, {{snapshot-rate-micros}} microdollars per GiB-hour | Whole image file; qualified and enabled copy accounting counts verified extra storage |
| [Volume](./javascript#volumes)               | **{{volume-rate-micros}} microdollars per GiB-hour**, about {{volume-month}} per GiB per 30-day month           | The full size you create it with, written or not                                      |

Where deferred compression has been qualified and enabled, a memory capture can be ready for same-server starts while `compressionPending: true`. Raw preparation files are Runtime overhead. Snapshot billing uses the final verified compressed allocation from its ready time, within existing prepaid bounds. A paused source uses its final measured size from the original freeze, but only if it is still paused when that measurement arrives. Waking or deleting it before then does not charge the unmeasured parked interval. See [snapshot storage](./storage#snapshots-survive-their-server).

Where copied-image accounting has been qualified and enabled, an identical image copy verified in your account on the same server adds only its extra storage to billing and quota. The shared base and each verified extra allocation count once while a ready copy still holds them. Deleting the base's owner moves it to a remaining ready copy. An extra allocation moves only to a proven descendant of the copy that added it. Retained capacity is freed only after the last files holding it are removed. Deleting and recreating owners preserves accrued charges. It does not reset the meter. Until that accounting is enabled, all images keep full-file accounting. Changed images and unverified copies keep it afterward too.

The snapshot and image rate is paused storage's rate, rounded down to whole microdollars. The volume rate is the reserved disk rate. A volume holds its whole size on its server from the moment you create it.

Building an image is free. Without credit, it counts toward the free usage, unless it fails through a fault of ours. The snapshot a fork takes for itself, and deletes, is also free. A snapshot is kept as long as you have credit, with no end date (7 days without credit), unless you choose 1 to 365 days. A snapshot's copy off its server is part of the snapshot and costs nothing more. Volume backups cost **{{backup-rate}} per decimal GB per 30-day month**. A backup made before this price keeps {{backup-rate-before}} until {{backup-raise-date}}. Backups are charged on `storedBytes` after a backup is copied and checked ([storage and backups](./storage)). Every volume is backed up off its server daily, unless you turn that off.

The [free usage](./included-usage) stores your first three images and your first 10 GiB of volumes free, for as long as you keep them. They are never charged, even after you add credit. Deleting one frees its place. Snapshots are not part of that free storage.

How much an account stores is limited in GiB: 500 GiB in all and 250 GiB of snapshots with credit, and 50 GiB and 20 GiB without. Past a limit, nothing is deleted. New snapshots, images, backups and volumes are refused until there is room ([limits](./limits#storage)).

An item's rate is fixed when you make it. A new price reaches items that already exist only from a date announced ahead, here and in the [changelog](./changelog). Its rate now is under `rates` in `GET /v1/usage`: `storage.stored` for a snapshot or a volume backup, `storage.reserved` for an image and `storage.provisioned` for a volume.

Storage is paid an hour at a time from your balance. The hold covers the most the item can be charged for that hour. The charge is what it used, and the rest is released. Each hour settles within a minute of its end, usually within seconds, and appears in the [usage export](./api#export-settled-usage) from then on.

<!-- launch: apps -->

## Apps

An App's copies are machines on the Sandboxes meter, billed at the Apps rate: **{{app-cpu-rate}} per active vCPU-hour** and **{{app-memory-rate}} per GiB-hour of memory** while a copy is awake. Its disk past the first {{running-disk-included}} is billed as a sandbox's disk is, and its traffic out is billed as a sandbox's outbound traffic. There is no fee per App, per request or per deploy.

- **Copies kept awake.** `minCopies` keeps that many copies awake whether or not requests come, so they pay for memory all the time. One copy of 1 vCPU and 1 GiB kept awake for a 30-day month costs {{=$2 720 * app-memory-rate}} in memory, plus the CPU it uses.
- **Frozen copies are free.** A copy that has gone quiet freezes. An App keeps its spare copies frozen for the next burst. A frozen or parked copy pays nothing.
- **Saved copies.** The live and the previous version each keep a saved copy (a snapshot of the warm server), billed as a snapshot, **{{paused-storage-rate}} per decimal GB per 30-day month**. An App with `minCopies: 0` and no requests pays only these.

<!-- /launch: apps -->

<!-- launch: ci -->

## CI/CD

A check machine costs **{{ci-vcpu-minute}} per vCPU-minute**, with {{ci-gib-per-vcpu}} of memory per vCPU. It is billed by the second, from when it starts until it is deleted, with no minimum and no rounding up. That is {{ci-2vcpu-minute}} a minute for a 2-vCPU, 8 GiB job. A job of 90 seconds on the default machine, 4 vCPU and 16 GiB, costs {{=$4 4 * 90 / 60 * ci-vcpu-minute}}. A job that passed before is not run, so it costs nothing. There is no fee per user, per repository or per check. A warm snapshot is charged at the [snapshot rate](#snapshots-images-and-volumes) while it is kept ([CI/CD](./ci)).

<!-- /launch: ci -->

## Network products

Inbound traffic is free. Each account's first **{{outbound-allowance}} of outbound traffic a month** is free. After that, it costs **{{outbound-rate}} per decimal GB**. Outbound traffic is what your sandboxes send to the internet, over the connections they open (TCP and UDP). For sandboxes created from 5 October 2026, it also covers what they serve through previews, custom domains and TCP ports, including a desktop's live view. Everything a sandbox receives is not counted. Neither is traffic to your own network over a WireGuard tunnel, traffic to your other sandboxes by name, or your code's calls to Runtime's own API at `http://runtime.internal`. What a sandbox created before 5 October 2026 serves stays free for its life. A sandbox without credit has free traffic, and it uses none of the allowance.

The allowance is shared by all of an account's sandboxes. It starts again on the first of each month, UTC. Traffic is charged from your balance each time a sandbox's compute settles. That happens while it runs, in windows of up to an hour, each settled after it ends. It also happens when it stops or pauses, and whenever you read the [usage export](./api#export-settled-usage), which first settles each running sandbox paid from credit through about a minute ago. Traffic is never held in advance, and it never takes the balance below zero. The rate is fixed in each sandbox's quote, as `egress.outbound` in `rates` for what it sends and `egress.served` for what it serves. `GET /v1/usage` returns the month so far under `outbound`: what was sent, what the allowance covered, and what the rest cost. At {{outbound-rate}}, 1 TB past the allowance costs {{=$0 1000 * outbound-rate}}.

<!-- launch: apps -->

What Cloudflare's cache serves for an App's addresses and custom domains, without asking the App, is outbound traffic too. It is billed at the same {{outbound-rate}} per decimal GB, from the same monthly allowance as your sandboxes. The bytes are read from Cloudflare's analytics an hour at a time, and charged once for each hour, within about half an hour of its end. They show in `GET /v1/usage` under `outbound`, with your sandboxes' traffic. An App made without credit sends for free and uses none of the allowance.

<!-- /launch: apps -->

<!-- launch: functions -->

What Cloudflare's cache serves for a Function's addresses and custom domains, without calling the Function, is outbound traffic too. It is billed at the same {{outbound-rate}} per decimal GB, from the same monthly allowance as your sandboxes. The bytes are read from Cloudflare's analytics an hour at a time, and charged once for each hour, within about half an hour of its end. They show in `GET /v1/usage` under `outbound`, with your sandboxes' traffic. A Function made without credit sends for free and uses none of the allowance.

<!-- /launch: functions -->

A paid sandbox moves up to {{paid-daily-transfer}} a day, in and out together. An account without credit moves {{trial-daily-transfer}} a day across all its sandboxes. [The network](./sandbox-environment#the-network) has the speeds.

A dedicated IPv4 address costs **{{address-month}} per 30-day month**. A WireGuard tunnel costs **{{tunnel-month}} per 30-day month**, including up to 16 peers. These are prorated to funded time. Each resource's rate is fixed in its quote. Dedicated IPv6, custom domains (up to 50) and TCP ports are included.

If credit or another spending permission prevents renewal, address and tunnel traffic stops. The reservation stays yours until you release it. Unpaid time is never billed later. A dedicated address never silently switches to a shared outbound address. See [networking](./networking) for funding status and access.

## Pay with stablecoins

Credit can be bought in USDC on Base, Solana or Tempo, from any wallet. `runtime billing topup 50` prints an address per network and the exact amount to send. `--wait` waits until the credit lands. `runtime billing status <id>` says whether the payment arrived. A top-up is {{topup-min}} to {{topup-max}}, and a new account buys at most $500 in its first week.

An agent working with no person can open its own account this way. There is no sign-in, no browser and no card, and no free trial. The account gets its key only once its payment lands. Until a person takes the account over, it earns no [welcome match](#welcome-match) and no referral reward. Payments made after a takeover earn them as they do for anyone.

```bash no-run
npx withruntime billing topup 20 --new-account --accept-terms --wait
```

- `--accept-terms` agrees to the [terms](https://withruntime.com/legal/terms) for whoever the agent acts for.
- It prints a claim code, shown once. It is the only way to the account's key, so keep it secret. `runtime billing claim <code> --wait` fetches the key if the first response was lost.
- `--wait` saves the key on that machine once the money lands. The CLI, SDKs and MCP use it from then on.
- A person can take the account over later at [withruntime.com/account/claim](https://withruntime.com/account/claim) with the claim code.

Over HTTP, with no CLI:

1. Make a claim code: `rtclaim_` and 43 base64url characters from 32 random bytes. Holding it before the first response means a retry finds the same account and opens no second one.
2. `POST https://withruntime.com/api/wallet/topups` with `{"usd": 20, "acceptTerms": true, "claimCode": "rtclaim_…"}` returns 201 with an address per network and the exact amount. Send exactly that amount to one of them.
3. `POST https://withruntime.com/api/wallet/claim` with `{"claimCode": "rtclaim_…"}` returns 202 until the payment lands, then 200 with `apiKey`, once. Store it as `RUNTIME_API_KEY`.

With MCP and no shell, `npx -y withruntime mcp` offers `runtime_wallet_open` and `runtime_wallet_claim` before it is connected. The claim saves the key, and Runtime's tools appear. A remote MCP client with no key connects to `https://api.withruntime.com/mcp?signup=wallet` for the same two tools. Its claim returns the key once, for `Authorization: Bearer <key>` on `https://api.withruntime.com/mcp`.

Every SDK has the two calls: `openWalletAccount` and `claimWalletAccount` in JavaScript, `withruntime.wallet` in Python, `OpenWalletAccount` and `ClaimWalletAccount` in Go, `WithRuntime::Wallet` in Ruby and `Wallet` in Java.

## Auto top-up

Auto top-up adds credit from a saved card when your balance falls below a line you pick, so sandboxes never stop for an empty balance. Turn it on at [Usage & billing](https://withruntime.com/account/billing#auto-top-up). It starts with these settings: when credit falls below {{auto-below}}, add {{auto-amount}}, up to {{auto-monthly}} in a calendar month (UTC). You can change any of them. The line can be set to any amount from {{auto-below}}. The monthly maximum can be any amount from {{auto-least-monthly}}. The amount runs from {{auto-amount}} to {{topup-max}}, and $500 in an account's first week, as for any top-up. That is also the most an account adds in 24 hours. The card is saved on Stripe's page. Runtime never sees its number.

- Each automatic top-up earns **{{auto-bonus}} more as credit** once its charge has gone through. For example, add $20 and you get $21. The extra is granted credit, never cash, and it is used after the month's free usage.
- While auto top-up is on with a saved card, the account runs **{{auto-sandboxes}} sandboxes at once** instead of {{paid-sandboxes}}, with twice the vCPUs, memory and disk across them. Turning it off returns new starts to {{paid-sandboxes}}. Sandboxes already running keep running. A limit set for your account by support or a pilot stays as it is.
- Only one charge runs at a time. The line is checked every minute, and a charge is never repeated for the same fall below the line. Tax is added as on any top-up.
- If the bank declines a charge or asks to confirm it, auto top-up turns itself off, and Usage & billing says why. Nothing that is running stops. Turn it on again, or save another card. Removing the card also turns it off.
- If an automatic top-up is refunded or charged back, its extra credit goes back too, up to what is unspent. A refund is smaller by any of the extra already spent.

Owners, admins and billing members can change it, and so can a key one of them made: `runtime billing auto-top-up on --below 25 --amount 50 --monthly 1000`, `billing.autoTopUp.set()` in the SDK, or `PUT /v1/billing/auto-top-up`. A figure left out keeps the one saved. `runtime billing auto-top-up off` turns it off. `runtime_account_get` in MCP shows it. Only a person can save the card.

## When your balance runs out

While your sandboxes run on paid credit, each owner of the account is told when the balance will last under five days at this month's pace. Each owner is also told when the balance has run out. Each notice is sent once, and again after the next top-up. The notices go to the account inbox and by email. Usage & billing shows the same warning. The account's webhooks are told at the same two moments, with `credit.low` and `credit.empty` ([events](./observability)). `GET /v1/limits` returns the credit left and the days it lasts (`credit.runwayDays`), so an agent can add credit in time. An account opened with a wallet has no person to email, so this is how it hears.

Storage charges stop at zero, and your balance never goes below it. You never owe money. Nothing is lost immediately:

- A stopped or paused sandbox's disk is kept for **30 days** in an account that has bought credit or saved a card. Any other item, and every item in an account that has done neither, is kept for **seven days**. An account notice tells you the date, and a second notice warns you a day before it. Notices go to your account inbox (`runtime_notices` in MCP). The day-before warning is also emailed to the account's owners, from Runtime, in one email for everything it covers.
- Add credit within those days, and charging starts again from then. The days it went unpaid are written off. They are never charged, now or later.
- Once those days pass unpaid, the item is deleted. A volume that a sandbox still uses is deleted once that sandbox lets it go.

Paused sandboxes follow the same rule.

## When a payment is under review

If a card's bank reports a top-up as possibly not the cardholder's, or the card also paid for an account that was suspended or charged back, spending is held while we review it. A request that would spend returns `account_blocked` (402) with that reason. Usage & billing says a payment is under review. Your balance, sandboxes, volumes and images are kept. Nothing is refunded or taken. Spending resumes when the review clears. Write to support@withruntime.com to speed it up. One card paying for two of your accounts is fine on its own.

## Per 1,000 runs

The standard example: 2 vCPUs, 4 GiB, 60 seconds of running time per run, 20 CPU-seconds of work per run, and 1,000 completed runs. A CPU-second is one core busy for one second. Two cores busy for ten seconds use 20 CPU-seconds.

```
CPU:    1,000 × 20 / 3,600 × {{cpu-rate}} = {{=$6 1000 * 20 / 3600 * cpu-rate}}
Memory: 1,000 × 60 / 3,600 × 4 × {{memory-rate}} = {{=$6 1000 * 60 / 3600 * 4 * memory-rate}}
Total:  {{=$6 1000 * 20 / 3600 * cpu-rate + 1000 * 60 / 3600 * 4 * memory-rate}}, approximately {{cost:runtime}} per 1,000 runs
```

At 100,000 runs a month, that is {{cost:runtime:100000}}. The figure assumes the CPU floor does not exceed measured CPU. It leaves out taxes, paid disk retention, network charges if any, free credits and retries. Count startup and dependency setup in running time when they are inside the billable interval.

## Published rate comparison

The same example at each provider's published rates, checked {{rivals-checked}}. Each provider's comparison page gives its own date.

| Provider                                                        | CPU and memory for 1,000 runs |              Runtime saves |
| --------------------------------------------------------------- | ----------------------------: | -------------------------: |
| **Runtime**                                                     |          **{{cost:runtime}}** |                          — |
| Northflank, published CPU and memory rates (4 GB)               |           {{cost:northflank}} |      {{saving:northflank}} |
| Cloudflare Sandbox, published rates (2 vCPU, 6 GiB, 12 GB disk) |           {{cost:cloudflare}} |      {{saving:cloudflare}} |
| Prime Sandboxes, published rates (5 GiB disk)                   |                {{cost:prime}} |           {{saving:prime}} |
| Fly Machines, `performance-2x` with 4 GB, `iad`                 |         {{cost:fly-machines}} |    {{saving:fly-machines}} |
| Morph, 2 MCUs an hour                                           |                {{cost:morph}} |           {{saving:morph}} |
| Vercel Sandbox, published `iad1` rates (4 GB)                   |               {{cost:vercel}} |          {{saving:vercel}} |
| Freestyle, published rates (32 GiB disk)                        |            {{cost:freestyle}} |       {{saving:freestyle}} |
| Fly Sprites, published rates (4 GB of memory in use)            |          {{cost:fly-sprites}} |     {{saving:fly-sprites}} |
| CodeSandbox SDK, a Nano VM (2 cores, 4 GB)                      |          {{cost:codesandbox}} |     {{saving:codesandbox}} |
| E2B, published per-second rates                                 |                  {{cost:e2b}} |             {{saving:e2b}} |
| Daytona, published CPU and memory rates                         |              {{cost:daytona}} |         {{saving:daytona}} |
| Blaxel, 4 GB of memory while active                             |               {{cost:blaxel}} |          {{saving:blaxel}} |
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
- Vercel charges {{rate:vercel:cpu}} per active CPU-hour and {{rate:vercel:memory}} per provisioned GB-hour in `iad1`. Other regions differ.
- Modal charges {{=$4 rate:modal:cpu * 2}} per physical core-hour and {{=$4 rate:modal:memory}} per GiB-hour, on whichever is higher of request and use.
- Cloudflare needs at least 3 GiB per vCPU, so its row is priced at 6 GiB.
- Northflank charges {{rate:northflank:cpu}} per allocated vCPU-hour and {{rate:northflank:memory}} per GB-hour. It is the one row where a job that keeps every CPU busy costs less than on Runtime.
- Morph charges {{rate:morph:unit}} per MCU-hour. 2 vCPUs and 4 GB is 2 MCUs.
- CodeSandbox charges 10 credits an hour at {{term:codesandbox:credit-price}} for a Nano VM.
- Blaxel charges {{=$7 rate:blaxel:memory / 3600}} per GB-second of active time, with CPU included.
- Runloop charges {{rate:runloop:cpu}} per CPU-hour, {{rate:runloop:memory}} per GB-hour and {{rate:runloop:disk}} per GB-hour of disk.
- AWS Lambda MicroVMs charge {{=$10 rate:lambda-microvms:cpu / 3600}} per vCPU-second and {{=$10 rate:lambda-microvms:memory / 3600}} per GB-second of the baseline size while a MicroVM runs, on Arm in US East.
- Freestyle charges {{rate:freestyle:cpu}} per vCPU-hour, {{rate:freestyle:memory}} per GiB-hour of memory and {{rate:freestyle:disk}} per GiB-hour of storage, all on the allocation.
- Prime Sandboxes charge {{part:prime:disk}} per vCPU-hour, {{rate:prime:memory}} per GiB-hour of memory and {{rate:prime:disk}} per GiB-hour of disk while running. Rates are published through 22 December 2026.

Plan fees, storage, network, free credits and negotiated prices are left out of every row.

Sources: [E2B pricing](https://e2b.dev/pricing),
[Daytona pricing](https://www.daytona.io/pricing),
[Vercel Sandbox pricing](https://vercel.com/docs/sandbox/pricing),
[Modal pricing](https://modal.com/pricing),
[Cloudflare Containers pricing](https://developers.cloudflare.com/containers/pricing/),
[Fly.io pricing](https://fly.io/pricing/),
[Together: CodeSandbox SDK](https://docs.together.ai/docs/together-code-sandbox-legacy),
[Morph Cloud pricing](https://cloud.morph.so/web/pricing),
[Northflank pricing](https://northflank.com/pricing),
[Runloop pricing](https://www.runloop.ai/pricing),
[Blaxel pricing](https://blaxel.ai/pricing),
[AWS Lambda pricing](https://aws.amazon.com/lambda/pricing/),
[Freestyle pricing](https://www.freestyle.sh/pricing),
[Prime Sandboxes overview](https://docs.primeintellect.ai/sandboxes/overview).

## Security and team features

Everything here is free on every account. There is no enterprise plan, no seat fee and no add-on to buy. A company pays the same rates as one person.

- **Single sign-on** over SAML or OIDC with Okta, Microsoft Entra ID, Google Workspace or any SAML 2.0 or OpenID Connect provider, which an owner can require of everyone else ([single sign-on](./single-sign-on)).
- **Directory sync** over SCIM. Your directory adds people, gives them roles from its groups, and removes them, revoking their keys, the moment they leave.
- **Roles:** owner, admin, developer and billing, for as many people as you need ([teams](./teams#roles)).
- **An audit log** of every change to members, keys, money and security settings, with who, when and from which address. It is kept at least 400 days, downloadable as CSV and readable over the API ([audit log](./teams#audit-log)).
- **Two-step sign-in** with a passkey or an authenticator app, which an owner can require ([two-step sign-in](./security#two-step-sign-in)).
- **Spending and access controls:** read-only keys, a daily spending limit per key, and compartments that keep one team's keys out of another team's work ([read-only keys and daily limits](./security#read-only-keys-and-daily-limits)).
- **A data processing addendum** that is part of the terms for every account ([data processing addendum](/legal/dpa)), and the [uptime promise](#uptime-promise) for every paid account.

The [security and compliance](./trust) page is the summary a security review asks for. For a questionnaire, write to security@withruntime.com.

## Uptime promise

Paid accounts are promised {{uptime-promise}} API uptime every calendar month. It is measured by the check from outside our servers that the [status page](/status) publishes. If a month falls short, every paid account receives {{uptime-credit}} of that month's charges back as service credit in the first week of the next month. No request is needed. The credit is added automatically, the account's owners are emailed, and the billing page lists it. The full terms are in the [Uptime Promise](/legal/sla).

**A server that fails is not charged for.** If the server a sandbox runs on stops responding to Runtime, the sandbox is charged only up to the last moment it responded. Time a server holds a sandbox frozen because it cannot reach Runtime is not charged either, for memory or CPU.

## Welcome match

Credit your organization adds within {{welcome-days}} days of signing up is matched with credit, up to {{welcome-max}} in total. There is nothing to claim. Add credit at [Usage & billing](https://withruntime.com/account/billing#add-credit), and the match lands beside it. Home and the billing page show how much of the {{welcome-max}} is used and when the offer ends.

- Every payment in those {{welcome-days}} days counts, not only the first. Add $20 and then $500, and you get $520 more. Add $800 and then $500, and you get {{welcome-max}} more. Credit added after day {{welcome-days}} is not matched.
- The credit lands when each payment settles, whether you pay by card or through Link. Paid through a wallet that tells us neither the card nor the Link account, it lands once someone at Runtime has checked it.
- The match is granted credit. It is used after the month's free usage, and it expires 12 months after it is given.
- It does not stack with a [referral](./referrals). If you signed up through a referral link, the referral matches your payments instead, the same {{referral-max}} over the same {{referral-days}} days, and it is never smaller.
- One payer, one match: a card or Link account whose payment was matched for another organization is not matched again.
- If a payment is refunded or charged back, its matching credit goes back too, up to what is unspent. A refund of that payment is smaller by any of its matching credit already spent. The rest of the match stays. What was taken back can be matched again within the {{welcome-days}} days.

Moving from E2B, Daytona, Vercel Sandbox, Modal, Cloudflare, Fly or Blaxel? `runtime switch --from e2b` records where you came from, so `runtime compare` and Runtime know what you left. Your credit is matched as everyone's is. `runtime switch` on its own shows the match: how much is used and left, and how long you have.

## Check it on your own workload

Once you have run on Runtime, `runtime compare` prices your own sandboxes both ways:

```bash check
runtime compare --from e2b
```

It takes your settled sandboxes from the last 30 days (`--days` up to 90). It prices them at the rates you were quoted. It also prices the same vCPUs, memory and running time at the rival's published rates from the table above. Sandboxes that free usage paid for are priced at the standard rates. That is what the same work costs on paid credit, and the output says how many there were. Then it says what you save, and about how much that is a month. With no sandboxes yet, it prices an example and says so. It compares compute only. Storage, network, plan fees and free allowances are left out. The same figures come from `GET /v1/usage/compare` and the `runtime_account` MCP tool with action `compare`, in microdollars.

To compare a workload you have not moved yet, ask your agent:

“Compare my last 1,000 completed runs with Runtime. Use the same measured job behavior, include my current discounts and required features, show all inputs, and separate estimated savings from measured savings.”
