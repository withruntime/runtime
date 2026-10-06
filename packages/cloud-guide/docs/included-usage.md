# Included usage

Every account gets usage included **every calendar month**, with no card,
after a verified sign-in. It is {{included-machine}}:

| Product                                   | Included each month   |
| ----------------------------------------- | --------------------- |
| Machine memory                            | {{free-memory}}       |
| Machine active CPU                        | {{free-cpu}}          |
| Saved copies (snapshots, images, backups) | {{free-saved-copies}} |
| Disks (volumes)                           | {{free-disks}}        |

- It renews on the 1st of each month, 00:00 UTC. What is left at the end of a
  month does not carry over.
- It is used first, before any credit, on every account, with credit or
  without, and is never charged. There is nothing to choose: a request's
  `funding` is accepted and ignored.
- An account given free hours before 5 October 2026 keeps what is left of
  them, and has the included usage as well.
- Model calls are not included.

## Without credit

The limits below hold while the account holds no credit. Once it does, its
sandboxes have paid limits and still use the included usage first
([after you add credit](#after-you-add-credit)).

- Up to **eight sandboxes running at once**, each up to **2 vCPU and 4 GiB of
  memory**, with up to 10 GiB of disk (4 GiB by default). Paused sandboxes do
  not count toward the eight.
- At most **{{no-credit-total}} at once** across every sandbox and image build
  that is running.
- CPU is shared, never reserved, and its guaranteed floor (`cpuFloorMillis`)
  is at most 250 thousandths of a vCPU; the default is 50. A create that asks
  for more is refused with `no_credit_size_limit`, naming each field, and so is
  a fork of such a sandbox.
- Sandboxes without credit download with no speed limit and upload at up to
  {{trial-upload}} each, and move {{trial-daily-transfer}} a day in all, in and
  out together. While a server's link is full, a paid sandbox gets
  {{paid-share}} a sandbox without credit's share of it.
- A sandbox without credit that keeps trying to reach internal or cloud
  metadata addresses has its network cut and the account suspended. One that
  holds its CPUs flat out for 30 minutes is slowed to half a core for the rest
  of its run.
- Previews of a sandbox without credit are private: a link carries its token.
  Public previews need a kept top-up: one paid and not refunded. Credit given
  alone does not open them ([pricing](./pricing#how-many-at-once)).
- A sandbox runs while it works and pauses itself when idle, until the
  included usage runs out; then it pauses, unless the account holds credit, in
  which case it carries on on credit. There is no time limit unless you set
  one with `timeoutSeconds` (60 to 86,400); one longer than the usage left is
  cut to it. Idle means nothing happening in it for `idlePauseSeconds`
  ({{idle-pause}} by default): no request, no command, terminal, SSH session or
  port forward open, no CPU use and no traffic; a browser tab left open on a
  preview does not count. Wake it to keep going.
- Your first three images and first 10 GiB of volumes are stored free, for as
  long as you keep them ([pricing](./pricing#snapshots-images-and-volumes)). A
  build uses the included usage: at most 2 vCPU and 4 GiB,
  {{trial-build-time}} and {{trial-builds-a-day}} builds a day, with only the
  time it builds used, and none when it fails through a fault of ours.
- A [scheduled job](./jobs)'s runs use it too, each a sandbox without credit
  within the same size and count. A run it cannot take waits with
  `blockedReason` `credits` until the account holds credit or the month
  renews.
- A sandbox without credit reaches the internet on ports 80 and 443 only.
  Other ports, such as a database's or git over SSH, need a paid sandbox of an
  account with a kept top-up.

Over HTTP, a create is `POST /v1/sandboxes`. This body names the defaults; an
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
The agent runs everything on the included usage, switches any sandbox code the
project has on another provider, and tells you what you would save each month.

## Use it from code

**You do not have to ask for it.** `create()` uses the included usage while the
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
  `reserved` (held for what runs now, given back unless used), `left`, `month`
  and `renewsAt`.
- `trial` is the machine time a new sandbox without credit can still run, in
  milliseconds: `availableMs`, with `offer` (`monthly`, or `hours` for an
  account given free hours before 5 October 2026) and `renewsAt`. The field
  keeps its older name, so code that reads it goes on working.

In the browser, [Usage & billing](https://withruntime.com/account/billing)
shows what each product used this month and what is left.

## When you reach a limit

| Code                         | What it means                                                                                     | What to do                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `no_credit_running_limit`    | Eight sandboxes without credit are running; `details.running` names them                          | Stop or pause one; an SDK create waits for a slot  |
| `no_credit_total_limit`      | Running sandboxes and builds would pass {{no-credit-total}}; the message says what runs now       | Stop or pause one, or wait for a build to end      |
| `no_credit_domain_limit`     | Accounts on your company's email domain share eight running sandboxes without credit, all running | Stop or pause one, or add credit                   |
| `no_credit_size_limit`       | The size asked for is larger than 2 vCPU, 4 GiB and 10 GiB of disk                                | Omit the size fields for the default               |
| `no_credit_build_limit`      | {{trial-builds-a-day}} builds started in the last 24 hours                                        | Reuse an image, or retry later                     |
| `no_credit_capacity_full`    | The room servers keep for accounts without credit is full right now                               | Retry shortly; an SDK create waits                 |
| `included_usage_used_up`     | This month's included usage is used and the account holds no credit                               | Add credit, or wait for the 1st (UTC)              |
| `included_usage_unavailable` | The account has no included usage yet: its owner has not signed in with a verified email          | Sign in with Google or an email address you verify |

These codes were named `trial_busy`, `trial_capacity`, `invalid_trial`,
`trial_domain_limit`, `trial_build_limit`, `trial_exhausted` and
`trial_unavailable` before 5 October 2026 ([changelog](./changelog)).

Requests sent at the same moment are admitted in no set order, so any one of
them may be the one refused. Shared mail providers such as gmail.com,
outlook.com and icloud.com have no domain limit. Temporary inbox services such
as Guerrilla Mail and Mailinator cannot open an account.

Included usage cannot be cashed out, refunded, carried over or gained by
signing in again.

## After you add credit

**Add credit and keep going.** An owner, admin or billing member adds prepaid
credit at [Usage & billing](https://withruntime.com/account/billing), any
amount from {{topup-min}}, with no subscription. There is nothing to switch:
from then on

- new sandboxes are paid, with paid limits (larger sizes, any port, public
  previews, persistence, more at once), and still use the included usage
  first, then credit;
- a paused sandbox without credit wakes on credit;
- a running sandbox without credit carries on on credit when the included
  usage ends, without pausing.

- A paid sandbox runs the same way: while it works, until you stop it, it idles
  into a pause, or credit or a spending limit runs out. `persistent` keeps one
  running with no idle pause. A stop keeps a sandbox's disk until you delete
  it.
- A paid account runs {{paid-sandboxes}} sandboxes at once from its first
  top-up, paused ones not counted, and more on request
  ([pricing](./pricing#how-many-at-once)).
- Refer a company and you both get credit matching its first top-up, from
  {{referral-min}} to {{referral-max}} each ([referrals](./referrals)).

For what a sandbox may reach, see [security](./security).
