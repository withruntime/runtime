# Limits

Your plan sets how much runs at once. [`GET /v2/usage`](./reference/usage#get-a-usage) returns your account's limits as they apply now, with its credit and charges.

| Limit | Pro | Growth | Scale |
| --- | --- | --- | --- |
| vCPUs in one machine | 8 | 16 | 32 |
| Memory in one machine (GiB) | 32 | 64 | 96 |
| vCPUs running at once | 100 | 250 | 500 |
| Memory running at once (GiB) | 200 | 500 | 1024 |
| New machines a second | 20 | 50 | 100 |
| Disk, all machines (GiB) | 500 | 2048 | 5120 |

During the trial, at most 5 new machines start each second. Enterprise sets its own limits. Every limit is in the [pricing reference](./reference/pricing).

## When a limit is reached

A create past a limit is refused with an error that names the limit. Pausing or deleting machines frees their vCPUs and memory. The SDKs retry an answer that names its wait; see [errors and retries](./errors).

## Give this to your agent

Paste this into your coding agent:

> Read https://withruntime.com/docs/limits.md. Check this project never asks for a machine larger than its plan allows or runs more at once than its limit, and that it handles a refusal by waiting or queueing rather than failing the user's task.
>
> This page as Markdown: https://withruntime.com/docs/limits.md
