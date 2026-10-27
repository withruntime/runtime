"""runtime.agents against a stub API, sync and async: every route with the
API's names, paging by ``nextCursor``, the log followed by long polls until the
session ends, wait(), the refusals as the SDK's own errors, and the templates
held to the guide's copy (packages/cloud-guide/agent-templates.json)."""
import asyncio
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from withruntime import (AsyncRuntime, AuthenticationError, ConflictError, InvalidRequestError, NotFoundError,
                         PermissionDeniedError, RateLimitError, Runtime)
from withruntime import RuntimeError as RuntimeAPIError
from tests.instant_sleeps import instant_sleeps

AGENT_ID = "11111111-1111-4111-8111-111111111111"
SESSION_ID = "22222222-2222-4222-8222-222222222222"
CHILD_ID = "44444444-4444-4444-8444-444444444444"
TRIGGER_ID = "33333333-3333-4333-8333-333333333333"
AGENT = {"id": AGENT_ID, "name": "dev", "version": 1, "definition": {"command": "run"}, "labels": {},
         "createdAt": "2026-10-18T00:00:00Z", "updatedAt": "2026-10-18T00:00:00Z"}
TRIGGER = {"id": TRIGGER_ID, "agentId": AGENT_ID, "kind": "github",
           "config": {"repository": "acme/web", "installation": 42}, "pausedAt": None, "pausedWhy": None,
           "createdAt": "2026-10-18T00:00:00Z"}
HELD = {"id": "c1", "triggerId": TRIGGER_ID, "agentId": AGENT_ID, "key": "disk", "text": "disk full",
        "labels": {}, "why": "ended", "state": "held", "sessionId": None, "notify": "email",
        "createdAt": "2026-10-18T00:00:00Z", "resolvedAt": None}
MEMORY = {"scope": "", "path": "notes/tea.md", "bytes": 21, "updatedAt": "2026-10-18T00:00:00Z",
          "updatedBy": "key_1"}
USAGE = {"bytes": 42, "files": 2, "limitBytes": 1073741824, "limitFiles": 100000}
GUIDE = Path(__file__).resolve().parents[3] / "packages" / "cloud-guide" / "agent-templates.json"


def session(state="running", last_seq=1):
    return {"id": SESSION_ID, "agentId": AGENT_ID, "agentVersion": 1, "key": None, "trigger": "api",
            "state": state, "reason": None, "result": None, "sandboxId": None, "lastSeq": last_seq,
            "labels": {}, "createdAt": "2026-10-18T00:00:00Z", "startedAt": None, "endedAt": None,
            "parentSessionId": None, "rootSessionId": SESSION_ID, "depth": 0,
            "cost": {"dollars": 0.25, "vcpuSeconds": 120, "gibSeconds": 240},
            "treeCost": {"dollars": 0.75, "vcpuSeconds": 360, "gibSeconds": 720},
            "historyBytes": 2048, "attachmentBytes": 4096, "stopWhy": None, "deletedAt": None}


def child(**fields):
    """A session its parent's harness started, as the API answers it."""
    return {**session("done", 4), "id": CHILD_ID, "trigger": "spawn", "parentSessionId": SESSION_ID, "depth": 1,
            **fields}


def event(seq, kind="reply", text="hi"):
    return {"seq": seq, "kind": kind, "actor": "agent", "body": {"text": text}, "createdAt": "2026-10-18T00:00:00Z"}


REFUSALS = {
    "beta": (403, "product_in_beta", PermissionDeniedError),
    "denied": (403, "permission_denied", PermissionDeniedError),
    "missing": (404, "not_found", NotFoundError),
    "ended": (409, "session_ended", ConflictError),
    "taken": (409, "name_taken", ConflictError),
    "paused": (409, "trigger_paused", ConflictError),
    "uninstalled": (409, "not_installed", ConflictError),
    "budget": (402, "budget_reached", RuntimeAPIError),
    "open": (409, "session_open", ConflictError),
    "quota": (429, "quota_exceeded", RateLimitError),
    "invalid": (400, "invalid_request", InvalidRequestError),
    "refused": (401, "unauthorized", AuthenticationError),
}


