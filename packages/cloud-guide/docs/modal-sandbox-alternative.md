# Runtime vs Modal Sandboxes

Runtime gives each agent sandbox its own microVM kernel and costs **84% less than Modal** for an agent that mostly waits on a model.

**The saving:** 1,000 one-minute runs of a 2 vCPU, 4 GiB sandbox cost **$0.64 on
Runtime and $3.97 on Modal**. At 100,000 runs a month that is $63.89 against
$396.60, **$333 a month saved**.

## Where Runtime is better

- **You pay for the CPU you use.** Modal bills whichever is higher, the CPU a
  sandbox requested or the CPU it used, so a requested core is billed while it
  waits. Runtime measures the CPU your code actually uses, with a floor of a
  twentieth of a vCPU. There is no request to size in advance.
- **Lower rates on both meters.** A vCPU-hour costs $0.025 on Runtime; Modal
  charges $0.1419 per physical core-hour, $0.071 per vCPU. Memory costs $0.0075
  per GiB-hour against Modal's $0.0240. Even with every CPU busy the whole
  time, the example job costs $1.33 on Runtime and $3.97 on Modal.
- **Its own kernel per sandbox.** A microVM puts a hardware virtualization
  boundary between sandboxes. Modal uses gVisor, a user-space kernel that
  intercepts system calls. See [security](./security).
- **Pause with memory, on every sandbox.** A paused Runtime sandbox wakes with
  its processes still running, kept for 1 to 365 days. Forks copy a running
  sandbox, memory and processes included.
- **Nothing to set up first.** One call creates a sandbox, with no app or
  project. Outside Modal, a Modal sandbox needs an App.
- **Your agent sets itself up.** It runs `npx withruntime sandbox run --trial -- ...`,
  shows you a link, and starts once you approve in the browser. No API key goes
  into a prompt or a config file, and the [MCP server](./mcp) reuses the same
  connection.

## At a glance

Modal's figures come from its public pricing and documentation, checked
23 September 2026.

|                | Runtime                                                  | Modal Sandboxes                                           |
| -------------- | -------------------------------------------------------- | --------------------------------------------------------- |
| Isolation      | Firecracker microVM, own kernel                          | gVisor, a user-space kernel that intercepts system calls  |
| CPU billing    | $0.025 per vCPU-hour of measured CPU, with a small floor | $0.1419 per physical core-hour (2 vCPUs), request or use  |
| Memory billing | $0.0075 per reserved GiB-hour                            | $0.0240 per GiB-hour, request or use                      |
| Plan fee       | None; prepaid credit from $10                            | Starter $0 with $30 a month of compute; Team $250 a month |
| Free start     | 100 sandbox hours, no card                               | $30 of compute a month on Starter                         |
| Session length | Leases of up to an hour, extended as often as needed     | Up to 24 hours; snapshots carry state beyond that         |
| Setup          | One call; no app or project                              | A Modal App is needed outside Modal                       |

## Cost for the same job

Take 1,000 runs of a sandbox with 2 vCPUs (one physical core on Modal) and
4 GiB. Each run lasts 60 seconds and keeps the CPU busy for 20 CPU-seconds: an
agent that spends most of its time waiting for a model.

```
Runtime  CPU    1,000 × 20 s / 3,600 × $0.025      = $0.14
         Memory 1,000 × 60 s / 3,600 × 4 × $0.0075 = $0.50
         Total                                        $0.64

Modal    CPU    1,000 × 60 s × 1 core × $0.00003942 = $2.37
         Memory 1,000 × 60 s × 4 × $0.00000667      = $1.60
         Total                                        $3.97
```

- **Saving:** 84%, or $3.33 per 1,000 runs.
- **Per month:** at 100,000 runs, $63.89 on Runtime against $396.60 on Modal.
- **Busier work:** with both CPUs busy for the whole minute, $1.33 on
  Runtime against $3.97 on Modal. At this size, Runtime is cheaper however busy the
  sandbox is.

A smaller request lowers Modal's figure, but it also caps what the sandbox can
use when it needs more. Plan fees, storage, network, taxes and free credits are
left out of both. See [pricing](./pricing) for Runtime's terms.

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

Checked 23 September 2026.

- [Modal pricing](https://modal.com/pricing)
- [Modal resources and billing](https://modal.com/docs/guide/resources)
- [Modal Sandboxes](https://modal.com/docs/guide/sandbox)
- [Modal security](https://modal.com/docs/guide/security)
- Runtime [pricing](./pricing), [security](./security) and [products](./products)
