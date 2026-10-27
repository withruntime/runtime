"""GENERATED from _async_products/secrets.py by scripts/generate_sync.py. Do not edit."""
# ``runtime.secrets``: secrets your sandboxes use without seeing them, and that
# scheduled jobs put into their environment.
#
#     runtime.secrets.set("OPENAI_API_KEY", value=key, hosts=["api.openai.com"])
#
# Every sandbox of your organization then has ``OPENAI_API_KEY`` set to a
# placeholder. The egress proxy swaps in the value on HTTPS requests to the
# hosts in a credential header (Authorization, x-api-key, x-goog-api-key and a
# few more), or, with ``header``, sets that header on every request to them;
# never in the URL or another header. That value is sealed and never returned
# by anything.
#
#     runtime.secrets.set("DB_PASSWORD", value=password, jobs=True)
#
# keeps a copy scheduled jobs can bind: runtime.jobs.create(..., secrets=[...]).
#
#     runtime.secrets.set("DATABASE_PASSWORD", value=password, exposed=True,
#                               only={"sandboxes": [sandbox_id]})
#
# gives those sandboxes the value itself instead of a placeholder, for what is
# not an HTTPS header: a database password, an SSH key.
from __future__ import annotations

from typing import Any, Optional, TypedDict
from urllib.parse import quote

from .._errors import ConflictError, InvalidRequestError, NotFoundError, RuntimeError, SecretPartlyStoredError
from .jobs import switched_off


class SecretScope(TypedDict, total=False):
    """Which sandboxes get a secret: those whose labels hold every pair of any
    one selector in ``labels`` (1 to 8 selectors of 1 to 8 pairs, including
    sandboxes created or labelled later), those named in ``sandboxes``
    (1 to 100 ids), and every copy of the Apps named in ``apps`` (1 to 100
    App ids, any version a key that may reveal secrets deployed). A secret as
    returned carries it as ``only``; absent means every sandbox of the
    organization."""
    labels: list[dict[str, str]]
    sandboxes: list[str]
    apps: list[str]


class _RulePaths(TypedDict):
    paths: list[str]


class SecretRule(_RulePaths, total=False):
    """Which requests to a secret's hosts carry it: ``methods`` (every method
    when absent) and ``paths``, each exact or a prefix ending in ``/*``."""
    methods: list[str]


class _GithubAppIds(TypedDict):
    id: int
    installation: int


class SecretGithubApp(_GithubAppIds, total=False):
    """A GitHub App the servers act as: ``id`` is the App's id and
    ``installation`` the installation's id. ``repositories`` are the
    repositories each token reaches, by name (every repository of the
    installation when absent). ``permissions`` is what each token may do, such
    as ``{"contents": "write"}`` (``read``, ``write`` or ``admin``), at most
    what the App holds (all of them when absent). ``api`` is the App's API on
    GitHub Enterprise Server (``https://<host>/api/v3``; one of the secret's
    hosts); default ``https://api.github.com``."""
    repositories: list[str]
    permissions: dict[str, str]
    api: str


class SecretGit(TypedDict):
    """What a git push over HTTPS carrying the secret may update. ``push`` are
    the branches: ``refs/heads/`` then a name, with ``*`` only at the end for
    any name that begins so, and ``{label.<key>}`` for the sandbox's own label
    of that key (a sandbox without it pushes nothing it names). Empty: no push
    at all."""
    push: list[str]


class _GraphqlMutations(TypedDict):
    mutations: list[str]


class SecretGraphql(_GraphqlMutations, total=False):
    """``mutations`` a request may make; any other is refused with 403. A query
    always goes. ``path`` is where GraphQL is served (default ``/graphql``)."""
    path: str