class Stub(BaseHTTPRequestHandler):
    seen: list = []
    # Each request's Authorization header, in order.
    auth: list = []
    mode = "ok"
    # Each read of the log answers the next of these pages; each read of the
    # session the next of these states. The last of each repeats.
    pages: list = []
    states: list = []
    # When set, what a read of one session answers.
    record = None
    # The version a read of the workflow answers; each long poll adds one.
    version = 1
    # The server of the test now running.
    live = None

    def log_message(self, *args):
        pass

    def answer(self, value, status=200):
        data = b"" if value is None else json.dumps(value).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def handle_any(self):
        if self.server is not Stub.live:
            return
        length = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(length)) if length else None
        url = urlsplit(self.path)
        path, query = url.path, parse_qs(url.query, keep_blank_values=True)
        Stub.seen.append((self.command, path, query, body, self.headers.get("idempotency-key")))
        Stub.auth.append(self.headers.get("authorization"))
        if Stub.mode in REFUSALS:
            status, code, _ = REFUSALS[Stub.mode]
            return self.answer({"error": {"code": code, "message": f"refused: {code}", "hint": "h"}}, status)
        method = self.command
        if path == "/v1/agents/dev/memory":
            if "q" in query:
                return self.answer({"data": [{**MEMORY, "snippet": "**tea**", "rank": 0.5}], "nextCursor": None})
            if "cursor" in query:
                return self.answer({"data": [{**MEMORY, "scope": "customer:42"}], "nextCursor": None, "usage": USAGE})
            return self.answer({"data": [MEMORY], "nextCursor": "page-2", "usage": USAGE})
        if path == "/v1/agents/dev/memory/content":
            if method == "PUT":
                return self.answer({"scope": query["scope"][0], "path": query["path"][0], "bytes": 9,
                                    "created": True, "updatedAt": "2026-10-18T00:00:00Z"})
            if method == "DELETE":
                return self.answer({"deleted": True})
            return self.answer({**MEMORY, "content": "tea, no sugar"})
        if path == "/v1/agents/slack/installs":
            return self.answer({"url": "https://withruntime.com/api/account/agents/slack/start?install=s",
                                "expiresAt": "2026-10-26T17:15:00.000Z"}, 201)
        if path == "/v1/agents/slack/teams":
            return self.answer({"data": [{"team": "T0ACME", "name": "Acme", "botUser": "U0BOT",
                                          "installedAt": "2026-10-26T17:00:00.000Z"}]})
        if path.startswith("/v1/agents/slack/teams/"):
            return self.answer({"team": path.rsplit("/", 1)[1], "removed": True})
        if path.startswith("/v1/agents/workflows"):
            return self.workflow_route(method, path, query)
        if path == "/v1/agents/asks":
            return self.answer({"data": [ASK], "nextCursor": None})
        if path.startswith("/v1/agents/asks/"):
            return self.answer({**ASK, "state": "answered", "answer": body} if method == "POST" else ASK)
        if path == "/v1/agents" and method == "GET":
            if "cursor" in query:
                return self.answer({"data": [{**AGENT, "id": "second", "warnings": ["subscription_for_customers"]}],
                                    "nextCursor": None})
            return self.answer({"data": [AGENT], "nextCursor": "page-2"})
        if path == "/v1/agents/sessions" and method == "GET":
            if "cursor" in query:
                return self.answer({"data": [{**session(), "id": "second"}], "nextCursor": None})
            return self.answer({"data": [session()], "nextCursor": "page-2"})
        if path.endswith("/trace"):
            if query["format"] == ["otlp"]:
                return self.answer({"resourceSpans": [{"scopeSpans": [{"spans": [{"name": "invoke_agent dev"}]}]}]})
            return self.answer(TRACE)
        if path.endswith("/events"):
            page = Stub.pages.pop(0) if len(Stub.pages) > 1 else Stub.pages[0]
            return self.answer(page)
        if path.endswith("/messages"):
            return self.answer({"seq": 7})
        if path.endswith("/stop"):
            return self.answer(session("stopped"))
        if path == f"/v1/agents/sessions/{SESSION_ID}" and method == "DELETE":
            return self.answer(None, 204)
        if path == f"/v1/agents/sessions/{SESSION_ID}" and Stub.record is not None:
            return self.answer(Stub.record)
        if path == f"/v1/agents/sessions/{SESSION_ID}":
            state = Stub.states.pop(0) if len(Stub.states) > 1 else (Stub.states or ["running"])[0]
            return self.answer(session(state, 3))
        if path.endswith("/sessions") and method == "POST":
            return self.answer({"session": session("queued"), "joined": body.get("key") == "customer:42", "seq": 1},
                               200 if body.get("key") == "customer:42" else 201)
        if path.endswith("/triggers"):
            return self.answer({"data": [TRIGGER]} if method == "GET" else TRIGGER, 200 if method == "GET" else 201)
        if path.endswith("/calls"):
            return self.answer({"outcome": "joined", "sessionId": SESSION_ID, "seq": 2, "callId": None,
                                "why": None, "replayed": False})
        if path.endswith("/held"):
            return self.answer({"data": [HELD], "nextCursor": None})
        if path.endswith("/start") and "/held/" in path:
            return self.answer({"session": session("queued"), "joined": False, "calls": 2})
        if path.endswith("/dismiss"):
            return self.answer({**HELD, "state": "dismissed"})
        if path.startswith("/v1/agents/triggers/") and method == "PATCH":
            return self.answer({**TRIGGER, "rules": body["rules"]})
        if path.startswith("/v1/agents/triggers/"):
            if method == "DELETE":
                return self.answer(None, 204)
            paused = path.endswith("/pause")
            return self.answer({**TRIGGER, "pausedAt": "x" if paused else None,
                                "pausedWhy": body["why"] if paused else None})
        if path.startswith("/v1/agents"):
            if method == "DELETE":
                return self.answer(None, 204)
            return self.answer(AGENT, 201 if method == "POST" else 200)
        self.answer({"error": {"code": "not_found", "message": "no"}}, 404)

    def workflow_route(self, method, path, query):
        base = f"/v1/agents/workflows/{WORKFLOW_ID}"
        if path == "/v1/agents/workflows":
            return self.answer(workflow(1), 201) if method == "POST" else self.answer(
                {"data": [workflow(1)], "nextCursor": None})
        if path == f"{base}/steps":
            return self.answer({"data": [STEP], "nextCursor": None})
        if path == f"{base}/stop":
            return self.answer(workflow(9, "stopped"))
        if "wait" not in query:
            return self.answer(workflow(Stub.version))
        # Each long poll answers the next version; the third has ended.
        Stub.version += 1
        return self.answer(workflow(Stub.version, "done", '["X", "Y"]') if Stub.version >= 3
                           else workflow(Stub.version))

    do_GET = do_POST = do_PATCH = do_PUT = do_DELETE = handle_any


