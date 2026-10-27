---
launch: agents
---

# Set up agents from your repo

Put one file in your repo, then run one command. `runtime.yml` names your
agents. `runtime agents deploy` makes your account match the file. Run it by
hand, or from CI on every merge.

## 1. Write the file

```bash no-run
runtime agents init --template claude-code
```

That writes a starter `runtime.yml` (or adds an `agents:` section to the
one you have). Edit it to set what you want:

```yaml
agents:
  fixer:
    template: claude-code # the harness: its command and its model key's secret
    use: team # 4 vCPU, 8 GiB; or support: 1 vCPU, 1 GiB, 1,000 at once
    instructionsFile: AGENTS.md # read from the repo; or instructions: "..."
    maxSessionDollars: 5 # a session stops at $5 (the default)
    maxDayDollars: 100 # and the agent starts nothing new past $100 a day (the default)
    triggers:
      - kind: schedule
        config:
          { cron: "0 9 * * 1-5", timezone: America/Denver, input: "Fix what failed overnight." }
  helper:
    template: codex
    use: support
    instructions: |
      You answer questions about Acme's billing. Be brief and kind.
```

Each agent takes a `template`. It fills in the agent's command and the secret
its model key is stored as. The templates are `claude-code`, `codex`,
`gemini-cli`, `claude-agent-sdk`, `openai-agents-sdk`, and `review` and `judge`,
the reviewer and rule-checker of [CI/CD agent steps](./ci#agent-steps). An
agent also takes any field of its definition: `command`, `from`, `vcpu`,
`memoryMiB`, `instructions` or `instructionsFile`, `env`, `secrets`, `pool`,
`mcp`, `volumes`, `idlePauseSeconds`, `maxSessionSeconds`, `maxConcurrent`,
`maxSessionDollars`, `maxDayDollars`, `memory`, `model` and `sessionOverrides`
(what a session's start may override: [per-session
overrides](./agents#per-session-overrides)). Your values override the
template's. For example, `secrets: [CLAUDE_CODE_OAUTH_TOKEN]` uses your
subscription's token in place of the API key. Without a size, an agent has 4
vCPU and 8 GiB.

`triggers` lists `{kind, config, rules?}`: `schedule`, `webhook`, `slack` or
`github` ([Agents](./agents)), with [its rules](./agents#rules). Add `paused:
<why>` to hold one. A trigger the file does not name is removed; one whose
rules changed keeps its secret.

A webhook's secret, which each of its calls carries, is never in the file.
The deploy that adds the webhook prints it under that line (`secret
rtat_…`). In `--json` and the SDK's result, it is that change's `secret`. It is
shown only once, so save it then. Lost it? Take the webhook out of the file and
deploy. Then put it back and deploy again: this creates a new webhook with a
new secret.

Store the model key once. The sandbox sees only a placeholder:

```bash no-run
printf %s "$ANTHROPIC_API_KEY" | runtime secrets set ANTHROPIC_API_KEY --host api.anthropic.com
```

## 2. Deploy it

```bash no-run
runtime agents deploy --dry-run   # what it would change, nothing changed
runtime agents deploy
```

Each change is printed on its own line, with the idempotency key it was sent
with:

```
runtime.yml: 2 agents.
create agent fixer (claude-code, 4 vCPU, 8192 MiB)  (key deploy:3f9c…)
add trigger schedule "0 9 * * 1-5" to fixer  (key deploy:a41e…)
create agent helper (codex, 1 vCPU, 1024 MiB)  (key deploy:07bd…)
Done: 3 changes.
```

Run it again and nothing changes. An agent whose definition changed gets a
new version. An agent whose definition did not change keeps its own. If a
deploy stops halfway, run it again. Each change's key ensures nothing is made
twice.

An agent the file no longer names is left alone. `--prune` deletes it, with
its triggers. It deletes only agents that an earlier deploy made. Agents you
made by hand stay. Deleting an agent deletes its [memory](agents.md#memory) for
good, so `--prune` keeps one that still holds memory files and says so. Add
`--prune-memory` to delete it and its files too. Renaming an agent in the file
creates a new agent. The old one, and its memory, stay until you prune it. A
mistake in the file is refused before anything changes. The error names the
line, the agent and the field:

```
runtime.yml:4: agents.fixer.vcpu takes 1, 2, 4, 8 or 16.
```

## 3. From CI

Run the same command with an API key in `RUNTIME_API_KEY`, or call the SDK:

```ts check
import { agents, loadAgentsFile } from "withruntime/agents";

const result = await agents().deploy(loadAgentsFile("runtime.yml"), { dryRun: true });
for (const change of result.changes) console.log(change.text, change.key);
```

An agent working on your repo can do the same through MCP:
`runtime_agents_deploy` takes the file as JSON. Python, Go, Java and Ruby
run the CLI: `npx withruntime agents deploy`.

The file is at most 256 KiB. YAML anchors and aliases (`&name`, `*name`) are
not accepted: write each value out where it is used.

## The rule

A subscription is for your own team's agents. An agent that serves your
customers uses an API key: that is the providers' terms.
