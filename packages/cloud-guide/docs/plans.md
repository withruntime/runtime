# Plans

Plans are in a private beta. Only the organizations in it can see or choose
one. Everyone else keeps paying for what runs from prepaid credit, as before.
Nothing changes for an account until it chooses a plan.

A plan is a monthly fee that comes back as usage:

- **The fee buys usage.** Each month, the fee is given back as plan usage, at
  the same measured prices as any credit. You still pay only for what runs.
  The plan does not add a charge of its own.
- **Used first, then expires.** Plan usage is spent before any credit: first
  plan usage, then free and given credit, then credit you bought. Any plan usage
  left at the end of the month expires. Your credit stays.
- **Twice in the first month.** A plan's first month, and the first month
  after you move up to it, holds twice its usage.
- **Yearly.** A plan with a yearly price costs ten months' fee for twelve.
- **A trial.** A plan with a trial can be tried free for its days, once per
  person, without a card, from the console.
- **Higher limits, more features, more support.** A plan raises limits, such
  as how many sandboxes run at the same time. It turns on features such as single sign-on,
  roles and the audit log. It sets your support: docs, the support agent, a
  shared Slack channel, or a dedicated one. It never lowers a limit you have.
- **Limits are ceilings, not room held for you.** A plan lets you run up to
  its limits. At a busy moment, a sandbox can still wait for room, as on any
  account.
- **First in line when room is short.** When a region is short of room,
  what waits for it is admitted by its account's lane. The order is Enterprise first, then
  Scale, Pro Max, Pro and Free. Runtime's own work, such as the checks of
  our own repository, comes after every customer's. A contract is Enterprise. An
  account with no plan is in the Pro lane, or the Free lane while it is on a
  trial. See [waiting in line for room](./limits#waiting-in-line-for-room).
- **Add-ons.** Some plans offer add-ons, such as 50 more concurrent sandboxes.
  They are charged monthly beside the plan.
- **Changing.** Moving up takes effect immediately. The difference for the rest of the
  month is charged, prorated. Moving down, or cancelling, takes effect at the
  end of the period you paid for. You keep the plan until then. You can
  take a cancel back before then.
- **The card.** A paid plan keeps a card on file. While the plan is active,
  you can replace the card but not remove it. Bought credit pays the fee only
  when there is no card. Given credit never pays a fee.
- **Moving up by itself.** An owner can let the account move to the plan that
  lifts a limit when the limit refuses something. This is off unless an owner turns
  it on.

When a limit refuses something, the refusal names the plan that lifts it and
the command that moves to it, in `details.plan`. A feature the plan does not
include, such as single sign-on, roles other than owner, the audit log or a
new conversation with the support agent, is refused with `plan_required`.
It names the plan that includes it the same way.

Only an owner, admin or billing member, or a key one of them made, can choose,
change or cancel a plan or its add-ons. Only an owner turns moving up by
itself on or off. Any key of the organization can read them. A person, signed in,
starts a first plan and a trial.

## Read the plans and yours

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const { current, plans } = await runtime.plans.list();
console.log(
  current?.name ?? "no plan",
  plans.map((plan) => plan.id),
);
```

```python check
from withruntime import Runtime

r = Runtime().plans.list()
print(r["current"], [plan["id"] for plan in r["plans"]])
```

```sh no-run
npx withruntime plans
```

In Go it is `client.Plans.List(ctx)`, in Java `runtime.plans().list()` and in
Ruby `runtime.plans.list`. Over HTTP it is `GET /v1/plans`. Over MCP, it is the
`runtime_plans` tool's `get` action. A plan has these fields:

| Field               | Meaning                                                                        |
| ------------------- | ------------------------------------------------------------------------------ |
| `id`, `name`        | What `choose` takes, and its name                                              |
| `card`              | Plans sharing a card are one choice with a switch, such as two sizes           |
| `feeMicros`         | The monthly fee, before tax; `"0"` for Free                                    |
| `yearlyFeeMicros`   | The yearly fee, or null when the plan has none                                 |
| `bonusMicros`       | Usage given on top of the fee each month                                       |
| `trialDays`         | How long its trial lasts; 0 for none                                           |
| `firstPeriodDouble` | Whether the first month holds twice the usage                                  |
| `support`           | `docs`, `agent`, `slack` or `dedicated`                                        |
| `collection`        | `card`, charged monthly or yearly; or `invoice`                                |
| `contract`          | A contract made for your organization alone                                    |
| `included`          | Usage included each month: `product`, `meter`, `quantity` and `unit`           |
| `limits`            | What the plan raises: `limit` (such as `sandbox.count`) and `max` (null: none) |
| `features`          | What the plan turns on, such as `single-sign-on`, `roles` and `audit-log`      |
| `addOns`            | `id`, `name`, `feeMicros`, the `limits` each `add`s to, and a `feature`        |

`current` is the plan you are on, or null: `planId`, `name`, `status`
(`incomplete`, `trialing`, `active`, `past_due` or `canceled`), `interval`
(`month` or `year`), `periodStart`, `periodEnd`, `trialEndsAt`,
`cancelAtPeriodEnd`, `nextPlanId` (a move down waiting for `periodEnd`),
`startedAt`, `addOns` (`id`, `quantity`, and `endsAt` once removed),
`autoUpgrade`, and `planUsage`: this month's `grantedMicros`, the
`leftMicros` spent first, and when it `expiresAt`.

## Choose, change or cancel

```sh no-run
npx withruntime plans choose <plan>
npx withruntime plans choose <plan> --yearly
npx withruntime plans cancel
npx withruntime plans resume
npx withruntime plans add-on <add-on>
npx withruntime plans remove-add-on <add-on>
npx withruntime plans auto-upgrade on
```

The SDKs call them `choose(plan)`, `cancel()`, `resume()`, `addOn(id)`,
`removeAddOn(id)` and `autoUpgrade(on)`. Over HTTP, they are
`POST /v1/plans/choose` with `{"plan": "<id>"}` and an optional
`"interval": "year"`, `POST /v1/plans/cancel`, `POST /v1/plans/resume`,
`POST /v1/plans/add-ons` with `{"addOn": "<id>"}`,
`DELETE /v1/plans/add-ons/<id>` and `PUT /v1/plans/auto-upgrade` with
`{"on": true}`. Each returns `checkoutUrl` and `current`. With no plan yet,
`checkoutUrl` is the page where a person signs in, chooses the plan and pays
the first month. The plan starts once that payment goes through. A
plan's interval changes at its renewal: cancel, then choose it yearly. MCP
only reads plans. Choosing one moves money, which a person or the CLI does.

Money is integer microdollars in strings: `"25000000"` is 25 dollars.
