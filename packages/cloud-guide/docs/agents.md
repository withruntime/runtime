---
launch: agents
---

# Agents

An agent runs a harness in a sandbox of its own for each session, using your own model key. The harness is Claude Code, Codex, Gemini CLI, or your own code on the Claude Agent SDK or the OpenAI Agents SDK. Your app drives its sessions through the API and webhooks. Each conversation or task is a **session**. A session has its own Linux machine and an ordered log of what was said and done. It shares nothing with any other session.

Use an agent for one of two things:

- **Your customers.** Your product calls the API for each of your customers, with a key of your own (`key: "customer:42"`). Each customer gets a session of their own. A waiting session's sandbox pauses after 10 seconds. It then pays only for its storage until the next message. A paused sandbox is running again 76 ms after it is asked to wake (median, timed on Runtime's servers on 28 September 2026: [speed](./speed)).
- **Your team.** An agent works on your code from a Slack thread or a GitHub pull request. It runs on a 4 vCPU, 8 GiB machine. It ends with what it made.

Choose a harness: [Claude Code](./agents-claude-code), [Codex](./agents-codex), [Gemini CLI](./agents-gemini-cli), [Claude Agent SDK](./agents-claude-agent-sdk) or [OpenAI Agents SDK](./agents-openai-agents-sdk). Each page has three steps.
Code written for Claude Managed Agents runs here with its client's base URL and key changed: [switch from Claude Managed Agents](./switch-from-claude-managed-agents).

## Make one

An agent has a name and a definition. A template sets the harness's command and the secret that holds its key. A use sets the size and bounds:

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

| Use       | For                                      | Size          | Pauses after | Concurrent sessions | Triggers      |
| --------- | ---------------------------------------- | ------------- | ------------ | ------------------- | ------------- |
| `support` | your customers, one session per customer | 1 vCPU, 1 GiB | 10 s         | 1,000               | API, webhook  |
| `team`    | your team's code                         | 4 vCPU, 8 GiB | 60 s         | 10                  | Slack, GitHub |