WORKFLOW_ID = "55555555-5555-4555-8555-555555555555"
STEP = {"phase": "fix", "item": 0, "itemText": "a.ts", "state": "done", "reason": "done", "result": "ok",
        "sessionId": CHILD_ID, "createdAt": "2026-10-18T00:00:00Z", "startedAt": None, "endedAt": None}


def workflow(version, state="running", result=None):
    return {"id": WORKFLOW_ID, "name": "triage", "state": state, "reason": None if state == "running" else "done",
            "result": result, "parentSessionId": None, "spec": {}, "maxSessions": 100, "maxConcurrent": 20,
            "maxDollars": 10, "started": 2, "version": version, "labels": {},
            "phases": [{"name": "fix", "agentId": AGENT_ID, "total": 2, "ready": True, "pending": 0,
                        "running": 0, "done": 2, "failed": 0}],
            "cost": {"dollars": 0, "vcpuSeconds": 0, "gibSeconds": 0}, "createdAt": "2026-10-18T00:00:00Z",
            "updatedAt": "2026-10-18T00:00:00Z", "endedAt": None}


ASK = {"id": "ask-1", "step": "bucket-cap", "question": "Raise the cap?", "options": [{"label": "Raise"}],
       "pick": "Raise", "state": "open", "sessions": [{"sessionId": SESSION_ID, "state": "asking", "seq": 2}]}

TRACE = {"sessionId": SESSION_ID, "totals": {"turns": 1, "toolCalls": 0, "costUsd": 0.084},
         "models": [], "tools": [],
         "spans": [{"seq": 2, "kind": "turn", "model": "claude-opus-5-5", "costUsd": 0.084}], "nextAfter": None}


