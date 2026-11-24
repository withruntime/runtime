# Commands and processes

## Run a command to its end

[`POST /v2/sandboxes/{id}:exec`](./reference/sandboxes#exec) takes an [ExecRequest](./reference/sandboxes#execrequest) and returns the [Process](./reference/sandboxes#process) it ran as, with its [`stdout`](./reference/sandboxes#process) and [`stderr`](./reference/sandboxes#process). Runs a command as a process and returns it once it ended, with its output; with wait false, at once, while it runs. A paused sandbox is resumed first. Asked again with the same Idempotency-Key, it runs nothing more: it returns the first run's process, waiting for its end while it runs.

| Field | |
| --- | --- |
| [`cmd`](./reference/sandboxes#execrequest) | The command: text, run by `bash -lc` (`"npm test"`), or a list, the program and its arguments run without a shell (`["npm", "test"]`). |
| [`cwd`](./reference/sandboxes#execrequest) | The directory it runs in; the user's home when omitted. |
| [`env`](./reference/sandboxes#execrequest) | Environment variables to add. |
| [`stdin`](./reference/sandboxes#execrequest) | Bytes sent to its standard input. |
| [`timeoutSeconds`](./reference/sandboxes#execrequest) | Seconds it may run before it is stopped (`1.5` for 1,500 ms); it runs to its end when omitted or 0. |

For pipes, `&&` or shell variables, run the command through a shell: `["bash", "-c", "cd /tmp && ls | wc -l"]`. Keep untrusted input out of the shell's text: pass it in `env` or `stdin`.

```python
import base64
from withruntime.generated import Runtime

runtime = Runtime()
sandbox = runtime.sandboxes.create()
try:
    words = base64.b64encode(b"one two three\n").decode()
    result = runtime.sandboxes.exec(sandbox.id, cmd=["wc", "-w"], stdin=words)
    print(result.stdout.strip())  # 3
    assert result.stdout.strip() == "3", result
finally:
    runtime.sandboxes.delete(sandbox.id)
```

## Start a process

[`POST /v2/sandboxes/{id}:exec`](./reference/sandboxes#exec) with [`wait`](./reference/sandboxes#execrequest) false starts a program and returns its [Process](./reference/sandboxes#process) at once, while it runs. Use it for servers, watchers and interpreters.

- [`GET /v2/sandboxes/{id}/processes/{process}/output`](./reference/sandboxes#processoutput) reads its output from a byte cursor. [`waitSeconds`](./reference/sandboxes#processoutput): Seconds to wait for output past the cursor or its exit, at most 8.
- [`POST /v2/sandboxes/{id}/processes/{process}:write`](./reference/sandboxes#writeprocess) sends it input, when it was started with [`stdinOpen`](./reference/sandboxes#execrequest).
- [`POST /v2/sandboxes/{id}/processes/{process}:signal`](./reference/sandboxes#signalprocess) sends it a signal, such as `SIGTERM`.
- Each output read returns the process too: its [`state`](./reference/sandboxes#process), and its [`exitCode`](./reference/sandboxes#process) once it ended.

```ts
import { Runtime } from "withruntime";

const runtime = new Runtime();
const sandbox = await runtime.sandboxes.create({});
try {
  const p = await runtime.sandboxes.exec(sandbox.id, { cmd: "for i in 1 2 3; do echo line $i; done", wait: false });
  let cursor = 0;
  let text = "";
  for (let reads = 0; reads < 10; reads++) {
    const out = await runtime.sandboxes.processOutput(sandbox.id, p.id, { cursor, waitSeconds: 2 });
    for (const chunk of out.chunks) text += chunk.text;
    cursor = out.nextCursor;
    if (out.process && out.process.state !== "running") break;
  }
  console.log(text);
  if (!text.includes("line 3")) throw new Error(text);
} finally {
  await runtime.sandboxes.delete(sandbox.id);
}
```

## Give this to your agent

Paste this into your coding agent:

> Read https://withruntime.com/docs/commands.md. In this project, run short commands with exec and servers or interactive programs as processes, and make sure every process is stopped or its machine deleted when the work ends.
>
> This page as Markdown: https://withruntime.com/docs/commands.md
