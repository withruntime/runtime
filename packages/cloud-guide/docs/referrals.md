# Referrals

Share your link. When someone signs up with it:

- **They get** every credit they add in their first {{referral-days}} days matched, up to
  {{referral-max}} in total, as everyone does with the [welcome match](./pricing#welcome-match).
- **You get** the same: as much as they are matched, payment by payment, up to
  {{referral-max}} for each person you bring.
- **Then, for {{referral-share-months}} months,** you earn {{referral-share}} of what they spend from credit they
  paid for, as credit.
- **Each person you bring earns its own share,** with no limit on how many.

| They add in their first {{referral-days}} days |          You get | They get, on top |
| ---------------------------------------------- | ---------------: | ---------------: |
| {{referral-min-purchase}}                      | {{referral-min}} | {{referral-min}} |
| $50, then $450                                 |             $500 |             $500 |
| $2,000                                         | {{referral-max}} | {{referral-max}} |

Someone who then spends $500 a month from credit they paid for earns you
{{= 500 * referral-share / 100}} a month for {{referral-share-months}} months.

The details:

- Your link is `https://withruntime.com/r/<code>`, and
  `https://withruntime.com/?ref=<code>` works too. Owners, admins and billing
  members find it on [Home](https://withruntime.com/account) and under
  **Refer & earn** on [Usage & billing](https://withruntime.com/account/billing),
  which **Refer & earn** in the account menu also opens. You can also ask for
  it with the API, an SDK, the CLI or MCP (below). The code belongs to your
  organization and never changes.
- Showing someone what you built? A preview link is a good way; the answer to
  creating one says so. Runtime adds nothing to the pages a preview serves: no
  badge, no banner.
- The link has to be followed before they sign up. It is remembered
  for 30 days in a cookie that holds only the code, and it carries through
  Google and email sign-in.
- Each payment they make in their first {{referral-days}} days is matched on both
  sides, until each side has {{referral-max}} from that person; the first one of
  {{referral-min-purchase}} or more gives each side at least {{referral-min}}. Payments after
  day {{referral-days}} are not matched. Free usage never counts. Each match is paid when Stripe confirms the card or Link account
  behind the payment, usually within seconds of it; the payment's own credit
  never waits. When that payment, or one of yours, went through a wallet that
  tells us neither, the match is paid once someone at Runtime has checked it.
- Your share is worked out from what they spend from credit they paid
  for: never from matched, referral, startup or any other granted credit, or
  the month's free usage. It is added as credit on the 1st of each month
  (UTC) for the month before, for {{referral-share-months}} months from their first matched
  payment. While they have a payment in dispute, no share is added for them;
  once the dispute is won the share catches up, and once it is lost the
  next month's share is not added (that use was paid with the disputed
  money) and the months after it are. While none of their matched payments
  stands (all refunded or disputed), no share is added for them.
- The page your link opens says "You're invited", with the offer and the way
  to sign up. It never names who invited them: your company's name is not on
  it.
- A referral and the [welcome match](./pricing#welcome-match) never both pay:
  someone who signed up with your link gets the referral's match, which is
  the same {{referral-max}} over the same {{referral-days}} days, and never smaller.
- You can earn up to **{{referral-cap}} of referral credit per calendar year** (UTC),
  matches and shares together. Past that, the person you referred still gets
  their credit; yours is recorded as over the cap.
- Referring yourself does not count: not your own organization, not another
  address of yours, not an address on the same company email domain (a shared
  provider such as gmail.com is not one company), not an organization that shares
  a member with yours, now or before, directly or through a third organization,
  and not someone who has paid with a card or Link account your
  organization has paid with, or the other way round. This is checked again at
  every payment and every month's share, so it holds whatever changes after
  sign-up. A code that does not count never stops anyone signing up.
- If a matched payment is partly refunded, its match is worked out again on
  what stands, and both sides give back the difference. If it is disputed, or
  less than {{referral-min-purchase}} of the first one stands, both sides' match of that payment
  is taken back; their other payments keep theirs. Either way, only
  what is still unspent is taken, so a refund is smaller by any referral credit
  already spent on either side. Credit you already spent stays counted against
  your {{referral-max}} from that person and your yearly cap, so a payment
  refunded and made again is not matched for you twice. While such a refund is being paid out, the
  credit it will take back is held on both sides and can't be spent.
- A lost dispute also takes back the share paid since that payment, at most
  {{referral-share}} of the disputed amount. A refund takes back no share: the share was paid
  on credit they had already spent.
- Referral credit is spent like any other credit. It can't be exchanged for
  cash or refunded.

## Read your link and what it earned

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const r = await runtime.referrals.get();
console.log(r.link, r.signedUp, r.paid, r.earnedMicros);
```

```python check
from withruntime import Runtime

r = Runtime().referrals.get()
print(r["link"], r["capRemainingMicros"])
```

```sh no-run
npx withruntime referrals
```

In Go it is `client.Referrals.Get(ctx)`, in Java `runtime.referrals().get()`
and in Ruby `runtime.referrals.get`. Over HTTP it is `GET /v1/referrals`, and
over MCP the `runtime_account` tool's `referrals` action. Each answers the same
fields:

| Field                             | Meaning                                                             |
| --------------------------------- | ------------------------------------------------------------------- |
| `code`, `link`                    | Your code and the link to share                                     |
| `signedUp`                        | People who signed up with your link                                 |
| `pending`                         | Of those, the ones that have not made a first payment yet           |
| `paid`, `capped`                  | Referrals with a payment matched, and how many the yearly cap cut   |
| `payingCompanies`                 | People you referred with a matched payment still standing           |
| `rewardMicros`, `maxRewardMicros` | The least on a first payment, and the most per person, each side    |
| `windowDays`                      | Days after sign-up in which payments are matched                    |
| `shareBasisPoints`, `shareMonths` | Your share of their paid spending (1000 is 10%), and for how long   |
| `reversed`                        | Referrals whose every matched payment was refunded or disputed      |
| `earnedMicros`                    | Referral credit you kept, all time: matches and share               |
| `shareEarnedMicros`               | Of that, the share                                                  |
| `earnedThisYearMicros`            | What counts against this year's cap                                 |
| `capRemainingMicros`              | What you can still earn this year                                   |
| `referredBy`                      | Whether your own organization joined through a link, and its credit |

Money is integer microdollars in strings: `"25000000"` is $25.
