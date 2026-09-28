"""GENERATED from _async_products/secrets.py by scripts/generate_sync.py. Do not edit."""
# ``runtime.secrets``: secrets your sandboxes use without seeing them, and that
# scheduled jobs put into their environment.
#
#     runtime.secrets.set("OPENAI_API_KEY", value=key, hosts=["api.openai.com"])
#
# Every sandbox of your organization then has ``OPENAI_API_KEY`` set to a
# placeholder. The egress proxy swaps in the value on HTTPS requests to the
# hosts (in the URL and headers), or, with ``header``, sets that header on every
# request to them. That value is sealed and never returned by anything.
#
#     runtime.secrets.set("DB_PASSWORD", value=password, jobs=True)
#
# keeps a copy scheduled jobs can bind: runtime.jobs.create(..., secrets=[...]).
from __future__ import annotations

from typing import Any, Optional, TypedDict
from urllib.parse import quote

from .._errors import ConflictError, InvalidRequestError, NotFoundError, RuntimeError, SecretPartlyStoredError
from .jobs import switched_off


class _RulePaths(TypedDict):
    paths: list[str]


class SecretRule(_RulePaths, total=False):
    """Which requests to a secret's hosts carry it: ``methods`` (every method
    when absent) and ``paths``, each exact or a prefix ending in ``/*``."""
    methods: list[str]


def _unavailable(error: Exception) -> bool:
    return isinstance(error, RuntimeError) and (error.code == "unavailable" or error.status == 503)


class Secrets:
    """``runtime.secrets``: one secret by name, kept where its value may go.
    With ``hosts``, sandboxes see a placeholder and the egress proxy adds the
    value on HTTPS to those hosts; that copy is never readable. With
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

    def _set_job_copy(self, name: str, value: str, key: Optional[str]) -> dict[str, Any]:
        copies = self._job_copies()
        live = next((c for c in copies if c["name"] == name and c.get("deletedAt") is None), None)
        if live is not None:
            return self._store("POST", f"/v1/secrets/{quote(live['id'], safe='')}:rotate",
                                     body={"value": value, "expectedVersion": live["version"]}, idempotency_key=key)
        if any(c["name"] == name for c in copies):
            raise ConflictError(f"A jobs secret named {name} was deleted, and a deleted name cannot be used again.",
                                code="name_conflict", status=409, hint="Store it under another name.",
                                details={"field": "name"})
        return self._store("POST", "/v1/secrets", body={"name": name, "value": value}, idempotency_key=key)

    def set(self, name: str, *, value: str, hosts: Optional[list[str]] = None, header: Optional[str] = None,
                  format: Optional[str] = None, rules: Optional[list[SecretRule]] = None, jobs: bool = False,
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

        ``jobs=True`` also keeps a copy scheduled jobs can use (up to 64 KiB of
        UTF-8 without ``hosts``); setting it again rotates it. With both, a jobs
        copy that fails after the sandboxes' copy is stored raises
        ``SecretPartlyStoredError``, and the same call again finishes it."""
        if not hosts and not jobs:
            raise InvalidRequestError("Say where the value may go: hosts for sandboxes, jobs=True for scheduled "
                                      "jobs, or both.", code="invalid_request", details={"field": "hosts"})
        saved: Optional[dict[str, Any]] = None
        if hosts:
            body: dict[str, Any] = {"value": value, "hosts": hosts}
            if header is not None:
                body["header"] = header
            if format is not None:
                body["format"] = format
            if rules is not None:
                body["rules"] = rules
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

    def list(self) -> list[dict[str, Any]]:
        """The sandboxes' secrets: names, hosts, headers and placeholders. Never
        values. ``all()`` includes the jobs copies."""
        return (self._t.json("GET", "/v1/egress-secrets"))["secrets"]

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
        """One secret by name, with where its value may go."""
        for entry in self.all():
            if entry["name"] == name:
                return entry
        raise NotFoundError(f"No secret named {name}.", code="not_found", status=404,
                            hint="List them with runtime.secrets.all().")

    def rotate(self, name: str, value: str, *, idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """A new version of the jobs copy. Only the jobs copy has versions; to
        change the sandboxes' copy, ``set`` it again."""
        live = self._live(name)
        if live is None:
            raise NotFoundError(f"{name} has no copy for jobs to rotate.", code="not_found", status=404,
                                hint="Store one with set(name, value=..., jobs=True).")
        return self._store("POST", f"/v1/secrets/{quote(live['id'], safe='')}:rotate",
                                 body={"value": value, "expectedVersion": live["version"]},
                                 idempotency_key=idempotency_key)

    def reveal(self, name: str, *, version: Optional[int] = None) -> dict[str, Any]:
        """The jobs copy's value (the key needs secrets_reveal). The sandboxes'
        copy can never be read back."""
        live = self._live(name)
        if live is None:
            raise NotFoundError(f"{name} has no copy for jobs; the sandboxes' copy of a secret can never be read "
                                "back.", code="not_found", status=404)
        body: dict[str, Any] = {} if version is None else {"version": version}
        return self._store("POST", f"/v1/secrets/{quote(live['id'], safe='')}:reveal", body=body)

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
