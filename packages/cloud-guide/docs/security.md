# Isolation and account boundaries

Runtime uses Firecracker microVMs on Runtime-operated dedicated servers.

- Each sandbox has its own Linux kernel, disk and guest environment.
- CPU, memory, disk, network rules, time limits and billing are enforced on the host, outside the guest.
- Host credentials, control sockets and provider credentials never reach customers.
- Our own servers run tests of guest separation, selected private-address refusals, restart recovery and time limits that end on the host.
- A fork, or a create from a memory snapshot, copies each running program's random-number state. Make keys and tokens after the copy. See [randomness in copies](./storage#randomness-in-copies).

## Keys and secrets

**Keep keys in server-side secret storage, one per agent or application.**

- A key covers every Cloud product, including products enabled later. It lasts until revoked.
- A key can never do more than the role of the member who made it allows. Runtime reads that role on every request (see [teams](./teams)).
- Never put a key in a public prompt, URL, browser bundle, repository, command-line argument or diagnostic log.
- A framework adapter does not expand what the key is allowed to do.
- If a key turns up in public, Runtime may revoke that one key. The account's owners are emailed why. The audit log shows that Runtime revoked it, and the reason. Every other key keeps working.

Pass a command its secrets through `env`, never in the command line. Runtime never echoes `env` values back. Its journals and request records keep only a hash of them. A command line is not protected that way. Anything running in the sandbox can read it.

**Runtime keeps a command's program name, never its arguments.** For each command run through the API, the SDKs, the CLI or MCP, Runtime records the program (`python3`, from `python3 train.py --token …`). It also records the exit code, how long the command ran, when it started, which key or person ran it, and in which sandbox. Arguments, the rest of the command line and environment values are never stored. Arguments can carry a secret typed inline. A terminal is recorded as its shell and nothing typed in it. A code interpreter cell is recorded as its language (`python-cell`), never its code. Runtime keeps the record for 14 days. It shows on the sandbox's page in your account.

## Read-only keys and daily limits

**Both are optional.** Without them, a key reaches every product. Its use is limited only by your prepaid balance.

