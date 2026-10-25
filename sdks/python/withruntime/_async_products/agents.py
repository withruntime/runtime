# ``runtime.agents``: an agent is a versioned definition (where its sandbox
# starts, its size, the command that runs its harness, its instructions, the
# secrets and MCP servers it may use); a session is one piece of work or one
# conversation with it, with its own sandbox and an ordered log of events.
# Private beta: an account outside it is refused with PermissionDeniedError,
# code ``product_in_beta`` (403), and retrying does not change it.
#
#     definition = runtime.agents.templates.definition("claude-code", use="team")
#     await runtime.agents.create("dev", definition)
#     session = await runtime.agents.start("dev", "Fix the flaky test in ci.ts")
#     async for event in session.events():
#         print(event["kind"], event["body"].get("text"))
#
# The account's inbox of what its sessions ask: ``runtime.agents.asks.list()``
# and ``.answer()``.
from __future__ import annotations

import copy
import time
from collections.abc import Mapping
from collections.abc import Iterator as KeyIterator
from typing import Any, AsyncIterator, Optional, TypedDict, Union
from urllib.parse import quote

from .._agent_templates import TEMPLATES, USES
from .._errors import InvalidRequestError, RuntimeError

# A session has ended once it is one of these; it never changes again.
SESSION_ENDED = ("done", "failed", "stopped")
# How long one read of a session's log waits on the server for a new event.
EVENTS_WAIT_SECONDS = 30


def _enc(value: str) -> str:
    return quote(value, safe="")


def _fields(**values: Any) -> dict[str, Any]:
    """The API's body: a field left as None is not sent."""
    return {name: value for name, value in values.items() if value is not None}


class AgentCost(TypedDict):
    """What a session, or its tree, has used: ``dollars``, ``vcpuSeconds``
    and ``gibSeconds``."""
    dollars: float
    vcpuSeconds: float
    gibSeconds: float


class AgentSessionRecord(TypedDict):
    """A session as the API answers it. Times are ISO 8601 strings.

    ``trigger``: api, slack, github, schedule, webhook, or spawn (a child a
    harness started). ``state``: queued, running, waiting, done, failed or
    stopped. ``reason`` (why it ended): among others ``budget`` (its tree
    reached ``maxSessionDollars``), ``parent_ended`` and ``deleted`` (a
    deleted record). ``stopWhy``: why a stop was asked, ``stopped``,
    ``budget`` or ``parent_ended``, or None.

    Its tree: ``parentSessionId`` (None for a top session), ``rootSessionId``
    (itself for a top session) and ``depth`` (0 to 3, 0 at the top). Its use:
    ``cost`` (this session's so far) and ``treeCost`` (it and every session
    under it). Its storage: ``historyBytes`` (its log) and
    ``attachmentBytes`` (its files and screenshots). ``deletedAt`` is set
    once its history was deleted (``sessions.delete``)."""
    id: str
    agentId: str
    agentVersion: int
    key: Optional[str]
    trigger: str
    state: str
    reason: Optional[str]
    result: Optional[str]
    sandboxId: Optional[str]
    lastSeq: int
    labels: dict[str, str]
    createdAt: str
    startedAt: Optional[str]
    endedAt: Optional[str]
    parentSessionId: Optional[str]
    rootSessionId: str
    depth: int
    cost: AgentCost
    treeCost: AgentCost
    historyBytes: int
    attachmentBytes: int
    stopWhy: Optional[str]
    deletedAt: Optional[str]


def _agent(record: dict[str, Any]) -> dict[str, Any]:
    """An agent as the API answers it; ``warnings`` is always a list."""
    if isinstance(record, dict) and record.get("warnings") is None:
        record["warnings"] = []
    return record


def _timed_out() -> RuntimeError:
    return RuntimeError("Waiting reached its deadline; the session goes on.", code="timeout",
                        hint="Call wait() again, or read the session, to keep following it.")


