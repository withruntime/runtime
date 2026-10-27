# Runtime vs Modal Sandboxes

Runtime gives each agent sandbox its own microVM kernel. It costs **{{saving:modal}} less than Modal** for an agent that mostly waits on a model.

**Switch in one line.** Your Modal Sandbox code keeps working. Change the
import and set `RUNTIME_API_KEY`.

```ts no-run
import { ModalClient } from "withruntime/modal"; // was: from "modal"
```

```python no-run
from withruntime import modal  # was: import modal
```

Modal's own sandbox examples run on it unchanged, except the features
[listed below](#what-the-drop-in-refuses). Those stop with an error naming
Runtime's alternative.

**The saving:** 1,000 one-minute runs of a 2 vCPU, 4 GiB sandbox cost **{{cost:runtime}} on
Runtime and {{cost:modal}} on Modal**. At 100,000 runs a month that is {{cost:runtime:100000}} against
{{cost:modal:100000}}, **{{=$0 less:modal:100000}} a month saved**.

Comparing more than two? [Modal Sandbox alternatives](/compare/modal-alternatives) ranks the other providers by the cost of the same job.

## Where Runtime is better

- **You pay for the CPU you use.** Modal bills whichever is higher, the CPU a
  sandbox requested or the CPU it used. So a requested core is billed while it
  waits. Runtime measures the CPU your code actually uses, with a floor of {{cpu-floor-share}}. There is no request to size in advance.
- **Waiting costs storage, not compute.** A Runtime sandbox left idle for {{idle-pause}} pauses by
  itself and keeps its memory. It then pays {{paused-storage-rate}} per GB (10⁹ bytes) a month
  until a request wakes it.
- **An uptime promise that pays itself.** Paid accounts are promised
  {{uptime-promise}} API uptime each month. A month below it returns {{uptime-credit}} of that
  month's charges as credit. No claim is needed ([Uptime Promise](/legal/sla)).
- **Lower rates on both meters.** A vCPU-hour costs {{cpu-rate}} on Runtime. Modal
  charges {{=$4 rate:modal:cpu * 2}} per physical core-hour, {{=$3 rate:modal:cpu}} per vCPU. Memory costs {{memory-rate}}
  per GiB-hour against Modal's {{=$4 rate:modal:memory}}. Even with every CPU busy the whole
  time, the example job costs {{cost:runtime:busy}} on Runtime and {{cost:modal}} on Modal.
- **Its own kernel per sandbox.** A microVM puts a hardware virtualization
  boundary between sandboxes. Modal uses gVisor, a user-space kernel that
  intercepts system calls. See [security](./security).
- **Pause with memory, on every sandbox.** A paused Runtime sandbox wakes with
  its processes still running, kept while you have credit. Forks copy a running
  sandbox, memory and processes included.
- **Nothing to set up first.** One call creates a sandbox, with no app or
  project. Outside Modal, a Modal sandbox needs an App.
- **Teams at no extra charge.** Single sign-on over SAML or OIDC (Okta,
  Microsoft Entra ID, Google Workspace), SCIM, roles and an audit log come with
  every account ([single sign-on](./single-sign-on)). Modal puts SAML single sign-on and
  audit logs on its Enterprise plan.
- **Custom domains and a fixed address without a plan.** A paid account serves
  a sandbox port at your own hostname. It sends from a dedicated outbound
  address for {{address-month}} a month ([networking](./networking)). Modal's custom
  domains and static IP proxy come with its Team plan, {{term:modal:team}} a month.
- **Keys the sandbox never sees.** Store an API key once. The sandbox holds a
  placeholder. Runtime's proxy adds the value only to HTTPS requests to the
  hosts you name. A prompt injection has nothing to leak ([security](./security)).
- **Your credit matched.** Credit you add within {{welcome-days}} days of signing up is matched, up to {{welcome-max}} in total
  ([welcome match](./pricing#welcome-match)).
- **Your agent sets itself up.** It runs `npx withruntime sandboxes run -- ...`,
  shows you a link, and starts once you approve in the browser. No API key goes
  into a prompt or a config file. The [MCP server](./mcp) reuses the same
  connection.

**Also included:** a code interpreter, network allow and deny lists, custom
images, volumes backed up daily, private previews, a Linux desktop, metrics,
webhooks, OpenTelemetry export, S3, R2 and GCS bucket mounts, MCP servers from a
catalog and identity tokens for AWS and Google Cloud. Paid accounts add TCP
ports and WireGuard private networks. See [products](./products).

## At a glance

Modal's figures come from its public pricing and documentation, checked
{{checked:modal}}.

|                | Runtime                                                                     | Modal Sandboxes                                                                                                        |
| -------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Isolation      | Firecracker microVM, own kernel                                             | gVisor, a user-space kernel that intercepts system calls                                                               |
| CPU billing    | {{cpu-rate}} per vCPU-hour of measured CPU, with a small floor              | {{=$4 rate:modal:cpu * 2}} per physical core-hour (2 vCPUs), request or use                                            |
| Memory billing | {{memory-rate}} per reserved GiB-hour                                       | {{=$4 rate:modal:memory}} per GiB-hour, request or use                                                                 |
| Plan fee       | None; prepaid credit from {{topup-min}}                                     | Starter {{term:modal:starter}} with {{term:modal:starter-credit}} a month of compute; Team {{term:modal:team}} a month |
| Free start     | {{included-machine}} in the first 30 days, no card                          | {{term:modal:starter-credit}} of compute a month on Starter                                                            |
| Session length | No time limit: runs while it works, pauses itself after {{idle-pause}} idle | Up to 24 hours; snapshots carry state beyond that                                                                      |
| Setup          | One call; no app or project                                                 | A Modal App is needed outside Modal                                                                                    |

## Cost for the same job

Take 1,000 runs of a sandbox with 2 vCPUs (one physical core on Modal) and
4 GiB. Each run lasts 60 seconds and keeps the CPU busy for 20 CPU-seconds. This
is an agent that spends most of its time waiting for a model.

```
Runtime  CPU    1,000 × 20 s / 3,600 × {{cpu-rate}}      = {{part:runtime:cpu}}
         Memory 1,000 × 60 s / 3,600 × 4 × {{memory-rate}} = {{part:runtime:memory}}
         Total                                        {{cost:runtime}}

Modal    CPU    1,000 × 60 s × 1 core × {{=$8 rate:modal:cpu * 2 / 3600}} = {{part:modal:cpu}}
         Memory 1,000 × 60 s × 4 × {{=$8 rate:modal:memory / 3600}}      = {{part:modal:memory}}
         Total                                        {{cost:modal}}
```

- **Saving:** {{saving:modal}}, or {{less:modal}} per 1,000 runs.
- **Per month:** at 100,000 runs, {{cost:runtime:100000}} on Runtime against {{cost:modal:100000}} on Modal.
- **Busier work:** with both CPUs busy for the whole minute, {{cost:runtime:busy}} on
  Runtime against {{cost:modal:busy}} on Modal. At this size, Runtime is cheaper however busy the
  sandbox is.

A smaller request lowers Modal's figure. It also caps what the sandbox can
use when it needs more. Plan fees, storage, network, taxes and free credits are
left out of both. On Runtime, inbound traffic is free. Each account's first
{{outbound-allowance}} out a month is free. After that, outbound traffic costs
{{outbound-rate}} per GB (10⁹ bytes). See [pricing](./pricing) for
Runtime's terms.

## How to switch

Give your coding agent the one instruction in [migration](./migrate). It
replaces the Modal calls on a branch, tests them on the free usage, and tells
you what you save each month. Your old code stays on the main branch until you
merge.

### Change one import

Runtime's SDK runs code written for Modal's Sandboxes, as this page describes
from version 0.25.0 (Python 0.23.0), for Modal's JavaScript SDK 0.11.1 and
Python SDK 1.6.2. Change the import and set `RUNTIME_API_KEY`:

```ts no-run
import { ModalClient } from "withruntime/modal"; // was: from "modal"
```

```python no-run
from withruntime import modal  # was: import modal
```

A Modal token is never needed or sent. Apps group sandboxes by name. Images
build from the same registry tags and Dockerfile steps. Commands run as
root, as in a Modal container. A `timeout` (`timeoutMs`) ends the sandbox. An
`idle_timeout` (`idleTimeoutMs`) pauses it with its memory kept, waking at
the next command, file call or tunnel request. Outbound domain and CIDR
allowlists, tunnels, tags, names, file calls and watches, filesystem snapshots,
and in Python memory snapshots work as Modal documents them. Each of Modal's
sandbox examples was run against Runtime on 18 October 2026, in both
languages.

### What the drop-in refuses

These stop with a `CompatibilityError` before anything is created. The
message names what to use on Runtime:

- **GPUs.** Runtime runs on CPUs.
- **Modal Classes, Dicts, Queues, web endpoints and Functions without a
  schedule.** Run the code in a sandbox. A Function with a `schedule` deploys
  as a [job](./jobs#modal).
- **Named secrets** (`Secret.from_name`, `secrets.fromName`). Runtime's
  [secrets](./security#secrets-sandboxes-never-see) are used without being seen. Store one with
  `runtime.secrets.set`, or pass values with `Secret.from_dict`
  (`secrets.fromObject`).
- **Secrets in image build steps.** A Runtime build keeps no secret. Use the
  secret when the sandbox runs instead.
- **Volumes made on first use** (`create_if_missing`, ephemeral volumes) and
  volume sub-paths. A Runtime [volume](./storage#attaching-a-volume) has a fixed size. Create it
  first, then mount all of it.
- **Sidecars.** Start a second sandbox and join both to a private network.
- **Connect tokens and custom domains** on a tunnel. Share the port as a
  private preview instead.
- **Directory snapshots and exit snapshots.** Take a filesystem snapshot
  before `terminate()`, then start new sandboxes from it.
- **Proxies and inbound CIDR allowlists.** Use Runtime's static outbound
  addresses and network rules.

`COMPATIBILITY.md` in each package lists every mapping.

### Or port the calls

Modal:

```python check
import modal
app = modal.App.lookup("my-app", create_if_missing=True)
sb = modal.Sandbox.create(app=app)
process = sb.exec("python3", "-c", "print(sum([125, 250, 375]))")
print(process.stdout.read())
sb.terminate()
```

Runtime:

```python
from withruntime import Sandbox
with Sandbox.create() as box:
    box.files.write("/workspace/invoice.py", "print(sum([125, 250, 375]))\n")
    print(box.exec("python3 /workspace/invoice.py", check=True).stdout)
```

## When Modal may fit better

- **GPUs.** Modal sandboxes can use GPUs. Runtime runs on CPUs.
- **A wider platform today.** Functions and web endpoints sit beside sandboxes
  in the same account and SDK. Runtime has [scheduled jobs](./jobs) beside its
  sandboxes, but not functions or endpoints.

## Sources

Checked 23 September 2026; plan features checked 27 September 2026.

- [Modal pricing](https://modal.com/pricing)
- [Modal resources and billing](https://modal.com/docs/guide/resources)
- [Modal Sandboxes](https://modal.com/docs/guide/sandbox)
- [Modal security](https://modal.com/docs/guide/security)
- Runtime [pricing](./pricing), [security](./security) and [products](./products)