- **Read-only key.** Choose **Read only** when you create a key at [API keys](https://withruntime.com/account/keys), or pass `--read-only` to `runtime keys create`. It sees the whole account. That includes every sandbox and its state, spec and cost, the images, volumes, snapshots, previews and network rules beside them, account notices, the balance, and its own access and limit. It also covers products added later. It cannot create, start, stop, pause, wake, run a command, write a file, change anything or spend anything. It does not see inside sandboxes (files, command output), job runs or secrets. A private preview reaches it without its token. Use it for monitoring, dashboards and CI checks.
- **Daily spending limit.** Set one on any key that can spend. Set it when you create the key, or later from its row. The limit is the most that key's agent may commit in any 24 hours. It counts what is already charged and what running sandboxes are about to use. It counts everything the agent's sandboxes cost, including renewals and parked storage. An account-wide key's limit also counts what it asks for on another key's sandbox. That covers a wake, an extension or a restart. It also covers the renewals that carry that sandbox to the end of its `timeoutSeconds`. When a create, wake, extension or renewal would pass the limit, the request fails with `spending_limit_reached` (HTTP 402). Nothing is charged. A running sandbox keeps the time it is already funded for. A sandbox whose next renewal would pass the limit stops or pauses at the end of that time. Room returns as older spending leaves the 24-hour window.

An owner, admin or developer of the account can create a key of either kind:

- They create one at [API keys](https://withruntime.com/account/keys), or approve one in the browser that `runtime keys create` asked for from a terminal (see below).
- The member who made a key, or an owner or admin, sets, changes or removes its limit. They can do this only on the website.
- A key acts on what its own agent made. Only an owner or admin can make a key **account-wide**, so it sees and uses everything in the account. An account-wide key is allowed only for a key of an owner or admin. It lapses if that person becomes a developer ([keys in a team](./teams#keys-in-a-team)).
- A key can read its own access and limit with `GET /v1/limits`, `runtime limits` or the `runtime_account` tool's `limits` action.
- No key can raise, remove or set a limit. A full-access key of an owner or admin can make keys that have no more than it has ([run a swarm](./teams#run-a-swarm)).
- The [audit log](./teams#audit-log) records every key made, revoked or limited, and every connection approved. Each entry names who did it and from where.

A sandbox can also carry `maxTotalCostMicros`. This is the most it may cost over its whole life. When it reaches that cost, the sandbox stops, with `stopReason` `lifetime_cap`.

Set a limit above what the agent's paused sandboxes cost in a day. If storage for a paused sandbox cannot be paid for, it is treated like storage on an empty balance. You are notified by an account notice. The account's owners also get an email a day before. After seven days unpaid, it is deleted.

## Compartments

**A compartment separates a group of keys from the rest of the account.** Use one per customer of your platform, or for an agent whose sandboxes no other key may reach.

- An owner or admin makes one at [API keys](https://withruntime.com/account/keys). Choose **One compartment** under **Sees** when you make a key. Then pick a compartment, or name a new one. More keys can join it the same way.
- A key in a compartment lists, creates, runs commands in, forks, snapshots, pauses, wakes and deletes these: sandboxes, snapshots, images, volumes, previews, ports, jobs, job secrets, Apps and Functions. It acts only on those that its compartment's keys made. It can use nothing else.
- It deploys an App or Function from an image only. A deploy that names a `build` returns 403 `outside_compartment`. Builds and repositories return the same error.
- It cannot give an App or Function a name that one of the account's own Apps holds. Creating or renaming it returns 409 `name_taken`.
- It may set an App's `releaseWatch` to `alert` or `rollback`, but never `off`. Turning it off would stop the owners hearing of a release that got worse. Turning it off returns 403 `forbidden`.
- Anything outside its compartment returns 404 `not_found`, the same as an id that does not exist. No key outside the compartment reaches in either. That includes read-only keys. The only exception is an account-wide key, which sees everything in the account.
- Each compartment has its own sandbox names. `getOrCreate("main")` in one compartment never returns another compartment's `main`. A name held by another compartment never returns `name_taken`.
- An image name belongs to the compartment (or the rest of the account) that first built it. Nobody else can add a version to it or move its tags. A build by another compartment with that name returns 409 `name_taken`.
- A fork, or a create from a snapshot, stays in the compartment of the key that made it. A resource never moves between compartments. A key's compartment is set when the key is made and never changes.
- A key in a compartment cannot reach the account's own settings. These are billing, keys, domains, dedicated addresses, the account's networks, egress secrets, registry logins, webhooks, telemetry export, the audit log, builds and repositories. Those return 403 `outside_compartment`. The key can read who it is with `GET /v1/me`. Its `compartment` field names its compartment.
- A compartment's sandboxes are not in the account's private network or its WireGuard peers. The account's egress rules, egress secrets, your own proxy and signed requests still apply to them.
- No key can make a compartment. A compartment can be deleted only when it holds nothing. Deleting one that holds something returns 409 `compartment_not_empty`. Its keys stop working when it is deleted.
- The [audit log](./teams#audit-log) records each compartment and every key put in one.

## Network access

**Every outbound connection goes through a proxy on the host.** Programs that use `HTTP_PROXY` and programs that open raw sockets follow the same rules. Nothing in the guest can go around it, root included.

- A paid sandbox of an account with a kept top-up reaches any public host on any port. A sandbox without credit reaches ports 443 and 80.
- Some ports are never reachable: telnet, Windows RPC, NetBIOS and SMB, and IRC. Mail ports open only when support enables mail for your account.
- Private and internal addresses are refused. Code that retries one, such as a cloud SDK looking for credentials at the metadata address, is only refused.
- The proxy watches every sandbox, with credit or without, for traffic that only abuse makes. That includes trying one internal address after another. It includes a port scan, or a sweep of addresses that do not answer. It includes a cryptocurrency mining pool, and mail sent straight to many mail servers. The thresholds sit far above what test suites, builds, package installs, crawlers within the limits, CI and load tests against your own servers do. A sandbox that crosses a threshold loses its network. It is then paused, or stopped if it cannot pause. Your inbox (`GET /v1/notices`) says what was seen and what was done. The sandbox stays paused or stopped, with its files kept, until support lifts the block. Until then, a wake, restart, snapshot or fork of it, or a start from a snapshot of it, returns `sandbox_halted`. An account that has paid is never suspended for it. An account that has never paid is suspended for any of them. Traffic that looks like a flood, repeated attempts on the closed mail ports, or full CPU beside a mining pool's website is only recorded for a person to look at.
- Services that exist only to catch a security test's call-back are refused to every sandbox and image build. Examples are `oast.live`, `interact.sh` and Burp Collaborator. To test Runtime itself, see [report a vulnerability](#report-a-vulnerability).
- Each sandbox's rules can narrow this further. They bind root inside the sandbox too. See [the sandbox environment](./sandbox-environment).
- Code in a sandbox reaches Runtime's own API only at `http://runtime.internal`. It uses an API key, like any other caller. The host sends each request on to the public API over HTTPS. It reaches nothing else of its own. See [Runtime's API from inside a sandbox](./sandbox-environment#runtime-s-api-from-inside-a-sandbox).
- Each sandbox has limits on concurrent connections, upload speed and bytes per day. It shares its server's link fairly with the other sandboxes, so one sandbox cannot crowd out the others. A paid sandbox uploads at up to {{paid-upload}}. Its sustained rate is {{paid-upload-sustained}}, after its first {{paid-upload-burst}}. It moves {{paid-daily-transfer}} a day. A sandbox without credit uploads at up to {{trial-upload}}. It moves {{trial-daily-transfer}} a day for the whole account. Uploads are limited because they are what spam and floods use. Downloads are not ([the sandbox environment](./sandbox-environment#the-network)).

Inbound connections need a preview, a proved custom domain, an allocated TCP port or an authorized private tunnel. Each reaches only the sandbox port and account it was granted.

A preview is private, with an expiring token, unless you make it public. A paid sandbox of an account with a kept top-up can make it public. A sandbox without credit's previews are always private. While an account is blocked, or every purchase it made is refunded in full, its public previews need the token, like private ones. They are public again once it pays.

Preview addresses are under `runtimehost.com`, never under `withruntime.com`. So sandbox content never shares an origin with your account.

A preview signed in by its cookie accepts a WebSocket, or a request that changes something, only from two places. One is its own address. The other is a site you allow to embed it. A request that changes something uses any method except GET, HEAD and OPTIONS. From any other page, another preview included, it returns `origin_not_allowed` (403). Code that sends the preview token in its header or query is not affected.

Rotating a preview token refuses every token issued before it. It also closes connections opened with one. This happens before the call returns. Making a preview private, deleting it, removing a custom domain or closing a TCP port takes effect the same way. So does Runtime taking a site down or suspending an account.

A suspension also pauses the account's running sandboxes. It keeps their memory and disk. None of them starts or wakes until the account is restored.

Public ingress rate tracking fails closed when its tracking table, which has a size limit, is full. Established connections and the separate operator SSH allowance follow their own rules.

When you move a project over, check that its package registries and other destinations are reachable under these terms.

## Secrets sandboxes never see

**Store an API key once. Your sandboxes use it without holding it.** Each secret has a name, a value and the hosts it may go to.

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

Or open [Settings → Secrets](https://withruntime.com/account/secrets). It lists every secret by name. For each one, it shows the hosts it may reach, where its value goes, its rules, which sandboxes get it, whether jobs have a copy, and who added it and last changed it. An owner, admin or developer can add a secret, replace its value or delete it there. The value is typed once and never shown again.

- Every sandbox in your account (or only the sandboxes the secret names, see `only` below) has an environment variable named after the secret. It holds a placeholder such as `rtsec_3f9c…`. Code uses it as it would use the key: `Authorization: Bearer $OPENAI_API_KEY`, or an SDK that reads `OPENAI_API_KEY`.
- The host's proxy replaces the placeholder with the value. It does this in the credential header of HTTPS requests to the secret's hosts. The credential headers are `Authorization`, `x-api-key`, `x-goog-api-key`, `api-key`, `xi-api-key`, `x-subscription-token` and `private-token`. A request to any other host carries the placeholder. The placeholder is worthless on its own.
- The value never goes into the URL (its path or query) or into any other header. This holds even for the secret's hosts. There, the placeholder goes out as it is. A hijacked agent might request `https://api.openai.com/v1/$OPENAI_API_KEY`, hoping the server's error page repeats the path. It gets back only the placeholder.
- When a placeholder goes out unreplaced where the proxy can see it, the account gets the event `sandbox.secret_not_applied`. The event says which secret, and why. Examples are plain HTTP, the URL or another header, a request the rules keep out, and HTTPS to an address. See [events](./observability#events). To find why a placeholder arrived unchanged, see [troubleshooting](./troubleshooting#a-secret-s-placeholder-reaches-the-server-unchanged).
- With `header`, the proxy sets that header on every HTTPS request to the hosts. It replaces any value the sandbox sent in that header. Code then needs no placeholder at all. The value goes into that header and nowhere else. Use it for an API that reads its key from another header. When two secrets set the same header on one host, such as a key per team, the request carries one of them. It carries the one whose placeholder the sandbox put in that header. A request that names neither is refused with a 400 that names both. An API that takes a key only in the URL (such as `?key=`) cannot be used with a secret.
- With `rules`, on accounts with credit, the value goes only into requests that a rule allows. A rule allows requests by method and path. Runtime decides this for each request on a connection. A path is exact (`/v1/chat/completions`). Or it is a prefix ending in `/*` (`/repos/acme/*`). A prefix covers the paths under it. It does not cover `/repos/acme` or `/repos/acme/`. A segment that is `*` alone, before the end, matches any one segment. For example, `/repos/acme/app/pulls/*/comments` allows a pull request's comments and nothing else under it. The path is compared as sent, with the query left out. A request whose path a server could read two ways gets no secret that has rules. Such paths have any of these: `.` or `..` segments, a doubled slash (`//`), an escaped slash, letter, digit or dot (`%2F`, `%2e`), a semicolon or a backslash. Other escaped characters stay escaped. A server may read `%3A` and `:` differently. So a client that sends `/v1/models/x%3AgenerateContent` needs a rule written that way too. A secret can have up to 16 rules, with up to 16 paths each. In the CLI, from `withruntime` 0.7.0, give `--allow "GET,HEAD /repos/acme/*"` once per rule. Or give `--allow /v1/chat/completions` for every method. In the SDKs, use `rules: [{ methods: ["GET"], paths: ["/repos/acme/*"] }]`. An account with no credit gets `payment_required` (402).
- A secret's hosts and rules can be narrowed without its value, from `withruntime` 0.22.0. Run `runtime secrets set NAME --keep-value` with the narrower `--host` and `--allow`. The API is `PUT /v1/egress-secrets/{name}/rules`. The SDK call is `runtime.secrets.narrow(name, { hosts, rules })`. Every SDK has `narrow`. Narrower means the secret can go nowhere it could not go before. Each host must be one its hosts already name, such as `a.example.com` or `*.a.example.com` under `*.example.com`. Each method and path a new rule allows must be one its rules allow now. A secret without rules allows every request, so any rules narrow it. On an account with no credit, giving rules to a secret that had none returns `payment_required` (402). Storing rules does the same. Anything wider is refused with `invalid_request`. The error says what would widen. A new place could learn the value, so widening needs the value. The audit log records the change as an update with `narrowed`. For example, a token that should only fetch one repository over git:

  ```bash no-run
  runtime secrets set GIT_BASIC --keep-value \
    --allow "GET /acme/app.git/info/refs" --allow "POST /acme/app.git/git-upload-pack"
  ```

  A push (`POST /acme/app.git/git-receive-pack`) then goes out with the placeholder. GitHub refuses it.

- With `only`, the secret goes to some of your sandboxes instead of all of them. Those are the sandboxes whose labels match a selector, and the sandboxes you name by id. Any other sandbox has no environment variable for the secret. The proxy puts its value into none of that sandbox's requests, even with the placeholder copied in by hand. A selector matches a sandbox whose labels hold every one of its pairs. A sandbox that matches any one selector gets the secret. This includes a sandbox created or labelled later. It has the secret from its first request. A running sandbox gets it from the moment the label change returns. With a key that may read secrets, the update waits until its server holds the change. It then says so with `secretsEnforced: true`. Any other key's relabel reaches the sandbox within 15 seconds. Use it to keep an orchestrator's own credentials away from the sandboxes it starts for others:

  ```bash no-run
  printf %s "$SLACK_APP_TOKEN" | runtime secrets set SLACK_APP_TOKEN --host slack.com --only-label role=hub
  runtime secrets set GITHUB_TOKEN --host api.github.com --only-label role=hub --only-label purpose=agent < token.txt
  runtime secrets set DEPLOY_KEY --host api.example.com --only-sandbox <sandbox id> < key.txt
  runtime secrets scope RUNTIME_API_KEY --only-label role=hub   # an existing secret, no value needed
  ```

  Each `--only-label` is one selector. `role=hub,tier=prod` needs both pairs. `--only-sandbox` names a sandbox by id, up to 100 of them.

  `--only-app <app id>` gives the secret to every copy of an App. Its copies get new ids at every deploy, restart and scale-up. Each copy has the secret from its first request. No other sandbox can join, because only Runtime makes an App's copies.

  The App's deploy names the secrets its copies see as environment variables, with `secrets: ["OPENAI_API_KEY"]`. The deploy needs a key that may reveal secrets. Later deploys by such a key keep them. So do pushes to the connected repository's production branch with unchanged build settings. A key that may only deploy cannot hand its own code the App's secrets. Such a deploy is refused. A copy holds the placeholder, never the value.

  In the SDKs, the form is `only: { labels: [{ role: "hub" }], sandboxes: ["<id>"], apps: ["<app id>"] }`. In Python and Ruby it is a dict. In Go it is `Only: &withruntime.SecretScope{...}`. In Java it is a map. Pass it to `secrets.set` or `secrets.scope`. In the API and MCP tool, use the same `only` object.

  Replacing a secret's value without `only` keeps the scope it has. So a new value never reaches more sandboxes than the old one did. `--all-sandboxes` (`only: {}`) gives the secret to every sandbox again. `runtime secrets scope` (`PUT /v1/egress-secrets/{name}/sandboxes`, `runtime.secrets.scope(name, only)`) changes who gets an existing secret without its value. `runtime secrets ls` shows who gets each one.

  Only the key that made a sandbox can label it. But any key of the account that can make sandboxes can make one with a scope's labels, and so get the secret. A sandbox made by a key in a compartment matches no label, only its id. For a credential that matters, name its sandboxes by id. Only a key that can write secrets can change those. Or keep keys that make sandboxes out of the sandboxes you are guarding.

  A scope is free on every account. An upstream proxy's credential is sent for every sandbox the proxy covers, whatever its scope.

- A secret's name is also the environment variable its sandboxes see. You can give `env` instead. Then sandboxes see the placeholder in that variable. Several secrets may share one variable. Each must be scoped to sandboxes the others do not reach. One example is a GitHub token per repository, each seen as `GITHUB_TOKEN`:

  ```bash no-run
  runtime secrets set GITHUB_TOKEN_WEB --host api.github.com --only-label repo=web --env GITHUB_TOKEN < web.txt
  runtime secrets set GITHUB_TOKEN_API --host api.github.com --only-label repo=api --env GITHUB_TOKEN < api.txt
  ```

  A sandbox labelled `repo=web` sees only `GITHUB_TOKEN_WEB`'s placeholder in `GITHUB_TOKEN`. Its requests carry only that token. In the SDKs and the API, set `env: "GITHUB_TOKEN"` on `secrets.set`. A store or scope change is refused with 409 `conflict` if it would let one sandbox get two secrets of the same variable. That happens when one secret reaches every sandbox, or when a sandbox is in both scopes now. A sandbox labelled into both scopes later sees the first by name. Both secrets reach it, as their scopes say. Replacing a value without `env` keeps the variable. Setting `env` to the secret's own name restores the name. A variable that Runtime sets in every sandbox cannot be a secret's `env`. Neither can one that decides what its programs load or trust. Examples are `PATH`, `LD_PRELOAD`, `SSL_CERT_FILE` and `HTTPS_PROXY`. A sandbox's `secrets` list, `--secret` on a create and `runtime secrets ls` name secrets by name, not by variable.

- A jobs secret (`--jobs`) belongs to the key that stored it. Your other keys cannot use it until you share it. Share it with `runtime secrets share NAME --agent <id>`, or with `--all`. You can always use it yourself. A secret you store on the website is available to every key. A job that binds a secret another key stored stops until that secret is shared.
- With `secrets` on a create, the sandbox names the secrets it may use. It gets only those. This is least privilege from the sandbox's side. An agent whose definition needs one key gets that key and nothing else. So a prompt injection cannot send your deploy key anywhere. That holds even to a host the deploy key allows. The list narrows each secret's `only`. It never widens it. A secret scoped away from the sandbox stays away, whatever the list says. `[]` means none. Leave the field out for every secret that reaches the sandbox, as before.

  ```bash no-run
  runtime sandboxes create --secret ANTHROPIC_API_KEY
  runtime sandboxes create --no-secrets          # no secret at all
  ```

  ```ts check
  import { Sandbox } from "withruntime";

  await using agent = await Sandbox.create({ secrets: ["ANTHROPIC_API_KEY"] });
  console.log(agent.info.secrets); // ["ANTHROPIC_API_KEY"]
  ```

  In the API and the `runtime_sandboxes_create` MCP tool, pass `"secrets": ["ANTHROPIC_API_KEY"]`. In Python, Go, Java and Ruby, use the create's `secrets` option. The list holds at most 64 names. A sandbox outside a secret's list has no environment variable for it. The proxy puts the value into none of its requests, even with the placeholder copied in by hand. You can list a name you have not stored yet. It takes effect once you store that secret. The list is fixed for the sandbox's life. An update cannot change it. A fork, or a copy of a snapshot, keeps its source's list. It may only narrow the list, with `secrets` on the fork. A wider list is refused. The response's `secrets` is the list as stored, read back. If a sandbox's list cannot be confirmed, the sandbox is stopped before anything runs in it. The create returns `secrets_unconfirmed` (500). Create it again. `getOrCreate` with `secrets` refuses a sandbox that already holds the name and may use more than it asks. It returns `secrets_mismatch`. Reading a sandbox shows its list as `secrets`, or `null` when it names none. Each server holds the list before the sandbox's first request.

- The value is sealed to the servers' key when you store it. No API, tool or command returns it. A sandbox never holds it, not in its environment, its memory or its disk. So a prompt injection or a stolen sandbox cannot leak it.
- Plain HTTP never carries a secret. Request bodies are never rewritten. Requests to a secret's hosts go over HTTP/2 when your client and the host both offer it. Then a program's calls to one host share one connection. Otherwise they go over HTTP/1.1. WebSockets and gRPC work.
- To reach those hosts, the proxy opens the HTTPS connection itself. It checks the real server's certificate. Sandboxes already trust Runtime's certificate for those hosts. Python, Node, curl and git pick it up through `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE` and `NODE_EXTRA_CA_CERTS`. A program with its own pinned certificates needs the file `/usr/local/share/ca-certificates/runtime-egress.crt` added to them. Each organization has its own certificate authority, the same on every server. A sandbox that wakes, moves to another server or is forked keeps the same certificate, so programs that are already running keep working. A sandbox is never given or served another organization's certificate authority.
- Name only hosts you trust with the value. A host that echoes requests back would show it to the sandbox.
- A secret with header `Authorization` and format `AWS4-HMAC-SHA256 {value}` holds a bucket's `ACCESS_KEY_ID:SECRET_ACCESS_KEY`. It signs S3 requests instead. The proxy signs each request to its hosts again with the real key. The secret key is never sent at all. See [mounting your own bucket](./storage#mount-your-own-bucket).
- A sandbox that starts or wakes after you store a secret has it from its first request, however briefly it runs. Until 9 October 2026, a sandbox that started on a server not yet running another of your sandboxes could send the placeholder for up to five minutes. Replacing a secret keeps its placeholder. Running sandboxes use the new value within seconds. Deleting a secret erases the value from every server that held it. That includes servers no longer running your sandboxes. Closing your account erases them all. Deleting a secret does not revoke the key at its provider.
- A change returns `enforced: true` once two things are true. Every server running your sandboxes has confirmed it. Every server still holding an earlier version has confirmed it too. A sandbox that starts or wakes later gets the change before it runs. `false` means a server has not confirmed the change yet. Each server asks Runtime for changes every 15 seconds and takes them by itself. A server that lost what it held gets the change again the same way. A server that has not heard from Runtime for a minute stops putting any of your secrets' values into requests. The placeholder goes out instead. This continues until the server hears from Runtime again. So on a server cut off from Runtime, a deleted secret is sent for at most a minute. None of your sandboxes starts or wakes there until it hears again. A change reaches connections already open at their next request.
- A server keeps your secrets only while it runs your sandboxes. It keeps them 5 more minutes after the last one leaves, for a quick wake. Then it erases them.
- The [audit log](./teams) records every change to a secret or to your upstream proxy. Each entry names who made the change. Each change is also an [event](./observability#events) that a webhook can receive. Neither the log nor the event ever holds the value.
- An account can have up to {{sandbox-secrets}} secrets for sandboxes (`--host`). Each secret is at most 8 KiB of visible ASCII, with up to 16 hosts. Secrets for jobs (`--jobs`) have their own limit of {{paid-secrets}} per account ([jobs](./jobs#secrets-in-a-job)). The API is `PUT /v1/egress-secrets/{name}`, `GET /v1/egress-secrets` and `DELETE /v1/egress-secrets/{name}`. The MCP tool is `runtime_secrets`, with `set`, `list` and `delete`.

### GitHub: an App's tokens, branch limits and API budgets

**Give agents GitHub access without a token that can do everything.** A secret can hold a GitHub App's private key. It can limit which branches a push may update. It can cap each sandbox's calls. Our servers enforce all of this on the way out. So a hijacked agent can't get past it.

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
await runtime.secrets.set("GITHUB_AGENTS", {
  value: process.env.GITHUB_APP_PRIVATE_KEY ?? "",
  hosts: ["github.com", "api.github.com"],
  githubApp: {
    id: 123456,
    installation: 7890123,
    repositories: ["my-app"],
    permissions: { contents: "write", pull_requests: "write" },
  },
  git: { push: ["refs/heads/task/{label.task}", "refs/heads/task/{label.task}--*"] },
  api: { callsPerHour: 400, writesPerHour: 120, keep: 1000, copies: true, fresh: 10 },
  only: { labels: [{ purpose: "agent" }] },
});
```

The same fields go to `PUT /v1/egress-secrets/{name}` and to every SDK. The SDK versions are `withruntime` 0.25.0 for JavaScript, 0.23.0 for Python, Go 0.12.0, and Java and Ruby 0.11.0. The field names are `github_app`, `git` and `api` in Python and Ruby. They are `GithubApp`, `Git` and `API` in Go. In Java, they go in the policy map. Reading the secret returns them, never the key. They only narrow what a secret does, so they are free.

- **`githubApp`**: the value is the App's private key (PEM). Our servers sign the App's token request. They use the installation token that GitHub returns. That token is narrowed to `repositories` and `permissions` when you name them. The token goes as `Authorization: Bearer` to the API. It goes as git's `x-access-token` to `git` over HTTPS. So `git clone`, `git push` and `gh` work with no credential in the sandbox. The key itself goes into no request. A token is made on first use, and again before it ends. While a token is being made, a request gets `503` with `Retry-After: 1`. If GitHub refuses the App a token, requests get `502` with GitHub's reason. This lasts until a try succeeds. Another try comes 30 seconds after a refusal. A GitHub App secret takes no `header` or `format`. For GitHub Enterprise Server, `api` is `https://<host>/api/v3`. That name must be a public name among the secret's hosts.
- **`git.push`**: the branches a push may update. Each is `refs/heads/` followed by a name. `*` is allowed only at the end. `{label.task}` stands for the sandbox's own `task` label. Any label key works. So each agent pushes only its own branch. A label goes right below a fixed first segment, as in `refs/heads/task/{label.task}`. It can never be `refs/heads/{label.task}`. After the label comes `/`, `--` or the end of the pattern. Each first segment takes one label key across all your secrets. So `task/` cannot take both `{label.task}` and `{label.name}`. This keeps two sandboxes from naming the same branch. A value is the branch of the first sandbox your account made with it. It stays that sandbox's after the sandbox is deleted. So a later sandbox with the same value never pushes to a finished agent's open pull request. Give the label when you create the sandbox. Once made, a sandbox's value of a label that a push pattern names cannot change. A sandbox pushes nothing that a label names in these cases. It lacks that label. The label's value holds `/`, `*` or `--`, or ends in `-`. An earlier sandbox had the same value. Or a key in a compartment made it. Any other ref, a tag or a delete is refused before anything reaches GitHub. `git push` prints why: `! [remote rejected] HEAD -> main (GITHUB_AGENTS pushes only …)`. `push: []` makes the secret fetch-only. The API can't get around these limits. With `git`, the secret makes an API write only when its `rules` name it. So a secret without rules writes nothing through the API. It makes a GraphQL mutation only when `api.graphql` lists it. Even then, it never writes a file, merges, makes or deletes a ref, renames or protects a branch, or makes a release. It also never makes a GraphQL mutation that does those things, such as `createCommitOnBranch`, `updateRef` or `mergePullRequest`. Each such request gets `403` with `x-runtime-egress: secret-git`. A `PATCH` of a branch the patterns allow still goes. A GitHub App secret with `git` must name its tokens' `permissions`. Those must exclude `admin`, `administration` and `secrets`. And `workflows`, `actions` and `environments` may be at most `read`.
- **`api.callsPerHour` and `api.writesPerHour`**: the most calls, and the most writes, each sandbox makes with the secret in an hour. A write is any method except GET, HEAD and OPTIONS, or a GraphQL mutation. Past either limit, the request gets `429` with `Retry-After`. `writesPerHour: 0` means read-only. A clone or push is not counted.
- **`api.keep`**: calls left for everyone else. No call goes while GitHub's last `x-ratelimit-remaining` for that bucket (core, graphql or search) is at or below `keep`. This holds until its reset. The request gets `429` with `Retry-After`. Your own services keep the last of the hour.
- **`api.copies` and `api.fresh`**: a GET over HTTP/2 is answered from this server's copy. This happens while GitHub answers `304` to its ETag. A `304` costs no GitHub calls. The copy is shared by every sandbox the secret reaches on that server. With `fresh` (1 to 300 seconds), a copy that young is answered without asking GitHub. This includes GraphQL queries. Past a sandbox's hour, its earlier reads are still answered from the copy. Each such answer carries `x-runtime-copy`, with the value `revalidated`, `fresh` or `unasked`. Answers with `no-store`, `set-cookie` or `Vary: *` are never kept. GraphQL answers holding `errors` are never kept either.
- **`api.graphql`**: `{ mutations: ["addComment", "createPullRequest"] }`. A query always goes. A mutation goes only when every mutation in the request is listed. Anything else is refused with `403`. `path` is where GraphQL is served. It is `/graphql` unless you say otherwise (`/api/graphql` on Enterprise Server).

### A secret your sandbox checks on requests it receives

A secret above only ever leaves a sandbox. Some secrets are checked by the sandbox's own server. One example is a shared key that another service sends in a header to its [preview](./networking#private-preview-links). For these, the program needs the value itself. Put it in the sandbox's `env`. The API, the CLI and the website never show its value. Make the key on your own machine. Give it to both sides from there. Then it is in no command line, file, log or chat:

```bash no-run
key=$(openssl rand -hex 32)
# The other side, here a Cloudflare Worker's secret, read from standard input.
printf %s "$key" | npx wrangler secret put APP_SHARED_KEY
# The sandbox: --env NAME alone sends that variable's value from your shell.
APP_SHARED_KEY=$key runtime sandboxes update "${id}" --env APP_SHARED_KEY
unset key
# A program already running keeps the value it started with: restart it.
```

- To rotate it, run the same lines again. Then restart the server in the sandbox. To avoid failed requests in between, have the server accept the old and the new key. For example, use `APP_SHARED_KEY` and `APP_SHARED_KEY_NEXT`. Do this until the other side has the new one. Then remove the old one with `--unset-env`.
- From withruntime 0.17.1, `--env NAME` without `=` works on `create`, `update`, `exec` and `run`. It works the same way as `docker run -e NAME`. A name not set in your shell is refused before anything is sent. Older versions take `--env NAME=value` only. From code, use `env` on create, or `sandbox.update({ env })`.
- Runtime's app in ChatGPT never takes a key's value. Set it from the CLI, the API or an agent connected with an API key. The preview stays private. The other service still needs its preview token as well.

## Your own proxy

**Paid accounts can send their sandboxes' connections through their own HTTP or HTTPS proxy.** The proxy's controls and logs then apply. The traffic leaves from the proxy's address.

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

- Runtime's own rules apply first. A connection they refuse never reaches your proxy. Then the host reaches the destination with `CONNECT` through your proxy.
- `secret` names one of your secrets. Its value is sent as the whole `Proxy-Authorization` header, such as `Basic dXNlcjpwYXNz`. The secret's hosts must name the proxy's host. The secret cannot be deleted while the proxy uses it.
- `hosts` limits which destinations go through the proxy, such as `["*.internal.example.com"]`. The rest leave directly. Without it, every connection goes through the proxy.
- Runtime still puts in secrets before the bytes enter your proxy's tunnel. So your proxy sees encrypted traffic to the destination.
- If your proxy refuses the connection or cannot be reached, the connection fails with `upstream-proxy-failed`. It never falls back to a direct connection. This also holds on a server that has not yet been given your proxy. There, every connection fails the same way until the server has your proxy. UDP to a destination the proxy covers is refused.
- The proxy's own address must be public. Its port must be one a sandbox may reach. An `https://` proxy's certificate must verify against the public roots.
- `runtime networks upstream-proxy get` reads the setting, and `remove` removes it. In Python, it is `runtime.networks.upstream_proxy`. The API is `PUT`, `GET` and `DELETE /v1/networks/upstream-proxy`. The MCP tool is `runtime_networks_upstream_proxy`, with `set`, `get` and `remove`. The CLI command and the SDK methods were added in `withruntime` 0.7.0.

## Root inside the sandbox

The sandbox user has passwordless `sudo`. Root inside the guest controls the guest and nothing else. CPU, memory, disk, network rules, time limits and billing are enforced on the host.

## Lifetimes and storage

A stopped sandbox is not a separately promised backup. Export important results before you stop it.

## Browser-approved agent connections

**Connect an agent without copying a key.** Run the [CLI login](./cli), check the request code and agent name, then approve **Connect agent**.

- The browser uses your existing session when possible.
- An owner, admin or developer of the account can approve a new connection. A person who belongs to several accounts chooses which one on the same page.
- The request expires after 15 minutes. Do not approve unsolicited connection links.
- The page shows the name the requesting computer gives itself. It also shows the city and country where Runtime saw the request come from. The computer sets its own name. So treat the name as a hint, and match the code.

`runtime keys create` asks for an API key the same way. Use it on a CI runner or anywhere else with no browser:

- The page shows the key's name, its access, its daily limit, and that it lasts until revoked. An owner, admin or developer approves **Create key**.
- A billing member, an agent and an existing key cannot approve one.
- Whoever started the request receives the key. So approve only a request you started yourself.
- The key is sealed to that terminal. It is printed there once. Runtime keeps only a hash of it.
- If the command stops before the key arrives, the request is cancelled. A key that was approved but not yet received is revoked before anyone holds it.

Approval creates a separate agent identity and credential. It does not give the agent your browser session. The credential is encrypted for the initiating CLI when delivered. It is saved outside the project. On Unix, the credential directory is private to its user. The file has owner-only permissions. Software running as your user can read the file. So keep the machine and its backups secure.

Each connection can operate across the account and spend its prepaid balance. So connect only agents you trust. Separate identities let you see which agent did what. They also let you revoke one agent without the others. To cap what one agent may spend, set a daily limit on its row at [API keys](https://withruntime.com/account/keys) after it connects.

The browser reports success after the CLI receives and verifies the credential. Signing out of the browser leaves agent connections active. To revoke a single credential, use **API keys**. Or run `npx withruntime logout` on its machine. If the package is installed, run `runtime logout`. Revocation does not stop running resources. Inspect them, and stop any work you no longer want. Billing follows confirmed resource state, not sign-in state.

## The browser terminal

**The terminal on a sandbox's page acts as the agent that started the sandbox. It never acts as your browser session.** The website holds a key of that agent for you. The key is labelled "Runtime website terminals". The website discards the key's secret as soon as it makes the key. To open a terminal, the page asks the website for a ticket. The API trades the ticket for that key.

- A ticket opens one terminal in one sandbox, for the person who asked for it. It lasts 60 seconds. Its first use spends it, whatever the outcome.
- The page sends it as a WebSocket subprotocol, so it never appears in an address or an access log. Runtime keeps only its SHA-256 hash.
- The API accepts a ticket only from a page on withruntime.com. A ticket offered for another sandbox or from another site is spent and refused.
- When the ticket is used, Runtime checks again that you may still act as that agent. A changed role or a removed member is refused.
- Every call the terminal makes faces the same checks as that agent's API key. To close every browser terminal it holds, revoke "Runtime website terminals" on [API keys](https://withruntime.com/account/keys). The next terminal makes a new key.
- A person can open 30 terminals a minute. Each ticket is recorded with who asked, when, from which site and what became of it. Each record is kept 30 days.

## Single sign-on

**Sign in through your company's identity provider, and require it.** Owners connect Okta, Microsoft Entra ID, Google Workspace or any SAML or OIDC provider at [Single sign-on](https://withruntime.com/account/single-sign-on). It is free on every account. See [single sign-on](./single-sign-on).

- Your provider can sign in only addresses on the email domain you proved with a DNS record. Only one Runtime account can hold a proven domain.
- SAML assertions must be signed. They must be meant for Runtime. They must be within their validity window. They must answer a sign-in that Runtime started. Each is accepted once.
- **Require single sign-on** refuses every other kind of session for your members. Owners stay exempt, so a provider outage cannot lock you out. API keys are separate. Revoke or limit them on [API keys](https://withruntime.com/account/keys).
- SCIM directory sync removes a person as soon as your directory deactivates them. In the same step, it revokes every key they made.

## Identity tokens instead of stored keys

**Give code in a sandbox access to your cloud without a key in it.** A sandbox asks Runtime for a short-lived OIDC token. The token names the sandbox, its organization and its image. The sandbox then trades the token for credentials in your AWS or Google Cloud account. Or it presents the token to your own API. See [identity tokens](./identity-tokens).

- A sandbox can get a token only for itself. It can get one only while it runs. The token is for the audience it names. Tokens last 10 minutes. A sandbox can ask for up to an hour instead.
- The signing keys stay on Runtime's own servers. Only their public halves are published, at `https://withruntime.com/oidc/jwks`.
- Scope your trust policy to your organization's id (`org:<org-id>:*`), or to one image. Then no other Runtime customer's sandbox can assume your role.

## Before production traffic

- Run your real workload on the [free usage](./included-usage), including its package registries, cleanup and recovery.
- Give each agent or application its own key, with a daily limit where it helps.
- Keep outputs you need outside the sandbox.

Anyone can sign up at https://withruntime.com/sign-in.

## Domains, TCP ports, addresses and the tunnel

- **A custom domain is proved by DNS.** Only a TXT record holding the token made for your claim proves that a hostname is yours. A CNAME left pointing at Runtime proves nothing. So nobody can take over a name its owner forgot to clean up. Certificates are requested only for proved names.
- **A TCP port reaches one port of one sandbox.** A private network reaches only your own account's sandboxes. It never reaches another account's sandboxes, Runtime's servers or internal addresses. It never reaches the internet. The WireGuard gateway runs each account's network in its own user-space network stack. So nothing a peer sends reaches the server's own network stack. Rotating or removing a peer's key ends its connections.
- **Runtime's own relays inside a sandbox** (ports 10800, 10802 and 10853) are never reachable from outside. That covers a preview, a domain, a TCP port or the tunnel.
- **A dedicated outbound address is yours alone** while you hold it. After you release it, it rests 30 days before another account can have it.
- **Every connection is logged.** Each log entry has the sandbox, the account and the client's address. It has no contents. So a report can be traced and acted on. Runtime can turn off a domain, a port, a tunnel or everything in an account at once.

## Two-step sign-in

Customer sign-in uses Google, an email link, single sign-on or a passkey. A new account opened by email is confirmed with a six-digit code. The code is typed on the page where it was asked for. It must be entered within ten minutes and within three tries. A link in an email never opens a new account.

New accounts by email are not opened from a data-centre or VPN network. Use Google instead, or write to support. A home network opens at most two new accounts in an hour.

Every address that asks for an email gets the same answer, after the same checks. So the sign-in page does not reveal whether an address has an account.

An address is emailed at most five times an hour. One network can send at most 30 sign-in emails an hour to existing accounts. Requests from a network where the account has signed in within 90 days have their own allowance. So no one else can use up yours.

A code takes at most ten wrong tries a day per address. The tries are counted across every code and browser. After that, for a day, the address's codes stop working. Its email then carries only the one-click link.

A new code cancels the one before it. Codes are stored keyed with a secret. They are compared in constant time.

Directory reviewers use a separate, pre-provisioned demo identity with a password. That login accepts only the configured review identity. It grants no extra permissions. It follows the same second-step requirements.

Turn it on under **Settings → Two-step sign-in**, with a passkey, an authenticator app, or both. Keep the ten backup codes it gives you. From then on, every sign-in asks for the second step before the account opens. That holds whether you sign in with Google, an email link or single sign-on.

- **A passkey** lives in iCloud Keychain, Google Password Manager, 1Password, Windows Hello or a security key. You confirm it with your fingerprint, face or device PIN. It works only on withruntime.com, so a look-alike site cannot phish it. **Sign in with a passkey** on the sign-in page counts as both steps. It needs no email link and no code.
- **An authenticator app** (1Password, Google Authenticator, Authy or any app that shows six-digit codes): scan the QR code and enter the code it shows.

A backup code works once. Use one when your devices are lost. New backup codes replace the old ones whenever you ask. Removing a passkey or the app asks you to confirm it is you first. Removing the last one turns two-step sign-in off.

An owner can require two-step sign-in for everyone in the account. Members who have not set it up do so at their next sign-in. An owner turns on their own two-step sign-in before requiring it. The [audit log](./teams) records turning it on or off, each passkey added or removed, and the requirement. API keys and connected agents are not affected. They do not sign in through a browser. Five wrong codes in a row pause the step for fifteen minutes.

## Report a vulnerability

**Write to security@withruntime.com before you test anything. Write again with what you find.** Testing Runtime's own servers, network or other accounts without agreeing it with us first breaks the [acceptable use policy](/legal/acceptable-use). We may suspend the account.

A report helps most when it includes three things. Include the steps to reproduce the problem. Include the sandbox or request ids involved. Include the time, with its time zone. Please give us a reasonable time to fix a problem before you describe it in public. The same address is in [`/.well-known/security.txt`](https://withruntime.com/.well-known/security.txt).
