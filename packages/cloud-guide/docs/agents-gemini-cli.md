---
launch: agents
---

# Gemini CLI as an agent

Google's Gemini CLI runs in its own sandbox for each session. It uses Runtime's
`runtime-agent` MCP server to read input, reply and finish
([Agents](./agents)). Three steps.

## 1. Store a key, or log in once

For an agent that serves your customers, a Gemini API key:

```bash no-run
printf %s "$GEMINI_API_KEY" | runtime secrets set GEMINI_API_KEY --host generativelanguage.googleapis.com
```

For your own team's agents you may sign in with your Google account instead.
Sign in once inside a sandbox, then save it. Every session starts from that
snapshot, signed in:

```bash no-run
runtime sandboxes create --name gemini-login
runtime sandboxes shell gemini-login
#   in the sandbox:  npx -y @google/gemini-cli   (choose Sign in with Google)
runtime sandboxes snapshot gemini-login      # prints the snapshot's id
```

The sign-in is kept in `~/.gemini`, which a volume can hold instead.

## 2. Create the agent

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
await runtime.agents.create({
  name: "docs-writer",
  definition: {
    ...runtime.agents.templates["gemini-cli"].definition,
    ...runtime.agents.uses.team.definition,
    instructions: "You keep acme/web's README in step with its code.",
  },
});
```

```bash no-run
runtime agents create docs-writer --template gemini-cli --use team \
  --instructions "You keep acme/web's README in step with its code."
```

With the signed-in snapshot, add `--snapshot <snapshotId>` (`from: {snapshot}`).

## 3. Start a session

```bash no-run
runtime agents start docs-writer "Bring the README up to date." --follow
```

## The rule

A subscription is for your own team's agents. An agent that serves your
customers uses an API key: that is Google's terms. Runtime has no "connect
your subscription" button. You sign in by hand, as above.