class AgentTemplates(Mapping):
    """The harnesses an agent can run, by key: ``claude-code``, ``codex``,
    ``gemini-cli``, ``claude-agent-sdk`` and ``openai-agents-sdk``. Each has a
    title, the command, the API key's secret and host, how a subscription
    logs in (None: the SDKs take an API key) and a definition. ``uses`` holds
    the presets ``support`` (your customers, driven by your own app: 1 vCPU,
    1 GiB, a session per end customer under your own key such as
    ``customer:42``, triggers api and webhook) and ``team`` (your team: 4
    vCPU, 8 GiB, triggers slack and github).

    A subscription is for your own team's agents. An agent that serves your
    customers uses an API key: those are the providers' terms, and the API
    warns with ``subscription_for_customers`` when one does not."""

    def __init__(self) -> None:
        self._templates = TEMPLATES
        self.uses: dict[str, dict[str, Any]] = copy.deepcopy(USES)

    def __getitem__(self, key: str) -> dict[str, Any]:
        return copy.deepcopy(self._templates[key])

    def __iter__(self) -> KeyIterator[str]:
        return iter(self._templates)

    def __len__(self) -> int:
        return len(self._templates)

    def definition(self, template: str, use: Optional[str] = None) -> dict[str, Any]:
        """A new definition: the template's, with the use's preset over it.
        Pass it to ``agents.create`` as it is, or change it first."""
        if template not in self._templates:
            raise InvalidRequestError(f"No template {template!r}.", code="invalid_request",
                                      details={"field": "template"},
                                      hint=f"Nothing was sent. Use one of {', '.join(self._templates)}.")
        if use is not None and use not in USES:
            raise InvalidRequestError(f"No use {use!r}.", code="invalid_request", details={"field": "use"},
                                      hint=f"Nothing was sent. Use one of {', '.join(USES)}.")
        merged = copy.deepcopy(self._templates[template]["definition"])
        if use is not None:
            merged.update(copy.deepcopy(USES[use]["definition"]))
        return merged


