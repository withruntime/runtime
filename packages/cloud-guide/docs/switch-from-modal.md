# Switch from Modal

| Modal | Runtime |
| --- | --- |
| `modal.Sandbox.create(app=app, image=image)` | [`POST /v2/sandboxes`](./reference/sandboxes#create-a-sandbox), with [`image`](./reference/sandboxes#sandboxcreate) or [`snapshot`](./reference/sandboxes#sandboxcreate) |
| `sb.exec("python", "-c", code)` | [`POST /v2/sandboxes/{id}:exec`](./reference/sandboxes#exec), with [`wait`](./reference/sandboxes#execrequest) false to read output as it comes |
| `sb.open(path, "w")` | [`PUT /v2/sandboxes/{id}/files`](./reference/sandboxes#write) |
| `sb.tunnels()` | [`POST /v2/sandboxes/{id}/previews`](./reference/previews#create-a-preview) |
| `sb.snapshot_filesystem()` | [`POST /v2/sandboxes/{id}:snapshot`](./reference/sandboxes#snapshot) |
| `sb.terminate()` | [`DELETE /v2/sandboxes/{id}`](./reference/sandboxes#delete-a-sandbox) |

```python
from withruntime.generated import Runtime

runtime = Runtime()
sandbox = runtime.sandboxes.create()
try:
    result = runtime.sandboxes.exec(sandbox.id, cmd=["python3", "-c", "import sys; print(sys.version_info[0])"])
    print(result.stdout)  # 3
    assert result.stdout.strip() == "3", result
finally:
    runtime.sandboxes.delete(sandbox.id)
```

Runtime bills the CPU a sandbox uses, $0.03 per busy vCPU-hour, and a paused sandbox pays only for storage, $0.18 per GB-month.

## Give this to your agent

Paste this into your coding agent:

> Read https://withruntime.com/docs/switch-from-modal.md. Replace every Modal Sandbox call in this project with its Runtime call, on a branch, run the project's tests and its real job on Runtime, and fix what fails. Never delete the Modal account or its tokens.
>
> This page as Markdown: https://withruntime.com/docs/switch-from-modal.md
