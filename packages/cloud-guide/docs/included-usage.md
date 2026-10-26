# Free usage

Every account gets free usage, with no card, after a verified sign-in. It is
{{included-machine}}. An account that has never paid gets the machine time
**once, across its first 30 days**. After that it gets none until it adds credit. An
account that has paid (bought credit) gets it **every calendar month**. Saved
copies and disks are monthly for every account:

| Product                                   | Free usage            |
| ----------------------------------------- | --------------------- |
| Machine memory                            | {{free-memory}}       |
| Machine active CPU                        | {{free-cpu}}          |
| Saved copies (snapshots, images, backups) | {{free-saved-copies}} |
| Disks (volumes)                           | {{free-disks}}        |

- For an account that has paid, it renews on the 1st of each month, 00:00 UTC.
  What is left at the end of a month does not carry over. For an account that
  has never paid, the machine time ends 30 days after the account was opened
  (`freeUntil` in `GET /v1/usage`), whatever is left. It comes back every
  month once the account has paid. Credit Runtime gave, such as the welcome
  match, does not count as paying.
- It is used first, before any credit, on every account, with credit or
  without. It is never charged. There is nothing to choose. A request's
  `funding` is accepted and ignored.
- An account given free hours before 5 October 2026 keeps what is left of
  them. It has the free usage as well.
