# Roll Runtime out to your company

One Runtime account can hold your whole company: its people, their agents, one
prepaid balance and one audit log. This guide is the order to set it up in.
Each step links to the guide with the detail.

Single sign-on, directory sync, roles and the audit log are free on every
account. There is no seat fee and no plan to buy.

## 1. Choose the owner

The person who signs in first owns the account. Owners are the only ones who
connect single sign-on, make other owners and close the account.

- Make at least two owners, so the company never depends on one person. At
  [Members](https://withruntime.com/account/members), invite the second person,
  then pick **Owner** in their row.
- Owners always keep Google and email-link sign-in, even when single sign-on is
  required, so a broken identity provider cannot lock you out.

## 2. Fund the account

Everyone in the account spends the same prepaid balance.

- An owner, an admin or a billing member adds credit by card at
  [Usage & billing](https://withruntime.com/account/billing). There is no
  subscription; the page shows how long the credit lasts at this month's pace,
  and each purchase links to its Stripe receipt.
- Give whoever pays the bills the **billing** role. They add credit and see
  payments, and cannot start anything or make keys.
- The first top-up lifts the account from the [free trial](./trial) to the paid
  limits and, while it is not refunded, opens every outbound port,
  custom domains, TCP ports, public previews and private networks
  ([pricing](./pricing#how-many-at-once)).
- Moving from another provider? Your first top-up is matched
  ([switching credit](./pricing#switching-credit)).

## 3. Connect your identity provider

Skip this step if you only need a few people; invitations work without it.

At [Single sign-on](https://withruntime.com/account/single-sign-on), an owner:

1. Creates an app in Okta, Microsoft Entra ID, Google Workspace or any SAML 2.0
   or OpenID Connect provider, using the values the page shows.
2. Proves the company's email domain with one DNS TXT record.
3. Chooses the role people get when they first sign in. It is developer unless
   you change it.

Then, if you want:

- **Require single sign-on**, so members other than owners can come in only
  through your provider.
- **Turn on directory sync (SCIM)** in Okta or Entra ID. Your directory then
  adds people, sets their roles from its groups and removes them the moment
  they leave, revoking every key they made.

The provider-by-provider steps are in [single sign-on](./single-sign-on).

## 4. Bring people in

Pick a role for each person. The full table is in
[teams](./teams#roles).

| Role      | Give it to                                      |
| --------- | ----------------------------------------------- |
| Owner     | Two or three people who own the relationship    |
| Admin     | Team leads who manage people, keys and settings |
| Developer | Engineers who run agents and sandboxes          |
| Billing   | Finance, who add credit and read payments       |

- **With single sign-on,** people join on their first sign-in with the default
  role, or with the role their directory group gives.
- **Without it,** an owner or admin invites each person by email at
  [Members](https://withruntime.com/account/members). The link works once, only
  for that address.
- Someone who already uses Runtime keeps their own account and joins yours as
  well. They switch between the two from the account name at the top of the
  sidebar, or with `runtime account switch` in the CLI.

## 5. Give each agent its own key

Keys belong to the account, not to a person, and everyone in it can see every
key at [API keys](https://withruntime.com/account/keys).

- **One key per agent or application.** The audit log and the bill then say
  which one did what, and you can revoke one without stopping the rest.
- **A daily spending limit on every key that spends.** It is the most that key
  can commit in 24 hours. Only a person can set it, on the website; no key can
  raise its own ([read-only keys and daily limits](./security#read-only-keys-and-daily-limits)).
- **Read-only keys for dashboards, monitoring and CI checks.** They see the
  whole account and cannot start or change anything.
- **Account-wide keys for shared services.** A normal key sees only what it
  made. An owner or admin can make a key account-wide, so a service reaches
  every sandbox in the account ([keys in a team](./teams#keys-in-a-team)).
- **Secrets the sandboxes never see.** Store company API keys once as account
  secrets. Runtime adds them to outbound requests for the hosts you name
  ([secrets](./security#secrets-sandboxes-never-see)).
- **Identity tokens instead of stored cloud keys.** Sandboxes can reach AWS,
  Google Cloud and others with signed tokens ([identity tokens](./identity-tokens)).

A key can never do more than the person who made it. Change that person's role
and their keys change with it on the next request.

## 6. Watch it

- **Audit log.** Owners and admins read every change to members, keys, credit,
  security settings and single sign-on at
  [Audit log](https://withruntime.com/account/audit), or from code with
  `runtime audit`. Entries cannot be edited
  ([audit log](./teams#audit-log)).
- **Spending.** [Usage & billing](https://withruntime.com/account/billing)
  shows what each product cost each day.
- **Events in your own tools.** Send lifecycle events to your URL with
  [webhooks](./observability), or logs and metrics to your collector over
  OpenTelemetry.

## 7. When someone leaves

- **With directory sync,** deactivate them in your directory. They lose access
  at once and every key they made is revoked in the same step.
- **Without it,** an owner or admin chooses **Remove** in their row at
  [Members](https://withruntime.com/account/members). The effect is the same.
- What they created, such as sandboxes, volumes and images, stays with the
  account.

## Before you go to production

- Read [security](./security#before-production-traffic) for isolation, network
  rules and the checks to run first.
- Need more sandboxes or capacity than the paid limits? Write to support with
  the numbers ([feedback and support](./feedback-and-support)).
