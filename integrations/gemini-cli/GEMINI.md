# Runtime Cloud

Use the `runtime` MCP server when a task needs untrusted or unfamiliar code run,
packages installed, a long job, a clean Linux machine or a web app shared at a
URL. Follow the instructions the server sends when it connects.

- If the Runtime tools are missing or answer `unauthorized`, run
  `npx -y withruntime login` in a terminal, show the user the link and code it
  prints, and restart the MCP server after they approve. Never ask for a key.
- Create sandboxes with `runtime_sandboxes_create`, check `exitCode` from
  `runtime_sandboxes_exec` rather than call success, and delete every sandbox
  you started with `runtime_sandboxes_delete`, confirming `state` is `deleted`.
- To move a project from another sandbox provider, read
  https://withruntime.com/llms.txt and the Switch guide it lists for that
  provider, and follow it.