class AsyncAgentSession:
    """One session of an agent: its record in ``session`` (an
    AgentSessionRecord: {id, agentId, agentVersion, key, trigger, state,
    reason, result, sandboxId, lastSeq, labels, createdAt, startedAt,
    endedAt}, its tree {parentSessionId, rootSessionId, depth}, its use
    {cost, treeCost}, each {dollars, vcpuSeconds, gibSeconds}, its storage
    {historyBytes, attachmentBytes}, stopWhy and deletedAt), and whether
    ``start`` ``joined`` the open session with the same key, with the ``seq``
    of the words it sent. A session's history is kept, counted as storage,
    until it is deleted (``sessions.delete``)."""

    def __init__(self, t: Any, session: AgentSessionRecord, joined: bool = False,
                 seq: Optional[int] = None) -> None:
        self._t = t
        self.session: AgentSessionRecord = session
        self.id: str = session["id"]
        self.joined = joined
        self.seq: int = seq if seq is not None else int(session.get("lastSeq") or 0)

    def __repr__(self) -> str:
        return f"AgentSession(id={self.id!r}, state={self.state!r})"

    @property
    def state(self) -> str:
        """queued, running, waiting, done, failed or stopped, as last read."""
        return self.session["state"]

    @property
    def ended(self) -> bool:
        return self.state in SESSION_ENDED

    def _path(self, tail: str = "") -> str:
        return f"/v1/agents/sessions/{_enc(self.id)}{tail}"

    async def refresh(self) -> AgentSessionRecord:
        """Read the session again."""
        self.session = await self._t.json("GET", self._path())
        return self.session

    async def children(self, *, cursor: Optional[str] = None, limit: Optional[int] = None) -> AsyncPage:
        """A page of its direct children, the sessions its harness started
        (``trigger`` spawn), newest first, ``limit`` a page;
        ``async for`` walks every page. ``sessions.list(root=...)`` reads a
        whole tree."""
        return await AsyncAgentSessions(self._t).list(parent=self.id, cursor=cursor, limit=limit)

    async def send(self, text: str, *, idempotency_key: Optional[str] = None) -> int:
        """Words into the session while it runs or waits; returns their seq.
        A retry with the same ``idempotency_key`` is the same words, never
        twice. An ended session refuses with ConflictError ``session_ended``."""
        body = await self._t.json("POST", self._path("/messages"), body={"text": text},
                                  idempotency_key=idempotency_key)
        return int(body["seq"])

    async def events(self, *, after: int = 0) -> AsyncIterator[dict[str, Any]]:
        """``async for`` each event of the log after seq ``after`` (0: from the
        start), in order, as it comes: {seq, kind, actor, body, createdAt},
        the words in ``body["text"]``. ``kind`` is input, answer, reply, ask,
        status, result, error, note, or child (a child session's end, posted
        into its parent's log). Each read waits up to 30 seconds on the
        server for a new one; the loop ends once the session has ended and
        its whole log has been given."""
        ended = False
        while True:
            page = await self._t.json("GET", self._path("/events"),
                                      query={"after": after, "wait": 0 if ended else EVENTS_WAIT_SECONDS})
            data = page.get("data") or []
            for event in data:
                after = max(after, int(event["seq"]))
                yield event
            if page.get("ended"):
                if not data:
                    return
                ended = True

    async def stop(self) -> AgentSessionRecord:
        """Ask it to stop. A queued session ends at once; a running or waiting
        one ends once its sandbox is gone (``wait`` follows it there)."""
        self.session = await self._t.json("POST", self._path("/stop"))
        return self.session

    async def wait(self, *, timeout: float = 0) -> AgentSessionRecord:
        """Return the session once it has ended (done, failed or stopped; a
        failed session is returned, not raised: read ``reason``). Each round
        waits on the session's log, not a timer. ``timeout`` in seconds, 0 for
        none; past it, RuntimeError ``timeout`` and the session goes on."""
        if not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or timeout != timeout \
                or timeout < 0 or timeout == float("inf"):
            raise InvalidRequestError("timeout must be a finite, nonnegative number of seconds.",
                                      code="invalid_request", details={"field": "timeout"},
                                      hint="Fix the option and call again; nothing was sent.")
        deadline = time.monotonic() + timeout if timeout > 0 else None
        options: dict[str, Any] = {} if deadline is None else {"deadline": deadline}
        try:
            while True:
                await self._read(options)
                if self.ended:
                    return self.session
                seconds = EVENTS_WAIT_SECONDS
                if deadline is not None:
                    left = deadline - time.monotonic()
                    if left <= 0:
                        raise _timed_out()
                    seconds = max(1, min(EVENTS_WAIT_SECONDS, int(left)))
                await self._t.json("GET", self._path("/events"),
                                   query={"after": int(self.session.get("lastSeq") or 0), "wait": seconds},
                                   **options)
        except RuntimeError as error:
            if deadline is not None and time.monotonic() >= deadline and error.code == "request_timeout":
                raise _timed_out() from error
            raise

    async def _read(self, options: dict[str, Any]) -> None:
        self.session = await self._t.json("GET", self._path(), **options)


