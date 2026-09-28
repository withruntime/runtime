# Runtime vs Modal Sandboxes

Runtime gives each agent sandbox its own microVM kernel and costs **{{saving:modal}} less than Modal** for an agent that mostly waits on a model.

**The saving:** 1,000 one-minute runs of a 2 vCPU, 4 GiB sandbox cost **{{cost:runtime}} on
Runtime and {{cost:modal}} on Modal**. At 100,000 runs a month that is {{cost:runtime:100000}} against
{{cost:modal:100000}}, **{{=$0 less:modal:100000}} a month saved**.

## Where Runtime is better

- **You pay for the CPU you use.** Modal bills whichever is higher, the CPU a
  sandbox requested or the CPU it used, so a requested core is billed while it
  waits. Runtime measures the CPU your code actually uses, with a floor of {{cpu-floor-share}}. There is no request to size in advance.
- **Waiting costs storage, not compute.** Left idle for {{idle-pause}}, a Runtime
  sandbox pauses by itself with its memory kept, then pays {{paused-storage-rate}} per GB a
  month until a request wakes it; the next command runs {{wake}} after that.
- **An uptime promise that pays itself.** Paid accounts are promised
  {{uptime-promise}} API uptime each month; a month below it returns {{uptime-credit}} of that
  month's charges as credit, with no claim to file ([Uptime Promise](/legal/sla)).
- **Lower rates on both meters.** A vCPU-hour costs {{cpu-rate}} on Runtime; Modal
  charges {{=$4 rate:modal:cpu * 2}} per physical core-hour, {{=$3 rate:modal:cpu}} per vCPU. Memory costs {{memory-rate}}
  per GiB-hour against Modal's {{=$4 rate:modal:memory}}. Even with every CPU busy the whole
  time, the example job costs {{cost:runtime:busy}} on Runtime and {{cost:modal}} on Modal.
- **Its own kernel per sandbox.** A microVM puts a hardware virtualization
  boundary between sandboxes. Modal uses gVisor, a user-space kernel that
  intercepts system calls. See [security](./security).
- **Pause with memory, on every sandbox.** A paused Runtime sandbox wakes with
  its processes still running, kept for 1 to 365 days. Forks copy a running
  sandbox, memory and processes included.
- **Nothing to set up first.** One call creates a sandbox, with no app or
  project. Outside Modal, a Modal sandbox needs an App.
- **Teams at no extra charge.** Single sign-on over SAML or OIDC (Okta,
  Microsoft Entra ID, Google Workspace), SCIM, roles and an audit log come with
  every account ([single sign-on](./single-sign-on)). Modal puts SAML single sign-on and
  audit logs on its Enterprise plan.
- **Custom domains and a fixed address without a plan.** A paid account serves
  a sandbox port at your own hostname, and sends from a dedicated outbound
  address for {{address-month}} a month ([networking](./networking)). Modal's custom
  domains and static IP proxy come with its Team plan, {{term:modal:team}} a month.
- **Keys the sandbox never sees.** Store an API key once; the sandbox holds a
  placeholder and Runtime's proxy adds the value only to HTTPS requests to the
  hosts you name, so a prompt injection has nothing to leak ([security](./security)).
- **Switching credit.** Run `runtime switch --from modal` before your first
  top-up and that top-up is matched, up to {{switching-max}}
  ([switching credit](./pricing#switching-credit)).
- **Your agent sets itself up.** It runs `npx withruntime sandbox run --trial -- ...`,
  shows you a link, and starts once you approve in the browser. No API key goes
  into a prompt or a config file, and the [MCP server](./mcp) reuses the same
  connection.

**Also included:** a code interpreter, network allow and deny lists, custom
images, volumes backed up daily, private previews, a Linux desktop, metrics,
webhooks, OpenTelemetry export, S3, R2 and GCS bucket mounts, MCP servers from a
catalog and identity tokens for AWS and Google Cloud. Paid accounts add TCP
ports and WireGuard private networks. See [products](./products).

## At a glance

Modal's figures come from its public pricing and documentation, checked
{{checked:modal}}.

|                | Runtime                                                                                                                         | Modal Sandboxes                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Isolation      | Firecracker microVM, own kernel                                                                                                 | gVisor, a user-space kernel that intercepts system calls                                                               |
| CPU billing    | {{cpu-rate}} per vCPU-hour of measured CPU, with a small floor                                                                  | {{=$4 rate:modal:cpu * 2}} per physical core-hour (2 vCPUs), request or use                                            |
| Memory billing | {{memory-rate}} per reserved GiB-hour                                                                                           | {{=$4 rate:modal:memory}} per GiB-hour, request or use                                                                 |
| Plan fee       | None; prepaid credit from {{topup-min}}                                                                                         | Starter {{term:modal:starter}} with {{term:modal:starter-credit}} a month of compute; Team {{term:modal:team}} a month |
| Free start     | {{trial-hours}} sandbox hours, no card                                                                                          | {{term:modal:starter-credit}} of compute a month on Starter                                                            |
| Session length | Leases of up to an hour, extended as often as needed, or persistent while credit lasts; pauses itself after {{idle-pause}} idle | Up to 24 hours; snapshots carry state beyond that                                                                      |
| Setup          | One call; no app or project                                                                                                     | A Modal App is needed outside Modal                                                                                    |

## Cost for the same job

Take 1,000 runs of a sandbox with 2 vCPUs (one physical core on Modal) and
4 GiB. Each run lasts 60 seconds and keeps the CPU busy for 20 CPU-seconds: an
agent that spends most of its time waiting for a model.

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

A smaller request lowers Modal's figure, but it also caps what the sandbox can
use when it needs more. Plan fees, storage, network, taxes and free credits are
left out of both. On Runtime, inbound traffic is free, and each account's first
{{outbound-allowance}} out a month is free, then {{outbound-rate}} per GB. See [pricing](./pricing) for
Runtime's terms.

## How to switch

Give your coding agent the one instruction in [migration](./migrate). It
replaces the Modal calls on a branch, tests them on the free trial, and tells
you what you save each month. Your old code stays on the main branch until you
merge.

Modal:

```python check
import modal
app = modal.App.lookup("my-app", create_if_missing=True)
sb = modal.Sandbox.create(app=app)
process = sb.exec("python3", "-c", "print(6 * 7)")
print(process.stdout.read())
sb.terminate()
```

Runtime:

```python
from withruntime import Sandbox
with Sandbox.create(funding="trial") as box:
    print(box.exec("python3 -c 'print(6 * 7)'", check=True).stdout)
```

## When Modal may fit better

- **GPUs.** Modal sandboxes can use GPUs. Runtime runs on CPUs.
- **A wider platform today.** Functions, web endpoints and scheduled jobs sit
  beside sandboxes in the same account and SDK.

## Sources

Checked 23 September 2026; plan features checked 27 September 2026.

- [Modal pricing](https://modal.com/pricing)
- [Modal resources and billing](https://modal.com/docs/guide/resources)
- [Modal Sandboxes](https://modal.com/docs/guide/sandbox)
- [Modal security](https://modal.com/docs/guide/security)
- Runtime [pricing](./pricing), [security](./security) and [products](./products)
