# Sandbox lifecycle

A sandbox's [`state`](./reference/sandboxes#sandbox) is one of `starting`, `running`, `paused`, `deleted`, `error`. Every change of state is one of the moves below: a call you make, or Runtime's own when the machine starts, stops or is lost.

| From | To | By |
| --- | --- | --- |
| (new) | `starting` | [`create`](./reference/sandboxes#create-a-sandbox) |
| `starting` | `running` | Runtime |
| `starting` | `error` | Runtime |
| `running`, `starting` | `paused` | [`pause`](./reference/sandboxes#pause) |
| `running` | `paused` | Runtime |
| `paused` | `starting` | [`resume`](./reference/sandboxes#resume) |
| `running` | `starting` | Runtime |
| `starting`, `running`, `paused`, `error` | `deleted` | [`delete`](./reference/sandboxes#delete-a-sandbox) |

## What to do in each state

- [`POST /v2/sandboxes/{id}:exec`](./reference/sandboxes#exec) resumes a `paused` sandbox first, so a paused sandbox needs no resume call before a command.
- [`POST /v2/sandboxes/{id}:pause`](./reference/sandboxes#pause) keeps the sandbox's disk and stops its CPU and memory billing. [`POST /v2/sandboxes/{id}:resume`](./reference/sandboxes#resume) starts it again. See [pause and resume](./pause-and-resume).
- [`DELETE /v2/sandboxes/{id}`](./reference/sandboxes#delete-a-sandbox) ends a sandbox in any state. Delete every sandbox you no longer need: a paused sandbox still pays for its storage.
- A `error` sandbox failed to start and can only be deleted. Create a new one, from a [snapshot](./snapshots) if you keep its state.
- A `starting` sandbox is being made, resumed, or started again on another server after its own stopped answering; wait for `running`.
- A `deleted` sandbox is in a delete's answer alone: a get of a deleted sandbox is 404, and no list shows one.

## No time limit

A sandbox has no time limit: it runs until it pauses or is deleted. [`idlePauseSeconds`](./reference/sandboxes#sandbox): Seconds with nothing happening before it pauses; 0 never.

## Spending limits

[`maxCost`](./reference/sandboxes#sandboxcreate): The most it may cost in all, in US dollars (`"5.00"`): once it has cost that it pauses, and starts again only once its maxCost is raised (`update`); what a key's per-request and spend caps count. When omitted under a key with a per-request or spend cap, the most that key's caps leave.

## Give this to your agent

Paste this into your coding agent:

> Read https://withruntime.com/docs/lifecycle.md. Check this project's Runtime code handles every sandbox state it can meet, and that every sandbox it creates is deleted on every path, failures included.
>
> This page as Markdown: https://withruntime.com/docs/lifecycle.md
