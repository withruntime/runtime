# Runtime for the Vercel AI SDK

Run an AI SDK harness agent (Claude Code, Codex, OpenCode, Pi and the rest) in a Runtime sandbox, or give any AI SDK model call four sandbox tools.

`createRuntimeSandbox()` is a sandbox provider for the AI SDK's `HarnessAgent`,
like `@ai-sdk/sandbox-vercel`. Pass it as the agent's `sandbox` and the harness,
its bootstrap and every command it runs live in a Firecracker microVM with its
own kernel, billed for the CPU it uses. The agent definition does not change.

## Harness agents

```bash no-run
npm install withruntime @ai-sdk/harness @ai-sdk/harness-claude-code
```

```ts no-run
import { HarnessAgent, type HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import { createRuntimeSandbox } from "withruntime/ai-harness";

// harness: claudeCode from @ai-sdk/harness-claude-code, codex, opencode, pi, ...
export async function fixTests(harness: HarnessAgentAdapter) {
  const agent = new HarnessAgent({
    harness,
    sandbox: createRuntimeSandbox({ ports: [4000], create: { funding: "trial" } }),
    instructions: "You are a careful coding assistant.",
  });
  const session = await agent.createSession();
  try {
    const result = await agent.generate({ session, prompt: "Fix the failing test." });
    return result.text;
  } finally {
    await session.destroy();
  }
}
```

The key comes from `RUNTIME_API_KEY` or this machine's `npx withruntime login`,
as for the rest of the SDK. Pass `createRuntimeSandbox({ runtime })` to share a
client, or `{ sandbox }` to run the harness in a sandbox you created and keep.

Bridge harnesses (Claude Code, Codex, OpenCode, Deep Agents) talk to a bridge in
the sandbox over a WebSocket, so give them a port: the agent uses the first one
in `ports`. Host-runtime harnesses such as Pi need none.

## Options

Every option is optional.

| Option              | What it does                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `create`            | How to create each sandbox: `funding`, `region`, `image`, `snapshot`, `vcpu`, memory, disk, time limit, `network` |
| `env`               | Set for every command, under the command's own `env`                                                              |
| `ports`             | Ports shared as Runtime previews; bridge harnesses use the first                                                  |
| `previewVisibility` | `private` (default): the endpoint carries a preview token; `public`: anyone with the address, paid only           |
| `previewTtlSeconds` | How long each endpoint's token lasts, 60 seconds to 7 days; one day by default                                    |
| `commandTimeoutMs`  | The longest a command may run: one hour by default, 24 hours at most                                              |
| `pauseOnStop`       | `session.stop()` pauses the sandbox, so a resumed session wakes the same machine                                  |
| `runtime`           | The client to use                                                                                                 |
| `sandbox`           | A sandbox you created; the provider never stops it                                                                |

## What runs in the sandbox

- **Commands** run under `bash` as the sandbox user, with passwordless `sudo`,
  in the session's working directory under `/workspace`. Output streams, so a
  long log is not cut at the size of one answer. A command past its limit exits 124. `run` also takes `stdin` and `timeoutMs`, and aborting a command ends it
  in the sandbox too.
- **Files** are read and written atomically, with parent directories made for
  you. A file over 1 MiB is written under `/workspace`.
- **Ports** become previews at `runtimehost.com`, private unless you ask. An
  HTTPS endpoint carries its token in the link and in the
  `x-runtime-preview-token` header; a WebSocket endpoint sends it in the header.
- **Network policy.** `allow-all` is the public web, `deny-all` refuses every
  outbound connection, and `custom` reaches only the listed hosts and ranges,
  with `deniedCIDRs` refused. Changes apply at once, to open connections too.
- **Bootstrap.** A harness's setup recipe runs once in each new sandbox before
  its first turn.

## Stop, resume and destroy

With a session id, each sandbox is named `ai-harness-<id>`. `session.destroy()`
stops it. `session.stop()` stops it too, or with `pauseOnStop` pauses it: its
files, memory and processes are kept, billed as paused storage
([pricing](./pricing#paused-storage)), and
`agent.createSession({ sessionId, resumeFrom })` wakes the same machine.

A missing or refused key raises the AI SDK's
`HarnessSandboxAuthenticationError`, so your application can tell configuration
from an outage.

## Tools for `generateText` and agents

Without a harness, `runtimeTools(sbx)` from `withruntime/ai` gives any AI SDK
model the four [framework tools](./frameworks#vercel-ai-sdk): `runtime_exec`,
`runtime_read_file`, `runtime_write_file` and `runtime_list_files`.

```ts
import { generateText, stepCountIs, type LanguageModel } from "ai";
import { Sandbox } from "withruntime";
import { runtimeTools } from "withruntime/ai";

export async function solve(model: LanguageModel, prompt: string) {
  await using sbx = await Sandbox.create();
  const { text } = await generateText({
    model,
    tools: runtimeTools(sbx),
    stopWhen: stepCountIs(20),
    prompt,
  });
  return text;
}
```

It needs the `ai` package, version 5 or later. Mastra agents take the same tools.

## What was verified

- On 25 September 2026 the provider ran under `@ai-sdk/harness` 1.0.124's own
  `HarnessAgent`, driven by a scripted harness adapter so no model was called,
  against a fake of the Runtime API behind the real API router: create, the
  bootstrap recipe, commands with env, stdin, timeouts and abort, files, private
  and public previews, network policy, pause, resume and stop.
- The same scripted agent against real sandboxes, including a WebSocket through
  a private preview as a bridge harness opens one, is written and has not run
  yet. No bridge harness (Claude Code, Codex) has run on Runtime yet.
- On 23 September 2026 `runtimeTools` ran in the AI SDK's own agent loop (AI SDK
  7.0.87) against real trial sandboxes, driven by a scripted model.

Official reference checked 25 September 2026:
[AI SDK HarnessAgent](https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-agent).
