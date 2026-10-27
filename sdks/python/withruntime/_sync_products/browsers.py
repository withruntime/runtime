"""GENERATED from _async_products/browsers.py by scripts/generate_sync.py. Do not edit."""
# ``runtime.browsers``: a task in plain words, done by an agent that browses,
# in a sandbox with Chromium (POST /v1/browsers/runs). Private beta: an
# account outside it is refused with PermissionDeniedError, code
# ``product_in_beta`` (403).
#
#     run = runtime.browsers.run("Find the price of the cheapest plan on withruntime.com")
#     print(run["state"], run["output"] or run["error"])
#     for step in runtime.browsers.runs.follow(run["id"]):   # its recording
#         print(step["n"], step["url"], len(step["frame"] or ""))
#
# The model's key is your egress secret: ANTHROPIC_API_KEY for claude- models
# (the default, claude-sonnet-5-5), OPENAI_API_KEY for gpt- and o-series,
# GEMINI_API_KEY for gemini-. A run is billed as its sandbox's time, at the
# sandbox rates; the model's use is on your key.
#
# A run: id, state (queued, running, done, failed or stopped), task, model,
# startUrl, output (the answer, once done), error (why it failed, and what
# to do), steps, url (the page it ended on), sandboxId, labels, createdAt,
# startedAt and endedAt (ISO 8601). A step: n (0 is the page before the first
# step; the last, the page at the end), url, title, goal, actions, frame (the
# page as a base64 JPEG), at and seq.
from __future__ import annotations

from typing import Any, Iterator, Optional

from .apps import _enc, _fields

# Each read of a run's steps waits up to this long on the server for one.
STEPS_WAIT_SECONDS = 30
RUN_ENDED = ("done", "failed", "stopped")


class BrowserRuns:
    """``runtime.browsers.runs``, at /v1/browsers/runs."""

    _base = "/v1/browsers/runs"

    def __init__(self, t: Any) -> None:
        self._t = t

    def create(self, task: str, *, start_url: Optional[str] = None, model: Optional[str] = None,
                     max_steps: Optional[int] = None, allowed_domains: Optional[list[str]] = None,
                     labels: Optional[dict[str, str]] = None,
                     idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Start a run and return it at once (state queued). ``start_url`` is
        opened before the first step; ``max_steps`` is 1 to 200 (default 30);
        ``allowed_domains`` limits the pages it opens."""
        body = _fields(task=task, start_url=start_url, model=model, max_steps=max_steps,
                       allowed_domains=allowed_domains, labels=labels)
        return self._t.json("POST", self._base, body=body, idempotency_key=idempotency_key)

    def get(self, run_id: str) -> dict[str, Any]:
        """One run: its state, output or error, and its steps so far."""
        return self._t.json("GET", f"{self._base}/{_enc(run_id)}")

    def list(self, *, limit: Optional[int] = None) -> Any:
        """Runs, newest first; ``for`` walks every page."""
        from .._sync_client import Page

        def fetch(cursor: Optional[str]) -> Any:
            body = self._t.json("GET", self._base, query={"limit": limit, "cursor": cursor})
            return Page(body["data"], body.get("nextCursor"), fetch)
        return fetch(None)

    def steps(self, run_id: str, *, after: int = 0, limit: Optional[int] = None,
                    frames: Optional[bool] = None, wait: Optional[int] = None) -> dict[str, Any]:
        """One page of its steps after seq ``after``: {data, after, ended}.
        ``wait`` (seconds, up to 30) waits on the server for a step."""
        return self._t.json("GET", f"{self._base}/{_enc(run_id)}/steps",
                                  query={"after": after, "limit": limit, "frames": frames, "wait": wait})

    def follow(self, run_id: str, *, after: int = 0, frames: bool = True) -> Iterator[dict[str, Any]]:
        """``async for`` each step as it comes, until the run ends: its
        recording. Each read waits on the server, not a timer."""
        while True:
            page = self.steps(run_id, after=after, wait=STEPS_WAIT_SECONDS,
                                    frames=None if frames else False)
            data = page.get("data") or []
            for step in data:
                yield step
            after = int(page.get("after") or after)
            if page.get("ended") and not data:
                return

    def stop(self, run_id: str) -> dict[str, Any]:
        """Stop it; its sandbox is deleted and its steps are kept."""
        return self._t.json("POST", f"{self._base}/{_enc(run_id)}:stop", body={})

    def wait(self, run_id: str) -> dict[str, Any]:
        """The run once it has ended (done, failed or stopped; a failed run is
        returned, not raised: read ``error``)."""
        run = self.get(run_id)
        if run["state"] in RUN_ENDED:
            return run
        for _ in self.follow(run_id, frames=False):
            pass
        return self.get(run_id)


class Browsers:
    """``runtime.browsers`` (private beta): browser runs. ``run`` starts one
    and waits for its end; ``runs`` starts, reads, follows and stops them."""

    def __init__(self, t: Any) -> None:
        self._t = t
        self.runs = BrowserRuns(t)

    def run(self, task: str, *, start_url: Optional[str] = None, model: Optional[str] = None,
                  max_steps: Optional[int] = None, allowed_domains: Optional[list[str]] = None,
                  labels: Optional[dict[str, str]] = None) -> dict[str, Any]:
        """Do ``task`` in a browser and return the run once it has ended:
        ``output`` once done, ``error`` once failed."""
        started = self.runs.create(task, start_url=start_url, model=model, max_steps=max_steps,
                                         allowed_domains=allowed_domains, labels=labels)
        return self.runs.wait(started["id"])
