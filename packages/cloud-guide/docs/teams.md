# Teams and the audit log

One Runtime account can have as many people as you need. They share its
credit, its sandboxes and other resources, and its keys. Each person has a
role, and every change to members, keys, money and security settings goes into
an audit log with who made it, when, and from which address.

Every account starts with one person, its owner. Nothing changes until you
invite someone.

## Roles

| What they can do                                                  | Owner | Admin | Developer | Billing |
| ----------------------------------------------------------------- | :---: | :---: | :-------: | :-----: |
| See resources, usage, balance, keys and members                   |  yes  |  yes  |    yes    |   yes   |
| Start, run and delete sandboxes and other resources, using credit |  yes  |  yes  |    yes    |    —    |
| Create API keys and approve CLI connections                       |  yes  |  yes  |    yes    |    —    |
| Revoke or limit a key somebody else made                          |  yes  |  yes  |     —     |    —    |
| Make a key account-wide, or limit it to its own again             |  yes  |  yes  |     —     |    —    |
| Add credit and see payments                                       |  yes  |  yes  |     —     |   yes   |
| Invite, remove and change the role of members                     |  yes  |  yes  |     —     |    —    |
| Read the audit log                                                |  yes  |  yes  |     —     |    —    |
| Make someone an owner, or change or remove an owner               |  yes  |   —   |     —     |    —    |

- An account always has at least one owner. To hand an account over, make the
  new person an owner, then leave or change your own role.
- Anyone can leave an account, and anyone can revoke a key they made.
- A key can never do more than the person who made it. Runtime checks that
  person's role on every request, so changing someone from developer to billing
  makes their keys read-only at once.

## Invite people

