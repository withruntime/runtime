---
launch: agents
---

# Agents

An agent runs a harness (Claude Code, Codex, Gemini CLI, or your own code on
the Claude Agent SDK or the OpenAI Agents SDK) in a sandbox of its own for
each session, on your own model key. Your app drives its sessions through
the API and webhooks. Each conversation or task is a **session**: its own
Linux machine, an ordered log of what was said and done, and nothing shared
with any other session.

Use one agent for either of two things:

- **Your customers.** Your product calls the API for each of your customers,
  with a key of your own (`key: "customer:42"`), and each gets a session of
  their own. A waiting session's sandbox pauses after 10 seconds and pays only
  its storage until the next message; a paused sandbox is running again 76 ms after it is asked to wake
  (median, timed on Runtime's servers on 28 September 2026: [speed](./speed)).
- **Your team.** An agent works on your code from a Slack thread or a GitHub
  pull request, in a 4 vCPU, 8 GiB machine, and ends with what it made.

Pick a harness: [Claude Code](./agents-claude-code), [Codex](./agents-codex),
[Gemini CLI](./agents-gemini-cli), [Claude Agent SDK](./agents-claude-agent-sdk)
or [OpenAI Agents SDK](./agents-openai-agents-sdk). Each page is three steps.

## Make one

An agent is a name and a definition. A template gives the harness's command
and the secret its key is stored as; a use gives the size and bounds:

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
await runtime.agents.create({
  name: "helper",
  definition: {
    ...runtime.agents.templates["claude-code"].definition,
    ...runtime.agents.uses.support.definition,
    instructions: "You answer questions about Acme's billing. Be brief and kind.",
  },
});
```

```bash no-run
runtime agents templates                     # the harnesses and the uses
runtime agents create helper --template claude-code --use support \
  --instructions "You answer questions about Acme's billing. Be brief and kind."
```

| Use       | For                                      | Size          | Pauses after | Sessions at once | Triggers      |
| --------- | ---------------------------------------- | ------------- | ------------ | ---------------- | ------------- |
| `support` | your customers, one session per customer | 1 vCPU, 1 GiB | 10 s         | 1,000            | API, webhook  |
| `team`    | your team's code                         | 4 vCPU, 8 GiB | 60 s         | 10               | Slack, GitHub |

The definition takes, besides `command`: `from` (an image of yours, or a
snapshot), `vcpu`, `memoryMiB`, `instructions` (up to 64 KiB), `env`,
`secrets`, `mcp` (MCP servers it may reach), `volumes`, `idlePauseSeconds`,
`maxSessionSeconds` and `maxConcurrent`. Without a use, an agent's sandbox
has 4 vCPU and 8 GiB. A change is a new version; sessions already running
keep theirs.

## Model keys, any provider

Your model key is an egress secret: the sandbox sees a placeholder, and
Runtime's egress proxy puts the key in only on HTTPS to the host you name, so
neither the harness nor anything it runs can read it. Name the secret in the
agent's `secrets`.

| Provider                       | Secret                                      | Host                                |
| ------------------------------ | ------------------------------------------- | ----------------------------------- |
| Anthropic                      | `ANTHROPIC_API_KEY`                         | `api.anthropic.com`                 |
| OpenAI                         | `OPENAI_API_KEY`                            | `api.openai.com`                    |
| Google                         | `GEMINI_API_KEY`                            | `generativelanguage.googleapis.com` |
| OpenRouter                     | `OPENROUTER_API_KEY`                        | `openrouter.ai`                     |
| Any OpenAI-compatible endpoint | `OPENAI_API_KEY`, and `env.OPENAI_BASE_URL` | that endpoint's host                |

```bash no-run
printf %s "$ANTHROPIC_API_KEY" | runtime secrets set ANTHROPIC_API_KEY --host api.anthropic.com
```

## Your own subscription, for your own team

Runtime has no "connect your subscription" button and does not offer one. You
can log a harness in to your own Claude, ChatGPT or Google subscription by
hand: Claude Code takes a token you make on your own computer
([Claude Code](./agents-claude-code)); Codex and Gemini CLI log in once inside
a sandbox you then save as a snapshot or keep on a volume, and the agent
starts every session `from` that snapshot ([Codex](./agents-codex),
[Gemini CLI](./agents-gemini-cli)).

**The rule:** a subscription is for your own team's agents. An agent that
serves your customers uses an API key: that is the providers' terms. An agent
whose secrets name `CLAUDE_CODE_OAUTH_TOKEN` and that is set up for your
customers (the `support` use) carries the warning
`subscription_for_customers`, in the API and the console.

## Sessions

Start a session with its first words. Words with the same `key` join its open
session instead: one session per Slack thread, pull request or customer of
yours, keyed as your app chooses.

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const session = await runtime.agents.start("helper", {
  input: "How do I change my card?",
  key: "customer:42",
});
for await (const event of session.events()) {
  if (event.kind === "reply") console.log(event.body.text);
  if (event.kind === "ask") await session.send("Visa ending 4242");
}
const ended = await session.wait();
console.log(ended.state, ended.result);
```

```bash no-run
runtime agents start helper "How do I change my card?" --key customer:42 --follow
runtime agents sessions --agent helper
runtime agents stop <sessionId>
runtime agents sessions delete <sessionId>   # an ended one, and its log
```

A session is `queued`, `running`, `waiting` (its harness waits for words; its
sandbox is paused), then `done`, `failed` or `stopped`. Its log holds
`input` and `answer` (words in), `reply`, `ask`, `status`, `result`, `error`
and `note` (words out), each numbered; `events` follows it, woken the moment
an event is written, and ends with the session. Over HTTP,
`GET /v1/agents/sessions/{id}/events?after=<seq>&wait=30` long-polls, and
`Accept: text/event-stream` streams it.

## Subagents

A session's harness can start a child session to work beside it: its own
sandbox, of the same agent or another of yours. A tree goes at most 3 levels
below its first session and holds at most 20 open children. Stopping a session
stops every open session under it, and a child's end is a `child` event in its
parent's log, so a parent waiting for it wakes.

## Budgets

Every agent has two caps, on by default: `maxSessionDollars`, what one session
and every session under it may cost (default $5), and `maxDayDollars`, what the
agent may spend in a UTC day (default $100). A session at its cap is stopped
and ends `stopped` with the reason `budget`; an agent at its day cap starts
nothing new until the next day. Starting a session, or a child under one, past
its cap is answered `409` with the code `budget_reached`. Set either cap in the
definition.

## Watching and replaying

Each session's page in the console shows it live as it runs: what it was told,
what it said and did, and what it has cost so far. An ended session replays
from its first event. The same log is `events` in the SDK, from any `after`.

## History

A session's history (its log) and its files are plain storage. They count
toward your plan's included storage and are kept until you delete them; each
session says its size. Deleting a session takes its words and those of every
session under it, once all have ended. Its record of what it ran and spent
stays, so the caps still count it.

## Triggers

Besides the API, a trigger starts or feeds an agent's sessions:

| Kind       | Config                                                                     | A session per         |
| ---------- | -------------------------------------------------------------------------- | --------------------- |
| `slack`    | `{team, channel}`, once Runtime's Slack app is installed in your workspace | thread                |
| `github`   | `{installation, repository}`, once Runtime's GitHub App is installed       | pull request or issue |
| `schedule` | `{cron, timezone?, input}`                                                 | run                   |
| `webhook`  | `{}`                                                                       | call, or its key      |

Adding a webhook answers its `secret` once, and never again: each of its
calls carries it, and one without it is refused. Pausing a trigger refuses
its events, saying why, and holds nothing else.

```bash no-run
runtime agents triggers add helper --kind webhook --config '{}'
runtime agents triggers pause <triggerId> --why "Moving to the new help center"
```

## Inside the sandbox

Each session's harness is given `RUNTIME_AGENT_SESSION`,
`RUNTIME_AGENT_REPORT_TOKEN` and `RUNTIME_API`, the agent's instructions in
`~/.runtime-agent/start.md`, and an MCP server, `runtime-agent`
(`~/.runtime-agent/mcp.json`), with five tools: `reply`, `ask`, `status`,
`wait` (for the next words) and `done`. The report token reaches only that
session's log; no API key enters the sandbox.

## Price

An agent's sandbox is billed as it runs, the same way as any sandbox; history
is storage. No session fee, no seats. Your model provider bills your key. The
rates are in [pricing](./pricing#agents), and an account's limits in
[limits](./limits#what-an-account-holds-and-runs).
