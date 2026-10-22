# ``runtime.builds``: a connected repository built at a ref, for an App to
# deploy. Private beta: an account outside it is refused with
# PermissionDeniedError, code ``product_in_beta`` (403), and retrying does not
# change it.
#
#     repo = await runtime.builds.repositories.connect(
#         provider="github", repository="acme/web", deploy=f"app:{app['id']}", start_command="bun start")
#     build = await runtime.builds.create(repo["id"], "main")
#     async for event in runtime.builds.logs(build["id"], follow=True):
#         print(event.get("text", event))
from __future__ import annotations

from typing import Any, AsyncIterator, Optional
from urllib.parse import quote

from .._errors import ConnectionError, RuntimeError
from .apps import _UNSET, _cursor, _failure, _fields

# A build is done once it is one of these.
BUILD_ENDED = frozenset({"succeeded", "failed", "cancelled", "superseded"})
# How long a follow runs by default, reconnections included.
FOLLOW_SECONDS = 120


def _enc(value: str) -> str:
    return quote(value, safe="")


async def _sleep(seconds: float) -> None:
    from .._async_client import sleep  # here, not at the top: that module imports this one
    await sleep(seconds)


def _invalid(cursor: Optional[str], hint: str = "Retry the log from the last received cursor.") -> RuntimeError:
    return _failure("build_log_invalid", hint, cursor)


def _failing_step(value: Any) -> bool:
    if value is None:
        return True
    if not isinstance(value, dict):
        return False
    lines = value.get("lastLines")
    code = value.get("exitCode")
    return (isinstance(value.get("name"), str)
            and (code is None or (isinstance(code, int) and not isinstance(code, bool)))
            and isinstance(lines, list) and len(lines) <= 20 and all(isinstance(line, str) for line in lines))


