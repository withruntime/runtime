# Pricing

You pay for what your machines use, measured, plus a plan fee that comes back as usage. Every figure on this page comes from the [pricing reference](./reference/pricing), which billing charges from.

## What a machine costs

| While it is | You pay for | Price |
| --- | --- | --- |
| Running | CPU it uses | $0.03 per active vCPU-hour |
| Running | Memory it holds | $0.008 per GiB-hour |
| Running | Its disk | $0.10 per GiB-month |
| Paused | What it stores | $0.18 per GiB-month |
| Any | Traffic it sends out | $0.03 per GB |

- **CPU is billed on use.** A machine waiting on a model or a network call uses almost no CPU, and pays almost nothing for it. While it runs, it is billed at least 0.1 vCPU.
- **Memory is billed on what the machine holds**, its [`memoryGB`](./reference/sandboxes#sandboxcreate), while it runs.
- **A paused machine pays only for storage.** See [pause and resume](./pause-and-resume).
- **A deleted machine costs nothing.**
- **No outbound traffic is free.** Every GB a machine sends out is billed at $0.03 per GB, from the plan's included usage like every other charge. Inbound traffic is free.

So the cost of a machine is about: active vCPUs × hours × $0.03, plus GiB of memory × hours × $0.008.

## Plans

| | Pro | Growth | Scale |
| --- | --- | --- | --- |
| Monthly fee | $25 | $99 | $499 |
| Usage included each month | $25 | $110 | $575 |
| vCPUs running at once | 100 | 250 | 500 |
| vCPUs in one machine | 8 | 16 | 32 |
| Custom roles, keys held to one project | None | Yes | Yes |

The fee is returned as usage: on Pro, the first $25 of usage each month is included. Enterprise is yearly, with custom limits. Every plan's limits are in the [pricing reference](./reference/pricing).

## How usage is paid

Usage is paid from your plan's included usage first, then from credit, then by your card. Usage past what the plan includes is charged before the month ends, each time it reaches the next step once the charge before is paid: $50, $100, $250, $500, then every $1,000. The rest is charged with your next plan fee.

## Trial

Signing up takes no card. Creating a machine needs one: until a card is added at [withruntime.com/account/start](https://withruntime.com/account/start), every call that creates or changes a machine, volume or address answers `402` with the error code `card_required`. Adding the card starts the 7-day Pro trial with $5 of usage. A reminder comes on day 5.

## Deals

A deal is credit, or days or months of a plan's fee for free. Redeeming one needs a card on file.

## When you cancel or a charge is unpaid

There is no free plan. When you cancel, or a charge stays unpaid, your machines pause. 30 days after they pause, once that day has ended in every time zone, their data is deleted: disks, snapshots and volumes. An email comes on day 23 and day 29 before it is. Your account and its invoices stay. Adding a card or choosing a plan before then wakes your machines with their data. Credit on the account keeps the data while it lasts; the 30 days start once it is spent.

## Control what you spend

- [`maxCost`](./reference/sandboxes#sandboxcreate): The most it may cost in all, in US dollars (`"5.00"`): once it has cost that it pauses, and starts again only once its maxCost is raised (`update`); what a key's per-request and spend caps count. When omitted under a key with a per-request or spend cap, the most that key's caps leave.
- [`GET /v2/usage`](./reference/usage#get-a-usage) returns the month's usage so far.

## Give this to your agent

Paste this into your coding agent:

> Read https://withruntime.com/docs/pricing.md and https://withruntime.com/docs/reference/pricing.md, then estimate this project's monthly Runtime bill from how many machines it runs, their size, how long they run and how busy their CPU is. Show the arithmetic.
>
> This page as Markdown: https://withruntime.com/docs/pricing.md
