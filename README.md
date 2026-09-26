# Runtime

The SDKs, CLI, MCP server and agent integrations for
[Runtime](https://withruntime.com): sandboxes for AI agents. Each sandbox is a
Firecracker microVM with its own Linux kernel, started from one call.

```bash
npm install withruntime   # TypeScript SDK, the `runtime` CLI and the MCP server
pip install withruntime   # Python SDK, sync and async
```

```ts
import { Sandbox } from "withruntime";

await using sbx = await Sandbox.create();
const result = await sbx.exec("python3 -c 'print(6 * 7)'");
console.log(result.exitCode, result.stdout);
```

```python
from withruntime import Sandbox

with Sandbox.create() as sbx:
    result = sbx.exec("python3 -c 'print(6 * 7)'")
    print(result.exit_code, result.stdout)
```

The client reads `RUNTIME_API_KEY`, or the connection `npx withruntime login`
saved on this machine. A new account starts on a free trial with no card. The
[quickstart](https://withruntime.com/docs/start) takes it from there.

## What is here

| Path                                                                              | What it is                                                                                                                  |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `packages/cloud-sdk`                                                              | The TypeScript SDK, the `runtime` CLI and the MCP server: [`withruntime`](https://www.npmjs.com/package/withruntime) on npm |
| `sdks/python`                                                                     | The Python SDK: [`withruntime`](https://pypi.org/project/withruntime/) on PyPI                                              |
| `sdks/python/integrations/langchain-withruntime`                                  | LangChain and Deep Agents sandbox backend                                                                                   |
| `sdks/go`, `sdks/java`, `sdks/ruby`                                               | The Go, Java and Ruby SDKs                                                                                                  |
| `integrations/pydantic-ai`, `integrations/google-adk`                             | Pydantic AI and Google ADK integrations                                                                                     |
| `integrations/claude-code`, `codex`, `cursor`, `gemini-cli`, `vscode`, `windsurf` | Skills, rules and MCP settings for coding agents                                                                            |
| `packages/cloud-guide/docs`                                                       | The guides served at [withruntime.com/docs](https://withruntime.com/docs), which the SDK tests check samples against        |

## Documentation

- [Start](https://withruntime.com/docs/start)
- [TypeScript](https://withruntime.com/docs/javascript) and [Python](https://withruntime.com/docs/python)
- [CLI](https://withruntime.com/docs/cli) and [MCP](https://withruntime.com/docs/mcp)
- [Frameworks](https://withruntime.com/docs/frameworks), and moving from
  [E2B](https://withruntime.com/docs/e2b-alternative) or
  [Daytona](https://withruntime.com/docs/daytona-alternative)
- [Pricing](https://withruntime.com/docs/pricing)

## Tests

`bun test` in `packages/cloud-sdk` and `python3 -m unittest discover -s tests`
in `sdks/python` run here as they are. The suites that start Runtime's API
server in-process, including all of the Go, Java and Ruby tests, run in
Runtime's main repository before each release.

## Contributing

Each release copies the SDKs here from Runtime's main repository, so each
commit here is one copy, named after the versions in its source; a copy made
before those versions reach npm and PyPI says so. Issues are welcome. A pull request is
reviewed here and carried into the next release with its author credited.

## License

Apache-2.0. See `LICENSE`.