class AgentsTest(unittest.TestCase):
    # Each test has a stub of its own: a request a test gave up on (a wait past
    # its deadline) that a busy machine handles late reaches its own test's
    # stub, which drops it, never the next test's record.
    def setUp(self):
        self.server = Stub.live = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        Stub.seen, Stub.mode, Stub.pages, Stub.states = [], "ok", [{"data": [], "ended": True}], []
        Stub.auth = []
        Stub.record = None
        Stub.version = 1

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def client(self):
        return Runtime(api_key="rk_test", base_url=self.url, max_retries=2)

    def routes(self):
        return [(s[0], s[1]) for s in Stub.seen]

    def test_every_agent_verb_calls_its_route_with_the_apis_names(self):
        with self.client() as runtime:
            agent = runtime.agents.create("dev", {"command": "run"}, labels={"team": "web"})
            self.assertEqual(agent["warnings"], [])
            runtime.agents.get("dev bot")
            agents = list(runtime.agents.list(limit=1))
            self.assertEqual([a["id"] for a in agents], [AGENT_ID, "second"])
            self.assertEqual(agents[1]["warnings"], ["subscription_for_customers"])
            self.assertEqual(runtime.agents.update(AGENT_ID, {"command": "run2"})["version"], 1)
            self.assertIsNone(runtime.agents.delete(AGENT_ID))
        self.assertEqual(self.routes(), [
            ("POST", "/v1/agents"), ("GET", "/v1/agents/dev%20bot"), ("GET", "/v1/agents"), ("GET", "/v1/agents"),
            ("PATCH", f"/v1/agents/{AGENT_ID}"), ("DELETE", f"/v1/agents/{AGENT_ID}")])
        self.assertEqual(Stub.seen[0][3], {"name": "dev", "definition": {"command": "run"}, "labels": {"team": "web"}})
        self.assertEqual(Stub.seen[2][2], {"limit": ["1"]})
        self.assertEqual(Stub.seen[3][2], {"cursor": ["page-2"], "limit": ["1"]})
        self.assertEqual(Stub.seen[4][3], {"definition": {"command": "run2"}})
        # Every write carries a key, so the transport's retries never write twice.
        self.assertTrue(all(s[4] for s in Stub.seen if s[0] != "GET"))

    def test_start_send_stop_and_the_sessions_reads(self):
        with self.client() as runtime:
            started = runtime.agents.start("dev", "Fix the test", labels={"pr": "7"}, idempotency_key="start-1")
            self.assertEqual((started.id, started.state, started.joined, started.seq), (SESSION_ID, "queued", False, 1))
            joined = runtime.agents.start(AGENT_ID, "Hello", key="customer:42")
            self.assertTrue(joined.joined)
            runtime.agents.start("dev", "Summarize", overrides={"model": "claude-haiku-5-5", "disallowedTools": ["Bash"]})
            self.assertEqual(started.send("More words", idempotency_key="words-1"), 7)
            self.assertEqual(started.stop()["state"], "stopped")
            self.assertTrue(started.ended)
            again = runtime.agents.sessions.get(SESSION_ID)
            self.assertEqual((again.id, again.joined, again.seq), (SESSION_ID, False, 3))
            listed = runtime.agents.sessions.list(agent="dev", state="running")
            self.assertEqual([s["id"] for s in listed], [SESSION_ID, "second"])
            self.assertIsNone(runtime.agents.sessions.delete(SESSION_ID))
        base = f"/v1/agents/sessions/{SESSION_ID}"
        self.assertEqual(self.routes(), [
            ("POST", "/v1/agents/dev/sessions"), ("POST", f"/v1/agents/{AGENT_ID}/sessions"),
            ("POST", "/v1/agents/dev/sessions"),
            ("POST", f"{base}/messages"), ("POST", f"{base}/stop"), ("GET", base),
            ("GET", "/v1/agents/sessions"), ("GET", "/v1/agents/sessions"), ("DELETE", base)])
        self.assertEqual(Stub.seen[0][3], {"input": "Fix the test", "labels": {"pr": "7"}})
        self.assertEqual(Stub.seen[0][4], "start-1")
        self.assertEqual(Stub.seen[1][3], {"input": "Hello", "key": "customer:42"})
        self.assertEqual(Stub.seen[2][3], {"input": "Summarize",
                                           "overrides": {"model": "claude-haiku-5-5", "disallowedTools": ["Bash"]}})
        self.assertEqual(Stub.seen[3][3], {"text": "More words"})
        self.assertEqual(Stub.seen[3][4], "words-1")
        self.assertEqual(Stub.seen[6][2], {"agent": ["dev"], "state": ["running"]})
        self.assertEqual(Stub.seen[7][2], {"agent": ["dev"], "state": ["running"], "cursor": ["page-2"]})
        self.assertTrue(all(s[4] for s in Stub.seen if s[0] != "GET"))

    def test_children_and_tree_lists_read_by_parent_root_and_deleted(self):
        with self.client() as runtime:
            handle = runtime.agents.sessions.get(SESSION_ID)
            children = handle.children(limit=5)
            self.assertTrue(children.has_more)
            self.assertEqual([s["id"] for s in children], [SESSION_ID, "second"])
            self.assertEqual(len(list(runtime.agents.sessions.list(root=SESSION_ID, deleted=True))), 2)
            runtime.agents.sessions.list(parent=SESSION_ID, state="done", deleted=False)
        reads = [s[2] for s in Stub.seen if s[1] == "/v1/agents/sessions"]
        self.assertEqual(reads, [
            {"parent": [SESSION_ID], "limit": ["5"]}, {"parent": [SESSION_ID], "limit": ["5"], "cursor": ["page-2"]},
            {"root": [SESSION_ID], "deleted": ["true"]}, {"root": [SESSION_ID], "deleted": ["true"], "cursor": ["page-2"]},
            {"parent": [SESSION_ID], "state": ["done"], "deleted": ["false"]}])
        # A spawn is the harness's own call: no SDK method sends one.
        self.assertFalse(any(s[1].endswith("/spawn") for s in Stub.seen))
        self.assertFalse(hasattr(handle, "spawn"))

    def test_a_sessions_tree_cost_and_storage_read_as_the_api_sends_them(self):
        Stub.record = child(reason="budget", stopWhy="budget")
        with self.client() as runtime:
            found = runtime.agents.sessions.get(SESSION_ID).session
        self.assertEqual((found["trigger"], found["parentSessionId"], found["rootSessionId"], found["depth"]),
                         ("spawn", SESSION_ID, SESSION_ID, 1))
        self.assertEqual((found["reason"], found["stopWhy"]), ("budget", "budget"))
        self.assertEqual(found["cost"], {"dollars": 0.25, "vcpuSeconds": 120, "gibSeconds": 240})
        self.assertEqual(found["treeCost"]["dollars"], 0.75)
        self.assertEqual((found["historyBytes"], found["attachmentBytes"]), (2048, 4096))
        self.assertIsNone(found["deletedAt"])

    def test_a_deleted_session_is_kept_as_a_record_with_an_empty_log(self):
        Stub.record = {**session("done", 4), "reason": "deleted", "key": None, "result": None,
                       "deletedAt": "2026-10-19T00:00:00Z"}
        with self.client() as runtime:
            self.assertIsNone(runtime.agents.sessions.delete(SESSION_ID))
            kept = runtime.agents.sessions.get(SESSION_ID)
            self.assertEqual(list(kept.events()), [])
        self.assertEqual((kept.session["reason"], kept.session["deletedAt"]), ("deleted", "2026-10-19T00:00:00Z"))
        self.assertEqual(kept.session["cost"]["dollars"], 0.25)
        base = f"/v1/agents/sessions/{SESSION_ID}"
        self.assertEqual(self.routes(), [("DELETE", base), ("GET", base), ("GET", f"{base}/events")])

    def test_a_childs_end_reads_in_its_parents_log(self):
        Stub.pages = [{"data": [event(5, "child", "done: https://github.com/acme/web/pull/8")], "ended": True},
                      {"data": [], "ended": True}]
        with self.client() as runtime:
            events = list(runtime.agents.sessions.get(SESSION_ID).events(after=4))
        self.assertEqual([(e["seq"], e["kind"]) for e in events], [(5, "child")])

    def test_events_long_poll_from_after_and_drain_the_log_once_it_ended(self):
        Stub.pages = [
            {"data": [event(1, "input", "Fix it"), event(2, "status", "on it")], "ended": False},
            {"data": [], "ended": False},
            {"data": [event(3, "result", "https://github.com/acme/web/pull/7")], "ended": True},
            {"data": [event(4, "note", "sandbox deleted")], "ended": True},
            {"data": [], "ended": True},
        ]
        with self.client() as runtime:
            handle = runtime.agents.sessions.get(SESSION_ID)
            events = list(handle.events())
        self.assertEqual([e["seq"] for e in events], [1, 2, 3, 4])
        self.assertEqual(events[2]["body"]["text"], "https://github.com/acme/web/pull/7")
        reads = [s[2] for s in Stub.seen if s[1].endswith("/events")]
        self.assertEqual(reads, [
            {"after": ["0"], "wait": ["30"]}, {"after": ["2"], "wait": ["30"]}, {"after": ["2"], "wait": ["30"]},
            {"after": ["3"], "wait": ["0"]}, {"after": ["4"], "wait": ["0"]}])

    def test_events_start_after_a_given_seq(self):
        with self.client() as runtime:
            self.assertEqual(list(runtime.agents.sessions.get(SESSION_ID).events(after=9)), [])
        self.assertEqual([s[2] for s in Stub.seen if s[1].endswith("/events")], [{"after": ["9"], "wait": ["30"]}])

    def test_wait_follows_the_log_until_the_session_ended_and_returns_it(self):
        Stub.states = ["running", "running", "waiting", "failed"]
        Stub.pages = [{"data": [event(4)], "ended": False}, {"data": [], "ended": True}]
        with self.client() as runtime:
            handle = runtime.agents.sessions.get(SESSION_ID)
            ended = handle.wait()
        # A failed session is returned, not raised.
        self.assertEqual(ended["state"], "failed")
        self.assertEqual(handle.state, "failed")
        base = f"/v1/agents/sessions/{SESSION_ID}"
        self.assertEqual(self.routes(), [("GET", base), ("GET", base), ("GET", f"{base}/events"), ("GET", base),
                                         ("GET", f"{base}/events"), ("GET", base)])
        self.assertTrue(all(s[2] == {"after": ["3"], "wait": ["30"]} for s in Stub.seen if s[1].endswith("/events")))

    def test_a_wait_past_its_deadline_says_timeout(self):
        Stub.states = ["running"]
        Stub.pages = [{"data": [], "ended": False}]
        with self.client() as runtime:
            handle = runtime.agents.sessions.get(SESSION_ID)
            with self.assertRaises(RuntimeAPIError) as caught:
                handle.wait(timeout=0.05)
            self.assertEqual(caught.exception.code, "timeout")
            with self.assertRaises(InvalidRequestError):
                handle.wait(timeout=-1)

    def test_every_trigger_verb_calls_its_route(self):
        with self.client() as runtime:
            created = runtime.agents.triggers.create("dev", "github", {"repository": "acme/web", "installation": 42})
            self.assertEqual(created["config"]["installation"], 42)
            self.assertEqual(runtime.agents.triggers.list("dev")[0]["id"], TRIGGER_ID)
            self.assertEqual(runtime.agents.triggers.pause(TRIGGER_ID, "release freeze")["pausedWhy"], "release freeze")
            self.assertIsNone(runtime.agents.triggers.resume(TRIGGER_ID)["pausedAt"])
            self.assertIsNone(runtime.agents.triggers.delete(TRIGGER_ID))
        base = f"/v1/agents/triggers/{TRIGGER_ID}"
        self.assertEqual(self.routes(), [
            ("POST", "/v1/agents/dev/triggers"), ("GET", "/v1/agents/dev/triggers"), ("POST", f"{base}/pause"),
            ("POST", f"{base}/resume"), ("DELETE", base)])
        self.assertEqual(Stub.seen[0][3], {"kind": "github", "config": {"repository": "acme/web", "installation": 42}})
        self.assertEqual(Stub.seen[2][3], {"why": "release freeze"})

    def test_the_inbox_lists_by_state_and_labels_gets_one_and_answers_it(self):
        with self.client() as runtime:
            asks = list(runtime.agents.asks.list(state=["open", "expired"], labels={"team": "infra"}))
            self.assertEqual([a["step"] for a in asks], ["bucket-cap"])
            self.assertEqual(runtime.agents.asks.get("ask-1")["pick"], "Raise")
            answered = runtime.agents.asks.answer("ask-1", "Raise", text="Done.")
            self.assertEqual(answered["answer"], {"option": "Raise", "text": "Done."})
            with self.assertRaises(InvalidRequestError):
                runtime.agents.asks.answer("ask-1")
        self.assertEqual(self.routes(), [
            ("GET", "/v1/agents/asks"), ("GET", "/v1/agents/asks/ask-1"), ("POST", "/v1/agents/asks/ask-1/answer")])
        query = Stub.seen[0][2]
        self.assertEqual((query["state"], query["label"]), (["open", "expired"], ["team:infra"]))

    def test_a_workflow_runs_is_followed_by_version_with_a_long_poll_and_lists_its_steps(self):
        spec = {"agent": "dev", "phases": [{"name": "fix", "input": "Fix {{item}}", "each": ["a.ts", "b.ts"]}]}
        with self.client() as runtime:
            flow = runtime.agents.workflows.run(spec, idempotency_key="wf-1")
            self.assertEqual((flow.id, flow.state), (WORKFLOW_ID, "running"))
            self.assertEqual([w["version"] for w in flow.follow()], [2, 3])
            self.assertEqual((flow.state, flow.workflow["result"]), ("done", '["X", "Y"]'))
            Stub.version = 1
            self.assertEqual(runtime.agents.workflows.get(WORKFLOW_ID).wait()["state"], "done")
            self.assertEqual([x["itemText"] for x in flow.steps(state="done")], ["a.ts"])
            self.assertEqual([w["id"] for w in runtime.agents.workflows.list(state=["running"])], [WORKFLOW_ID])
            self.assertEqual(flow.stop()["state"], "stopped")
        base = f"/v1/agents/workflows/{WORKFLOW_ID}"
        self.assertEqual(Stub.seen[0][3], spec)
        self.assertEqual(Stub.seen[0][4], "wf-1")
        polls = [s[2] for s in Stub.seen if "wait" in s[2]]
        self.assertEqual(polls[:2], [{"after": ["0"], "wait": ["30"]}, {"after": ["2"], "wait": ["30"]}])
        self.assertEqual(self.routes()[-3:], [
            ("GET", f"{base}/steps"), ("GET", "/v1/agents/workflows"), ("POST", f"{base}/stop")])
    def test_a_held_tool_call_is_approved_or_denied_with_its_message(self):
        with self.client() as runtime:
            self.assertEqual(runtime.agents.asks.approve("ask-1")["answer"], {"option": "Allow"})
            denied = runtime.agents.asks.deny("ask-1", "Clean dist/ only.")
            self.assertEqual(denied["answer"], {"option": "Deny", "text": "Clean dist/ only."})
            self.assertEqual(runtime.agents.asks.deny("ask-1")["answer"], {"option": "Deny"})
        self.assertEqual(self.routes(), [("POST", "/v1/agents/asks/ask-1/answer")] * 3)

    def test_trigger_rules_calls_and_held_calls_call_their_routes_and_a_call_carries_the_secret(self):
        with self.client() as runtime:
            triggers = runtime.agents.triggers
            triggers.create("dev", "webhook", {}, rules={"key": "{cause}", "onEnded": "ask"})
            self.assertEqual(triggers.set_rules(TRIGGER_ID, {"priority": 10})["rules"], {"priority": 10})
            done = triggers.call(TRIGGER_ID, "rtat_secret_1234567890", "disk full", key="disk",
                                 labels={"host": "vin-5"}, idempotency_key="alert-7")
            self.assertEqual((done["outcome"], done["seq"]), ("joined", 2))
            self.assertEqual([c["id"] for c in triggers.held(TRIGGER_ID, state=["held"])], ["c1"])
            self.assertEqual(triggers.start_held(TRIGGER_ID, "c1")["calls"], 2)
            self.assertEqual(triggers.dismiss_held(TRIGGER_ID, "c1")["state"], "dismissed")
        base = f"/v1/agents/triggers/{TRIGGER_ID}"
        self.assertEqual(self.routes(), [
            ("POST", "/v1/agents/dev/triggers"), ("PATCH", base), ("POST", f"{base}/calls"), ("GET", f"{base}/held"),
            ("POST", f"{base}/held/c1/start"), ("POST", f"{base}/held/c1/dismiss")])
        self.assertEqual(Stub.seen[0][3], {"kind": "webhook", "config": {},
                                           "rules": {"key": "{cause}", "onEnded": "ask"}})
        self.assertEqual(Stub.seen[2][3], {"text": "disk full", "key": "disk", "labels": {"host": "vin-5"}})
        self.assertEqual(Stub.seen[2][4], "alert-7")
        self.assertEqual(Stub.seen[3][2], {"state": ["held"]})
        self.assertEqual(Stub.auth[2], "Bearer rtat_secret_1234567890")
        self.assertEqual(Stub.auth[1], "Bearer rk_test")

    def test_slack_install_teams_and_remove_call_their_routes(self):
        with self.client() as runtime:
            self.assertIn("/api/account/agents/slack/start", runtime.agents.slack.install()["url"])
            self.assertEqual([w["team"] for w in runtime.agents.slack.teams()], ["T0ACME"])
            self.assertIsNone(runtime.agents.slack.remove("T0ACME"))
        self.assertEqual(self.routes(), [
            ("POST", "/v1/agents/slack/installs"), ("GET", "/v1/agents/slack/teams"),
            ("DELETE", "/v1/agents/slack/teams/T0ACME")])

    def test_every_memory_verb_calls_its_route_with_the_scope_in_the_query(self):
        with self.client() as runtime:
            page = runtime.agents.memory.list("dev", prefix="notes/", limit=1)
            self.assertEqual(page.usage, USAGE)
            self.assertEqual([f["scope"] for f in page], ["", "customer:42"])
            hits = runtime.agents.memory.search("dev", "tea", scope="")
            self.assertEqual(hits[0]["snippet"], "**tea**")
            self.assertEqual(runtime.agents.memory.read("dev", "notes/tea.md")["content"], "tea, no sugar")
            written = runtime.agents.memory.write("dev", "tone.md", "Formal.", scope="customer:42")
            self.assertEqual((written["scope"], written["created"]), ("customer:42", True))
            self.assertTrue(runtime.agents.memory.delete("dev", "notes/tea.md"))
        base = "/v1/agents/dev/memory"
        self.assertEqual(self.routes(), [
            ("GET", base), ("GET", base), ("GET", base), ("GET", f"{base}/content"), ("PUT", f"{base}/content"),
            ("DELETE", f"{base}/content")])
        self.assertEqual([s[2] for s in Stub.seen], [
            {"prefix": ["notes/"], "limit": ["1"]},
            {"prefix": ["notes/"], "cursor": ["page-2"], "limit": ["1"]},
            {"scope": [""], "q": ["tea"]},
            {"scope": [""], "path": ["notes/tea.md"]},
            {"scope": ["customer:42"], "path": ["tone.md"]},
            {"scope": [""], "path": ["notes/tea.md"]}])
        self.assertEqual(Stub.seen[4][3], {"content": "Formal."})

        async def go():
            async with AsyncRuntime(api_key="rk_test", base_url=self.url, max_retries=2) as runtime:
                page = await runtime.agents.memory.list("dev")
                files = await page.to_list()
                deleted = await runtime.agents.memory.delete("dev", "x.md", scope="customer:42")
                return page.usage, files, deleted
        usage, files, deleted = asyncio.run(go())
        self.assertEqual((usage, len(files), deleted), (USAGE, 2, True))

    def test_refusals_are_the_sdks_own_errors(self):
        for mode, (status, code, kind) in REFUSALS.items():
            Stub.seen, Stub.mode = [], mode
            with self.client() as runtime, instant_sleeps() as slept:
                with self.assertRaises(kind) as caught:
                    runtime.agents.start("dev", "hi")
            self.assertEqual((caught.exception.code, caught.exception.status), (code, status))
            # A 429 is retried as every product's is (with the same key), after
            # its back-offs; the rest are refused once.
            self.assertEqual(len(Stub.seen), 3 if status == 429 else 1, mode)
            self.assertEqual(len(slept), 2 if status == 429 else 0, mode)

    def test_templates_are_the_guides_and_merge_a_use_over_a_harness(self):
        with self.client() as runtime:
            templates = runtime.agents.templates
            self.assertEqual(list(templates), ["claude-code", "codex", "gemini-cli", "claude-agent-sdk",
                                               "openai-agents-sdk", "review", "judge", "browser"])
            # The reviewer's model keys are its pool of Claude accounts.
            self.assertEqual(templates.definition("review")["pool"], ["ANTHROPIC_API_KEY"])
            self.assertEqual(templates.definition("review", "team")["vcpu"], 4)
            if GUIDE.exists():
                guide = json.loads(GUIDE.read_text())
                self.assertEqual({"templates": dict(templates), "uses": templates.uses}, guide)
            definition = templates.definition("claude-code", use="support")
            self.assertEqual(definition, {**templates["claude-code"]["definition"], "template": "support", "vcpu": 1,
                                          "memoryMiB": 1024, "idlePauseSeconds": 10, "maxConcurrent": 1000})
            definition["vcpu"] = 16
            self.assertEqual(templates.definition("codex"), {"command": templates["codex"]["command"],
                                                             "secrets": ["OPENAI_API_KEY"]})
            self.assertEqual(templates.definition("claude-code", "support")["vcpu"], 1)
            self.assertEqual(templates.definition("gemini-cli", "team")["memoryMiB"], 8192)
            for template, use in (("nope", None), ("codex", "nope")):
                with self.assertRaises(InvalidRequestError):
                    templates.definition(template, use)
        self.assertEqual(Stub.seen, [])

    def test_trace_reads_the_sessions_turns_and_tool_calls_or_opentelemetry(self):
        with self.client() as runtime:
            session = runtime.agents.sessions.get(SESSION_ID)
            trace = session.trace()
            self.assertEqual((trace["totals"]["costUsd"], trace["spans"][0]["model"]), (0.084, "claude-opus-5-5"))
            self.assertIsNone(trace["nextAfter"])
            otlp = session.trace(format="otlp", after=7, limit=500)
            self.assertEqual(otlp["resourceSpans"][0]["scopeSpans"][0]["spans"][0]["name"], "invoke_agent dev")
            with self.assertRaises(InvalidRequestError):
                session.trace(format="xml")
        base = f"/v1/agents/sessions/{SESSION_ID}"
        self.assertEqual(self.routes(), [("GET", base), ("GET", f"{base}/trace"), ("GET", f"{base}/trace")])
        self.assertEqual([s[2] for s in Stub.seen[1:]], [{"format": ["json"], "after": ["0"]},
                                                          {"format": ["otlp"], "after": ["7"], "limit": ["500"]}])

        async def go():
            async with AsyncRuntime(api_key="rk_test", base_url=self.url, max_retries=2) as runtime:
                return await (await runtime.agents.sessions.get(SESSION_ID)).trace()
        self.assertEqual(asyncio.run(go())["totals"]["turns"], 1)

    def test_async_clients_await_and_iterate_the_same_way(self):
        Stub.pages = [{"data": [event(1), event(2)], "ended": True}, {"data": [], "ended": True}]
        Stub.states = ["done"]

        async def go():
            async with AsyncRuntime(api_key="rk_test", base_url=self.url, max_retries=2) as runtime:
                await runtime.agents.create("dev", runtime.agents.templates.definition("codex", "team"))
                ids = [a["id"] async for a in await runtime.agents.list()]
                handle = await runtime.agents.start("dev", "go")
                seq = await handle.send("more")
                events = [e["seq"] async for e in handle.events()]
                ended = await handle.wait()
                triggers = await runtime.agents.triggers.list("dev")
                sessions = await (await runtime.agents.sessions.list()).to_list()
                children = await (await handle.children()).to_list()
                return ids, seq, events, ended, triggers, sessions + children
        ids, seq, events, ended, triggers, sessions = asyncio.run(go())
        self.assertEqual(ids, [AGENT_ID, "second"])
        self.assertEqual((seq, events, ended["state"]), (7, [1, 2], "done"))
        self.assertEqual((len(triggers), len(sessions)), (1, 4))
        self.assertEqual([s[2] for s in Stub.seen if s[1] == "/v1/agents/sessions"][2:],
                         [{"parent": [SESSION_ID]}, {"parent": [SESSION_ID], "cursor": ["page-2"]}])
        self.assertEqual(Stub.seen[0][3]["definition"]["template"], "team")

    def test_an_async_workflow_follows_and_waits_the_same_way(self):
        async def go():
            async with AsyncRuntime(api_key="rk_test", base_url=self.url, max_retries=2) as runtime:
                flow = await runtime.agents.workflows.run({"agent": "dev", "phases": []})
                versions = [w["version"] async for w in flow.follow()]
                steps = await (await flow.steps()).to_list()
                return versions, (await flow.wait())["result"], steps
        versions, result, steps = asyncio.run(go())
        self.assertEqual((versions, result, steps), ([2, 3], '["X", "Y"]', [STEP]))


if __name__ == "__main__":
    unittest.main()


class AnthropicOptionsTest(unittest.TestCase):
    def test_anthropic_is_the_options_anthropics_sdk_takes(self):
        for client in (Runtime(api_key="rk_test", base_url="https://api.example.test"),
                       AsyncRuntime(api_key="rk_test", base_url="https://api.example.test")):
            self.assertEqual(client.agents.anthropic(),
                             {"base_url": "https://api.example.test/anthropic", "api_key": "rk_test"})
