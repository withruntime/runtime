# ``runtime.ci``: CI/CD (beta). A connected repository's checks run as jobs in
# sandboxes. Private beta: an account outside it is refused with
# PermissionDeniedError, code ``product_in_beta`` (403), and retrying does not
# change it. Times are Unix milliseconds.
#
#     repo = await runtime.ci.repositories.connect("acme/web")
#     page = await runtime.ci.checks.list(repository_id=repo["id"], state=["failed"])
#     check = await runtime.ci.checks.get(page.data[0]["id"])
#     job = await runtime.ci.jobs.get(check["jobs"][0]["id"])
#     print(job["log"])
from __future__ import annotations

from typing import Any, Optional
from urllib.parse import quote

from .apps import _fields


def _enc(value: str) -> str:
    return quote(value, safe="")


class AsyncCiRepositories:
    """``runtime.ci.repositories``: the repositories whose checks run."""

    def __init__(self, t: Any) -> None:
        self._t = t

    async def connect(self, repository: str, *, production_branch: Optional[str] = None,
                      config_path: Optional[str] = None, installation: Optional[int] = None,
                      name: Optional[str] = None, labels: Optional[dict[str, str]] = None,
                      idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Connect ``owner/name``, read through Runtime's GitHub App. Pushes and
        pull requests then run the checks written in ``config_path`` (default
        ``runtime.yml``); ``production_branch`` defaults to ``main``;
        ``installation`` is the GitHub App installation to read it through
        (the newest when left out)."""
        body = _fields(repository=repository, production_branch=production_branch, config_path=config_path,
                       installation=installation, name=name, labels=labels)
        return await self._t.json("POST", "/v1/ci/repositories", body=body, idempotency_key=idempotency_key)

    async def list(self, *, name: Optional[str] = None, labels: Optional[list[str]] = None,
                   state: Optional[list[str]] = None, limit: Optional[int] = None,
                   cursor: Optional[str] = None) -> AsyncPage:
        """Connected repositories; ``labels`` are ``key:value``, ``state`` is
        ``connected`` or ``disconnected``. ``async for`` walks every page."""
        from .._async_client import AsyncPage
        query = {"name": name, "label": labels, "state": state, "limit": limit}

        async def fetch(at: Optional[str]) -> AsyncPage:
            body = await self._t.json("GET", "/v1/ci/repositories", query={**query, "cursor": at})
            return AsyncPage(body["data"], body.get("nextCursor"), fetch)
        return await fetch(cursor)

    async def set_undo(self, repository_id: str, on: bool, *,
                       idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Turn on (or off) the undo of a red production branch's culprit:
        when main's check fails, CI/CD finds the first commit that fails it
        and opens a pull request reverting it, which lands once its own check
        passes. Off until set; only an owner's or admin's full key sets it."""
        return await self._t.json("POST", f"/v1/ci/repositories/{_enc(repository_id)}:update",
                                  body={"undoCulprits": on}, idempotency_key=idempotency_key)

    async def disconnect(self, repository_id: str, *, idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Stop running its checks; the checks already run stay readable."""
        return await self._t.json("DELETE", f"/v1/ci/repositories/{_enc(repository_id)}",
                                  idempotency_key=idempotency_key)


class AsyncCiChecks:
    """``runtime.ci.checks``: one run of a commit's jobs."""

    def __init__(self, t: Any) -> None:
        self._t = t

    async def list(self, *, repository_id: Optional[str] = None, state: Optional[list[str]] = None,
                   branch: Optional[str] = None, commit: Optional[str] = None,
                   pull_request: Optional[int] = None, limit: Optional[int] = None,
                   cursor: Optional[str] = None) -> AsyncPage:
        """Checks, newest first. ``state`` is any of ``queued``, ``running``,
        ``passed``, ``failed``, ``cancelled``; ``commit`` is a full sha.
        ``async for`` walks every page."""
        from .._async_client import AsyncPage
        query = {"repositoryId": repository_id, "state": state, "branch": branch, "commit": commit,
                 "pullRequest": pull_request, "limit": limit}

        async def fetch(at: Optional[str]) -> AsyncPage:
            body = await self._t.json("GET", "/v1/ci/checks", query={**query, "cursor": at})
            return AsyncPage(body["data"], body.get("nextCursor"), fetch)
        return await fetch(cursor)

    async def get(self, check_id: str) -> dict[str, Any]:
        """The check with its ``jobs`` in plan order (no log)."""
        return await self._t.json("GET", f"/v1/ci/checks/{_enc(check_id)}")

    async def cancel(self, check_id: str) -> dict[str, Any]:
        """Cancel a queued or running check: its jobs end and its machines are
        let go. A check that has ended is answered as it is."""
        return await self._t.json("POST", f"/v1/ci/checks/{_enc(check_id)}:cancel")


class AsyncCiJobs:
    """``runtime.ci.jobs``: one command of a check, run in sandboxes."""

    def __init__(self, t: Any) -> None:
        self._t = t

    async def get(self, job_id: str) -> dict[str, Any]:
        """The job with its ``log`` (the tail, at most 256 KiB). A failed job's
        ``sandboxIds`` may be kept paused: wake one or exec in it with
        ``runtime.sandboxes``. A review step's job has its ``review``: the
        ``verdict`` (pass or block), ``summary``, ``findings`` (``kind``,
        ``file``, ``line``, ``what``, ``fix``), ``notes``, and the ``agent``,
        ``account``, ``model`` and ``session`` that gave it; None otherwise."""
        return await self._t.json("GET", f"/v1/ci/jobs/{_enc(job_id)}")


class AsyncCiTests:
    """``runtime.ci.tests``: a repository's test files and their recent runs."""

    def __init__(self, t: Any) -> None:
        self._t = t

    async def list(self, repository_id: str, *, quarantined: Optional[bool] = None,
                   limit: Optional[int] = None, cursor: Optional[str] = None) -> AsyncPage:
        """Test files by name, each with its time, last runs and whether it is
        quarantined (its failures do not fail a check). ``async for`` walks
        every page."""
        from .._async_client import AsyncPage
        query = {"repositoryId": repository_id, "quarantined": quarantined, "limit": limit}

        async def fetch(at: Optional[str]) -> AsyncPage:
            body = await self._t.json("GET", "/v1/ci/tests", query={**query, "cursor": at})
            return AsyncPage(body["data"], body.get("nextCursor"), fetch)
        return await fetch(cursor)


class AsyncCiFlakes:
    """``runtime.ci.flakes``: tests that passed and failed on the same inputs.

    Each is quarantined at once (it still runs and reports, and blocks
    nothing), or still gating when the repository protects it; handed to an
    owner with 48 hours to fix it or delete it with a reason; fixed once 100
    runs of a main commit in parallel forks all pass."""

    def __init__(self, t: Any) -> None:
        self._t = t

    async def list(self, *, repository_id: Optional[str] = None, state: Optional[list[str]] = None,
                   limit: Optional[int] = None, cursor: Optional[str] = None) -> AsyncPage:
        """Flaky tests, newest first. ``state`` is any of ``quarantined``,
        ``gating``, ``fixed``, ``deleted`` (the first two are the open ones).
        ``async for`` walks every page."""
        from .._async_client import AsyncPage
        query = {"repositoryId": repository_id, "state": state, "limit": limit}

        async def fetch(at: Optional[str]) -> AsyncPage:
            body = await self._t.json("GET", "/v1/ci/flakes", query={**query, "cursor": at})
            return AsyncPage(body["data"], body.get("nextCursor"), fetch)
        return await fetch(cursor)

    async def get(self, flake_id: str) -> dict[str, Any]:
        """The flake with its test file's newest 200 ``runs`` (by commit and
        content key) and its ``failures``' jobs, whose logs ``jobs.get`` reads."""
        return await self._t.json("GET", f"/v1/ci/flakes/{_enc(flake_id)}")

    async def update(self, flake_id: str, *, prove: Optional[bool] = None, owner: Optional[str] = None,
                     delete_reason: Optional[str] = None,
                     idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """``prove=True`` asks for its 100 proof runs at main's next commit;
        ``owner`` hands it to a GitHub login or ``org/team``; ``delete_reason``
        says why its test is deleted (it ends once main no longer holds the
        file)."""
        body = _fields(prove=prove, owner=owner, delete_reason=delete_reason)
        return await self._t.json("POST", f"/v1/ci/flakes/{_enc(flake_id)}:update", body=body,
                                  idempotency_key=idempotency_key)


class AsyncCiReleases:
    """``runtime.ci.releases``: the steps each release took, as it took them:
    a migration's copy test or apply, a deploy ref moved, a server's canary or
    release, the website's deploy or promote, or a wait and why. Only
    repositories whose releases CI/CD runs have any."""

    def __init__(self, t: Any) -> None:
        self._t = t

    async def list(self, *, repository_id: Optional[str] = None, commit: Optional[str] = None,
                   limit: Optional[int] = None, cursor: Optional[str] = None) -> AsyncPage:
        """Steps, newest first: each ``commit``, ``source`` (``mover`` or the
        deploy target that walked it), ``host`` (or None), ``line`` and ``at``
        (Unix ms). ``commit`` keeps one release's. ``async for`` walks every
        page."""
        from .._async_client import AsyncPage
        query = {"repositoryId": repository_id, "commit": commit, "limit": limit}

        async def fetch(at: Optional[str]) -> AsyncPage:
            body = await self._t.json("GET", "/v1/ci/releases", query={**query, "cursor": at})
            return AsyncPage(body["data"], body.get("nextCursor"), fetch)
        return await fetch(cursor)


class AsyncCi:
    """``runtime.ci``: CI/CD (private beta)."""

    def __init__(self, t: Any) -> None:
        self._t = t
        self.repositories = AsyncCiRepositories(t)
        self.checks = AsyncCiChecks(t)
        self.jobs = AsyncCiJobs(t)
        self.tests = AsyncCiTests(t)
        self.flakes = AsyncCiFlakes(t)
        self.releases = AsyncCiReleases(t)
