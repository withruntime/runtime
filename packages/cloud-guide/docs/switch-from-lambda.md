# Switch from AWS Lambda

Lambda runs a handler per request, for at most 15 minutes, with no state between calls. A Runtime sandbox is a whole Linux machine: it keeps its files, processes and memory between calls, runs as long as you need, and pauses when nothing happens in it.

| Lambda | Runtime |
| --- | --- |
| `CreateFunction` with a package or image | [`POST /v2/sandboxes`](./reference/sandboxes#create-a-sandbox) from a [snapshot](./snapshots) that holds your code |
| `Invoke` | [`POST /v2/sandboxes/{id}:exec`](./reference/sandboxes#exec) |
| Environment variables | [`env`](./reference/sandboxes#execrequest), and [secrets](./secrets) for keys |
| Function URL | [`POST /v2/sandboxes/{id}/previews`](./reference/previews#create-a-preview) |
| `DeleteFunction` | [`DELETE /v2/sandboxes/{id}`](./reference/sandboxes#delete-a-sandbox) |

```bash
api=https://api.withruntime.com/v2
auth="Authorization: Bearer $RUNTIME_API_KEY"
id=$(curl -sf -X POST "$api/sandboxes" -H "$auth" -H "Content-Type: application/json" -d '{}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
trap 'curl -sf -X DELETE "$api/sandboxes/$id" -H "$auth" > /dev/null' EXIT
event='{"orderId": 7, "amount": 1250}'
curl -sf -X POST "$api/sandboxes/$id:exec" -H "$auth" -H "Content-Type: application/json" \
  -d "{\"cmd\": [\"python3\", \"-c\", \"import json, os; e = json.loads(os.environ['EVENT']); print(e['amount'] / 100)\"], \"env\": {\"EVENT\": $(printf '%s' "$event" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}}"
```

Runtime bills the CPU a sandbox uses, $0.03 per active vCPU-hour, and the memory it holds, $0.008 per GiB-hour, while it runs. Scheduled runs are [jobs](./reference/jobs). An HTTP endpoint that starts a copy per request is not on Runtime yet.

## Give this to your agent

Paste this into your coding agent:

> Read https://withruntime.com/docs/switch-from-lambda.md. Move the code this project runs in AWS Lambda for untrusted or long-running work into Runtime sandboxes, on a branch, and run its tests and real job there. Never delete the AWS functions or their roles.
>
> This page as Markdown: https://withruntime.com/docs/switch-from-lambda.md