Owners and admins invite people at
[Members](https://withruntime.com/account/members): choose **Invite**, enter an email address,
choose a role and choose **Send invitation**. To change someone's role later,
pick the new one in their row.

- The person gets an email with a link. The page also shows the link, so you can
  send it yourself.
- The link works once, for seven days, and only for someone who signs in with
  that email address. A forwarded link is no use to anyone else.
- Someone new to Runtime signs up through the link and lands in your account.
  Someone who already has an account keeps it and joins yours as well.
- Sending an invitation again to the same address replaces the first one.
  **Withdraw** cancels an invitation that has not been used.
- An invitation lasts only while its sender could send it again. When they
  leave, are removed or lose the role that can invite, their open invitations
  are withdrawn.
- An account can have 50 open invitations and send 25 in any 24 hours.

## Several accounts

A person can belong to several accounts, such as their own and their company's.

- **Website:** choose the account from its name at the top of the sidebar. On a
  phone, the name sits at the left of the top bar. Runtime remembers the choice
  in this browser.
- **Connecting an agent:** when you approve a connection or a key request, the
  approval page asks which account it is for.
- **CLI:** every account you connect is saved on the machine.

```bash no-run
npx withruntime account add            # connect another account; choose it in the browser
npx withruntime account                # list them; * marks the one in use
npx withruntime account switch Acme    # use Acme for every command after this
```

- **SDKs and the API:** a key belongs to one account, so use that account's key.
  `GET /v1/me` names the account and the role of the person who made the key.

## Keys in a team

Keys belong to the account, not to the person. Everyone who can see the
account sees every key, with who made it, at
[API keys](https://withruntime.com/account/keys).

- Each key is its own agent, so the audit log and the bill say which key did
  what.
- A key sees and uses the sandboxes and other resources its own agent made. A
  sandbox made with another key answers 404 to it, while a sandbox's name is
  still unique across the whole account.
- An owner or admin can make a key **account-wide**: it sees and uses every
  sandbox, snapshot, image, volume, service and job in the account, whichever
  key made it, and `getOrCreate` with a name another key holds returns that
  sandbox. Choose "Everything in the account" when you make the key, use
  **Make account-wide** on a key's row, or run
  `runtime keys create --account-wide`, which only an owner or admin can
  approve. This is how services that share sandboxes work, as a Blaxel
  workspace key does.
- An account-wide key still acts as its own agent. The audit log names it, and
  a wake, extension or restart it asks for is billed to it and counts against
  its own daily limit, even on a sandbox another key made. Job secrets stay
  with the person who made the key; the secrets sandboxes use are the
  account's, for every key.
- An account-wide key reaches the account only while the person who made it is
  an owner or admin. Changed to developer, it sees only what it made again, on
  the next request. Developers and billing members cannot make or switch one.
  A read-only key already sees the whole account and is never account-wide.
- The person who made a key sets or changes its daily spending limit. Owners and
  admins can limit or revoke any key.
- When someone leaves or is removed, the keys they made are revoked in the same
  step. What they created, such as sandboxes, volumes and images, stays with the
  account.

## Leaving and removing

On [Members](https://withruntime.com/account/members), use the link at the end of the person’s row
and confirm:

- **Leave** takes you out of an account. The last owner cannot leave until
  there is another owner.
- **Remove** takes someone else out. Admins remove developers, billing members
  and other admins; only an owner removes an owner.
- Either way, the person loses access at once and their keys stop working. They
  can be invited back, with a new role if you like.

## Closing the account

An owner closes the account for good at
[Close account](https://withruntime.com/account/close), linked at the foot of
Members, or from the terminal with `withruntime` 0.7.0 or later:

```bash no-run
runtime account close --confirm "Acme Inc"
```

Type the account's name exactly; `runtime whoami` shows it. From the CLI or the
API (`POST /v1/account:close` with `{"confirm": "<name>"}`, or
`runtime.account.close({ confirm })` in either SDK, from `withruntime` 0.7.0) it needs a key for every product made by an owner. No MCP tool
closes an account.

Closing cannot be undone. At once:

- every sandbox stops, and every snapshot, image, volume, volume backup,
  secret, egress secret and saved registry password is deleted;
- custom domains, dedicated addresses and the private network are released,
  and webhooks, telemetry exports and the upstream proxy removed;
- every key and CLI connection stops working, open invitations are withdrawn,
  and every member loses access.

What is unspent of a purchase made in the last 15 days is refunded on request:
write to support@withruntime.com. Other credit, including granted and referral
credit, is forfeited. Signing in again later starts a new, empty account.

## Audit log

Owners and admins read the audit log at
[Audit log](https://withruntime.com/account/audit). It records:

- **Members:** joined, added, removed, left, and role changes; invitations sent
  and withdrawn
- **Keys:** created and revoked, with the reason when Runtime revoked one; CLI connections and key requests approved or
  denied; spending limits set and removed
- **Credit:** top-ups started, credit bought, granted, earned by referral,
  refunded, disputed, taken back or expired
- **Security settings:** network rules, secrets created, updated, rotated,
  revealed and deleted (never the value), preview ports made public or private
- **Creations:** every sandbox, volume, image, snapshot, service and job, with
  its name, labels and funding (rules a sandbox is created with are part of
  its creation; a later change is a network rules entry)
- **Deletions:** volumes, images, snapshots, services and jobs
- **The account:** created, renamed, suspended and restored
- **Single sign-on:** connections added, changed and removed, domains
  verified, single sign-on required or not
- **Directory sync:** SCIM tokens made and revoked, people your directory
  added, deactivated, reactivated or deleted, and the role each group gives

Each entry has the action, who did it (a person, a key, your directory, or
Runtime itself for things like a card payment), the time, the client's IP address, the request id
and whether it came through the website, the API or MCP. A call made by code
inside one of your sandboxes also names that sandbox. A sandbox's pauses,
wakes and stops are not in the audit log; each sandbox has its own history.

Entries are kept for at least 400 days. Nobody can edit an entry, and none is
deleted before then. The page downloads the whole log, or one group of it, as
a CSV file.

### Read it from code

A key made by an owner or admin reads the log, if it has full access or is
read-only. Newest first, 50 at a time by default, up to 200.

```bash no-run
curl -H "Authorization: Bearer $RUNTIME_API_KEY" \
  "https://api.withruntime.com/v1/audit?action=member.&limit=100"
npx withruntime audit --action key.
```

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const { events, next } = await runtime.audit.list({ action: "credit." });
console.log(events.length, next);
```

```python check
from withruntime import Runtime

with Runtime() as runtime:
    page = runtime.audit.list(action="credit.")
    print(len(page["events"]), page["next"])
```

- `action` is one action, like `key.created`, or a group ending in a dot:
  `member.`, `invitation.`, `key.`, `connection.`, `limit.`, `credit.`,
  `network.`, `secret.`, `preview.`, `resource.`, `account.`, `sso.`, `scim.`.
- `next` is the page's last entry. Pass it as `before` for older entries.
- MCP: the `runtime_audit_list` tool, with the same filters.
- A key made by a developer or billing member, or a key limited to selected
  actions, gets `403 forbidden`.

## Sign-in and single sign-on

People sign in with an email link, with Google, or with your company's
identity provider. Single sign-on works over SAML or OIDC with Okta, Microsoft
Entra ID, Google Workspace and any other standard provider, and SCIM directory
sync adds, updates and removes people for you. Both are free on every account.
See [single sign-on](./single-sign-on) for the setup.

- An owner connects your identity provider for your email domain and proves the
  domain with a DNS record. Only an owner changes single sign-on.
- Anyone on that domain who signs in through your provider joins your account
  with the role you choose. Someone you removed does not come back that way.
- **Require single sign-on** makes your provider the only way in for members.
  Owners can still use Google or an email link, so a broken provider cannot
  lock you out, and API keys keep working.
- With SCIM, deactivating someone in your directory removes them from the
  account and revokes every key they made, at once. Groups in your directory
  decide roles: admin, developer or billing, never owner.
