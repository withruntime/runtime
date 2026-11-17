# Pricing

You pay for what your sandboxes use, measured, plus a plan fee that comes back as usage. Every figure on this page comes from the [pricing reference](./reference/pricing), which billing charges from.

## What a sandbox costs

| While it is | You pay for | Price |
| --- | --- | --- |
| Running | CPU it uses | $0.03 per busy vCPU-hour |
| Running | Memory it holds | $0.008 per GB-hour |
| Running | Its disk | $0.10 per GB-month |
| Paused | What it stores | $0.18 per GB-month |
| Any | Traffic it sends out | $0.03 per GB |

- **CPU is billed on use.** A sandbox waiting on a model or a network call uses almost no CPU, and pays almost nothing for it. While it runs, it is billed at least 0.1 vCPU.
- **Memory is billed on what the sandbox holds**, its [`memoryGB`](./reference/sandboxes#sandboxcreate), while it runs.
- **A paused sandbox pays only for storage.** See [pause and resume](./pause-and-resume).
- **A deleted sandbox costs nothing.**
- **No traffic out is free.** Every GB a sandbox sends out is billed at $0.03 per GB, from the plan's included usage like every other charge. Traffic in is free.

So the cost of a sandbox is about: busy vCPUs × hours × $0.03, plus GB of memory × hours × $0.008.

## Plans

| | Pro | Growth | Scale |
| --- | --- | --- | --- |
| Monthly fee | $25 | $99 | $499 |
| Usage included each month | $25 | $110 | $575 |
| vCPUs running at once | 100 | 250 | 500 |
| vCPUs in one sandbox | 8 | 16 | 32 |

The fee is returned as usage: on Pro, the first $25 of usage each month is included. Enterprise is yearly, with custom limits. Every plan's limits are in the [pricing reference](./reference/pricing).

## Trial

Signing up takes no card. Your first sandbox asks for one, and the 7-day Pro trial with $5 of usage starts then.

## Control what you spend

- [`maxCost`](./reference/sandboxes#sandboxcreate): The most it may cost in all, in US dollars (`"5.00"`): once it has cost that it pauses, and starts again only once its maxCost is raised (`update`); what a key's per-request and spend caps count. When omitted under a key with a per-request or spend cap, the most that key's caps leave.
- [`GET /v2/usage`](./reference/usage#get-a-usage) returns the month's usage so far.

## Give this to your agent

Paste this into your coding agent:

> Read https://withruntime.com/docs/pricing.md and https://withruntime.com/docs/reference/pricing.md, then estimate this project's monthly Runtime bill from how many sandboxes it runs, their size, how long they run and how busy their CPU is. Show the arithmetic.
>
> This page as Markdown: https://withruntime.com/docs/pricing.md