class AsyncAgentSessions:
    """``runtime.agents.sessions``: every agent's sessions."""

    def __init__(self, t: Any) -> None:
        self._t = t

    async def get(self, session_id: str) -> AsyncAgentSession:
        """One session by id, to follow, send to, stop or wait for."""
        record = await self._t.json("GET", f"/v1/agents/sessions/{_enc(session_id)}")
        return AsyncAgentSession(self._t, record)

    async def delete(self, session_id: str) -> None:
        """Delete an ended session's history: its log, and every log under it
        in its tree. Until then the history is kept, counted as storage. The
        session is kept as a deleted record: ``get`` still reads it, with
        ``deletedAt`` set, ``reason`` deleted, ``key`` and ``result`` cleared
        and its cost kept (a delete never frees budget), and its log reads
        empty. An open session or tree is refused with ConflictError
        ``session_open``: stop it first."""
        await self._t.json("DELETE", f"/v1/agents/sessions/{_enc(session_id)}")

    async def list(self, *, agent: Optional[str] = None, state: Optional[Union[str, list[str]]] = None,
                   parent: Optional[str] = None, root: Optional[str] = None, deleted: Optional[bool] = None,
                   cursor: Optional[str] = None, limit: Optional[int] = None) -> AsyncPage:
        """Sessions, newest first, of one ``agent`` (id or name) and in a
        ``state`` if given, ``limit`` a page. ``parent`` (a session's id):
        its direct children. ``root`` (a top session's id): its whole tree,
        the root included. ``deleted=True`` includes deleted records, which
        are hidden otherwise. ``async for`` walks every page."""
        from .._async_client import AsyncPage

        async def fetch(at: Optional[str]) -> AsyncPage:
            body = await self._t.json("GET", "/v1/agents/sessions",
                                      query={"agent": agent, "state": state, "parent": parent, "root": root,
                                             "deleted": deleted, "cursor": at, "limit": limit})
            return AsyncPage(body["data"], body.get("nextCursor"), fetch)
        return await fetch(cursor)


