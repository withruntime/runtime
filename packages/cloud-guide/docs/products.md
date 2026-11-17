# Products

Every product is a Linux machine with its own kernel, disk and network: a Firecracker microVM. They share one API, so a call you learn on one works on all of them. Each product starts at its own defaults, runs its own program, and serves its own port. Any field of [SandboxCreate](./reference/sandboxes#sandboxcreate) overrides a default.

| Product | What it is | vCPUs | Memory | Disk | Pauses when idle |
| --- | --- | --- | --- | --- | --- |
| [Sandboxes](./sandboxes) | A Linux machine with its own kernel. | 2 | 4 GB | 4 GB | After 300 seconds |
| [Functions](./functions) | A machine that answers HTTP with a handler in /app/index.ts. | 1 | 1 GB | 4 GB | After 60 seconds |
| [Apps](./apps) | A machine that keeps a web app in /app running on port 8080. | 2 | 2 GB | 4 GB | Never |
| [Sites](./sites) | A machine that serves the static files in /site on port 8080. | 1 | 1 GB | 4 GB | After 60 seconds |
| [CI/CD](./ci) | A machine that runs a repository's checks to their end. | 4 | 16 GB | 16 GB | After 300 seconds |
| [Browsers](./browsers) | A machine running headless Chromium. | 2 | 4 GB | 4 GB | After 60 seconds |
| [Desktops](./desktops) | A machine running a Linux desktop with Chromium. | 2 | 4 GB | 4 GB | After 300 seconds |
| [Notebooks](./notebooks) | A machine running JupyterLab on port 8888 over /workspace. | 2 | 4 GB | 4 GB | After 300 seconds |
| [Dev environments](./workspaces) | A development environment. | 4 | 8 GB | 16 GB | After 30 minutes |
| [Containers](./containers) | A machine that runs one OCI image from any registry under Docker on its own network. | 1 | 1 GB | 4 GB | After 300 seconds |
| [Builds](./images) | The machine an image's build runs on. | 2 | 4 GB | 16 GB | Never |

Each machine is billed for the CPU it uses, $0.03 per busy vCPU-hour, and the memory it holds, $0.008 per GB-hour. A paused machine is billed only for what it stores.

[Jobs](./jobs) run a command on a schedule, each run on a fresh machine. [Images](./images) are the disks machines boot.

## What every product does

- Run commands and programs: [commands and processes](./commands).
- Read and write its files: [files](./files).
- Share a port at an HTTPS address: [previews](./web-app).
- Pause it and resume it where it was: [pause and resume](./pause-and-resume).
- Copy it, running, with its memory: [snapshots and forks](./snapshots).
- Control where it connects: [networking](./networking).

## Give this to your agent

Paste this into your coding agent:

> Read https://withruntime.com/docs/products.md. Tell me which Runtime products this project should use for each part of it (its agent's code, its web app, its checks, its scheduled tasks), and why.
>
> This page as Markdown: https://withruntime.com/docs/products.md
