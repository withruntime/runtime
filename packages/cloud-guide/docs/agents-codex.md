---
launch: agents
---

# Codex as an agent

OpenAI's Codex CLI runs in a sandbox of its own for each session, with
Runtime's `runtime-agent` MCP server to read words, reply and finish
([Agents](./agents)). Three steps.

## 1. Store a key, or log in once

For an agent that serves your customers, an OpenAI API key:

```bash no-run
printf %s "$OPENAI_API_KEY" | runtime secrets set OPENAI_API_KEY --host api.openai.com
```

For your own team's agents you may use your ChatGPT subscription instead. Log
Codex in once inside a sandbox, then save it; every session starts from that
snapshot, logged in:

```bash no-run
runtime sandboxes create --name codex-login
runtime sandboxes shell codex-login
#   in the sandbox:  npx -y @openai/codex login --device-auth
runtime sandboxes snapshot codex-login       # prints the snapshot's id
```

Keep `~/.codex` on a volume instead if you would rather log in again without
a new snapshot.

## 2. Create the agent

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
await runtime.agents.create({
  name: "reviewer",
  definition: {
    ...runtime.agents.templates["codex"].definition,
    ...runtime.agents.uses.team.definition,
    instructions: "You review pull requests in acme/web and comment on risks.",
  },
});
```

```bash no-run
runtime agents create reviewer --template codex --use team \
  --instructions "You review pull requests in acme/web and comment on risks."
```

With the logged-in snapshot, add `--snapshot <snapshotId>` (`from: {snapshot}`).

## 3. Start a session

```bash no-run
runtime agents start reviewer "Review the open pull request #42." --follow
```

## The rule

A subscription is for your own team's agents. An agent that serves your
customers uses an API key: that is OpenAI's terms. Runtime has no "connect
your subscription" button; logging in is yours to do, by hand, as above.