class AsyncRepositories:
    """``runtime.builds.repositories`` (private beta): what builds, and where its
    builds deploy."""

    def __init__(self, t: Any) -> None:
        self._t = t

    async def connect(self, *, provider: str, repository: str, deploy: str,
                      production_branch: Optional[str] = None, previews: Optional[bool] = None,
                      root_directory: Optional[str] = None, install_command: Optional[str] = None,
                      build_command: Optional[str] = None, start_command: Optional[str] = None,
                      port: Optional[int] = None, health_path: Optional[str] = None,
                      build_env: Optional[dict[str, str]] = None, name: Optional[str] = None,
                      labels: Optional[dict[str, str]] = None,
                      idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Connect a repository: ``provider`` ``github`` (read through Runtime's
        GitHub App, see ``install_github``) or ``git`` (a public URL), and
        ``deploy`` ``app:<id>``, ``function:<id>`` or ``container:<id>``. Every
        push to ``production_branch`` builds and deploys it. ``install_command``
        is chosen by the lockfile when left out; ``start_command`` runs after the
        build with PORT set, and the build ends as that server, saved with its
        memory. ``build_env`` is never a secret: anyone who reads the repository
        sees it."""
        body = _fields(provider=provider, repository=repository, deploy=deploy,
                       production_branch=production_branch, previews=previews, root_directory=root_directory,
                       install_command=install_command, build_command=build_command,
                       start_command=start_command, port=port, health_path=health_path, build_env=build_env,
                       name=name, labels=labels)
        return await self._t.json("POST", "/v1/repositories", body=body, idempotency_key=idempotency_key)

    async def list(self, *, name: Optional[str] = None, label: Optional[list[str]] = None,
                   state: Optional[list[str]] = None, limit: Optional[int] = None) -> AsyncPage:
        """Connected repositories; ``state`` ``connected`` or ``disconnected``.
        ``async for`` walks every page."""
        from .._async_client import AsyncPage
        query = {"name": name, "label": label, "state": state, "limit": limit}

        async def fetch(cursor: Optional[str]) -> AsyncPage:
            body = await self._t.json("GET", "/v1/repositories", query={**query, "cursor": cursor})
            return AsyncPage(body["data"], body.get("nextCursor"), fetch)
        return await fetch(None)

    async def update(self, repository_id: str, *, repository: Optional[str] = None, deploy: Optional[str] = None,
                     production_branch: Optional[str] = None, previews: Optional[bool] = None,
                     root_directory: Optional[str] = None, install_command: Optional[str] = _UNSET,
                     build_command: Optional[str] = _UNSET, start_command: Optional[str] = _UNSET,
                     port: Optional[int] = None, health_path: Optional[str] = _UNSET,
                     build_env: Optional[dict[str, str]] = None, name: Optional[str] = _UNSET,
                     labels: Optional[dict[str, str]] = None,
                     idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Change its settings in place; its id and builds stay. A field left out
        stays; None clears ``name``, the commands and ``health_path``."""
        body = _fields(repository=repository, deploy=deploy, production_branch=production_branch,
                       previews=previews, root_directory=root_directory, port=port, build_env=build_env,
                       labels=labels)
        for field, value in (("name", name), ("installCommand", install_command), ("buildCommand", build_command),
                             ("startCommand", start_command), ("healthPath", health_path)):
            if value is not _UNSET:
                body[field] = value
        return await self._t.json("POST", f"/v1/repositories/{_enc(repository_id)}:update", body=body,
                                  idempotency_key=idempotency_key)

    async def disconnect(self, repository_id: str, *, idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Stop building it; its builds stay readable."""
        return await self._t.json("DELETE", f"/v1/repositories/{_enc(repository_id)}",
                                  idempotency_key=idempotency_key)

    async def install_github(self) -> dict[str, Any]:
        """A link (``url``, ``expiresAt``) to install Runtime's GitHub App, so
        private repositories build. Open it in a browser within 15 minutes and
        choose the repositories Runtime may read; then ``connect`` with
        provider ``github``."""
        return await self._t.json("POST", "/v1/repositories/github:install")


class AsyncBuilds:
    """``runtime.builds`` (private beta). Times are Unix milliseconds."""

    def __init__(self, t: Any) -> None:
        self._t = t
        self.repositories = AsyncRepositories(t)

    async def create(self, repository_id: str, ref: str, *, branch: Optional[str] = None,
                     name: Optional[str] = None, labels: Optional[dict[str, str]] = None,
                     idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Build a connected repository at ``ref`` (a branch, tag or commit).
        With ``branch``, the same branch and commit is one build, and a newer
        build of the branch supersedes older ones not yet ended."""
        body = _fields(repository_id=repository_id, ref=ref, branch=branch, name=name, labels=labels)
        return await self._t.json("POST", "/v1/builds", body=body, idempotency_key=idempotency_key)

    async def get(self, build_id: str) -> dict[str, Any]:
        return await self._t.json("GET", f"/v1/builds/{_enc(build_id)}")

    async def list(self, *, name: Optional[str] = None, label: Optional[list[str]] = None,
                   state: Optional[list[str]] = None, limit: Optional[int] = None) -> AsyncPage:
        """Your builds, filtered by ``name``, ``label`` and ``state``.
        ``async for`` walks every page."""
        from .._async_client import AsyncPage
        query = {"name": name, "label": label, "state": state, "limit": limit}

        async def fetch(cursor: Optional[str]) -> AsyncPage:
            body = await self._t.json("GET", "/v1/builds", query={**query, "cursor": cursor})
            return AsyncPage(body["data"], body.get("nextCursor"), fetch)
        return await fetch(None)

    async def cancel(self, build_id: str, *, idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Cancel it; a build already ended stays as it is."""
        return await self._t.json("POST", f"/v1/builds/{_enc(build_id)}:cancel", idempotency_key=idempotency_key)

    def logs(self, build_id: str, *, follow: bool = False, cursor: Optional[str] = None,
             page_cursor: Optional[str] = None, timeout: float = FOLLOW_SECONDS) -> Any:
        """Without ``follow``: ``await`` the last 200 lines, the state, and the
        failing step once one failed; ``page_cursor`` pages older lines. With
        ``follow=True``: ``async for`` each event as it comes, ``line``, ``gap``
        (lines too old to keep) and last ``terminal``, resuming after ``cursor``.
        A follow lasts at most ``timeout`` seconds, reconnections included (0:
        no deadline); an error's ``details["cursor"]`` is where to resume."""
        if follow:
            return self._follow(build_id, cursor, page_cursor, timeout)
        return self._log(build_id, cursor, page_cursor)

    async def _log(self, build_id: str, cursor: Optional[str], page_cursor: Optional[str]) -> dict[str, Any]:
        return await self._t.json("GET", f"/v1/builds/{_enc(build_id)}/logs",
                                  query={"cursor": cursor, "pageCursor": page_cursor})

    async def _follow(self, build_id: str, cursor: Optional[str], page_cursor: Optional[str],
                      timeout: float) -> AsyncIterator[dict[str, Any]]:
        import time
        if (cursor is not None and not _cursor(cursor)) or page_cursor is not None:
            raise _failure("invalid_log_options",
                           "Use an opaque cursor for follow; page_cursor is only for search pages.", cursor)
        deadline = time.monotonic() + timeout if timeout > 0 else None
        # Cursors are opaque positions: a line already given is known only by its cursor.
        seen: dict[str, None] = {} if cursor is None else {cursor: None}
        failures = 0

        def ended() -> RuntimeError:
            return _failure("timeout", "The follow reached its deadline; resume from details.cursor.", cursor)

        while True:
            if deadline is not None and time.monotonic() >= deadline:
                raise ended()
            continued = False
            query: dict[str, Any] = {"follow": True, "cursor": cursor}
            try:
                async for event in self._t.events("GET", f"/v1/builds/{_enc(build_id)}/logs", query=query,
                                                  deadline=deadline):
                    if not isinstance(event, dict):
                        raise _invalid(cursor)
                    at = event.get("cursor")
                    if at is not None and not _cursor(at):
                        raise _invalid(cursor)
                    kind = event.get("type")
                    if kind == "line":
                        stamp = event.get("at")
                        if (not isinstance(event.get("text"), str) or event.get("stream") not in ("stdout", "stderr")
                                or not isinstance(stamp, int) or isinstance(stamp, bool) or stamp < 0
                                or (event.get("step") is not None and not isinstance(event.get("step"), str))
                                or not _cursor(at)):
                            raise _invalid(cursor)
                        if at in seen:
                            continue
                        seen[at] = None
                        if len(seen) > 10_000:
                            del seen[next(iter(seen))]
                        cursor, failures = at, 0
                        yield event
                    elif kind == "gap":
                        if not _cursor(event.get("earliestCursor")) or (cursor is not None and at != cursor):
                            raise _invalid(cursor)
                        cursor = at
                        yield event
                    elif kind == "terminal":
                        reason, step = event.get("reason"), event.get("failingStep")
                        if ((cursor is not None and at != cursor) or event.get("state") not in BUILD_ENDED
                                or not isinstance(reason, str) or not reason or not _failing_step(step)
                                or (event.get("state") != "failed" and step is not None)):
                            raise _invalid(cursor)
                        yield event
                        return
                    elif kind == "continue":
                        if cursor is not None and at != cursor:
                            raise _failure("build_log_gap",
                                           "Resume from details.cursor; report a persistent missing log line.",
                                           cursor)
                        cursor, continued = at, True
                        break
                    elif kind == "error":
                        code, hint = event.get("code"), event.get("hint")
                        if at != cursor or not isinstance(code, str) or not code \
                                or not isinstance(hint, str) or not hint:
                            raise _invalid(cursor)
                        raise _failure(code, hint, cursor)
                    else:
                        raise _invalid(cursor)
            except ValueError as error:
                raise _invalid(cursor, "The log contained invalid JSON; retry from details.cursor.") from error
            except ConnectionError:
                # Lost the connection: reconnect from the last line. HTTP refusals
                # and protocol errors are the caller's to act on; the transport
                # already retried the retryable ones.
                if deadline is not None and time.monotonic() >= deadline:
                    raise ended()
            except RuntimeError as error:
                if error.code == "request_timeout" and deadline is not None and time.monotonic() >= deadline:
                    raise ended() from error
                raise
            if not continued:
                failures += 1
                if failures > 3:
                    raise _failure("build_log_interrupted",
                                   "Reconnect with logs(id, follow=True, cursor=details['cursor']).", cursor)
            # A service gone or answering continue at once must not spin.
            await _sleep(0.05 * max(1, failures))
