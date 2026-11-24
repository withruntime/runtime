# SDKs and the CLI

Every SDK, the CLI and the MCP tools are generated from the same spec as the API, so each one has every call, with the same names and fields. Each call's page in the [API reference](./reference/overview) shows it in curl, TypeScript, Python, Ruby, the CLI and MCP.

| | Install | Client |
| --- | --- | --- |
| TypeScript and JavaScript | `npm install withruntime` | `new Runtime()` |
| Python | `pip install withruntime` | `Runtime()` |
| Ruby | `gem install withruntime` | `Withruntime::Runtime.new` |
| Go | `go get withruntime.com/go/v2` | `generated.New(generated.Options{})`, from `withruntime.com/go/v2/generated` |
| CLI | `npm install --global withruntime` | `runtime <product> <call>` |

Each client reads `RUNTIME_API_KEY` and, when it is set, `RUNTIME_API_URL`. A call's method is named for it: [`POST /v2/sandboxes/{id}:exec`](./reference/sandboxes#exec) is `runtime.sandboxes.exec` in TypeScript, `runtime.sandboxes.exec` in Python and `runtime sandboxes exec` in the CLI.

## Retries and timeouts

The SDKs retry the answers [errors and retries](./errors) lists, up to 3 times, with the same `Idempotency-Key`, so a retried create never makes a second machine.

## From an agent

An agent can call the same API through MCP. See [MCP](./mcp).

## Give this to your agent

Paste this into your coding agent:

> Read https://withruntime.com/docs/sdks.md. Install the Runtime SDK for this project's language, call it with the key from RUNTIME_API_KEY, and use the reference's example for each call you need.
>
> This page as Markdown: https://withruntime.com/docs/sdks.md