- Model calls are not included.
- An account opened from a data-centre or VPN network (a cloud provider's
  address, or a VPN company's) gets its free usage once it adds credit,
  not before. Accounts are made in bulk from those networks. An account opened
  from a home, office or mobile network gets it at sign-in, as above.

## Without credit

The limits below hold while the account holds no credit. Once it does, its
sandboxes have paid limits. They still use the free usage first
([after you add credit](#after-you-add-credit)).

- Up to **{{trial-sandboxes}} sandboxes running at the same time**, each up to **2 vCPU
  and 4 GiB of memory**, with up to 10 GiB of disk (4 GiB by default). Paused
  sandboxes do not count toward the {{trial-sandboxes}}.
- At most **{{no-credit-total}} at the same time** across every sandbox and image build
  that is running.
- At most **{{no-credit-kept}} sandboxes kept**, running, paused or stopped. A
  create past that is refused with `no_credit_kept_limit`. Delete one to make
  room. Waking, resuming or deleting a sandbox you already keep is never
  refused.
- At most **{{no-credit-daily}} sandboxes made a day** (any 24 hours). Copies
  made by a fork count too. Past that limit, a create is refused with `no_credit_daily_limit`.
- At most **{{no-credit-keys}} live API keys** in the account, whoever made
  them. A new key past that is refused with `no_credit_key_limit`. Revoke one
  to make room. A revoked or expired key frees its place. Every key you
  already hold keeps working. The short-lived keys Runtime makes by
  itself, for the console, its terminals, image builds and the other work it
  runs for you, are not counted. Once the account adds credit,
  there is no limit.
- No [scheduled job](./jobs) runs. It waits until the account holds credit.
- CPU is shared, never reserved. Its guaranteed floor (`cpuFloorMillis`)
  is at most 250 thousandths of a vCPU; the default is 50. A create that asks
  for more is refused with `no_credit_size_limit`, naming each field. So is
  a fork of such a sandbox.
- Sandboxes without credit download with no speed limit and upload at up to
  {{trial-upload}} each. They move {{trial-daily-transfer}} a day in all, in and
  out together. While a server's link is full, a paid sandbox gets
  {{paid-share}} a sandbox without credit's share of it.
- A sandbox without credit that keeps trying to reach internal or cloud
  metadata addresses has its network cut, and the account is suspended. One that
  holds its CPUs flat out for 30 minutes is slowed to half a core for the rest
  of its run.
- Previews of a sandbox without credit are private. A link carries its token.
  Public previews need a kept top-up: one paid and not refunded. Credit given
  alone does not open them ([pricing](./pricing#how-many-at-once)).
- A sandbox runs while it works. It pauses itself when idle, until the
  free usage runs out. Then it pauses, unless the account holds credit. In
  that case it carries on on credit. There is no time limit unless you set
  one with `timeoutSeconds` (60 to 86,400). One longer than the usage left is
  cut to it. Idle means nothing happening in it for `idlePauseSeconds`
  ({{idle-pause}} by default): no request, no command, terminal, SSH session or
  port forward open, no CPU use and no traffic. A browser tab left open on a
  preview does not count. Wake it to keep going.
- Your first three images and first 10 GiB of volumes are stored free, for as
  long as you keep them ([pricing](./pricing#snapshots-images-and-volumes)).
  That is apart from the table. The {{free-disks}} of disks a month in the table
  pays for volumes past your first 10 GiB. A
  build uses the free usage: at most 2 vCPU and 4 GiB,
  {{trial-build-time}} and {{trial-builds-a-day}} builds a day. Only the
  time it builds is used. A build that fails through a fault of ours uses none.
- A [scheduled job](./jobs) does not run without credit. It waits with
  `blockedReason` `credits` until the account holds credit. Once it does,
  each run is a sandbox like any other, and uses the free usage first.
- A sandbox without credit reaches the internet on ports 80 and 443 only.
  Other ports, such as a database's or git over SSH, need a paid sandbox of an
  account with a kept top-up.

Over HTTP, a create is `POST /v1/sandboxes`. This body names the defaults. An
empty body is the same:

```json
{
  "vcpu": 2,
  "memoryMiB": 4096,
  "diskMiB": 4096,
  "cpu": "shared",
  "cpuFloorMillis": 50
}
```

## Tell your agent

Paste the setup prompt from [Get started](./start#give-your-agent-one-instruction).
The agent runs everything on the free usage. It switches any sandbox code the
project has on another provider, and tells you what you would save each month.

## Use it from code

**You do not have to ask for it.** `create()` uses the free usage while the
month has some left, sized to fit.

```ts
import { Runtime } from "withruntime";

const runtime = new Runtime();
const sbx = await runtime.sandboxes.create({ vcpu: 1, memoryMiB: 2048 });
try {
  console.log(sbx.info.funding, sbx.info.endsAt);
} finally {
  await sbx.stop();
}
```

Use a region listed for your account. Leave `region` out for the default.

## See what is left

Read it with `npx withruntime usage`, or `GET /v1/usage`:

- `allowances` has one row per product: `pool`, `unit`, `quantity`, `used`,
  `reserved` (held for what runs now, given back unless used), `left` (the
  quantity less what is used; what is held is not taken off), `month`,
  `renewsAt` and `freeUntil` (when the free usage ends for an account that has
  never paid; null once it has paid).
- `trial` is the machine time a new sandbox without credit can still run, in
  milliseconds: `availableMs`, with `offer` (`monthly`, or `hours` for an
  account given free hours before 5 October 2026) and `renewsAt`. The field
  keeps its older name, so code that reads it goes on working.
- `startupIncluded` lists what [Runtime for Startups](https://withruntime.com/startups)
  includes for an accepted startup, one row per product.
  `machine-cpu` and `machine-memory` have `period` `once`: `quantity`,
  `used`, `reserved` and `left`. They are used after the month's free usage and
  before credit, and never renewed. What is left ends at `expiresAt`, 12
  months after it was given. `saved-copies` and `disks` have `period`
  `month`: `quantity` GB added to each month's included storage until
  `expiresAt`, never used up, with `keptGB`, the GB kept now. Storage past it
  is charged at the published rates. `startupLimits` lists the concurrency limits
  that Runtime for Startups includes, `buildsAtOnce` and `sandboxesAtOnce`, until the same `expiresAt`.
  After it, null. The account is paid with no top-up until then. After that, it is paid once it holds credit it bought.

The old fields `pot` and `potLimits` still work for 30 days after this change ships, with a warning.

In the browser, [Usage & billing](https://withruntime.com/account/billing)
shows what each product used this month and what is left.

## When you reach a limit

| Code                         | What it means                                                                                                                                                                                                                           | What to do                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `no_credit_running_limit`    | Four sandboxes without credit are running; `details.running` names them                                                                                                                                                                 | Stop or pause one; an SDK create waits for a slot    |
| `no_credit_total_limit`      | Running sandboxes and builds would pass {{no-credit-total}}; the message says what runs now                                                                                                                                             | Stop or pause one, or wait for a build to end        |
| `no_credit_kept_limit`       | The account keeps {{no-credit-kept}} sandboxes, running, paused or stopped, and a create would make another                                                                                                                             | Delete one, or add credit                            |
| `no_credit_daily_limit`      | {{no-credit-daily}} sandboxes made in the last 24 hours                                                                                                                                                                                 | Reuse a sandbox, retry later, or add credit          |
| `no_credit_key_limit`        | The account holds {{no-credit-keys}} live API keys, and a new key would make another                                                                                                                                                    | Revoke one, or add credit                            |
| `no_credit_domain_limit`     | Accounts on your company's email domain share eight running sandboxes without credit, all running                                                                                                                                       | Stop or pause one, or add credit                     |
| `no_credit_size_limit`       | The size asked for is larger than 2 vCPU, 4 GiB and 10 GiB of disk                                                                                                                                                                      | Omit the size fields for the default                 |
| `no_credit_build_limit`      | {{trial-builds-a-day}} builds started in the last 24 hours                                                                                                                                                                              | Reuse an image, or retry later                       |
| `no_credit_capacity_full`    | The room servers keep for accounts without credit is full right now                                                                                                                                                                     | Retry shortly; an SDK create waits                   |
| `included_usage_used_up`     | The free usage is used and the account holds no credit                                                                                                                                                                                  | Add credit, or wait for the 1st (UTC) if it has paid |
| `included_usage_unavailable` | The account has no free usage: it goes once to each verified email address, and the owner's is unverified or already has it on another account; or the account was opened from a data-centre or VPN network, where it comes with credit | Verify your email, or add credit                     |

Each of these responses says what was refused and the limit. Then, in its
`hint` and in `details.addCredit`, it gives the one way past it: the account's owner
adds credit. Credit added within {{welcome-days}} days of signing up is matched, up to {{welcome-max}} in total
([how refusals look](./api#responses-and-errors)). An agent tells its person
which limit it met. It never adds credit on its own. The exception is an account it
opened with a wallet and no person pays for. There, the hint tells it to add
credit itself ([pay with stablecoins](./pricing)).

These codes were named `trial_busy`, `trial_capacity`, `invalid_trial`,
`trial_domain_limit`, `trial_build_limit`, `trial_exhausted` and
`trial_unavailable` before 5 October 2026 ([changelog](./changelog)).

Requests sent at the same moment are admitted in no set order, so any one of
them may be the one refused. Shared mail providers such as gmail.com,
outlook.com and icloud.com have no domain limit. Temporary inbox services such
as Guerrilla Mail and Mailinator cannot open an account.

Free usage cannot be cashed out, refunded, carried over or gained by
signing in again.

## After you add credit

**Add credit and keep going.** An owner, admin or billing member adds prepaid
credit at [Usage & billing](https://withruntime.com/account/billing). The amount can be any amount from {{topup-min}}, with no subscription. Credit you add within {{welcome-days}} days of signing up is matched, up to {{welcome-max}} in total
([welcome match](./pricing#welcome-match)). There is nothing to switch. From
then on:

- new sandboxes are paid, with paid limits (larger sizes, any port, public
  previews, persistence, more at the same time). They still use the free usage
  first, then credit;
- a paused sandbox without credit wakes on credit;
- a running sandbox without credit carries on on credit when the free
  usage ends, without pausing.

- A paid sandbox runs the same way. While it works, until you stop it, it idles
  into a pause, or credit or a spending limit runs out. `persistent` keeps one
  running with no idle pause. A stop keeps a sandbox's disk until you delete
  it.
- A paid account runs {{paid-sandboxes}} sandboxes at the same time from its first
  top-up. Paused ones are not counted. More are available on request
  ([pricing](./pricing#how-many-at-once)).
- Refer a company and you both get up to {{referral-max}}, then {{referral-share}} of what it
  spends for {{referral-share-months}} months ([referrals](./referrals)).

For what a sandbox may reach, see [security](./security).