class SecretApiPolicy(TypedDict, total=False):
    """Each sandbox's hour with the secret, the far end's reserve, GraphQL's
    mutations and shared copies. ``callsPerHour`` is the most requests each
    sandbox makes with the secret in an hour (past it, 429 with ``Retry-After``).
    ``writesPerHour`` is the most writes (any method but GET, HEAD and OPTIONS;
    a GraphQL mutation); 0 is none. ``keep`` is the calls the far end keeps for
    others: none is sent while its ``x-ratelimit-remaining`` says this many or
    fewer are left, until its reset. ``copies`` answers reads (GET over HTTP/2)
    from the server's copy while the far end answers 304 to its ETag, shared by
    every sandbox the secret reaches on that server. ``fresh`` (1 to 300, with
    ``copies``) is the seconds a copy is answered without asking the far end,
    GraphQL queries included."""
    callsPerHour: int
    writesPerHour: int
    keep: int
    copies: bool
    fresh: int
    graphql: SecretGraphql


def _unavailable(error: Exception) -> bool:
    return isinstance(error, RuntimeError) and (error.code == "unavailable" or error.status in (501, 503))


class Secrets:
    """``runtime.secrets``: one secret by name, kept where its value may go.
    With ``hosts``, sandboxes see a placeholder and the egress proxy adds the
    value on HTTPS to those hosts; that copy is never readable. With
    ``exposed=True`` instead of ``hosts``, the sandboxes and Apps ``only``
    names by id get the value itself. With
    ``jobs=True``, a copy scheduled jobs put into their run's environment; that
    copy belongs to the person whose key stored it, holds up to 64 KiB, is
    versioned, and can be read back with ``reveal``."""

    def __init__(self, t: Any) -> None:
        self._t = t

    def _store(self, *args: Any, **kwargs: Any) -> Any:
        try:
            return self._t.json(*args, **kwargs)
        except RuntimeError as error:
            raise switched_off("Secrets for jobs", error) from error

    def _job_copies(self) -> list[dict[str, Any]]:
        copies: list[dict[str, Any]] = []
        after: Optional[str] = None
        while True:
            page = self._store("GET", "/v1/secrets", query={"limit": 100, "after": after})
            copies.extend(page)
            if len(page) < 100:
                return copies
            after = page[-1]["id"]

    def _live(self, name: str) -> Optional[dict[str, Any]]:
        return next((c for c in self._job_copies() if c["name"] == name and c.get("deletedAt") is None), None)

    def _rotate(self, live: dict[str, Any], value: str, version: int, key: Optional[str]) -> dict[str, Any]:
        return self._store("POST", f"/v1/secrets/{quote(live['id'], safe='')}:rotate",
                                 body={"value": value, "expectedVersion": version}, idempotency_key=key)

    def _rotate_or_replay(self, live: dict[str, Any], value: str, key: Optional[str],
                                created: Optional[str] = None) -> dict[str, Any]:
        """Rotates from the version the copy has now. A key used before, by
        this same call whose answer was lost, is answered by the identical
        request again, with no second rotation: a set's create (``created``
        names it), or the rotate from the version before. Until 10 October
        2026 the retry changed its request and was refused as a conflict."""
        try:
            return self._rotate(live, value, live["version"], key)
        except RuntimeError as error:
            if error.code != "idempotency_conflict":
                raise
            replays = []
            if created is not None:
                replays.append(lambda: self._store("POST", "/v1/secrets", body={"name": created, "value": value},
                                                   idempotency_key=key))
            if live["version"] > 1:
                replays.append(lambda: self._rotate(live, value, live["version"] - 1, key))
            for replay in replays:
                try:
                    return replay()
                except RuntimeError as again:
                    # Not this request's earlier send: a conflict, or its key
                    # held by another request (idempotency_conflict, 422; 409
                    # from an older server).
                    if again.status != 409 and again.code != "idempotency_conflict":
                        raise
            raise

    def _set_job_copy(self, name: str, value: str, key: Optional[str]) -> dict[str, Any]:
        copies = self._job_copies()
        live = next((c for c in copies if c["name"] == name and c.get("deletedAt") is None), None)
        if live is not None:
            return self._rotate_or_replay(live, value, key, created=name)
        if any(c["name"] == name for c in copies):
            raise ConflictError(f"A jobs secret named {name} was deleted, and a deleted name cannot be used again.",
                                code="name_conflict", status=409, hint="Store it under another name.",
                                details={"field": "name"})
        return self._store("POST", "/v1/secrets", body={"name": name, "value": value}, idempotency_key=key)

    def set(self, name: str, *, value: str, hosts: Optional[list[str]] = None, header: Optional[str] = None,
                  format: Optional[str] = None, rules: Optional[list[SecretRule]] = None,
                  only: Optional[SecretScope] = None, github_app: Optional[SecretGithubApp] = None,
                  git: Optional[SecretGit] = None, api: Optional[SecretApiPolicy] = None, env: Optional[str] = None,
                  exposed: bool = False, expected_version: Optional[int] = None, jobs: bool = False,
                  idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Store or replace a secret. ``value`` is visible ASCII and spaces, at
        most 8 KiB. ``hosts`` are names or ``*.domain``. ``header`` (with
        ``format``, ``{value}`` where the secret goes) sets that header on every
        request to the hosts. Replacing a secret keeps its placeholder.

        ``rules`` (paid accounts, 1 to 16) limit the value to the requests a
        rule allows, such as ``[{"methods": ["GET"], "paths": ["/repos/acme/*"]}]``.
        Paths are exact or end in ``/*``, written canonically: starting with
        ``/``, no ``.`` or ``..`` segments, no ``;`` or ``\\``, no encoded slash.
        Without rules, every request to the hosts; replacing a secret without
        rules clears them.

        ``only`` gives the secret to those sandboxes alone (see ``SecretScope``);
        ``{}`` is every sandbox of the organization again. Absent when replacing
        a secret: the scope it has stays, so a new value never widens who gets it.

        ``github_app`` makes ``value`` a GitHub App's private key (PEM, many
        lines); the servers make the App's installation tokens themselves, each
        for an hour. The key goes into no request, and each request the rules
        allow carries the current token, as ``Authorization: Bearer`` to the API
        and as git's ``x-access-token`` to git over HTTPS. It takes no ``header``
        or ``format``. ``git`` limits what a git push may update, such as
        ``{"push": ["refs/heads/task/{label.task}"]}``; a push to any other ref,
        a tag, or a delete is refused before it leaves the server. ``api`` sets
        each sandbox's hour with the secret, the far end's reserve, GraphQL's
        mutations and shared copies. The answer and ``list`` return all three
        as ``githubApp``, ``git`` and ``api``.

        ``env`` is the environment variable sandboxes see it in, when not the
        secret's name. Secrets scoped to different sandboxes may share one, such
        as one GITHUB_TOKEN per repository; a write that would put two in one
        sandbox is refused (409). Absent when replacing: the variable it has stays.

        ``exposed=True``, with no ``hosts``, gives sandboxes the value itself in
        the variable instead of a placeholder: for what is not an HTTPS header,
        such as a database password, an SSH key or a service account's JSON.
        The value may then be any text of up to 64 KiB, several lines included,
        and it takes no ``header``, ``format``, ``rules``, ``github_app``,
        ``git`` or ``api``. It needs ``only`` naming the sandboxes or Apps that
        get it by id (``{"sandboxes": [...]}``, ``{"apps": [...]}``), never
        labels or every sandbox; a replacement may leave ``only`` out to keep
        the scope it has. Which machines get it changes only with the value:
        ``scope`` is refused for it, so ``set`` it again. Code in the sandbox
        can read it and send it anywhere, and it can be in the sandbox's
        snapshots and forks; for an HTTPS API, prefer ``hosts``. It is not
        kept: give it on every write of such a secret.

        ``expected_version`` writes only if the secret is at that version (its
        ``version`` from ``get`` or ``list``; 0: it must not exist yet), or
        raises ``ConflictError`` (``version_conflict``, with the current one in
        ``details["version"]``). Each new value adds one to the version.

        ``jobs=True`` also keeps a copy scheduled jobs can use (up to 64 KiB of
        UTF-8 without ``hosts``); setting it again rotates it. With both, a jobs
        copy that fails after the sandboxes' copy is stored raises
        ``SecretPartlyStoredError``, and the same call again finishes it."""
        if not hosts and not exposed and not jobs:
            raise InvalidRequestError("Say where the value may go: hosts for sandboxes, exposed=True to give "
                                      "sandboxes the value itself, jobs=True for scheduled jobs, or both.",
                                      code="invalid_request", details={"field": "hosts"})
        saved: Optional[dict[str, Any]] = None
        if hosts or exposed:
            body: dict[str, Any] = {"value": value}
            if hosts:
                body["hosts"] = hosts
            if header is not None:
                body["header"] = header
            if format is not None:
                body["format"] = format
            if rules is not None:
                body["rules"] = rules
            if only is not None:
                body["only"] = only
            if github_app is not None:
                body["githubApp"] = github_app
            if git is not None:
                body["git"] = git
            if api is not None:
                body["api"] = api
            if env is not None:
                body["env"] = env
            if exposed:
                body["exposed"] = True
            if expected_version is not None:
                body["expectedVersion"] = expected_version
            part = f"{idempotency_key}:sandboxes"[:128] if idempotency_key and jobs else idempotency_key
            saved = self._t.json("PUT", f"/v1/egress-secrets/{quote(name, safe='')}", body=body,
                                       idempotency_key=part)
        if not jobs:
            return saved  # type: ignore[return-value]
        try:
            copy = self._set_job_copy(name, value, f"{idempotency_key}:jobs"[:128] if idempotency_key else None)
        except RuntimeError as error:
            if saved is None:
                raise
            raise SecretPartlyStoredError(
                f"Stored {name} for sandboxes, but not for jobs: {error.message}", code=error.code,
                status=error.status, request_id=error.request_id,
                hint="Run the same call again: storing it for sandboxes again changes nothing, and the jobs copy "
                     "is stored or rotated.",
                details={"stored": ["sandboxes"], "field": "jobs"}) from error
        return {**(saved or {"name": name}), "jobs": copy}

    def scope(self, name: str, only: SecretScope) -> dict[str, Any]:
        """Changes which sandboxes get a secret, without its value: ``{}`` is
        every sandbox of the organization again. Returns the secret, with
        ``only`` and ``enforced``. Refused (400) for a real-value secret
        (``exposed``), whose machines change only with its value: ``set`` it
        again with ``value``, ``exposed=True`` and ``only``."""
        return self._t.json("PUT", f"/v1/egress-secrets/{quote(name, safe='')}/sandboxes", body=only)

    def narrow(self, name: str, *, hosts: Optional[list[str]] = None,
            rules: Optional[list[SecretRule]] = None) -> dict[str, Any]:
        """Narrow a secret's ``hosts`` and/or ``rules`` without its value. Only
        strictly narrower ones are accepted; widening needs the value, so call
        ``set`` again with it."""
        body: dict[str, Any] = {}
        if hosts is not None:
            body["hosts"] = hosts
        if rules is not None:
            body["rules"] = rules
        return self._t.json("PUT", f"/v1/egress-secrets/{quote(name, safe='')}/rules", body=body)

    def list(self, *, limit: int | None = None, after: str | None = None) -> list[dict[str, Any]]:
        """The sandboxes' secrets: names, hosts, headers and placeholders. Never
        values. ``all()`` includes the jobs copies. With ``limit`` (1 to 100)
        or ``after``, one page by name: the secrets named after ``after``; the
        next page's ``after`` is this one's last name. Without, every secret."""
        secrets: list[dict[str, Any]] = []
        start = after
        while True:
            query = {key: value for key, value in (("limit", limit), ("after", start)) if value is not None}
            page = self._t.json("GET", "/v1/egress-secrets", query=query)
            secrets.extend(page["secrets"])
            if limit is not None or after is not None or not page.get("next"):
                return secrets
            start = page["next"]

    def all(self) -> list[dict[str, Any]]:
        """Every secret by name: ``{"name", "sandboxes", "jobs"}``, each copy or None."""
        sandboxes = self.list()
        try:
            copies = [c for c in self._job_copies() if c.get("deletedAt") is None]
        except RuntimeError as error:
            if not _unavailable(error):
                raise
            copies = []
        by_name: dict[str, dict[str, Any]] = {s["name"]: {"name": s["name"], "sandboxes": s, "jobs": None}
                                              for s in sandboxes}
        for c in copies:
            by_name.setdefault(c["name"], {"name": c["name"], "sandboxes": None, "jobs": None})["jobs"] = c
        return [by_name[k] for k in sorted(by_name)]

    def get(self, name: str) -> dict[str, Any]:
        """One secret by name, with where its value may go: ``{"name",
        "sandboxes", "jobs"}``, each copy or None. The sandboxes' copy carries
        its ``version`` (pass it to ``set`` as ``expected_version``) and
        ``exposed``; never its value."""
        sandboxes: Optional[dict[str, Any]] = None
        try:
            sandboxes = self._t.json("GET", f"/v1/egress-secrets/{quote(name, safe='')}")
        except NotFoundError:
            pass
        try:
            live = self._live(name)
        except RuntimeError as error:
            if not _unavailable(error):
                raise
            live = None
        if sandboxes is not None or live is not None:
            return {"name": name, "sandboxes": sandboxes, "jobs": live}
        raise NotFoundError(f"No secret named {name}.", code="not_found", status=404,
                            hint="List them with runtime.secrets.all().")

    def rotate(self, name: str, value: str, *, idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """A new version of the jobs copy. Only the jobs copy has versions; to
        change the sandboxes' copy, ``set`` it again."""
        live = self._live(name)
        if live is None:
            raise NotFoundError(f"{name} has no copy for jobs to rotate.", code="not_found", status=404,
                                hint="Store one with set(name, value=..., jobs=True).")
        return self._rotate_or_replay(live, value, idempotency_key)

    def reveal(self, name: str, *, version: Optional[int] = None) -> dict[str, Any]:
        """The jobs copy's value (the key needs secrets_reveal). The sandboxes'
        copy can never be read back."""
        live = self._live(name)
        if live is None:
            raise NotFoundError(f"{name} has no copy for jobs; the sandboxes' copy of a secret can never be read "
                                "back.", code="not_found", status=404)
        body: dict[str, Any] = {} if version is None else {"version": version}
        return self._store("POST", f"/v1/secrets/{quote(live['id'], safe='')}:reveal", body=body)

    def share(self, name: str, agents: "list[str] | str") -> dict[str, Any]:
        """Choose which of your keys may use the jobs copy besides the one that
        stored it: agent ids (``principal_id`` from ``me()``), ``[]`` for only
        that key, or ``"all"`` for every key of yours. Replaces the list. Only
        your person or the key that stored it may call this."""
        live = self._live(name)
        if live is None:
            raise NotFoundError(f"{name} has no copy for jobs to share.", code="not_found", status=404,
                                hint="Store one with set(name, value=..., jobs=True).")
        return self._store("POST", f"/v1/secrets/{quote(live['id'], safe='')}:share", body={"agents": agents})

    def delete(self, name: str) -> dict[str, Any]:
        """Delete a secret everywhere it is kept: the sandboxes' value is erased
        and its placeholder stops working, and the jobs copy stops being given
        to runs (its name stays taken)."""
        try:
            live = self._live(name)
        except RuntimeError as error:
            if not _unavailable(error):
                raise
            live = None
        removed: Optional[dict[str, Any]] = None
        try:
            removed = self._t.json("DELETE", f"/v1/egress-secrets/{quote(name, safe='')}")
        except NotFoundError:
            if live is None:
                raise
        if live is not None:
            self._store("POST", f"/v1/secrets/{quote(live['id'], safe='')}:delete",
                              body={"expectedVersion": live["version"]})
        return {"name": name, "deleted": True, "enforced": (removed or {}).get("enforced", True),
                "from": (["sandboxes"] if removed else []) + (["jobs"] if live else [])}
