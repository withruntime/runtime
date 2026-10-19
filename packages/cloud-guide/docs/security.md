# Isolation and account boundaries

Runtime uses Firecracker microVMs on Runtime-operated dedicated servers.

- Each sandbox has its own Linux kernel, disk and guest environment.
- CPU, memory, disk, network rules, time limits and billing are enforced on the host,
  outside the guest.
- Host credentials, control sockets and provider credentials never reach
  customers.
- Tests on our own servers exercise guest separation, selected private-address
  refusals, restart recovery and time limits ending on the host.
- A fork, or a create from a memory snapshot, copies each running program's
  random-number state. Make keys and tokens after the copy; see
  [randomness in copies](./storage#randomness-in-copies).

## Keys and secrets

**Keep keys in server-side secret storage, one per agent or application.**

- A key covers every Cloud product, including products enabled later, and lasts
  until revoked. It can never do more than the role of the member who made it
  allows, read on every request (see [teams](./teams)).
- Never put a key in a public prompt, URL, browser bundle, repository,
  command-line argument or diagnostic log.
- A framework adapter does not expand what the key is allowed to do.
- If a key turns up in public, Runtime may revoke that one key. The account's
  owners are emailed why, the audit log shows Runtime revoked it with the
  reason, and every other key keeps working.

Give a command its secrets through `env`, never in the command line. Runtime
never echoes `env` values back, and its journals and request records keep only a
hash of them. A command line is not protected that way: anything running in the
sandbox can read it.

**What Runtime keeps about a command is its program's name, never its
arguments.** For each command run through the API, the SDKs, the CLI or MCP,
Runtime records the program (`python3`, from `python3 train.py --token …`),
its exit code, how long it ran, when it started, which key or person ran it and
in which sandbox. Arguments, the rest of the command line and environment
values are never stored, because arguments can carry a secret typed inline.
A terminal is recorded as its shell and nothing typed in it; a code
interpreter cell as its language (`python-cell`), never its code.
The record is kept 14 days and shown on the sandbox's page in your account.

## Read-only keys and daily limits

**Both are optional.** Without them a key reaches every product, bounded by
your prepaid balance.

- **Read-only key.** Choose **Read only** when you create a key at
  [API keys](https://withruntime.com/account/keys), or pass `--read-only` to
  `runtime keys create`. It sees the whole account: every sandbox and its state,
  spec and cost, the images, volumes, snapshots, previews and network rules
  beside them, account notices, the balance, and its own access and limit. That
  covers products added later too. It cannot create, start, stop, pause, wake,
  run a command, write a file, change anything or spend anything. It does not
  see inside sandboxes (files, command output), job runs or secrets, and a
  private preview reaches it without its token. Use it for monitoring,
  dashboards and CI checks.
- **Daily spending limit.** Set one on any key that can spend, when you create
  it or later from its row. It is the most that key's agent may commit in any
  24 hours, counting what is already charged and what running sandboxes are
  about to use. It counts everything the
  agent's sandboxes cost, including renewals and parked storage. An
  account-wide key's limit also counts what it asks for on another key's
  sandbox: a wake, an extension or a restart, and then the renewals that carry
  that sandbox to the end of its `timeoutSeconds`. When a create,
  wake, extension or renewal would pass it, that request fails with
  `spending_limit_reached` (HTTP 402) and nothing is charged. A running sandbox
  keeps the time it is already funded for; one whose next renewal would pass
  the limit stops or pauses at the end of that time. Room comes back as older spending leaves the
  24-hour window.

An owner, admin or developer of the account can create a key, of either kind:

- They create one at [API keys](https://withruntime.com/account/keys), or
  approve one in the browser that `runtime keys create` asked for from a
  terminal (see below).
- The member who made a key, or an owner or admin, sets, changes or removes its
  limit, and only on the website.
- A key acts on what its own agent made. Only an owner or admin can make a key
  **account-wide**, so it sees and uses everything in the account, and only
  for a key of an owner or admin; it lapses if that person becomes a developer
  ([keys in a team](./teams#keys-in-a-team)).
- A key can read its own access and limit with `GET /v1/limits`,
  `runtime limits` or the `runtime_account` tool's `limits` action.
- No key can raise, remove or set a limit. A full-access key of an owner or admin
  can make keys that have no more than it has ([run a swarm](./teams#run-a-swarm)).
- Every key made, revoked or limited, and every connection approved, is in the
  account's [audit log](./teams#audit-log), with who did it and from where.

A sandbox can also carry `maxTotalCostMicros`, the most it may cost over its
whole life: it stops there, with `stopReason` `lifetime_cap`.

Set a limit above what the agent's paused sandboxes cost in a day. If storage
for a paused sandbox cannot be paid for, it is treated like storage on an empty
balance: you are notified, by an account notice and an email to the account's
owners a day before, and after seven days unpaid it is deleted.

## Compartments

**A compartment walls a group of keys off from the rest of the account.** Use
one per customer of your platform, or for an agent whose sandboxes no other key
may reach.

- An owner or admin makes one at [API keys](https://withruntime.com/account/keys):
  choose **One compartment** under **Sees** when you make a key, and pick a
  compartment or name a new one. More keys can join it the same way.
- A key in a compartment lists, creates, runs commands in, forks, snapshots,
  pauses, wakes and deletes the sandboxes, snapshots, images, volumes,
  previews, ports, jobs and job secrets that its compartment's keys made, and
  nothing else.
- Anything outside its compartment answers 404 `not_found`, exactly as an id
  that does not exist. No key outside it reaches in either, read-only keys
  included, except an account-wide key, which sees everything in the account.
- Each compartment has its own sandbox names: `getOrCreate("main")` in one
  compartment never answers another's `main`, and a name another compartment
  holds is never `name_taken`. An image name belongs to the compartment (or
  the rest of the account) that first built it, so nobody else can add a
  version to it or move its tags: another compartment's build with that name
  answers 409 `name_taken`.
- A fork, or a create from a snapshot, stays in the compartment of the key
  that made it. A resource never moves between compartments: a key's
  compartment is set when the key is made and never changes.
- A key in a compartment cannot reach the account's own settings: billing,
  keys, domains, dedicated addresses, the account's networks, egress secrets,
  registry logins, webhooks, telemetry export, the audit log, apps and
  functions. Those answer 403 `outside_compartment`. It can read who it is with
  `GET /v1/me`, whose `compartment` names its compartment.
- A compartment's sandboxes are left out of the account's private network and
  its WireGuard peers. The account's egress rules, egress secrets, your own
  proxy and signed requests still apply to them.
- No key can make a compartment. A compartment is deleted only
  once it holds nothing: deleting one that does answers 409
  `compartment_not_empty`. Its keys stop working when it is deleted.
- Each compartment, and every key put in one, is in the
  [audit log](./teams#audit-log).

## Network access

**Every outbound connection goes through a proxy on the host.** Programs that
use `HTTP_PROXY` and programs that open raw sockets are held to the same rules;
nothing in the guest, root included, can go around it.

- A paid sandbox of an account with a kept top-up reaches any public host on any port. A sandbox without credit reaches ports 443 and 80.
- A few ports are never reachable (telnet, Windows RPC, NetBIOS and SMB, IRC),
  and mail ports open only when support enables mail for your account.
- Private and internal addresses are refused. Code that retries one, such as a
  cloud SDK looking for credentials at the metadata address, is only refused.
- The proxy watches every sandbox, with credit or without, for traffic that only abuse
  makes: trying one internal address after another, a port scan or a sweep of
  addresses that do not answer, a cryptocurrency mining pool, and mail sent
  straight to many mail servers. The thresholds sit far above what test
  suites, builds, package installs, crawlers within the limits, CI and load
  tests against your own servers do. A sandbox that crosses one loses its
  network and is paused, or stopped if it cannot pause; your inbox
  (`GET /v1/notices`) says what was seen and what was done. An account that
  has paid is never suspended for it; an account without credit that probes internal
  addresses is. Traffic that looks like a flood, repeated attempts on the
  closed mail ports, or full CPU beside a mining pool's website is only
  recorded for a person to look at.
- Services that exist only to catch a security test's call-back, such as
  `oast.live`, `interact.sh` and Burp Collaborator, are refused to every
  sandbox and image build. To test Runtime itself, see
  [report a vulnerability](#report-a-vulnerability).
- Each sandbox's rules can narrow this further, and they bind root inside the
  sandbox too. See [the sandbox environment](./sandbox-environment).
- Code in a sandbox reaches Runtime's own API only at `http://runtime.internal`,
  with an API key, like any other caller. The host sends each request on to
  the public API over HTTPS and reaches nothing else of its own. See
  [Runtime's API from inside a sandbox](./sandbox-environment#runtime-s-api-from-inside-a-sandbox).
- Each sandbox has limits on concurrent connections, upload speed and bytes
  per day, and shares its server's link fairly with the others, so one sandbox
  cannot crowd out others. A paid sandbox uploads at up to {{paid-upload}}, {{paid-upload-sustained}}
  sustained after its first {{paid-upload-burst}}, and moves {{paid-daily-transfer}} a day; a sandbox without credit
  uploads at up to {{trial-upload}}, with {{trial-daily-transfer}} a day for the whole account.
  Uploads are limited because they are what spam and floods use; downloads
  are not ([the sandbox environment](./sandbox-environment#the-network)).

Inbound connections require a preview, a proved custom domain, an allocated
TCP port or an authorized private tunnel. Each reaches only the sandbox port
and account it was granted. A preview is private with an expiring token unless
you make it public, which a paid sandbox of an account with a kept top-up
can do; a sandbox without credit's previews are always private. While an account is
blocked, or every purchase it made is refunded in full, its public previews
need the token like private ones, and they are public again once it pays.
Preview addresses are under `runtimehost.com`, never under
`withruntime.com`, so sandbox content never shares an origin with your account.
A preview signed in by its cookie takes a WebSocket or a request that changes
something (any method but GET, HEAD and OPTIONS) only from its own address or a
site you allow to embed it; from any other page, another preview included, it
answers `origin_not_allowed` (403). Code that sends the preview token in its
header or query is not affected.
Rotating a preview token refuses every token issued before it, and closes
connections opened with one, before the call returns. Making a preview private
or deleting it, removing a custom domain and closing a TCP port take effect the
same way, and so does Runtime taking a site down or suspending an account.
A suspension also pauses the account's running sandboxes, keeping their memory
and disk, and none of them starts or wakes until the account is restored.

Public ingress rate tracking fails closed when its bounded tracking table is
full. Established connections and the separate operator SSH allowance keep
their own rules.

When you switch a project over, check that its package registries and other
destinations are reachable on these terms.

## Secrets sandboxes never see

**Store an API key once; your sandboxes use it without holding it.** Each
secret has a name, a value and the hosts it may go to.

```bash no-run
printf %s "$OPENAI_API_KEY" | runtime secrets set OPENAI_API_KEY --host api.openai.com
runtime secrets ls
```

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
await runtime.secrets.set("GITHUB_TOKEN", {
  value: process.env.GITHUB_TOKEN ?? "",
  hosts: ["api.github.com", "*.githubusercontent.com"],
  header: "Authorization",
  format: "token {value}",
});
```

Or open [Settings → Secrets](https://withruntime.com/account/secrets): every
secret by name, the hosts each may reach, where its value goes, its rules,
which sandboxes get it, whether jobs have a copy, and who added and last
changed it. An owner, admin or developer adds one, replaces its value or
deletes it there. The value is typed once and never shown again.

- Every sandbox of your account (or only the sandboxes the secret names, see
  `only` below) has an environment variable of the secret's
  name, holding a placeholder such as `rtsec_3f9c…`. Code uses it as it would
  use the key: `Authorization: Bearer $OPENAI_API_KEY`, or an SDK that reads
  `OPENAI_API_KEY`.
- The host's proxy replaces the placeholder with the value in the credential
  header of HTTPS requests to the secret's hosts: `Authorization`, `x-api-key`,
  `x-goog-api-key`, `api-key`, `xi-api-key`, `x-subscription-token` or
  `private-token`. A request to any other host carries the placeholder, which
  is worthless.
- The value never goes into the URL (its path or query) or any other header,
  even to the secret's hosts: there the placeholder goes out as it is. A
  hijacked agent that asks for `https://api.openai.com/v1/$OPENAI_API_KEY`,
  hoping the server's error page repeats the path, gets back only the
  placeholder.
- When a placeholder goes out unreplaced where the proxy can see it (plain
  HTTP, the URL or another header, a request the rules keep out, HTTPS to an
  address), the account gets the event `sandbox.secret_not_applied` saying
  which secret and why ([events](./observability#events)). To find why a
  placeholder arrived unchanged, see
  [troubleshooting](./troubleshooting#a-secret-s-placeholder-reaches-the-server-unchanged).
- With `header`, the proxy sets that header on every HTTPS request to the hosts,
  replacing one the sandbox sent, so code needs no placeholder at all; the
  value goes into that header and nowhere else. Use it for an API that reads
  its key from another header. When two secrets set the same header on one
  host (a key per team, say), the request carries the one whose placeholder
  the sandbox put in that header; one naming neither is refused with a 400
  that names both. An API that only takes a key in the URL (such as `?key=`)
  cannot be used with a secret.
- With `rules`, on accounts with credit, the value goes only into the requests a rule
  allows, by method and path, decided for each request on a connection. A path
  is exact (`/v1/chat/completions`) or a prefix ending in `/*`
  (`/repos/acme/*`), which covers the paths under it but not `/repos/acme`
  or `/repos/acme/`. The path is compared as sent, the query left out. A
  request whose path a server could read two ways gets no secret that has
  rules: one with `.` or `..` segments, a doubled slash (`//`), an escaped
  slash, letter, digit or dot (`%2F`, `%2e`), a semicolon or a backslash.
  Other escaped characters stay escaped, since a server may read `%3A` and `:`
  differently: a client that sends `/v1/models/x%3AgenerateContent` needs a
  rule written that way too. Up to 16
  rules of up to 16 paths each. In the CLI, from `withruntime` 0.7.0, give `--allow "GET,HEAD /repos/acme/*"` once per rule, or
  `--allow /v1/chat/completions` for every method; in the SDKs,
  `rules: [{ methods: ["GET"], paths: ["/repos/acme/*"] }]`. An account with
  no credit gets `payment_required` (402).
- With `only`, the secret goes to some of your sandboxes instead of all of
  them: those whose labels match a selector, and those you name by id. Any
  other sandbox has no environment variable for it, and the proxy puts its
  value into none of that sandbox's requests, even with the placeholder
  copied in by hand. A selector matches a sandbox whose labels hold every one
  of its pairs, and a sandbox matching any one selector gets the secret,
  including one created or labelled later (it has the secret from its first
  request, and a running one from the moment the label change answers: the
  update, made with a key that may read secrets, waits until its server holds
  the change and says so with `secretsEnforced: true`; any other key's
  relabel reaches it within 15 seconds). Use it to keep an
  orchestrator's own credentials away from the sandboxes it starts for
  others:

  ```bash no-run
  printf %s "$SLACK_APP_TOKEN" | runtime secrets set SLACK_APP_TOKEN --host slack.com --only-label role=hub
  runtime secrets set GITHUB_TOKEN --host api.github.com --only-label role=hub --only-label purpose=agent < token.txt
  runtime secrets set DEPLOY_KEY --host api.example.com --only-sandbox <sandbox id> < key.txt
  runtime secrets scope RUNTIME_API_KEY --only-label role=hub   # an existing secret, no value needed
  ```

  Each `--only-label` is one selector (`role=hub,tier=prod` needs both);
  `--only-sandbox` names a sandbox by id, up to 100. In the SDKs,
  `only: { labels: [{ role: "hub" }], sandboxes: ["<id>"] }` (a dict in Python
  and Ruby, `Only: &withruntime.SecretScope{...}` in Go, a map in Java, passed
  to `secrets.set` or `secrets.scope`); in the API and MCP tool, the same
  `only` object. Replacing a secret's value without
  `only` keeps the scope it has, so a new value never reaches more sandboxes
  than the old one did; `--all-sandboxes` (`only: {}`) gives it to every
  sandbox again. `runtime secrets scope` (`PUT /v1/egress-secrets/{name}/sandboxes`,
  `runtime.secrets.scope(name, only)`) changes who gets an existing secret
  without its value. `runtime secrets ls` shows who gets each one. Only the key
  that made a sandbox can label it, but any key of the account that can make
  sandboxes can make one with a scope's labels and so get the secret (a
  sandbox made by a key in a compartment matches no label, only its id): for a
  credential that matters, name its sandboxes by id, which only a key that can
  write secrets can change, or keep keys that make sandboxes out of the
  sandboxes you are guarding. A scope is free on
  every account. An upstream proxy's credential is sent for every sandbox the
  proxy covers, whatever its scope.

- With `secrets` on a create, the sandbox names the secrets it may use, and
  gets only those: least privilege from the sandbox's side. An agent whose
  definition needs one key gets that key and nothing else, so a prompt
  injection cannot send your deploy key anywhere, even to a host the deploy
  key allows. It narrows each secret's `only` and never widens it: a secret
  scoped away from the sandbox stays away, whatever the list says. `[]` is
  none; leave it out for every secret that reaches the sandbox, as before.

  ```bash no-run
  runtime sandboxes create --secret ANTHROPIC_API_KEY
  runtime sandboxes create --no-secrets          # no secret at all
  ```

  ```ts check
  import { Sandbox } from "withruntime";

  await using agent = await Sandbox.create({ secrets: ["ANTHROPIC_API_KEY"] });
  console.log(agent.info.secrets); // ["ANTHROPIC_API_KEY"]
  ```

  In the API and the `runtime_sandboxes_create` MCP tool, `"secrets":
["ANTHROPIC_API_KEY"]`; in Python, Go, Java and Ruby, the create's
  `secrets` option. At most 64 names. A sandbox outside a secret's list has
  no environment variable for it, and the proxy puts the value into none of
  its requests, even with the placeholder copied in by hand. A name you have
  not stored yet is allowed, and takes effect once you store that secret.
  The list is fixed for the sandbox's life: an update cannot change it. A
  fork, and a copy of a snapshot, keeps its source's list and may only narrow
  it (`secrets` on the fork); a wider one is refused. The answer's `secrets` is the list as
  stored, read back; a sandbox whose list cannot be confirmed is stopped before
  anything runs in it, and the create answers `secrets_unconfirmed` (500):
  create it again. `getOrCreate` with
  `secrets` refuses (`secrets_mismatch`) a sandbox already holding the name
  that may use more than it asks. Reading a sandbox shows its list as
  `secrets` (`null` when it names none). Each server holds the list before
  the sandbox's first request.

- The value is sealed to the servers' key when you store it. No API, tool or
  command returns it, and a sandbox never holds it: not in its environment, its
  memory or its disk, so a prompt injection or a stolen sandbox cannot leak it.
- Plain HTTP never carries a secret, and request bodies are never rewritten.
  Requests to a secret's hosts go over HTTP/2 when your client and the host
  both offer it, so a program's calls to one host share one connection, and
  over HTTP/1.1 otherwise; WebSockets and gRPC work.
- To reach those hosts the proxy opens the HTTPS connection itself and checks
  the real server's certificate. Sandboxes trust Runtime's certificate for
  those hosts already; Python, Node, curl and git pick it up through
  `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE` and `NODE_EXTRA_CA_CERTS`. A program
  with its own pinned certificates needs the file
  `/usr/local/share/ca-certificates/runtime-egress.crt` added to them.
- Name only hosts you trust with the value. A host that echoes requests back
  would show it to the sandbox.
- A secret with header `Authorization` and format `AWS4-HMAC-SHA256 {value}`
  holds a bucket's `ACCESS_KEY_ID:SECRET_ACCESS_KEY` and signs S3 requests
  instead: the proxy signs each request to its hosts again with the real key,
  and the secret key is never sent at all. See
  [mounting your own bucket](./storage#mount-your-own-bucket).
- A sandbox that starts or wakes after you store a secret has it from its first
  request, however briefly it runs; until 9 October 2026 one that started on a
  server not yet running another of your sandboxes could send the placeholder
  for up to five minutes. Replacing a secret keeps its placeholder; running
  sandboxes use the new value within seconds. Deleting one erases the value
  from every server that held it, including servers no longer running your
  sandboxes, and closing your account erases them all; it does not revoke the
  key at its provider.
- A change answers `enforced: true` once every server running your sandboxes,
  and every server still holding an earlier version, has confirmed it; a
  sandbox that starts or wakes later is given it before it runs. `false` means
  a server has not confirmed it yet: each server asks Runtime for changes every
  15 seconds and takes them by itself, and one that lost what it held is given
  it again the same way. A server that has not heard from Runtime for a minute
  stops putting any of your secrets' values into requests (the placeholder
  goes out) until it has, so on a server cut off from Runtime a deleted secret
  is sent for at most a minute, and none of your sandboxes starts or wakes
  there until it hears again. A change reaches connections already open at
  their next request.
- A server keeps your secrets only while it runs your sandboxes, and for 5
  minutes after the last one leaves it, for a quick wake; then it erases them.
- Every change to a secret or to your upstream proxy is in the
  [audit log](./teams), naming who made it, and is an
  [event](./observability#events) a webhook can receive. Neither ever holds
  the value.
- Up to {{sandbox-secrets}} secrets for sandboxes (`--host`) per account, each at most 8 KiB of
  visible ASCII, with up to 16 hosts. Secrets for jobs (`--jobs`) have their
  own limit, {{paid-secrets}} per account ([jobs](./jobs#secrets-in-a-job)). The API is `PUT /v1/egress-secrets/{name}`, `GET /v1/egress-secrets`
  and `DELETE /v1/egress-secrets/{name}`; the MCP tool is
  `runtime_secrets`, with `set`, `list` and `delete`.

### A secret your sandbox checks on requests it receives

A secret above only ever leaves a sandbox. For one the sandbox's own server
checks, such as a shared key another service sends in a header to its
[preview](./networking#private-preview-links), the program needs the value itself: put it in the
sandbox's `env`. Its value is never shown back by the API, the CLI or the
website. Make the key on your own machine and give it to both sides from
there, so it is in no command line, file, log or chat:

```bash no-run
key=$(openssl rand -hex 32)
# The other side, here a Cloudflare Worker's secret, read from standard input.
printf %s "$key" | npx wrangler secret put APP_SHARED_KEY
# The sandbox: --env NAME alone sends that variable's value from your shell.
APP_SHARED_KEY=$key runtime sandboxes update "${id}" --env APP_SHARED_KEY
unset key
# A program already running keeps the value it started with: restart it.
```

- To rotate it, run the same lines again and restart the server in the
  sandbox. For no failed request in between, have the server accept the old
  and the new key (say `APP_SHARED_KEY` and `APP_SHARED_KEY_NEXT`) until the
  other side has the new one, then `--unset-env` the old.
- `--env NAME` without `=` works on `create`, `update`, `exec` and `run` from
  withruntime 0.17.1, as `docker run -e NAME` does; a name not set in your
  shell is refused before anything is sent. Older versions take
  `--env NAME=value` only. From code, it is `env` on create or
  `sandbox.update({ env })`.
- Runtime's app in ChatGPT never takes a key's value, so set it from the CLI,
  the API or an agent connected with an API key. The preview stays private:
  the other service still needs its preview token as well.

## Your own proxy

**Paid accounts can send their sandboxes' connections through their own HTTP
or HTTPS proxy,** so the proxy's controls and logs apply and the traffic leaves
from its address.

```bash no-run
printf %s "Basic $(printf %s user:pass | base64)" | runtime secrets set PROXY_AUTH --host proxy.example.com
runtime networks upstream-proxy set http://proxy.example.com:3128 --secret PROXY_AUTH
```

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
await runtime.networks.upstreamProxy.set({
  url: "http://proxy.example.com:3128",
  secret: "PROXY_AUTH",
  hosts: ["*.internal.example.com"],
});
```

- Runtime's own rules apply first: a connection they refuse never reaches your
  proxy. Then the host reaches the destination with `CONNECT` through yours.
- `secret` names one of your secrets whose value is sent as the whole
  `Proxy-Authorization` header, such as `Basic dXNlcjpwYXNz`. Its hosts must
  name the proxy's host; it cannot be deleted while the proxy uses it.
- `hosts` limits which destinations go through the proxy, such as
  `["*.internal.example.com"]`; the rest leave directly. Without it, every
  connection goes through it.
- Secrets are still put in by Runtime before the bytes enter your proxy's
  tunnel, so your proxy sees encrypted traffic to the destination.
- If your proxy refuses or cannot be reached, the connection fails with
  `upstream-proxy-failed`. It never falls back to a direct connection, also
  not on a server that has not yet been given your proxy: there every
  connection fails the same way until it has. UDP to a destination the proxy
  covers is refused.
- The proxy's own address must be public, and its port one a sandbox may reach.
  An `https://` proxy's certificate must verify against the public roots.
- `runtime networks upstream-proxy get` and `remove` read and remove it; in
  Python it is `runtime.networks.upstream_proxy`. The API is `PUT`, `GET` and
  `DELETE /v1/networks/upstream-proxy`; the MCP tool is
  `runtime_networks_upstream_proxy`, with `set`, `get` and `remove`. The CLI command and the SDK methods
  arrived in `withruntime` 0.7.0.

## Root inside the sandbox

The sandbox user has passwordless `sudo`. Root inside the guest controls the
guest and nothing else: CPU, memory, disk, network rules, time limits and billing are
enforced on the host.

## Lifetimes and storage

A stopped sandbox is not a separately promised backup. Export important results before you
stop it.

## Browser-approved agent connections

**Connect an agent without copying a key.** Run the [CLI login](./cli), check
the request code and agent name, then approve **Connect agent**.

- The browser uses your existing session when possible.
- An owner, admin or developer of the account can approve a new connection. A
  person who belongs to several accounts chooses which one on the same page.
- The request expires after 15 minutes. Do not approve unsolicited connection
  links.
- The page shows the name the requesting computer gives itself, and the city
  and country Runtime saw the request come from. The computer's name is
  whatever that computer says, so treat it as a hint and match the code.

`runtime keys create` asks for an API key the same way, for a CI runner or
anywhere else with no browser:

- The page shows the key's name, its access, its daily limit and that it lasts
  until revoked, and an owner, admin or developer approves **Create key**.
- A billing member, an agent and an existing key cannot approve one.
- Whoever started the request receives the key, so approve only a request you
  started yourself.
- The key is sealed to that terminal, printed there once and kept by Runtime
  only as a hash.
- A command stopped before the key arrives cancels the request, and a key
  approved but not yet received is revoked before anyone holds it.

Approval creates a distinct agent identity and credential. It does not give the
agent your browser session. The credential is encrypted for the initiating CLI
when delivered, and saved outside the project. On Unix, the credential
directory is private to its user and the file has owner-only permissions. It is
a file that software running as your user can read, so keep the machine and its
backups secure.

Each connection can operate across the account and spend its prepaid balance,
so connect only agents you trust. Separate identities let you see which agent
did what, and revoke one without the others. To cap what one agent may spend,
set a daily limit on its row at
[API keys](https://withruntime.com/account/keys) after it connects.

The browser reports success after the CLI receives and verifies the credential.
Signing out of the browser leaves agent connections active. Revoke an individual
credential from **API keys**, or run `npx withruntime logout` on its machine
(installed: `runtime logout`). Revocation does not itself stop running
resources: inspect them and stop any work you no longer want. Billing follows
confirmed resource state, not sign-in state.

## The browser terminal

**The terminal on a sandbox's page acts as the agent that started the sandbox,
never as your browser session.** The website holds a key of that agent labelled
"Runtime website terminals" for you, and throws its secret away as it makes it.
To open a terminal, the page asks the website for a ticket, and the API trades
the ticket for that key.

- A ticket opens one terminal in one sandbox, for the person who asked for it.
  It lasts 60 seconds, and its first use spends it, whatever the outcome.
- The page sends it as a WebSocket subprotocol, so it never appears in an
  address or an access log. Runtime keeps only its SHA-256 hash.
- The API accepts a ticket only from a page on withruntime.com. A ticket offered
  for another sandbox or from another site is spent and refused.
- When the ticket is used, Runtime checks again that you may still act as that
  agent. A changed role or a removed member is refused.
- Every call the terminal makes meets the same checks as that agent's API key.
  Revoke "Runtime website terminals" on
  [API keys](https://withruntime.com/account/keys) to close every browser
  terminal it holds; the next one makes a new key.
- A person can open 30 terminals a minute. Each ticket is recorded with who
  asked, when, from which site and what became of it, and kept 30 days.

## Single sign-on

**Sign in through your company's identity provider, and require it.** Owners
connect Okta, Microsoft Entra ID, Google Workspace or any SAML or OIDC
provider at [Single sign-on](https://withruntime.com/account/single-sign-on),
free on every account. See [single sign-on](./single-sign-on).

- Your provider can sign in only addresses on the email domain you proved with
  a DNS record, and only one Runtime account can hold a proven domain.
- SAML assertions must be signed, meant for Runtime, within their validity
  window and in answer to a sign-in Runtime started, and each is accepted once.
- **Require single sign-on** refuses every other kind of session to your
  members. Owners stay exempt so a provider outage cannot lock you out. API
  keys are separate: revoke or limit them on [API keys](https://withruntime.com/account/keys).
- SCIM directory sync removes a person the moment your directory deactivates
  them, and revokes every key they made in the same step.

## Identity tokens instead of stored keys

**Give code in a sandbox access to your cloud without putting a key in it.** A
sandbox asks Runtime for a short-lived OIDC token that names the sandbox, its
organization and its image, and trades it for credentials in your AWS or
Google Cloud account, or presents it to your own API. See
[identity tokens](./identity-tokens).

- A sandbox can get a token only for itself, only while it runs, and for the
  audience it names. Tokens last 10 minutes unless asked for up to an hour.
- The signing keys stay on Runtime's own servers. Only their public halves are
  published, at `https://withruntime.com/oidc/jwks`.
- Scope your trust policy to your organization's id (`org:<org-id>:*`), or to
  one image, so no other Runtime customer's sandbox can assume your role.

## Before production traffic

- Run your real workload on the [free usage](./included-usage), including its package
  registries, cleanup and recovery.
- Give each agent or application its own key, with a daily limit where it helps.
- Keep outputs you need outside the sandbox.

Anyone can sign up at https://withruntime.com/sign-in.

## Domains, TCP ports, addresses and the tunnel

- **A custom domain is proved by DNS.** Only a TXT record holding the token made
  for your claim proves a hostname is yours; a CNAME left pointing at Runtime
  proves nothing, so nobody can take over a name its owner forgot to clean up.
  Certificates are requested only for proved names.
- **A TCP port reaches one port of one sandbox,** and a private network reaches
  only your own account's sandboxes: never another account's, never Runtime's
  servers or internal addresses, never the internet. The WireGuard gateway runs
  each account's network in its own user-space network stack, so nothing a peer
  sends reaches the server's own network stack. Rotating or removing a peer's
  key ends its connections.
- **Runtime's own relays inside a sandbox** (ports 10800, 10802 and 10853) are
  never reachable from outside, by a preview, a domain, a TCP port or the tunnel.
- **A dedicated outbound address is yours alone** while you hold it, and rests
  30 days after you release it before another account can have it.
- **Every connection is logged** with the sandbox, the account and the client's
  address, without contents, so a report can be traced and acted on. Runtime
  can turn off a domain, a port, a tunnel or everything of an account at once.

## Two-step sign-in

Customer sign-in uses Google, an email link, single sign-on or a passkey.
A new account opened by email is confirmed with a six-digit code, typed on the
page where it was asked for within ten minutes and three tries; a link in an
email never opens a new account. New accounts by email are not opened from a
data-centre or VPN network (use Google, or write to support), and a home
network opens at most two in an hour. Every address that asks for an email
gets the same answer, after the same checks, so the sign-in page does not
reveal whether an address has an account. An address is emailed at most five
times an hour, and one network can send at most 30 sign-in emails an hour to
existing accounts; asks from a network where the account has signed in within
90 days have their own allowance, so no one else can use up yours. A code takes at most ten wrong tries a day per address,
counted across every code and browser; after that, for a day, the address's
codes stop working and its email carries only the one-click link. A new code
cancels the one before it, and codes are stored keyed with a secret and
compared in constant time.
Directory reviewers use a separate, pre-provisioned demo identity with a
password. That login accepts only the configured review identity, grants no
extra permissions, and follows the same second-step requirements.

Turn it on under **Settings → Two-step sign-in** with a passkey, an
authenticator app, or both, and keep the ten backup codes it gives you. From
then on, every sign-in, whether with Google, an email link or single sign-on,
asks for the second step before the account opens.

- **A passkey** lives in iCloud Keychain, Google Password Manager, 1Password,
  Windows Hello or a security key, and you confirm it with your fingerprint,
  face or device PIN. It works only on withruntime.com, so a look-alike site
  cannot phish it. **Sign in with a passkey** on the sign-in page counts as
  both steps: no email link and no code.
- **An authenticator app** (1Password, Google Authenticator, Authy or any app
  that shows six-digit codes): scan the QR code and enter the code it shows.

A backup code works once, for when your devices are lost, and new ones replace
the old whenever you ask. Removing a passkey or the app asks you to confirm it
is you first; removing the last one turns two-step sign-in off.

An owner can require it of everyone in the account. Members who have not set
it up do so at their next sign-in, and an owner turns on their own before
requiring it. Turning it on or off, each passkey added or removed, and the
requirement are recorded in the [audit log](./teams). API keys and connected
agents are not affected: they do not sign in through a browser. Five wrong
codes in a row pause the step for fifteen minutes.

## Report a vulnerability

**Write to security@withruntime.com before you test anything, and again with what
you find.** Testing Runtime's own servers, network or other accounts without
agreeing it with us first breaks the
[acceptable use policy](/legal/acceptable-use), and we may suspend the account.

A report helps most with the steps to reproduce it, the sandbox or request ids
involved, and the time with its time zone. Please give us a reasonable time
to fix a problem before you describe it in public. The same address is in
[`/.well-known/security.txt`](https://withruntime.com/.well-known/security.txt).
