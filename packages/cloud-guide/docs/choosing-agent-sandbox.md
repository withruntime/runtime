# How to choose a sandbox for AI agents

An agent sandbox is an isolated computer where an AI agent can run programs, install dependencies and work with files.

The right one completes your real jobs safely, reliably and at the lowest total
cost. This page gives the checks that decide it, and where Runtime stands on
each.

## Where Runtime stands out

- **It bills the CPU your agent uses.** Most agents spend most of their time
  waiting on a model. Runtime charges measured CPU at {{cpu-rate}} per vCPU-hour, with
  a floor of {{cpu-floor-share}}, and {{memory-rate}} per GiB-hour of memory.
- **Idle time bills only storage.** A sandbox pauses itself after
  {{idle-pause}} with nothing happening in it and wakes on the next request,
  running its next command {{wake}} later with its memory and processes intact.
- **It costs {{saving-range}} less** than {{rival-count}} other sandbox providers on an agent
  job that mostly waits ([the comparison](#compared-with-a-specific-provider)).
- **Every sandbox is a Firecracker microVM** with its own kernel, on dedicated
  servers Runtime operates.
- **Pause keeps memory.** A paused sandbox wakes with its processes still
  running, kept for 1 to 365 days. Forks copy a running sandbox, memory
  included.
- **An uptime promise.** {{uptime-promise}} API uptime a month for paid accounts, and
  {{uptime-credit}} of a short month's charges back as credit automatically
  ([Uptime Promise](/legal/sla)).
- **The agent sets itself up.** It asks for access, you approve once in the
  browser, and no key goes into a prompt or a project file.
- **Built for agents that retry and spend.** Idempotency keys on every write,
  read-only keys, and a daily spending limit per key.
- **Free to try.** {{trial-hours}} sandbox hours, no card, then prepaid credit from {{topup-min}} with
  no plan fee.

## Start with the workload

Write down one representative task. For example: install a repository's pinned
dependencies, run its test suite, make one change, and export the test report.

Record the language version, CPU and memory needs, network destinations, files
to keep, expected duration and acceptable failure rate.

| Requirement             | What to verify                                                | Runtime                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Isolated code execution | Boundary between guest, host and other tenants                | A Firecracker microVM with its own kernel for every sandbox                                                                                                    |
| Agent integration       | Actual remote execution, structured results, file round trip  | API, CLI, Python, JavaScript and MCP; an OpenAI Agents SDK sandbox client and ready tools for ten agent frameworks                                             |
| Easy authentication     | Connection without secrets in prompts or project files        | Browser-approved CLI connection; local MCP reuses it                                                                                                           |
| Outbound network        | Your package registries and service destinations work         | Every port on paid accounts, 80 and 443 on the trial; per-sandbox rules; secrets the sandbox never sees                                                        |
| Public app hosting      | Reachability, ingress auth and abuse controls                 | Previews: an HTTPS address per port, private by default                                                                                                        |
| Pause and restoration   | Files and memory survive; expiry and failed wake are explicit | Files, memory and processes kept 1–365 days; a failed wake says so                                                                                             |
| Custom environments     | Dependencies installed once, reused on every start            | Custom images from a recipe, any public or private image, or a Dockerfile; volumes                                                                             |
| Predictable cost        | CPU, memory, idle time, storage, retries and fees             | Pauses itself after {{idle-pause}} idle; measured CPU with a floor, reserved memory, separately quoted paused storage, {{outbound-allowance}} out a month free |
| Spending control        | Limits an agent cannot raise itself                           | Read-only keys and a daily spending limit per key, set only by a person                                                                                        |
| Team access             | Roles for people, and a record of who changed what            | Single sign-on (SAML, OIDC) and SCIM free; owner, admin, developer and billing roles; an audit log kept at least 400 days                                      |
| Reliability             | A published uptime figure, and what you get when it is missed | {{uptime-promise}} a month for paid accounts, {{uptime-credit}} back automatically; a status page checked from outside                                         |

For exact terms, read [security](./security), [pricing](./pricing),
[trial access](./trial), and the [API reference](./api).

## Measure completed jobs

Run the same inputs, dependency versions and output checks on every candidate.
Separate cold starts from warm or resumed runs, and run enough repetitions to
show slow runs and failures. Record:

- Time from request to an executable environment.
- Dependency setup, task execution and artifact export time.
- Median and 95th-percentile end-to-end completion time.
- Successful, failed and retried jobs, including exhausted capacity.
- CPU-seconds, allocated memory, running duration and retained storage.
- Total charge divided by successful jobs, including failed attempts.

State hardware, region, concurrency, dates, SDK versions, CPU guarantees and
pricing assumptions. A shared CPU ceiling is not a reserved physical core, so
compare like with like.

## Exercise the failures you will have to handle

Try a lost create response, an execution timeout, a nonzero exit code, a refused
network destination, an expired lease, and unavailable capacity on wake.

- Retrying the same operation should not create duplicate work or charges.
- Revoking one agent's credential should stop its access without breaking
  another agent's connection.
- For a pause test, write a file and keep a small in-memory value, pause,
  restore, then verify both. A clean boot is not proof that memory came back.

## Where Runtime fits best

Runtime fits coding agents, test execution, file processing and multi-step jobs
on Linux. Its measured CPU saves the most on workloads that wait on model or
network responses.

A running sandbox still pays its CPU floor and reserved memory, and paused
storage is billed separately. Inbound traffic is free, and each account's first
{{outbound-allowance}} out a month is free, then {{outbound-rate}} per GB. Sandboxes run Linux on CPUs, in
one US region today; see [products](./products) for everything available.

## Compared with a specific provider

The same job on each provider: 1,000 runs of a 2 vCPU, 4 GiB sandbox, 60
seconds each, 20 CPU-seconds of work. Rival rates were checked
{{rivals-checked}}; each provider's page gives its date.

| Provider                                                 |      Cost for 1,000 runs |              Runtime saves |
| -------------------------------------------------------- | -----------------------: | -------------------------: |
| **Runtime**                                              |     **{{cost:runtime}}** |                          — |
| [Northflank](./northflank-alternative)                   |      {{cost:northflank}} |      {{saving:northflank}} |
| [Cloudflare Sandbox](./cloudflare-sandbox-alternative)   |      {{cost:cloudflare}} |      {{saving:cloudflare}} |
| [Fly Machines](./fly-alternative)                        |    {{cost:fly-machines}} |    {{saving:fly-machines}} |
| [Prime Sandboxes](./prime-sandboxes-alternative)         |           {{cost:prime}} |           {{saving:prime}} |
| [Morph](./morph-alternative)                             |           {{cost:morph}} |           {{saving:morph}} |
| [Vercel Sandbox](./vercel-sandbox-alternative)           |          {{cost:vercel}} |          {{saving:vercel}} |
| [Freestyle](./freestyle-alternative)                     |       {{cost:freestyle}} |       {{saving:freestyle}} |
| [CodeSandbox](./codesandbox-alternative)                 |     {{cost:codesandbox}} |     {{saving:codesandbox}} |
| [E2B](./e2b-alternative)                                 |             {{cost:e2b}} |             {{saving:e2b}} |
| [Daytona](./daytona-alternative)                         |         {{cost:daytona}} |         {{saving:daytona}} |
| [Blaxel](./blaxel-alternative)                           |          {{cost:blaxel}} |          {{saving:blaxel}} |
| [Fly Sprites](./fly-alternative)                         |     {{cost:fly-sprites}} |     {{saving:fly-sprites}} |
| [Modal Sandboxes](./modal-sandbox-alternative)           |           {{cost:modal}} |           {{saving:modal}} |
| [AWS Lambda MicroVMs](./aws-lambda-microvms-alternative) | {{cost:lambda-microvms}} | {{saving:lambda-microvms}} |
| [Runloop](./runloop-alternative)                         |         {{cost:runloop}} |         {{saving:runloop}} |

Each page has the working, a side-by-side table, and how to switch. The saving
is largest for agents that wait; for a job that keeps every CPU busy the whole
time, Northflank's allocated rate is lower than Runtime's.

## Switch with one prompt

Give your coding agent the one instruction in [migration](./migrate). It
replaces the old provider's calls on a branch, tests them on the free trial, and
tells you what you save each month. Your old code stays on the main branch until
you merge. Code written for E2B, Daytona, Vercel Sandbox or Blaxel runs after
changing one import. Moving from E2B, Daytona, Vercel Sandbox, Modal,
Cloudflare, Fly or Blaxel, your first top-up is matched, up to {{switching-max}}
([switching credit](./pricing#switching-credit)). For a new project, start with
[getting started](./start).