class AsyncAgentAsks:
    """``runtime.agents.asks``: the account's inbox, the questions its agents'
    sessions need answered to go on. Each has ``why`` it matters, ``options``
    ({label, detail}), a recommended ``pick`` and maybe an expiry. Asks of
    one agent's sessions sharing a memory, with the same ``step``, are one
    row while it is open, and one answer reaches every session asking. ``state``: open, answered,
    withdrawn, expired (no pick) or closed (every asking session ended)."""

    def __init__(self, t: Any) -> None:
        self._t = t

    async def list(self, *, state: Optional[Union[str, list[str]]] = None, agent: Optional[str] = None,
                   labels: Optional[dict[str, str]] = None, cursor: Optional[str] = None,
                   limit: Optional[int] = None) -> AsyncPage:
        """Newest first: the open ones unless ``state`` says otherwise; of one
        ``agent``; carrying every one of ``labels`` (who sees an ask). ``async
        for`` walks every page."""
        from .._async_client import AsyncPage
        label = [f"{k}:{v}" for k, v in labels.items()] if labels else None

        async def fetch(at: Optional[str]) -> AsyncPage:
            body = await self._t.json("GET", "/v1/agents/asks",
                                      query={"state": state, "agent": agent, "label": label,
                                             "cursor": at, "limit": limit})
            return AsyncPage(body["data"], body.get("nextCursor"), fetch)
        return await fetch(cursor)

    async def get(self, ask_id: str) -> dict[str, Any]:
        """One ask, with the sessions asking it."""
        return await self._t.json("GET", f"/v1/agents/asks/{_enc(ask_id)}")

    async def answer(self, ask_id: str, option: Optional[str] = None, *, text: Optional[str] = None,
                     idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Answer with an ``option``'s label, ``text``, or both: every session
        asking reads it next and wakes. One no longer open is refused with
        ConflictError ``ask_closed``. Answers the ask as it is now."""
        if option is None and text is None:
            raise InvalidRequestError("An answer is an option's label, text, or both.")
        return await self._t.json("POST", f"/v1/agents/asks/{_enc(ask_id)}/answer",
                                  body=_fields(option=option, text=text), idempotency_key=idempotency_key)


class AsyncAgentTriggers:
    """``runtime.agents.triggers``: what starts or feeds an agent's sessions
    besides the API. Kinds and their config: ``slack`` {team, channel};
    ``github`` {repository, installation} (installation: the id of Runtime's
    GitHub App installation, your own; optional ``events``); ``schedule``
    {cron, timezone?, input}; ``webhook`` {}. A Slack
    workspace or GitHub installation that is not this account's own is
    refused with ConflictError ``not_installed``.

    Each trigger has ``rules``, every one optional: ``priority`` (-100 to
    100: queue order when the agent's maxConcurrent is full, higher first),
    ``maxStartsPerHour`` (a call past it is held for you), ``onEnded``
    (``start``, ``note`` or ``ask``: what a call does when its key's session
    has ended), ``notify`` (``email`` or ``webhook``: where a held call is
    told) and, a webhook's only, ``key`` (``"{cause}"``: the key of a call
    that sends none, from its JSON's fields). A call no session can take is
    held, never dropped: ``held``, ``start_held``, ``dismiss_held``."""

    def __init__(self, t: Any) -> None:
        self._t = t

    async def create(self, agent: str, kind: str, config: dict[str, Any],
                     rules: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        """A trigger of ``agent`` (id or name). A webhook's answer has its
        ``secret``, this once: each of its calls carries it."""
        body: dict[str, Any] = {"kind": kind, "config": config}
        if rules is not None:
            body["rules"] = rules
        return await self._t.json("POST", f"/v1/agents/{_enc(agent)}/triggers", body=body)

    async def set_rules(self, trigger_id: str, rules: dict[str, Any]) -> dict[str, Any]:
        """Its rules, whole, in place: its secret stays. ``{}`` is every default."""
        return await self._t.json("PATCH", f"/v1/agents/triggers/{_enc(trigger_id)}", body={"rules": rules})

    async def call(self, trigger_id: str, secret: str, text: str, *, key: Optional[str] = None,
                   labels: Optional[dict[str, str]] = None,
                   idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Call a webhook trigger as its sender would, by its ``secret``, never
        your key: {outcome, sessionId, seq, callId, why, replayed}, outcome
        ``started``, ``joined`` (the open session with ``key``), ``noted`` or
        ``held``. The same ``idempotency_key`` is the same call."""
        body: dict[str, Any] = {"text": text}
        if key is not None:
            body["key"] = key
        if labels is not None:
            body["labels"] = labels
        return await self._t.json("POST", f"/v1/agents/triggers/{_enc(trigger_id)}/calls", body=body,
                                  bearer=secret, idempotency_key=idempotency_key)

    async def held(self, trigger_id: str, *, state: Optional[list[str]] = None,
                   cursor: Optional[str] = None, limit: Optional[int] = None):
        """Calls it held for you, newest first; ``state`` of held, started,
        dismissed. ``async for`` walks every page."""
        from .._async_client import AsyncPage

        async def fetch(at: Optional[str]) -> AsyncPage:
            body = await self._t.json("GET", f"/v1/agents/triggers/{_enc(trigger_id)}/held",
                                      query={"state": state, "cursor": at, "limit": limit})
            return AsyncPage(body["data"], body.get("nextCursor"), fetch)
        return await fetch(cursor)

    async def start_held(self, trigger_id: str, call_id: str) -> dict[str, Any]:
        """Start a held call: {session, joined, calls}, one session with it
        and every call held for its key since, oldest first."""
        return await self._t.json("POST", f"/v1/agents/triggers/{_enc(trigger_id)}/held/{_enc(call_id)}/start",
                                  body={})

    async def dismiss_held(self, trigger_id: str, call_id: str) -> dict[str, Any]:
        """Dismiss a held call: nothing runs."""
        return await self._t.json("POST", f"/v1/agents/triggers/{_enc(trigger_id)}/held/{_enc(call_id)}/dismiss",
                                  body={})

    async def list(self, agent: str) -> list[dict[str, Any]]:
        """The agent's triggers, paused ones included."""
        body = await self._t.json("GET", f"/v1/agents/{_enc(agent)}/triggers")
        return body["data"]

    async def pause(self, trigger_id: str, why: str) -> dict[str, Any]:
        """Hold this trigger alone, saying ``why``: a webhook's calls are held
        for you (``held``), never dropped. Other triggers and the API go on."""
        return await self._t.json("POST", f"/v1/agents/triggers/{_enc(trigger_id)}/pause", body={"why": why})

    async def resume(self, trigger_id: str) -> dict[str, Any]:
        """Let a paused trigger go on."""
        return await self._t.json("POST", f"/v1/agents/triggers/{_enc(trigger_id)}/resume", body={})

    async def delete(self, trigger_id: str) -> None:
        await self._t.json("DELETE", f"/v1/agents/triggers/{_enc(trigger_id)}")


class AsyncAgentMemory:
    """``runtime.agents.memory``: an agent's built-in memory, text files its
    sessions keep across sessions and search. A ``scope`` is whose: ``""``
    (the default) for what every session of the agent shares, or a session
    key such as ``customer:42`` for that key's alone. A path is like a file's
    (``notes/preferences.md``). Up to 1 MiB a file, 1 GiB and 100,000 files an
    agent, billed as storage; past them a write is refused with ConflictError
    ``memory_full``."""

    def __init__(self, t: Any) -> None:
        self._t = t

    async def list(self, agent: str, *, scope: Optional[str] = None, prefix: Optional[str] = None,
                   cursor: Optional[str] = None, limit: Optional[int] = None) -> AsyncPage:
        """Files of ``agent`` (id or name) by scope and path, each {scope,
        path, bytes, updatedAt, updatedBy}; every scope unless ``scope`` is
        given. The page's ``usage`` is the agent's whole memory: {bytes,
        files, limitBytes, limitFiles}. ``async for`` walks every page."""
        from .._async_client import AsyncPage

        async def fetch(at: Optional[str]) -> AsyncPage:
            body = await self._t.json("GET", f"/v1/agents/{_enc(agent)}/memory", query={
                "scope": scope, "prefix": prefix, "cursor": at, "limit": limit})
            page = AsyncPage(body["data"], body.get("nextCursor"), fetch)
            page.usage = body.get("usage")  # type: ignore[attr-defined]
            return page
        return await fetch(cursor)

    async def search(self, agent: str, q: str, *, scope: Optional[str] = None,
                     limit: Optional[int] = None) -> list[dict[str, Any]]:
        """Files whose words or path match ``q`` (words, "a phrase", or,
        -not), best first, each {scope, path, snippet, rank, bytes,
        updatedAt}; every scope unless ``scope`` is given."""
        body = await self._t.json("GET", f"/v1/agents/{_enc(agent)}/memory",
                                  query={"scope": scope, "q": q, "limit": limit})
        return body["data"]

    async def read(self, agent: str, path: str, *, scope: str = "") -> dict[str, Any]:
        """One file: {scope, path, content, bytes, updatedAt, updatedBy}. None
        there is NotFoundError."""
        return await self._t.json("GET", f"/v1/agents/{_enc(agent)}/memory/content",
                                  query={"scope": scope, "path": path})

    async def write(self, agent: str, path: str, content: str, *, scope: str = "") -> dict[str, Any]:
        """Seed or replace a file: {scope, path, bytes, created, updatedAt}."""
        return await self._t.json("PUT", f"/v1/agents/{_enc(agent)}/memory/content",
                                  query={"scope": scope, "path": path}, body={"content": content})

    async def delete(self, agent: str, path: str, *, scope: str = "") -> bool:
        """Delete a file; whether there was one."""
        body = await self._t.json("DELETE", f"/v1/agents/{_enc(agent)}/memory/content",
                                  query={"scope": scope, "path": path})
        return bool(body["deleted"])


class AsyncAgents:
    """``runtime.agents`` (private beta). Times are ISO 8601 strings."""

    def __init__(self, t: Any) -> None:
        self._t = t
        self.sessions = AsyncAgentSessions(t)
        self.triggers = AsyncAgentTriggers(t)
        self.asks = AsyncAgentAsks(t)
        self.memory = AsyncAgentMemory(t)
        self.templates = AgentTemplates()

    async def create(self, name: str, definition: dict[str, Any], *, labels: Optional[dict[str, str]] = None,
                     idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Make an agent, version 1. ``definition`` as the API takes it:
        ``command`` (required), ``from`` ({image}, {snapshot}, or {repo}: a
        repository connected to CI/CD, "owner/name", each session a copy of
        its warm snapshot, checked out at /workspace/repo), ``vcpu`` and
        ``memoryMiB`` (4 vCPU and 8 GiB unless set; a definition from a
        snapshot takes neither, InvalidRequestError, since a snapshot keeps
        its own size), ``instructions``, ``env``, ``secrets``, ``mcp``,
        ``volumes``, ``idlePauseSeconds``, ``maxSessionSeconds``,
        ``maxConcurrent``, ``maxSessionDollars`` (more than 0, at most 10000,
        5 unless set: the session and every session under it, the root's
        covering its tree; a tree at it stops with reason ``budget``),
        ``maxDayDollars`` (more than 0, at most 100000, 100 unless set: the
        agent's sessions started that UTC day; an agent at it starts nothing
        new, ``budget_reached`` (402), until the next day),
        ``template``;
        ``templates.definition`` makes one.
        A name in use is refused with ConflictError ``name_taken``; the names
        sessions, triggers, templates and approvals are refused, since they are
        paths beside the agents."""
        return _agent(await self._t.json("POST", "/v1/agents",
                                         body=_fields(name=name, definition=definition, labels=labels),
                                         idempotency_key=idempotency_key))

    async def get(self, agent: str) -> dict[str, Any]:
        """One agent by id or name: {id, name, version, definition, labels,
        warnings, createdAt, updatedAt}."""
        return _agent(await self._t.json("GET", f"/v1/agents/{_enc(agent)}"))

    async def list(self, *, cursor: Optional[str] = None, limit: Optional[int] = None) -> AsyncPage:
        """Your agents, ``limit`` a page. ``async for`` walks every page."""
        from .._async_client import AsyncPage

        async def fetch(at: Optional[str]) -> AsyncPage:
            body = await self._t.json("GET", "/v1/agents", query={"cursor": at, "limit": limit})
            return AsyncPage([_agent(a) for a in body["data"]], body.get("nextCursor"), fetch)
        return await fetch(cursor)

    async def update(self, agent: str, definition: dict[str, Any]) -> dict[str, Any]:
        """A new version of the agent's definition, whole. Sessions already
        started keep the version they started with."""
        return _agent(await self._t.json("PATCH", f"/v1/agents/{_enc(agent)}", body={"definition": definition}))

    async def delete(self, agent: str) -> None:
        """Delete it: its triggers go, its open sessions are asked to stop."""
        await self._t.json("DELETE", f"/v1/agents/{_enc(agent)}")

    async def start(self, agent: str, input: str, *, key: Optional[str] = None,
                    labels: Optional[dict[str, str]] = None,
                    idempotency_key: Optional[str] = None) -> AsyncAgentSession:
        """Start a session of ``agent`` (id or name) with ``input`` as its
        first words. With ``key``, your own name for the conversation (a Slack
        thread, a pull request, one of your customers such as ``customer:42``),
        words join the open session with that key rather than start a second;
        the handle's ``joined`` says which happened. Too many open sessions are
        refused with RateLimitError ``quota_exceeded``, an agent at its day's
        budget with ``budget_reached`` (402)."""
        body = await self._t.json("POST", f"/v1/agents/{_enc(agent)}/sessions",
                                  body=_fields(input=input, key=key, labels=labels),
                                  idempotency_key=idempotency_key)
        return AsyncAgentSession(self._t, body["session"], bool(body.get("joined")), body.get("seq"))
