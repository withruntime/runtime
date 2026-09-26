# Runtime Cloud

Use the `runtime` MCP server when a task needs untrusted or unfamiliar code run,
packages installed, a long job, a clean Linux machine or a web app shared at a
URL. Follow the instructions the server sends when it connects.

- If the only Runtime tool is `runtime_connect`, call it, show the user the link
  and code, and call it again after they approve. Never ask for a key.
- Create sandboxes with `funding: "trial"` unless the user said to spend paid
  credit, check exit codes rather than call success, and stop every sandbox you
  started, confirming `stopped`.
- To move a project from another sandbox provider, call `runtime_docs_read`
  with topic `migrate` and follow it.
