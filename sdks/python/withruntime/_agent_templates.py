"""Agents' templates, as data: five harnesses and the two uses each can serve.
The same values are in every Runtime SDK and the guide
(packages/cloud-guide/agent-templates.json; tests/test_agents.py holds this
file to it).

A template is a harness: what runs in the session's sandbox, and the
provider's API key it needs, stored as an egress secret (the sandbox sees a
placeholder; the proxy adds the key on the way to ``apiKeyHost``). A use is a
preset merged over a template's definition: ``support`` answers your
customers, one session per end customer (your own key, such as
``customer:42``); ``team`` works on your team's code.

A subscription is for your own team's agents. An agent that serves your
customers (api or webhook sessions for end users) uses an API key: those are
the providers' terms, and the API says ``subscription_for_customers`` in the
agent's ``warnings`` when one does not."""
from __future__ import annotations

from typing import Any

_START = "\"$(cat ~/.runtime-agent/start.md)\""


def _template(key: str, title: str, command: str, secret: str, host: str, subscription: Any) -> dict[str, Any]:
    return {"key": key, "title": title, "command": command, "apiKeySecret": secret, "apiKeyHost": host,
            "subscription": subscription, "definition": {"command": command, "secrets": [secret]}}


TEMPLATES: dict[str, dict[str, Any]] = {t["key"]: t for t in (
    _template("claude-code", "Claude Code",
              "npx -y @anthropic-ai/claude-code --dangerously-skip-permissions --mcp-config "
              f"~/.runtime-agent/mcp.json -p {_START}",
              "ANTHROPIC_API_KEY", "api.anthropic.com",
              "token: run `claude setup-token` on your own computer (Pro/Max), then "
              "`runtime secrets set CLAUDE_CODE_OAUTH_TOKEN` scoped to api.anthropic.com"),
    _template("codex", "Codex CLI",
              f"npx -y @openai/codex exec --dangerously-bypass-approvals-and-sandbox {_START}",
              "OPENAI_API_KEY", "api.openai.com",
              "login once in the sandbox's terminal: `npx -y @openai/codex login --device-auth`, "
              "kept in the snapshot or a volume at `~/.codex`"),
    _template("gemini-cli", "Gemini CLI", f"npx -y @google/gemini-cli --yolo -p {_START}",
              "GEMINI_API_KEY", "generativelanguage.googleapis.com",
              "login once in the sandbox's terminal (Sign in with Google), kept at `~/.gemini`"),
    _template("claude-agent-sdk", "Claude Agent SDK", "python3 ~/agent.py",
              "ANTHROPIC_API_KEY", "api.anthropic.com", None),
    _template("openai-agents-sdk", "OpenAI Agents SDK", "python3 ~/agent.py",
              "OPENAI_API_KEY", "api.openai.com", None),
)}

USES: dict[str, dict[str, Any]] = {
    "support": {"key": "support", "title": "Your customers", "sessionKey": "customer:<id>",
                "triggers": ["api", "webhook"],
                "definition": {"template": "support", "vcpu": 1, "memoryMiB": 1024, "idlePauseSeconds": 10,
                               "maxConcurrent": 1000}},
    "team": {"key": "team", "title": "Your team", "sessionKey": None, "triggers": ["slack", "github"],
             "definition": {"template": "team", "vcpu": 4, "memoryMiB": 8192}},
}
