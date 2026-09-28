# The free trial

Every new account gets **{{trial-hours}} hours of sandbox time** after a verified sign-in, with no card.

- Up to **eight sandboxes running at once**, each up to **2 vCPU and 4 GiB of
  memory**, with up to 10 GiB of disk (4 GiB by default). Paused sandboxes do
  not count toward the eight.
- Trial CPU is shared, never reserved, and its guaranteed floor
  (`cpuFloorMillis`) is at most 250 thousandths of a vCPU; the default is 50.
  A create that asks for more is refused with `invalid_trial`, naming each
  field, and a fork of such a sandbox can go only onto `"paid"`.
- Trial sandboxes reach the web at 20 Mbit/s each, and move 5 GiB a day in all,
  in and out together.
- A trial sandbox that keeps trying to reach internal or cloud metadata
  addresses has its network cut and the account suspended. One that holds its
  CPUs flat out for 30 minutes is slowed to half a core for the rest of its run.
- Previews of a trial sandbox are private: a link carries its token. Public
  previews need a paid sandbox.
- The {{trial-hours}} hours are shared by all your trial sandboxes, so {{trial-sandboxes}} at once use them
  {{trial-sandboxes}} times as fast. Running time counts, idle or busy; paused or stopped time
  does not.
- Each session can last up to one hour; the server enforces `timeoutSeconds` of
  at most 3600. Extend a running sandbox or wake a paused one to keep going,
  within the time you have left.
- Your first three images and first 10 GiB of volumes are stored free, for as
  long as you keep them ([pricing](./pricing#snapshots-images-and-volumes)).
  A build counts toward the {{trial-hours}} hours: at most 2 vCPU and 4 GiB, 20 minutes
  and 10 builds a day, with only the time it builds used up.
- A trial request never falls back to paid credit, even when the account has
  some.
- Model calls are not included. Opening ports beyond the web (`connect`) needs
  an account that has bought credit.

Over HTTP, a trial create is `POST /v1/sandboxes`. This body names the
defaults; only `funding` needs to be there:

```json
{
  "funding": "trial",
  "vcpu": 2,
  "memoryMiB": 4096,
  "diskMiB": 4096,
  "cpu": "shared",
  "cpuFloorMillis": 50,
  "timeoutSeconds": 1800
}
```

## Tell your agent

Paste the setup prompt from [Get started](./start#give-your-agent-one-instruction).
The agent runs everything on the trial, switches any sandbox code the project
has on another provider, and tells you what you would save each month.

## Use the trial from code

**You do not have to ask for the trial.** `create()` with no `funding` uses it
while you have trial time left, sized to fit. Name `funding: "trial"` to insist
on it. If you omit `funding` after the trial is exhausted, available prepaid
credit can be used instead.

```ts
import { Runtime } from "withruntime";

const runtime = new Runtime();
const sbx = await runtime.sandboxes.create({ funding: "trial", vcpu: 1, memoryMiB: 2048 });
try {
  console.log(sbx.info.funding, sbx.info.expiresAt);
} finally {
  await sbx.stop();
}
```

Use a region listed for your account. Leave `region` out for the default.

## Track your time

Time is reserved when a sandbox starts and settled from its confirmed running
time when it ends, so stopping early gives the unused part back.

Read what is left with `npx withruntime usage` (or `GET /v1/usage`). The `trial`
fields are `totalMs`, `usedMs`, `reservedMs` and `availableMs`, in
milliseconds, apart from dollars. In the browser, the foot of the sidebar shows
the whole hours left, and [Usage & billing](https://withruntime.com/account/billing)
shows the hours used, set aside for running sandboxes, and left.

## When eight are running, or the hours run out

- **`trial_busy`:** eight trial sandboxes are running, and the error names them.
  Stop or pause one first; a paused sandbox does not count. Requests sent at the
  same moment are admitted in no set order, so any one of them may be the one
  refused. Retry it once a sandbox has stopped; an SDK create waits for a slot
  by itself, for up to two minutes by default.
- **`trial_domain_limit`:** accounts that sign in with your company's email
  domain share eight running trial sandboxes between them, and they are all
  running. Stop or pause one, or use paid funding. Shared mail providers such as
  gmail.com, outlook.com and icloud.com have no such limit. An SDK create waits
  for a slot, as it does for `trial_busy`.
- **`trial_exhausted`:** the time is used up, and new trial sandboxes are
  refused.

Sign in with Google or with an email address you keep. Temporary inbox
services such as Guerrilla Mail and Mailinator cannot open an account.

Free time cannot be cashed out, refunded or replenished by signing in again.

## After the trial

**Add credit and keep going.** An owner, admin or billing member adds prepaid
credit at
[Usage & billing](https://withruntime.com/account/billing), any amount from
{{topup-min}}, with no subscription. Then choose paid funding.

- At the standard rates, 100 fully busy hours of a 2 vCPU, 4 GiB sandbox cost
  $8.00 in compute ([pricing](./pricing)).
- A paid account runs {{paid-sandboxes}} sandboxes at once, and more on request; a new one runs
  {{new-account-sandboxes}} until its first week or {{new-account-spend}} of paid use is behind it
  ([pricing](./pricing#how-many-at-once)).
- Refer a company and you both get credit matching its first top-up, from {{referral-min}} to {{referral-max}}
  each ([referrals](./referrals)).

For what a sandbox may reach, see [security](./security).
