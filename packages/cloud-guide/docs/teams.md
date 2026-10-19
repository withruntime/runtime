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
| Have a key make, list and revoke keys over the API                |  yes  |  yes  |     —     |    —    |
| Make a key account-wide, or limit it to its own again             |  yes  |  yes  |     —     |    —    |
| Make, fill and delete compartments                                |  yes  |  yes  |     —     |    —    |
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
- An owner or admin can put a key in a **compartment** when making it: it then
  sees only what its compartment's keys made, and no other key reaches in
  except an account-wide one ([compartments](./security#compartments)).
- A full-access key of an owner or admin can make more keys over the API
  ([run a swarm](#run-a-swarm)).
- The person who made a key sets or changes its daily spending limit. Owners and
  admins can limit or revoke any key.
- When someone leaves or is removed, the keys they made are revoked in the same
  step. What they created, such as sandboxes, volumes and images, stays with the
  account.

## Run a swarm

One paid account, a coordinator and many workers. The coordinator holds a
full-access key of an owner or admin (a wallet account's key is one). It makes a key per
worker, each with its own daily cap.

```bash no-run
runtime keys create --name worker-1 --daily-limit 5   # prints the key once
runtime keys ls                                       # each worker, with its spend
runtime keys usage <keyId>                            # one worker in full
runtime keys revoke <keyId>                           # when the worker is done
```

```ts no-run
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY
const worker = await runtime.keys.create({ name: "worker-1", dailyLimitMicros: 5_000_000 });
// hand worker.key to the worker, then later:
console.log(await runtime.keys.usage(worker.keyId));
await runtime.keys.revoke(worker.keyId);
```

```bash no-run
curl -sS https://api.withruntime.com/v1/keys -H "Authorization: Bearer ${RUNTIME_API_KEY}" \
  -H "Idempotency-Key: worker-1" -H "Content-Type: application/json" \
  -d '{"name":"worker-1","dailyLimitMicros":5000000}'
curl -sS "https://api.withruntime.com/v1/usage?key=${KEY_ID}" -H "Authorization: Bearer ${RUNTIME_API_KEY}"
curl -sS -X DELETE "https://api.withruntime.com/v1/keys/${KEY_ID}" -H "Authorization: Bearer ${RUNTIME_API_KEY}"
```

- `POST /v1/keys` takes `name`, and optionally `access` (`full` or `read`),
  `reach` (`agent`, the default, or `account`) and `dailyLimitMicros`, or
  `sandboxes` and `actions` for [a key limited to sandboxes](#a-key-limited-to-sandboxes). It
  answers the new key once; a retry with the same `Idempotency-Key` answers
  without it.
- Each key is its own agent. A worker with reach `agent` sees only its own
  sandboxes, and its spend and audit rows are its own.
- A key made by a key with reach `agent` uses what a sandbox needs (sandboxes,
  files, images, volumes, snapshots, previews and ports), the Apps and
  Functions its own agent made (create, list, deploy, roll back, delete), its
  own usage, and `/v1/keys`. Another worker's App answers 404, as an id that
  does not exist. It deploys an App or Function from an image only: a deploy
  that names a `build` comes from the account's repositories and is refused
  with `403 forbidden`, before any build is read. Deploy builds with a key
  made on the website. It asks an App for at most 2 `minCopies`, 2 `spares`
  and 20 `maxCopies`; make a larger App with a key made on the website. It
  cannot give an App or Function a name one of the account's own Apps holds:
  create or rename answers `409 name_taken`. The account's own settings are
  refused with `403 forbidden`,
  whatever its person's role: closing the account, webhooks, telemetry
  exports, the audit log, credit and billing, secrets, scheduled jobs and their
  secrets, domains, networks, builds and repositories. Call those with a key made on the website, or
  make this key account-wide.
- The coordinator sees each worker's spend with `runtime keys ls` or
  `GET /v1/usage?key=<keyId>`, for itself, the keys it made at any depth, and
  any key its reads already reach.
- Workers start from the coordinator's snapshots that carry the label
  `share: made-keys` (set it when taking the snapshot, or later with
  `POST /v1/snapshots/{id}:update`). Only snapshots the coordinator's key took
  itself count, not those of other keys it can reach. The label is set on
  each snapshot itself and never copied: a sandbox started from a shared
  snapshot, a fork's copies and kept snapshot, and a snapshot taken without
  labels of its own all leave `share: made-keys` out, so a copy you change and snapshot
  again is not shared unless you label it. A worker key made before this
  feature was released (see the [changelog](./changelog)) does not reach
  shared snapshots: make it again. Every key under the
  coordinator, at any depth, can create a sandbox from such a snapshot, memory or disk, and do nothing
  else with it: it does not list, read, change or delete it. A snapshot
  without the label stays `404 snapshot_not_found` to them. So does a
  labelled snapshot of a sandbox that named its egress secrets (`secrets` on
  create): a copy would keep that list, and those secrets are the
  coordinator's to reach, not the worker's. The coordinator still starts it.
  Sharing never crosses a [compartment](./security#compartments). Revoking the
  coordinator's key ends the sharing.

  ```ts no-run
  const snapshot = await sandbox.snapshot({ labels: { share: "made-keys" } });
  // in a worker, with its own key:
  const copy = await new Runtime({ apiKey: worker.key }).sandboxes.create({
    snapshot: snapshot.id,
  });
  ```

- Revoking stops a key within ten seconds. What its agent made keeps running
  until stopped.
- Only a full-access key made by an owner or admin can do this. A read-only
  key, a selected-actions key, a developer's key or a key in a compartment
  cannot make, list or revoke keys.
- A new key never has more than the key that made it: account-wide only from
  an account-wide key, and it keeps the maker's expiry and per-request cap. When the maker has a daily limit, every key it makes needs
  one, and the daily limits of every live key under it, at any depth, add up to
  at most the maker's: a worker's own workers share its limit, never add to
  it. Keys are made at most 8 deep. A read-only key cannot spend, so takes no
  limit.
- At most 100 live keys made this way per account, and 1,000 made in any 24
  hours (`quota_exceeded`). Revoke workers' keys when done.
- Each is in the [audit log](#audit-log) as `key.created`, by the making key's
  agent, with `madeBy` naming the key that made it.

### A key limited to sandboxes

A key can be limited to a few sandboxes and to what it may do to them. Give it
to something that needs one sandbox and should hold no key to the rest of the
account, such as a watcher that restarts a server when it stops answering.

```bash no-run
runtime keys create --name watcher --sandbox <sandboxId> --actions get,create --daily-limit 2
```

```ts no-run
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY
const sandboxId = process.env.SANDBOX_ID!; // the sandbox to watch
const watcher = await runtime.keys.create({
  name: "watcher",
  sandboxes: [sandboxId],
  actions: ["get", "create"],
  dailyLimitMicros: 2_000_000,
});
```

- `POST /v1/keys` takes `sandboxes` (1 to 20 ids) and `actions` in place of
  `access` and `reach`. The actions are `get` (read the sandbox and its
  metrics), `create` (start, wake and restart it; it never makes a sandbox),
  `stop` (stop and pause it), `exec` (commands, processes and the
  interpreter), `read_file` and `write_file`.
- It is served only those sandboxes' own routes, called by id, and only for
  the actions it was given. Everything else answers `403 forbidden`: other
  sandboxes, lists, deleting, resizing, forking, networks, sessions, secrets,
  jobs, keys, the account's settings and MCP.
- It sees its sandboxes whichever key made them. The making key names only
  sandboxes it acts on itself, outside every compartment.
- Only `create` spends, so only a key with it takes a daily limit, and it needs
  one when the making key has one.
- `runtime keys ls` and `GET /v1/keys` show it with reach `sandboxes`, its
  `sandboxes` and its `actions`. It makes no keys.

#### Asked for in the browser

With no key on the machine, or with `--browser`, the same command asks an
owner or admin to approve the key in the browser, as `runtime keys create`
does for any key. Use it when the sandboxes were made by a connector such as
ChatGPT or Claude and nobody holds a key to make one with, or to give an agent
somewhere else a few sandboxes and nothing more:

```bash no-run
runtime keys create --name helper --sandbox <id>,<id> --actions get,exec,read_file,write_file
```

- It prints a link and a code. The approval page names each sandbox, what the
  key can do to it, and whether it can spend; the key reaches the terminal
  that asked, sealed to it, and is never shown anywhere else.
- Only an owner or admin approves it, for any sandbox in the account outside
  every compartment, whichever key made it.
- Without `create` it cannot start, wake or restart its sandboxes, and takes
  no daily limit: the key places no hold of its own. A running sandbox it
  reaches is billed to its owner as usual, and commands the key runs count as
  activity, so they keep it from pausing when idle. To bound that, give the
  sandbox a time limit (`timeoutSeconds`) or stop it when done.

## Leaving and removing

On [Members](https://withruntime.com/account/members), use the link at the end of the person’s row
and confirm:

- **Leave** takes you out of an account. The last owner cannot leave until
  there is another owner.
- **Remove** takes someone else out. Admins remove developers, billing members
  and other admins; only an owner removes an owner.
- Either way, the person loses access at once and their keys stop working. They
  can be invited back, with a new role if you like.
- What they made stays in the account: their stopped and paused sandboxes'
  disks, snapshots, volumes and images are kept on the account's credit, as
  anyone's are, until someone deletes them. The same holds when your
  directory suspends someone.

## Emails

Each person chooses which of Runtime's optional emails they get, for each
account they are in, at Settings, Emails
([withruntime.com/account/emails](https://withruntime.com/account/emails)).
Turning one off stops it for you only: other owners still get theirs, and the
account's notices (`GET /v1/notices`, Usage & billing) and webhooks still have
every one. Each of these emails also ends with a link that stops that kind
for you, after asking.

| Setting         | What it is                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------- |
| `own-deletions` | A day before a sandbox is deleted at the date its own `:retention` chose, at most once a day |
| `billing`       | When the account's credit runs low or runs out                                               |
| `usage`         | When the account has used 80% and all of the month's free usage                              |
| `tips`          | A few getting-started emails in your first days                                              |

Always sent, with no switch: sign-in links and invitations, a revoked key,
replies in a support conversation, credit about to expire, service credits,
and a warning before Runtime deletes something nothing pays for.

From code, a key reads and sets its own person's, never anyone else's:
`GET /v1/account/emails`, and `POST /v1/account/emails:update` with
`{"category": "own-deletions", "enabled": false}`; in the CLI,
`runtime account emails` and `runtime account emails own-deletions off`; in
MCP, `runtime_account` action `emails` reads them. Reading them needs a key
that reads usage, and changing them a key for every action: a read-only or
limited key is answered 403 `forbidden` and changes nothing. A key with no
person (a wallet account's) has none, and is answered 409 `no_person`.

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
