"""E2B code interpreter's data classes, as its Python SDK names them."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class OutputMessage:
    line: str
    timestamp: int
    """Unix epoch in nanoseconds, from the client's clock."""
    error: bool = False

    def __str__(self) -> str:
        return self.line


@dataclass
class ExecutionError:
    name: str
    value: str
    traceback: str

    def to_json(self) -> str:
        return json.dumps({"name": self.name, "value": self.value, "traceback": self.traceback})


class MIMEType(str):
    pass


_FIELDS = {
    "text/plain": "text", "text/html": "html", "text/markdown": "markdown", "image/svg+xml": "svg",
    "image/png": "png", "image/jpeg": "jpeg", "application/pdf": "pdf", "text/latex": "latex",
    "application/json": "json", "application/javascript": "javascript",
}


class Result:
    """One rich result, as E2B's. ``chart`` and E2B's ``data`` (its own
    DataFrame format) are never set on Runtime; a DataFrame arrives in
    ``extra`` under application/vnd.runtime.table+json."""

    def __init__(self, raw: Dict[str, Any], is_main_result: bool = False) -> None:
        self.raw = raw
        self.is_main_result = is_main_result
        self.text = self.html = self.markdown = self.svg = self.png = self.jpeg = None
        self.pdf = self.latex = self.javascript = None
        self.json: Optional[Any] = None
        self.data: Optional[dict] = None
        self.chart: Optional[Any] = None
        extra: Dict[str, Any] = {}
        for mime, value in raw.items():
            if mime in _FIELDS:
                setattr(self, _FIELDS[mime], value)
            else:
                extra[mime] = value
        self.extra: Optional[Dict[str, Any]] = extra or None

    def __getitem__(self, item: str) -> Any:
        return getattr(self, item)

    def formats(self) -> List[str]:
        found = [name for name in _FIELDS.values() if getattr(self, name)]
        return found + list((self.extra or {}).keys())

    def __str__(self) -> str:
        return self.text or ""

    def __repr__(self) -> str:
        return f"Result({self.text!r})" if self.text else f"Result(Formats: {', '.join(self.formats())})"


@dataclass
class Logs:
    stdout: List[str] = field(default_factory=list)
    stderr: List[str] = field(default_factory=list)


@dataclass
class Execution:
    results: List[Result] = field(default_factory=list)
    logs: Logs = field(default_factory=Logs)
    error: Optional[ExecutionError] = None
    execution_count: Optional[int] = None

    @property
    def text(self) -> Optional[str]:
        for result in self.results:
            if result.is_main_result:
                return result.text
        return None


@dataclass
class Context:
    id: str  # noqa: A003
    language: str
    cwd: str
