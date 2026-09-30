"""Shared value objects and validation for sandbox compatibility adapters."""
from __future__ import annotations

import json
import math
import re
from dataclasses import asdict, is_dataclass
from typing import Any


class CompatibilityError(ValueError):
    """An option cannot retain its meaning on Runtime; no resource was created."""


def reject(options: dict[str, Any], context: str) -> None:
    if options:
        raise CompatibilityError(f"{context} cannot preserve these options: {', '.join(sorted(options))}")


def positive(value: float, name: str, *, integral: bool = False) -> int | float:
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or value <= 0:
        raise ValueError(f"{name} must be a finite positive number")
    if integral and int(value) != value:
        raise CompatibilityError(f"{name} must be a whole number on Runtime")
    return int(value) if integral else value


def dockerfile(reference: str) -> str:
    # A reference is one Docker FROM argument, never extra Dockerfile instructions.
    if not isinstance(reference, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._/:@-]*", reference):
        raise ValueError("docker image must be a registry image reference")
    return f"FROM {reference}\n"


class Model(dict):
    """Attribute and mapping access, with the JSON helpers used by SDK callers."""
    def __getattr__(self, key: str) -> Any:
        try:
            return self[key]
        except KeyError as error:
            raise AttributeError(key) from error

    def __setattr__(self, key: str, value: Any) -> None:
        self[key] = value

    def model_dump(self, **options: Any) -> dict[str, Any]:
        exclude_none = options.pop("exclude_none", False)
        reject(options, "model_dump")
        return {k: v for k, v in self.items() if not exclude_none or v is not None}

    to_dict = model_dump
    dict = model_dump

    def model_dump_json(self, **options: Any) -> str:
        return json.dumps(self.model_dump(**options), default=str)


def values(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    if is_dataclass(value):
        return asdict(value)
    if hasattr(value, "model_dump"):
        return value.model_dump(exclude_none=True)
    raise TypeError("Expected a request model or dictionary")


ENV_PATH = "/workspace/.runtime-compat/environment.json"


def environment(data: bytes, extra: dict[str, str] | None = None) -> dict[str, str]:
    saved = json.loads(data)
    if not isinstance(saved, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in saved.items()):
        raise ValueError("The saved sandbox environment is invalid")
    return {**saved, **(extra or {})}


def runtime_key(explicit: str | None = None) -> str | None:
    """Never send a competitor credential to Runtime, or Runtime's to their API."""
    import os
    if explicit and explicit.startswith("rtcloud_"):
        return explicit
    configured = os.environ.get("RUNTIME_API_KEY")
    if configured:
        return configured
    if explicit:
        raise CompatibilityError("The supplied credential is not a Runtime key. Set RUNTIME_API_KEY or use runtime login.")
    return None


def named_shell(command: str, name: str) -> tuple[str, list[str]]:
    """Same shell state protocol as the TypeScript adapters, guarded across clients."""
    import hashlib
    root = "/workspace/.runtime-compat/shells/" + hashlib.sha256(name.encode()).hexdigest()
    script = ('readonly __runtime_state="$1" __runtime_command="$2"; '
        'if [ -f "$__runtime_state" ]; then source "$__runtime_state"; fi; '
        'trap \'__runtime_status=$?; (umask 077; export -p | sed "/^declare -x __runtime_/d" > "$__runtime_state.next"; '
        'printf "cd -- %q\\n" "$PWD" >> "$__runtime_state.next"; mv -- "$__runtime_state.next" "$__runtime_state"); '
        'exit "$__runtime_status"\' EXIT; eval "$__runtime_command"')
    return root, ["flock", root + "/lock", "bash", "-c", script, "bash", root + "/state", command]