Besides `command`, the definition takes these fields. `from` takes an image of yours, a snapshot, or `{"repo": "owner/name"}`. The repo is a GitHub repository connected to CI/CD. With a repo, each session starts as a copy of its warm snapshot. The repository is checked out at `/workspace/repo`, at the last passing commit on its production branch, with its setup run. The harness runs there. The other fields are `vcpu`, `memoryMiB`, `instructions` (up to 64 KiB), `env`, `secrets`, `mcp` (MCP servers it may reach), `volumes`, `network`, `idlePauseSeconds`, `maxSessionSeconds`, `maxConcurrent` and `permissions` (which tool calls wait for a person: see [permissions](#permissions)). `network` limits where each session's sandbox may connect: `{"internet": true, "allow": ["pypi.org"]}` lets it reach only the hosts listed, enforced by the sandbox's network rules from its first packet. Without a use, an agent's sandbox has 4 vCPU and 8 GiB. A change creates a new version. Sessions already running keep the version they started with.

Or keep your agents in your repo. A `runtime.yml` file names them. One command makes your account match the file.

```yaml
agents:
  fixer:
    template: claude-code
    use: team
    instructionsFile: AGENTS.md
    triggers:
      - kind: schedule
        config: { cron: "0 9 * * 1-5", input: "Fix what failed overnight." }
```

```bash no-run
runtime agents init fixer --template claude-code --use team   # writes the section
runtime agents deploy --dry-run                               # says what it would change
runtime agents deploy
```

For the whole file, CI and the MCP tool, see [set up agents from your repo](./agents-setup).

## Model keys, any provider

Your model key is an egress secret. The sandbox sees only a placeholder. Runtime's egress proxy adds the key only on HTTPS, and only to the host you name. So neither the harness nor anything it runs can read the key. Name the secret in the agent's `secrets`.

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

Runtime has no "connect your subscription" button, and it does not offer one. You can log a harness in to your own Claude, ChatGPT or Google subscription by hand. Claude Code takes a token that you make on your own computer ([Claude Code](./agents-claude-code)). Codex and Gemini CLI log in once, inside a sandbox. You then save that sandbox as a snapshot, or keep it on a volume. The agent starts every session `from` that snapshot ([Codex](./agents-codex), [Gemini CLI](./agents-gemini-cli)).

**The rule:** a subscription is for your own team's agents. An agent that serves your customers uses an API key. That is the providers' terms. An agent whose secrets name `CLAUDE_CODE_OAUTH_TOKEN`, and that is set up for your customers (the `support` use), carries the warning `subscription_for_customers`. The warning appears in the API and the console.

## A pool of Claude accounts

`pool` names 1 to 16 Claude accounts. Each one is an egress secret. It is either a subscription token (`claude setup-token`, for your own team's agents), or, for a name holding `API_KEY`, an API key. Each session takes the account with the most usage left. Runtime reads that from what the agent's last sessions learned. An account already busy with this agent's sessions counts for less. An account that is out of usage goes last until it resets. The harness gets that account as `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`). The pool's order is written to `~/.runtime-agent/session.json` as `pool`. The [`review`](./ci#agent-steps) template moves to the next account the moment one runs out of usage. When every account is out, it returns `later` with the soonest reset. A CI/CD check then waits instead of failing.

```bash no-run
printf %s "$TOKEN_1" | runtime secrets set CLAUDE_1 --host api.anthropic.com
printf %s "$TOKEN_2" | runtime secrets set CLAUDE_2 --host api.anthropic.com
runtime agents create ci-review --template review --pool CLAUDE_1 --pool CLAUDE_2
```

A key can name a pool's secrets only when it may use them, as with `secrets`. A harness that learns how much an account has left writes `~/.runtime-agent/accounts.json` (`{"CLAUDE_1": {"left": 0.4, "outUntil": null}}`). The file is kept for the agent's next sessions when this one ends.

## Sessions

Start a session with its first words. Words sent with the same `key` join its open session instead. Use one session per Slack thread, pull request or customer of yours. Key them as your app chooses. Keys that start with `ci-review:` belong to CI/CD, for its [agent steps](./ci#agent-steps). A start with one is refused with `invalid_request`.

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

A session is `queued`, `running`, `waiting`, then `done`, `failed` or `stopped`. In `waiting`, its harness waits for words, and its sandbox is paused. Its log holds `input` and `answer` (words in). It also holds `reply`, `ask`, `status`, `result`, `error` and `note` (words out), `child` (a [subagent](#subagents) ended), `turn` and `tool` (its [trace](#traces)), and `tool_call` (a call its [permissions](#permissions) checked). Each entry is numbered. `events` follows the log. It wakes as soon as an event is written, and it ends with the session. Over HTTP, `GET /v1/agents/sessions/{id}/events?after=<seq>&wait=30` long-polls. With `Accept: text/event-stream`, it streams the log instead.

## Asks and the inbox

When an agent needs a person, it asks. An ask has a question, the reason it matters, and up to eight options. Each option has a label and a detail. The ask also names the option the agent recommends. It can also have a **step** and an expiry, from one minute to 30 days. A step says what the ask waits on, such as `bucket:assets`. The session waits, paused, until the answer comes.

The account has one inbox. Asks with the same step, from sessions of one agent that share a [memory](#memory), are one row while open. One answer reaches every session that asks. Each session reads it as its next words and wakes. Six sessions of a team's agent (`"memory": {"scope": "agent"}`) asking for the same bucket are one question for you. You reply to it once. With memory per key, the default, only sessions of one key share an ask. So one customer's session never joins another's. A session with no memory shares only with its own subagents. Another agent that names the same step gets its own row. A session that joins an open ask changes nothing about it. Its question, labels and expiry stay the first asker's. Its answer names the step, not the first asker's question. An ask closes by itself when its sessions end, when the agent withdraws it, or when it expires. At expiry, it takes its recommended option as the answer. If it has none, it tells the sessions that nobody replied.

Labels say who sees an ask. An ask carries its agent's labels, with its own labels over them. The inbox filters by labels, so a team reads only its own asks.

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const open = await runtime.agents.asks.list({ labels: { team: "web" } });
for (const ask of open.data) {
  console.log(
    ask.question,
    ask.options.map((option) => option.label),
    ask.pick,
  );
  if (ask.pick) await runtime.agents.asks.answer(ask.id, { option: ask.pick });
}
```

```bash no-run
runtime agents asks --label team=web            # open asks, one line each
runtime agents asks get <ask>
runtime agents answer <ask> assets-prod         # an option
runtime agents answer <ask> --text "Use the new one, and tag it."
```

The console's **Agents › Asks** page shows the same inbox. Each option is a button. The Agents page says when asks wait on you. Over HTTP, the inbox is `GET /v1/agents/asks` (`state`, `agent`, `label=key:value`). `GET /v1/agents/asks/{id}` reads one ask. Reply with `POST /v1/agents/asks/{id}/answer`, using `option`, `text` or both. Text is up to 32 KiB. A quote, backslash or line break counts twice. An ask that is no longer open returns `ask_closed`. Sending the same answer again with the same `Idempotency-Key` gives the same answer. The SDKs have `agents.asks.list`, `get` and `answer`. The MCP server has them too (`runtime_agents_asks`, `runtime_agents_ask`, `runtime_agents_answer`). To reply, use a key that may run the sessions asking.

Inside the sandbox, the harness asks with its `ask` tool. It takes an ask back with `withdraw`. Over HTTP, send `POST $RUNTIME_API/v1/agents/sessions/$RUNTIME_AGENT_SESSION/asks` with the report token. Then use `.../asks/{id}/withdraw`.

## Permissions

The harnesses run with their own permission prompts off, since no person
watches a sandbox's terminal. An agent's `permissions` decide instead,
before each tool call runs: it runs, it is refused, or it waits for a
person. Only that call waits; the harness's other calls and every other
session go on, and a session that has nothing else to do pauses until the
answer, as it does for an ask.

| Policy         | The call                                                            |
| -------------- | ------------------------------------------------------------------- |
| `always_allow` | runs. The default.                                                  |
| `always_ask`   | waits for Allow or Deny in the [inbox](#asks-and-the-inbox).        |
| `auto`         | runs, is refused, or waits, as Runtime's rules below read the call. |

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
await runtime.agents.update("helper", {
  ...runtime.agents.templates["claude-code"].definition,
  permissions: {
    default: "auto",
    tools: { shell: "always_ask", read: "always_allow", "mcp:github": "always_ask" },
  },
});
```

```bash no-run
runtime agents update helper --permissions '{"default":"auto","tools":{"shell":"always_ask"}}'
```

`tools` (up to 64 entries) names a policy by, most particular first: the
tool's own name (`Bash`, `apply_patch`, `run_shell_command`,
`mcp__github__create_issue`), `mcp:<server>` for every tool of one MCP
server, then a family that holds the same tool in every harness: `shell`,
`edit`, `read`, `web` or `mcp`. A call no entry names takes `default`.

| Family  | Claude Code                                                                   | Codex                  | Gemini CLI                                                                                                                     |
| ------- | ----------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `shell` | `Bash`, `Monitor`, `TaskStop`, `BashOutput`, `KillShell`                      | `Bash` (every command) | `run_shell_command`                                                                                                            |
| `edit`  | `Edit`, `MultiEdit`, `Write`, `NotebookEdit`, `EnterWorktree`, `ExitWorktree` | `apply_patch`          | `write_file`, `replace`                                                                                                        |
| `read`  | `Read`, `Glob`, `Grep`, `LS`, `ListAgents`                                    | `view_image`           | `read_file`, `read_many_files`, `list_directory`, `glob`, `grep_search`, `list_background_processes`, `read_background_output` |
| `web`   | `WebFetch`, `WebSearch`                                                       | `web_search`           | `web_fetch`, `google_web_search`                                                                                               |

The harnesses' own bookkeeping (plans, todo lists, skills, their own
subagents, whose calls are checked one by one) takes `default`. A tool
Runtime does not recognize, such as one a new harness version adds, takes
the strictest of `default` and every family's policy, so a new shell tool
is never let through by a lenient default; name it in `tools` to give it
its own policy. Codex's hook names every command it runs `Bash`; its
`write_stdin`, which types into a command already running, reaches no
hook, so allowing an interactive command (a shell, `python3`) also allows
what is typed into it.

`auto` reads the call itself, with no model, in microseconds:

- **Runs:** reads and searches, the web's reads, edits inside `/workspace`
  and `/tmp` (a relative path is read from the folder the call runs in)
  except of a dotfile or dot-folder, and shell lines in which every command
  only reads (`ls`, `cat`, `grep`, `git status`, `git diff`, ...) or is the
  project's own install, build or test (`npm test`, `cargo test`, `pytest`,
  `go test`, `make check`, ...), with no redirect into a file. A read's long
  options must be known ones, spelled in full (`--ignore-case`, `--reverse`).
  A project's check runs unasked only as itself (`make test`, never
  `make deploy`) and only inside the session's folders: an output or folder
  flag that points elsewhere (`go build -o /usr/bin/x`, `make -C /`,
  `npm install -g`) makes it wait.
- **Refused** (`high_risk`): `sudo` or `su`, `rm` outside `/workspace` and
  `/tmp` or of either folder whole, a download piped into a shell, a force
  push or a deleted remote branch, deleting a repository or a release,
  dropping a database, publishing a package, `terraform destroy`,
  `kubectl delete`, a cloud CLI's deletes, and any change to the harness's
  settings or `~/.runtime-agent`, where the hook that holds calls is set up.
- **Waits** (`indeterminate`): everything else, and every MCP tool. That
  includes:
  - a command that runs another program (`env`, `xargs`,
    `sort --compress-program`, `rg --hostname-bin`) or sets a variable first
    (`LD_PRELOAD=... ls`);
  - a patch with a line `auto` does not know, or one that moves a file
    (`*** Move to:`) anywhere it may not edit;
  - a command that writes with a flag (`sort -o`, `yq -i`, `find -fprint`),
    or uses a long option `auto` does not know, or only part of one
    (`sort --out=...`);
  - an edit of a dotfile or dot-folder anywhere (`/workspace` is also the
    sandbox's home, so `.gitconfig`, `.profile`, `.bashrc`, `.npmrc` and
    `.git/` are settings that programs read and run);
  - any line that names the harness's settings or `~/.runtime-agent`, even
    one that looks like a read;
  - a path outside the session's folders.

Only **Runs** happens unasked, and only for lines `auto` can read whole; a
line it cannot read waits. `auto` judges each call by its own words: a build
or test it runs executes the project's code, which the session may have
edited, so for a guarantee that no command runs unseen, set `shell` to
`always_ask`.

A held call is an ask in the inbox with the options **Allow** and **Deny**,
the call itself in `toolCall` (`tool`, `input`, `toolUseId`, `seq`, `policy`,
`reasonCode`). Allow
runs it; Deny refuses it, and the words you send with a Deny are told to the
agent as the reason, so it can try another way.

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const open = await runtime.agents.asks.list({ state: ["open"] });
for (const ask of open.data) {
  if (!ask.toolCall) continue;
  console.log(ask.question, ask.toolCall.input);
  if (ask.toolCall.tool === "Read") await runtime.agents.asks.approve(ask.id);
  else await runtime.agents.asks.deny(ask.id, "Not now; read the logs first.");
}
```

```bash no-run
runtime agents asks                                  # held calls say "tool call: ..."
runtime agents approve <ask>
runtime agents deny <ask> --message "Not now; read the logs first."
```

Over HTTP, it is `POST /v1/agents/asks/{id}/answer` with `{"option":
"Allow"}`, or `{"option": "Deny", "text": "..."}`; an answer to a held call
without an option returns 400 `invalid_request`. The console's **Agents › Asks** page shows the
call's command or input with Allow and Deny buttons. The Python, Go, Java and
Ruby SDKs have `asks.approve` and `asks.deny` too.

Every call checked is a `tool_call` event in the session's log, whatever was
decided: its `text` (one line saying what the call does), `tool`, `input` (up
to 48 KiB), `toolUseId` and `evaluatedPermission` (`allow`, `deny` or `ask`),
with `evaluation` saying why: its `type` is the policy that decided
(`always_allow`, `always_ask` or `auto`), and for `auto`, its
`evaluatedPermission.reasonCode` is `high_risk` or `indeterminate`. A held
call sent again by the hook with the same `key` is the same ask, never a
second one.

How it works: each harness's own pre-tool hook (Claude Code's `PreToolUse`,
Codex's `PreToolUse`, Gemini CLI's `BeforeTool`) sends the call to `POST
$RUNTIME_API/v1/agents/sessions/$RUNTIME_AGENT_SESSION/tool-calls` with the
report token and a new `key` for each call, and waits for the answer. The
same `key` is sent only when the same call is sent again after a lost
response, and returns the same answer; a call without a `key` returns 400,
and a `key` sent with a different tool or input returns 409. Each call is
decided on its own: an earlier Allow never covers a later call with the
same input. If the API cannot be reached, or the hook fails in any way,
the call is refused, never run unchecked.

Runtime's own tools that affect only the session are never held: `wait`,
`reply`, `ask`, `withdraw`, `status`, `done`, and the memory reads
`recall`, `search` and `list`. The tools that reach past the session are
checked like any other tool, under the name `mcp__runtime-agent__<tool>`
in every harness:

| Tool                                              | Under `auto`       |
| ------------------------------------------------- | ------------------ |
| `spawn` (starts another agent's session)          | Waits for a person |
| `pr` (pushes a branch and opens a pull request)   | Waits for a person |
| `remember`, `forget` (change this agent's memory) | Runs               |

A policy can name them as `mcp__runtime-agent__spawn`, as
`mcp:runtime-agent`, or as `mcp`. A tool counts as Runtime's own only when
it comes from the `runtime-agent` MCP server, which replaces any server of
that name in the harness's settings. Where the harness sends the server's
name (Gemini CLI), that name decides. Otherwise the `mcp__runtime-agent__`
prefix decides.

A child session (`spawn`) is held at least as strictly as every session
above it: each call takes the strictest policy of its own agent's
permissions and of each ancestor's (`always_ask`, then `auto`, then
`always_allow`). A child whose agent has no `permissions` takes its
parent's, so its sandbox gets the hook too. A call its parent may not make
unasked is never made unasked through a child.

The hook is installed where a repository's or the user's settings cannot
turn it off: each harness's system settings, owned by root and written
with `sudo` when the session starts.

| Harness     | Where the hook is installed                                       | What it overrides                                                                                                                         |
| ----------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `/etc/claude-code/managed-settings.d/runtime-agent.json`          | Managed hooks run even when a user's, project's or local settings set `disableAllHooks`.                                                  |
| Codex       | `/etc/codex/requirements.toml`, with `[features] hooks = true`    | A user's or project's `[features] hooks = false`. Managed hooks need no trust, so no extra flag is needed.                                |
| Gemini CLI  | `/etc/gemini-cli/settings.json`, with `hooksConfig.enabled: true` | System settings take precedence over the user's and the workspace's. The harness is given this path in `GEMINI_CLI_SYSTEM_SETTINGS_PATH`. |

The hook runs a root-owned copy of the gate,
`/usr/local/lib/runtime-agent/runtime-agent`, with the Python that started
the session, in isolated mode without site packages (`-I -S`). Environment
variables such as `PYTHONPATH`, and files in the sandbox user's home such as
Python's user `site-packages`, `.pth` files and `usercustomize.py`, are not
loaded by the gate.

The hook and the copy are installed once, when the session's sandbox first
starts, before the harness runs. The copy has the session's id and API
address written into it. It checks every call whatever the session's files
in `~/.runtime-agent` later say, and a later start never removes the hook.
A held call runs only when the API confirms a person's Allow: the hook
sends the call again with its `key` and gets back how its ask stands. A line
in the sandbox's inbox only makes it check again sooner; it checks at least
once a minute.

The session fails with `setup_failed` before the harness starts, with the
file's name in the message, when the hook cannot be installed or a setting
would turn it off:

- a managed Claude Code settings file sets `disableAllHooks`;
- the image's `/etc/codex/requirements.toml` sets `features` or `hooks` itself;
- any Gemini CLI settings file (system defaults, user, or the folder the
  harness runs in) lists the hook in `hooksConfig.disabled`, or lists a
  name with a variable in it;
- a settings file the harness reads is not JSON;
- `sudo` is refused, or the sandbox user can write the Python the gate runs on.

A call that may change a harness's settings or `~/.runtime-agent` (an
edit naming `.claude/`, `.codex/`, `.gemini/`, `.runtime-agent/` or those
folders in `/etc`, or a shell command naming them that does not only read)
waits for a person under every policy, `always_allow` too. Under `auto`,
one that plainly writes them is refused.

So does a call that writes what runs later with no call to check: the home
folder's dotfiles and dot-folders (`~/.profile` and `~/.bashrc`, which the
harness's login shell reads at each start, `~/.local`, `~/.gitconfig`),
`~/bin`, and a checkout's `.git/config` and `.git/hooks`. Runtime's own
commands in the sandbox run its tool with the system's `python3` in
isolated mode (`-I -S`), and only when the tool is byte-for-byte the copy
Runtime wrote, so nothing the agent wrote runs before them.

The hook sends a call's input whole up to 48 KiB. A larger call (a long
patch, say) is sent cut, so Runtime cannot read all it does: it waits for a
person under every policy, and its line in the inbox starts with "(Input cut
to send: only part of it is shown.)". A call `auto` refuses stays refused.

The agent has its sandbox's root: a policy that lets `shell` run unasked
lets the agent run `sudo` and change anything, the hook included.
`always_ask` holds every shell call; keep it on `shell` when no call may
run unchecked.

## Subagents

A session's harness can start a child session to work beside it. The child has its own sandbox. It runs the same agent, or another of yours. A tree extends at most 3 levels below its first session. It holds at most 20 open children. Stopping a session stops every open session under it. When a child ends, it writes a `child` event to its parent's log. A parent waiting for that child wakes.

## Budgets

Every agent has two caps. Both are on by default. `maxSessionDollars` sets what one session and every session under it may cost. The default is $5. `maxDayDollars` sets what the agent may spend in a UTC day. The default is $100. A session at its cap is stopped and ends `stopped`, with the reason `budget`. An agent at its day cap starts nothing new until the next day. Starting a session, or a child under one, past its cap returns `402` with the code `budget_reached`. Set either cap in the definition.

## Watching and replaying

The console's page for each session shows it live as it runs. It shows what the session was told, what it said and did, and its cost so far. Its trace shows each model turn and tool call on a timeline, with tokens and model cost by model and by tool. An ended session replays from its first event. The same log is available as `events` in the SDK, from any `after`.

## Traces

Every model turn and tool call a session's harness makes is recorded in its
log, with no change to your agent: its time, tokens and cost. A turn is one
request to a model API: its model, when it started, how long it took and how
long until the first token, its input tokens (uncached), output tokens,
cache read and cache write tokens, its cost, its stop reason and HTTP status,
and the tool calls it asked for. A tool call runs from the turn that asked for
it to the request that returns its result, with its first 2,000 characters
of input and output and whether it failed.

Secrets are removed from a tool call's input and output, and from a turn's
error, before they are stored, and each is replaced with `[redacted]`. Inside the
sandbox, the relay removes the value of every variable the harness was given
whose name marks it as a secret (`KEY`, `TOKEN`, `SECRET`, `PASSWORD` and
similar), every value shaped like a key (including egress secret placeholders),
and every variable set in the agent's `env`. The API then removes anything
shaped like a key or credential (Runtime, GitHub, Slack, AWS, Google and
OpenAI keys, JWTs, private keys, passwords in URLs). A secret that matches
neither, such as one read from a file, is not removed.

The harness's model calls go through a relay inside the sandbox, which
forwards each request unchanged and reads the usage from the response:
`runtime-agent` points `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` and
`GOOGLE_GEMINI_BASE_URL` at it. This covers Claude Code, Codex, Gemini CLI,
the Anthropic, OpenAI and Google SDKs, and any OpenAI-compatible endpoint.
If your agent's `env` sets one of those variables (a gateway such as
OpenRouter), the relay forwards to that URL. A model call that does not use
these variables is not traced. Set `RUNTIME_AGENT_TRACE=0` in the agent's
`env` to turn the relay off.

Cost is an estimate at the provider's list price for the model, written when
the turn is recorded; the provider bills it, not Runtime. Anthropic cache
writes are priced at the 5-minute rate. A turn on a model with no known
list price has `costUsd: null`, and its tokens still count. A turn on a
subscription account (a Claude pool) is priced as the API would charge it.

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const session = await runtime.agents.session("<sessionId>");
const trace = await session.trace();
console.log(trace.totals.costUsd, trace.totals.turns, trace.totals.toolCalls);
for (const model of trace.models) console.log(model.model, model.inputTokens, model.costUsd);

// Spans are paginated: read on from nextAfter until it is null.
for (let page = trace; ;) {
  for (const span of page.spans)
    console.log(span.kind, span.kind === "turn" ? span.model : span.name, span.durationMs);
  if (page.nextAfter === null) break;
  page = await session.trace({ after: page.nextAfter, limit: 500 });
}
```

```bash no-run
runtime agents trace <sessionId>
runtime agents trace <sessionId> --otlp > trace.json
runtime agents trace <sessionId> --export --endpoint https://otel.example.com
```

`GET /v1/agents/sessions/{id}/trace` returns `{sessionId, totals, models,
tools, spans, nextAfter}`. `totals` covers the whole session, and `models`
and `tools` give the same counts by model and by tool. The totals are kept as
each span is recorded, so they are returned in one read however long the
session is. They name at most 64 models and 100 tools; any others are counted
under `(other)`. `spans` is paginated, in order: up to `limit` spans (default
200, maximum 500) after the `after` seq. Pass `nextAfter` as `after` to read the
next page; it is `null` once the log has no more events. A request reads at
most 2,000 log events, so a page can hold fewer spans than `limit`, or none,
and still have a `nextAfter`. The trace can be read while the session runs
and after it ends, including from cold storage. The Python
(`session.trace(after=, limit=)`), Go (`session.Trace(ctx, after, limit)`,
`session.TraceOTLP`), Ruby (`session.trace(after:, limit:)`) and Java
(`session.trace(after, limit)`, `session.traceOtlp(after, limit)`) SDKs and
the MCP tool `runtime_agents_trace` read the same pages. The CLI reads every
page. In the log, `turn` and `tool` events carry the same fields in `body`.

### OpenTelemetry

`?format=otlp` returns the same page as OpenTelemetry traces: an OTLP/JSON
`ExportTraceServiceRequest` with `nextAfter` beside `resourceSpans`. Remove
`nextAfter` and `POST` the rest to any OTLP/HTTP collector's `/v1/traces`;
the Go SDK returns the request without it. Every span ID is derived from the
span itself, so the pages of one trace join in the collector, and the
`invoke_agent` root span is sent once, in the first page (`after=0`). The
trace ID is the session ID without dashes. The session is an `invoke_agent` span; each
turn is a `chat` span and each tool call an `execute_tool` span under it,
with the GenAI semantic conventions' attributes: `gen_ai.provider.name`,
`gen_ai.request.model`, `gen_ai.usage.input_tokens`,
`gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`,
`gen_ai.response.finish_reasons`, `gen_ai.tool.name` and
`gen_ai.tool.call.id`, plus `runtime.cost_usd`. A tool call's span links to
the turn that asked for it, whichever page that turn was on.
`runtime agents trace --export` sends each page to
`--endpoint`, or to `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or
`OTEL_EXPORTER_OTLP_ENDPOINT` with the headers in
`OTEL_EXPORTER_OTLP_HEADERS`, as an OpenTelemetry SDK reads them.

## History

A session's history (its log) and its files are plain storage. They count toward your plan's included storage. They are kept until you delete them. Each session shows its size. Deleting a session deletes its words and those of every session under it. Deletion waits until all of them have ended. The session's record of what it ran and spent stays. The caps still count it.

Seven days after a session ends, its history moves to Runtime's cold storage,
encrypted with a key for that session alone. Reading it returns the same
events with the same paging (`events` with `after`, the console, the CLI and
MCP); a read that has to fetch from cold storage takes longer than one of a
recent session, well under a second. Its size and its storage charge do not
change. Deleting the session deletes its cold copy too, within 10 minutes. A
read that cold storage cannot answer returns `503 history_unavailable`; retry
it.

## Triggers

Besides the API, a trigger starts or adds input to an agent's sessions:

| Kind       | Config                                                                     | A session per         |
| ---------- | -------------------------------------------------------------------------- | --------------------- |
| `slack`    | `{team, channel}`, once Runtime's Slack app is installed in your workspace | thread                |
| `github`   | `{installation, repository}`, once Runtime's GitHub App is installed       | pull request or issue |
| `schedule` | `{cron, timezone?, input}`                                                 | run                   |
| `webhook`  | `{}`                                                                       | call, or its key      |

Adding a webhook returns its `secret` once, and never again. Each of its calls carries the secret as a Bearer token. It never carries your API key. So whatever sends the calls (an alerting system, a form, your server) holds only that secret.

```bash no-run
runtime agents triggers add helper --kind webhook --config '{}' --rules '{"key":"{alert.id}"}'
curl -X POST "$RUNTIME_API/v1/agents/triggers/<triggerId>/calls" \
  -H "Authorization: Bearer $RUNTIME_TRIGGER_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"text": "Checkout errors are up 4x", "key": "incident-981"}'
```

A call's body is `{text, key?, labels?}`. A call with the key of an open session joins that session. A sender whose JSON you can't shape can still group calls. Its whole body is the words. The trigger's `key` rule builds the key from its fields (`"{alert.id}"`, `"deploy-{service}"`). A `text/plain` body is the words. Send `Idempotency-Key`, and a retry is the same call. The response says what the call did: `201 started`, `200 joined`, `200 noted` or `202 held`. It also gives the `sessionId`, or the held `callId`.

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const done = await runtime.agents.triggers.call(
  "<triggerId>",
  process.env.RUNTIME_TRIGGER_SECRET ?? "",
  { text: "Checkout errors are up 4x", key: "incident-981" },
  { idempotencyKey: "alert-4417" },
);
console.log(done.outcome, done.sessionId ?? done.callId);
```

### Rules

Each trigger has rules. Every rule is optional:

| Rule               | What it does                                                                                                                                             | Default |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `priority`         | -100 to 100. When the agent is at `maxConcurrent`, its queued sessions start highest first, then oldest.                                                 | `0`     |
| `maxStartsPerHour` | New sessions it may start in an hour. Calls that join an open session don't count. A call past the limit is held.                                        | none    |
| `onEnded`          | What a call does when its key's last session has ended: `start` a new session, add a `note` to the ended session's log, or `ask` you (the call is held). | `start` |
| `notify`           | Where a held call is reported: `email` (to whoever added the trigger) or `webhook` (to your webhooks that take `agent.call.held`; email when none does). | `email` |
| `key`              | Webhooks only. The key for a call that sends none, built from its JSON fields, such as `"{alert.id}"`. If a field is missing, the call has no key.       | none    |

Set them when you add a trigger (`--rules`, or `rules` in `runtime.yml`). You can also set them in place. The trigger keeps its secret:

```bash no-run
runtime agents triggers rules <triggerId> '{"priority":10,"maxStartsPerHour":60,"onEnded":"ask"}'
```

A paused trigger refuses its events and says why. A webhook's calls are held for you instead.

```bash no-run
runtime agents triggers pause <triggerId> --why "Moving to the new help center"
```

## Held calls

A call that no session can take is held. It is never dropped. A call is held when its trigger is paused. It is held when it is past `maxStartsPerHour`. It is held when its key's session has ended and `onEnded` is `ask`. It is held when the agent's day budget is spent. It is held when your account's sessions are at their limit. The `why` field says which one (`paused`, `rate`, `ended`, `budget`, `quota`, `closed`). Whoever added the trigger gets an email. The email is sent at most once every 15 minutes per trigger. It lists every call held since. With `notify: webhook`, your webhooks get [`agent.call.held`](./observability#webhooks) instead. That event carries the call's id, trigger, agent, key and why. It never carries the call's words.

Start a held call, and it and every call held for its key since then begin one session, oldest first. Or dismiss it, and nothing runs.

```bash no-run
runtime agents triggers held <triggerId>
runtime agents triggers held start <triggerId> <callId>
runtime agents triggers held dismiss <triggerId> <callId>
```

Over HTTP: `GET /v1/agents/triggers/{id}/held?state=held`, then `POST .../held/{callId}/start` or `.../dismiss`.

## Inside the sandbox

Each session's harness is given `RUNTIME_AGENT_SESSION`, `RUNTIME_AGENT_REPORT_TOKEN` and `RUNTIME_API`. It is also given the agent's instructions in `~/.runtime-agent/start.md`. It gets an MCP server, `runtime-agent` (`~/.runtime-agent/mcp.json`), with these tools: `reply`, `ask` and `withdraw` (see [asks](#asks-and-the-inbox)), `status`, `wait` (for the next words) and `done`. For its [memory](#memory), it has `remember`, `recall`, `search`, `list` and `forget`. It also has `spawn`, which starts a subagent's session. The report token reaches only that session and its memory. No API key enters the sandbox.

## Memory

An agent keeps text files across its sessions, and it can search them. Examples are notes on a customer, a runbook, or what it learned last time. Memory is part of the agent. It is not a disk you attach. So every session reaches it, however many run at the same time. A file holds up to 1 MiB of text. An agent holds up to 1 GiB and 100,000 files. A write past either limit is refused with `memory_full`, and nothing is written.

The definition says whose memory a session reads:

- `"memory": {"scope": "key"}`, the default for every template. Each session key has its own memory. When your app keys sessions by customer (`customer:42`), one customer's notes never reach another customer's session. A session without a key has no memory. A session that a trigger started has its own key's memory, apart from the API's.
- `"memory": {"scope": "agent"}`, set on purpose. All the agent's sessions share one memory. Use it for an agent that only your own team talks to. A support agent can't share it. So one end user never reads or plants what the next one sees.

A session writes only its own scope. Runtime derives the scope from the definition. The session never chooses it. A session also reads the shared files that you put in the agent's memory yourself (the API's `""` scope). These are files every customer's session needs, such as an FAQ or a runbook. A session that keeps memory per key reads those shared files read-only. It never reads what another session wrote there. A file the session writes at the same path hides your shared file from that session alone. A subagent reads the memory of the session at the top of its tree, whatever key its parent gives it. So a customer's session can't start a subagent into another customer's memory. From inside the sandbox, the harness reaches the memory at `$RUNTIME_API/v1/agents/sessions/$RUNTIME_AGENT_SESSION/memory`, with the session's report token.

Seed what every session should know, and read what the agent kept:

```bash no-run
runtime agents memory put helper faq/refunds.md refunds.md
runtime agents memory ls helper --scope customer:42
runtime agents memory search helper "refund policy"
runtime agents memory cat helper notes.md --scope customer:42
runtime agents memory rm helper notes.md --scope customer:42
```

Without `--scope`, `put`, `cat` and `rm` use the shared memory. `ls` and `search` cover every scope. The SDKs have the same five operations (`agents.memory.list`, `search`, `read`, `write`, `delete`). The MCP server has them too (`runtime_agents` action `memory`). Deleting an agent deletes its memory.

## Price

A session's sandbox costs {{app-cpu-rate}} per active vCPU-hour and {{app-memory-rate}} per GiB-hour of memory while it runs. This is the same rate as an App. While it waits for words, the sandbox is paused and pays for paused storage. History is storage. Memory is storage too, counted on the bytes of its files' text and paths. There is no session fee and no seat charge. Your model provider bills your key. See [pricing](./pricing#agents) for the rates, and [limits](./limits#what-an-account-holds-and-runs) for an account's limits.
