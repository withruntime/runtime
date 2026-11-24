# Run an agent's code

An agent that writes code needs a place to run it that can't reach your machine. Give each agent session one sandbox: the model's code runs there, and files and installed packages stay between steps.

## The loop

Each step writes the model's code to a file, runs it with [`POST /v2/sandboxes/{id}:exec`](./reference/sandboxes#exec) and returns the result to the model. A command that fails returns a result with a non-zero `exitCode` and its `stderr`, so the model can read the error and try again.

```ts
import { Runtime } from "withruntime";

const runtime = new Runtime();

// Stand-ins for what your model writes: a first attempt with a bug, then the fix.
const attempts = ["rows = [i * i for i in range(5)]\nprint(total)\n", "rows = [i * i for i in range(5)]\nprint(sum(rows))\n"];

const sandbox = await runtime.sandboxes.create({ labels: { session: "example" } });
try {
  for (const [step, code] of attempts.entries()) {
    const path = `/tmp/step${step}.py`;
    await runtime.sandboxes.write(sandbox.id, new TextEncoder().encode(code), { path });
    const result = await runtime.sandboxes.exec(sandbox.id, { cmd: ["python3", path], timeoutSeconds: 30 });
    // Return this to the model as the tool's result.
    const feedback = { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, state: result.state };
    console.log(step, JSON.stringify(feedback));
    if (result.exitCode === 0) break;
  }
} finally {
  await runtime.sandboxes.delete(sandbox.id);
}
```

```python
from withruntime.generated import Runtime

runtime = Runtime()
attempts = ["print(total)\n", "print(sum(i * i for i in range(5)))\n"]

sandbox = runtime.sandboxes.create(labels={"session": "example"})
try:
    for step, code in enumerate(attempts):
        path = f"/tmp/step{step}.py"
        runtime.sandboxes.write(sandbox.id, code.encode(), path=path)
        result = runtime.sandboxes.exec(sandbox.id, cmd=["python3", path], timeout_seconds=30)
        print(step, result.exit_code, result.stdout or result.stderr.splitlines()[-1])
        if result.exit_code == 0:
            break
finally:
    runtime.sandboxes.delete(sandbox.id)
```

## What to return to the model

Return [`exitCode`](./reference/sandboxes#process), [`stdout`](./reference/sandboxes#process) and [`stderr`](./reference/sandboxes#process). Two more fields say when the output is not the whole story:

- [`state`](./reference/sandboxes#process): `timed_out` when it was still running at its timeout and was stopped. Set the limit with [`timeoutSeconds`](./reference/sandboxes#execrequest): Seconds it may run before it is stopped (`1.5` for 1,500 ms); it runs to its end when omitted or 0.
- [`stdoutTruncated`](./reference/sandboxes#process) and [`stderrTruncated`](./reference/sandboxes#process): stdout holds only part of what it wrote (its first 1 MiB). Have the model write large output to a file and read the part it needs.

## Long-running and interactive code

[`POST /v2/sandboxes/{id}:exec`](./reference/sandboxes#exec) runs a command to its end. For a server, a watcher or an interpreter the model keeps talking to, start it with [`POST /v2/sandboxes/{id}:exec`](./reference/sandboxes#exec) and [`wait`](./reference/sandboxes#execrequest) false, send it input with [`POST /v2/sandboxes/{id}/processes/{process}:write`](./reference/sandboxes#writeprocess) and read its output with [`GET /v2/sandboxes/{id}/processes/{process}/output`](./reference/sandboxes#processoutput). See [commands and processes](./commands).

## One sandbox per session

- Create the sandbox when the session starts, and delete it when the session ends. Label it ([`labels`](./reference/sandboxes#sandboxcreate)) with the session's ID, so you can find and delete sandboxes a crashed worker left behind with [`GET /v2/sandboxes`](./reference/sandboxes#list-sandboxes).
- Give it a name ([`name`](./reference/sandboxes#sandboxcreate)) and set [`getOrCreate`](./reference/sandboxes#sandboxcreate) to reuse the session's sandbox after a restart: With a name: the machine of that name when there is one, else a new one.
- Between steps, a sandbox with nothing happening pauses by itself and resumes on the next call. See [pause and resume](./pause-and-resume).
- To start many sessions from the same prepared state, prepare one sandbox and fork it with [`POST /v2/sandboxes/{id}:fork`](./reference/sandboxes#fork). See [snapshots and forks](./snapshots).

## Limit what the code can reach

The model's code runs as root inside its own kernel, never on your servers. To control what it can reach on the network, set the sandbox's network rules with [`PUT /v2/sandboxes/{id}/network`](./reference/sandboxes#setnetwork) ([networking](./networking)). To let it call an API without seeing the key, store the key as a [secret](./secrets).

## Give this to your agent

Paste this into your coding agent:

> Read https://withruntime.com/docs/agent-loop.md. Add a code-execution tool to this project's agent that runs each piece of model-written code in one Runtime sandbox per session, returns stdout, stderr and the exit code to the model, and deletes the sandbox when the session ends.
>
> This page as Markdown: https://withruntime.com/docs/agent-loop.md
