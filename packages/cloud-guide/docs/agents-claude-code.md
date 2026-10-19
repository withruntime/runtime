---
launch: agents
---

# Claude Code as an agent

Claude Code runs in a sandbox of its own for each session, with Runtime's
`runtime-agent` MCP server to read words, reply and finish
([Agents](./agents)). Three steps.

## 1. Store a key

For an agent that serves your customers, an Anthropic API key:

```bash no-run
printf %s "$ANTHROPIC_API_KEY" | runtime secrets set ANTHROPIC_API_KEY --host api.anthropic.com
```

For your own team's agents you may use your Claude Pro or Max subscription
instead. On your own computer, run `claude setup-token` and copy the token it
prints, then store it:

```bash no-run
printf %s "$TOKEN" | runtime secrets set CLAUDE_CODE_OAUTH_TOKEN --host api.anthropic.com
```

The sandbox sees a placeholder; the egress proxy puts the token in only on
HTTPS to api.anthropic.com.

## 2. Create the agent

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
await runtime.agents.create({
  name: "fixer",
  definition: {
    ...runtime.agents.templates["claude-code"].definition,
    ...runtime.agents.uses.team.definition,
    instructions: "You fix failing tests in acme/web and open a pull request.",
  },
});
```

```bash no-run
runtime agents create fixer --template claude-code --use team \
  --instructions "You fix failing tests in acme/web and open a pull request."
```

With a subscription token, name it in place of the API key:
`secrets: ["CLAUDE_CODE_OAUTH_TOKEN"]`, or `--secret CLAUDE_CODE_OAUTH_TOKEN`
on the command line (and drop `ANTHROPIC_API_KEY` from the definition).

## 3. Start a session

```bash no-run
runtime agents start fixer "The checkout test fails on main; fix it." --follow
```

The log shows its replies as they come and ends with its result.

## The rule

A subscription is for your own team's agents. An agent that serves your
customers uses an API key: that is Anthropic's terms. An agent whose secrets
name `CLAUDE_CODE_OAUTH_TOKEN` and that answers customers is marked
`subscription_for_customers`. Runtime has no "connect your subscription"
button.
