# Switch from Daytona

| Daytona | Runtime |
| --- | --- |
| `daytona.create()` | [`POST /v2/sandboxes`](./reference/sandboxes#create-a-sandbox) |
| `sandbox.process.executeCommand(cmd)` | [`POST /v2/sandboxes/{id}:exec`](./reference/sandboxes#exec) |
| `sandbox.process.createSession()`, `executeSessionCommand()` | [`POST /v2/sandboxes/{id}:exec`](./reference/sandboxes#exec) with [`wait`](./reference/sandboxes#execrequest) false, [`POST /v2/sandboxes/{id}/processes/{process}:write`](./reference/sandboxes#writeprocess), [`GET /v2/sandboxes/{id}/processes/{process}/output`](./reference/sandboxes#processoutput) |
| `sandbox.fs.uploadFile()`, `downloadFile()` | [`PUT /v2/sandboxes/{id}/files`](./reference/sandboxes#write), [`GET /v2/sandboxes/{id}/files`](./reference/sandboxes#read) |
| `sandbox.getPreviewLink(port)` | [`POST /v2/sandboxes/{id}/previews`](./reference/previews#create-a-preview) |
| `sandbox.stop()`, `sandbox.start()` | [`POST /v2/sandboxes/{id}:pause`](./reference/sandboxes#pause), [`POST /v2/sandboxes/{id}:resume`](./reference/sandboxes#resume): memory and processes are kept |
| `sandbox.delete()` | [`DELETE /v2/sandboxes/{id}`](./reference/sandboxes#delete-a-sandbox) |
| Snapshots | [snapshots](./snapshots) |

```python
from withruntime.generated import Runtime

runtime = Runtime()
sandbox = runtime.sandboxes.create()
try:
    response = runtime.sandboxes.exec(sandbox.id, cmd="echo $((6 * 7))")
    print(response.stdout)  # 42
    assert response.exit_code == 0 and response.stdout.strip() == "42", response
finally:
    runtime.sandboxes.delete(sandbox.id)
```

A stopped Daytona sandbox restarts with an empty memory; a paused Runtime sandbox resumes with its programs still running, and costs only its storage, $0.18 per GiB-month, while paused.

## Give this to your agent

Paste this into your coding agent:

> Read https://withruntime.com/docs/switch-from-daytona.md. Replace every Daytona call in this project with its Runtime call, on a branch, remove the Daytona SDK, run the project's tests and its real job on Runtime, and fix what fails. Never delete the Daytona account or its keys.
>
> This page as Markdown: https://withruntime.com/docs/switch-from-daytona.md
