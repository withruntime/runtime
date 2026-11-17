# Sandboxes

A sandbox is a Linux machine of your own: a Firecracker microVM with its own kernel, memory, disk and network address. Code in one sandbox can't see another sandbox or the server it runs on. A sandbox is the right place for code you don't fully trust, such as code an AI model wrote or a customer uploaded.

## What you choose at create

[`POST /v2/sandboxes`](./reference/sandboxes#create-a-sandbox) takes a [SandboxCreate](./reference/sandboxes#sandboxcreate). Every field is optional:

| Field | What it sets |
| --- | --- |
| [`vcpu`](./reference/sandboxes#sandboxcreate) | Its vCPUs. |
| [`memoryGB`](./reference/sandboxes#sandboxcreate) | Its memory in GB (1 GB is 1,024 MiB); a fraction is taken to the MiB (`1.5`). |
| [`diskGB`](./reference/sandboxes#sandboxcreate) | Its disk in GB (1 GB is 1,024 MiB), to the MiB. |
| [`image`](./reference/sandboxes#sandboxcreate) | The image it boots, by name (its newest version), `name:version` or ID; Runtime's default image when omitted. |
| [`snapshot`](./reference/sandboxes#sandboxcreate) | A snapshot it starts as: a copy of it running, at its sizes, in its project, with its secrets. |
| [`name`](./reference/sandboxes#sandboxcreate) | Its name, unique in its project. |
| [`labels`](./reference/sandboxes#sandboxcreate) | Labels to find it by. |
| [`secrets`](./reference/sandboxes#sandboxcreate) | The secrets it may get, by name, at most 64: only those of them whose scope admits it; [] none; every one whose scope admits it when omitted. A name with no secret yet takes effect once that secret is created. Fixed for its life: a fork or a copy of a snapshot keeps it. |
| [`maxCost`](./reference/sandboxes#sandboxcreate) | The most it may cost in all, in US dollars (`"5.00"`): once it has cost that it pauses, and starts again only once its maxCost is raised (`update`); what a key's per-request and spend caps count. When omitted under a key with a per-request or spend cap, the most that key's caps leave. |

On the Pro plan, one sandbox has at most 8 vCPUs and 32 GiB of memory, and the account runs at most 100 vCPUs at once. See [limits](./limits).

## What runs in it

The default image is a Linux system with Python and Node.js. Commands run as the user `runtime` in `/workspace`, with `sudo` and no password. Install anything with the system's package manager, or start from your own [image or snapshot](./snapshots).

- Run commands with [`POST /v2/sandboxes/{id}:exec`](./reference/sandboxes#exec), and long-running programs with it too, with [`wait`](./reference/sandboxes#execrequest) false. See [commands and processes](./commands).
- Read and write files with [`GET /v2/sandboxes/{id}/files`](./reference/sandboxes#read) and [`PUT /v2/sandboxes/{id}/files`](./reference/sandboxes#write). See [files](./files).
- Share a port at an HTTPS address with [`POST /v2/sandboxes/{id}/previews`](./reference/previews#create-a-preview). See [previews](./web-app).

## What it costs

A running sandbox is billed for the CPU it uses, $0.03 per busy vCPU-hour, at least 0.1 vCPU while it runs, and for the memory it holds, $0.008 per GB-hour. Its disk is $0.10 per GB-month while it runs. A paused sandbox is billed only for what it stores, $0.18 per GB-month. See [pricing](./pricing).

## Find your sandboxes

[`GET /v2/sandboxes`](./reference/sandboxes#list-sandboxes) returns the project's sandboxes, newest first. Filter it by state or by label. [`GET /v2/sandboxes/{id}`](./reference/sandboxes#get-a-sandbox) returns one, by ID. A sandbox's [`state`](./reference/sandboxes#sandbox) is one of `starting`, `running`, `paused`, `deleted`, `error`; see [lifecycle](./lifecycle).

## Give this to your agent

Paste this into your coding agent:

> Read https://withruntime.com/docs/sandboxes.md and https://withruntime.com/docs/lifecycle.md, then explain to me how this project should use Runtime sandboxes: one per task or per user, what size, and when each is deleted.
>
> This page as Markdown: https://withruntime.com/docs/sandboxes.md
