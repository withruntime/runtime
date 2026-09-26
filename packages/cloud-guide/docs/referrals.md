# Referrals

Share your link. When a company signs up with it and adds $10 or more of credit
for the first time, **you both get credit equal to what they added: at least
$25 and at most $500 each**. Theirs is added on top of what they bought.

| Their first top-up | You get | They get, on top |
| ------------------ | ------: | ---------------: |
| $10                |     $25 |              $25 |
| $137.42            | $137.42 |          $137.42 |
| $2,000             |    $500 |             $500 |

The details:

- Your link is `https://withruntime.com/r/<code>`, and
  `https://withruntime.com/?ref=<code>` works too. Owners find it under
  **Refer & earn** on [Usage & billing](https://withruntime.com/account/billing),
  which **Refer & earn** in the account menu and **Settings → Referrals** both
  open. You can also ask for it with the API, an SDK, the CLI or MCP (below). The code belongs to your organization and
  never changes.
- Showing someone what you built? A preview link is a good way; the answer to
  creating one says so. Runtime adds nothing to the pages a preview serves: no
  badge, no banner.
- The link has to be followed before the company is created. It is remembered
  for 30 days in a cookie that holds only the code, and it carries through
  Google and email sign-in.
- The reward is paid once per referred company, on its first top-up of $10 or
  more, and matches that top-up. Later top-ups pay nothing more. Free trial
  time never counts.
- A referral and the [switching credit](./pricing#switching-credit) never
  both pay: when a company that signed up with your link also records a switch,
  the referral's match applies, and it is never smaller.
- You can earn up to **$10,000 of referral credit per calendar year** (UTC).
  Past that, the company you referred still gets its credit; yours is recorded
  as over the cap.
- Referring yourself does not count: not your own organization, not another
  address of yours, not an address on the same company email domain (a shared
  provider such as gmail.com is not one company), and not a first top-up paid
  with a card your organization has paid with. A code that does not count never
  stops anyone signing up.
- If the qualifying top-up is partly refunded, the reward is matched again to
  what stands, and both sides give back the difference. If less than $10
  stands, or it is disputed, both rewards are taken back. Either way, only what
  is still unspent is taken.
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

Over HTTP it is `GET /v1/referrals`, and over MCP the `runtime_referrals_get`
tool. Both answer the same fields:

| Field                             | Meaning                                                             |
| --------------------------------- | ------------------------------------------------------------------- |
| `code`, `link`                    | Your code and the link to share                                     |
| `signedUp`                        | Companies that signed up with your link                             |
| `pending`                         | Of those, the ones that have not made a first top-up yet            |
| `paid`, `capped`                  | Rewards paid, and how many of those the yearly cap cut short        |
| `rewardMicros`, `maxRewardMicros` | The least and the most each side gets per referral                  |
| `reversed`                        | Rewards taken back because the qualifying top-up was refunded       |
| `earnedMicros`                    | Referral credit you kept, all time                                  |
| `earnedThisYearMicros`            | What counts against this year's cap                                 |
| `capRemainingMicros`              | What you can still earn this year                                   |
| `referredBy`                      | Whether your own organization joined through a link, and its credit |

Money is integer microdollars in strings: `"25000000"` is $25.
