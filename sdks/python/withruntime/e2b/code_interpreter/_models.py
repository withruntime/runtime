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

    def __init__(self, name: str, value: str, traceback: str, **kwargs):
        self.name, self.value, self.traceback = name, value, traceback

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

    def __init__(self, text=None, html=None, markdown=None, svg=None, png=None, jpeg=None,
                 pdf=None, latex=None, json=None, javascript=None, data=None, chart=None,
                 is_main_result=False, extra=None, **kwargs):
        self.text, self.html, self.markdown, self.svg = text, html, markdown, svg
        self.png, self.jpeg, self.pdf, self.latex = png, jpeg, pdf, latex
        self.json, self.javascript, self.data = json, javascript, data
        self.chart = None
        if chart:
            from .charts import _deserialize_chart
            try:
                self.chart = _deserialize_chart(chart)
            except Exception:
                import logging
                logging.getLogger(__name__).exception("Could not decode interpreter chart metadata")
        self.is_main_result, self.extra = is_main_result, extra

    @classmethod
    def _from_mime(cls, raw, is_main_result=False):
        fields, extra = {}, {}
        for mime, value in raw.items():
            if mime in _FIELDS:
                fields[_FIELDS[mime]] = value
            else:
                extra[mime] = value
        result = cls(**fields, is_main_result=is_main_result, extra=extra or None)
        result.raw = raw
        return result

    def __getitem__(self, item: str) -> Any:
        return getattr(self, item)

    def formats(self) -> List[str]:
        found = [name for name in (*_FIELDS.values(), "data", "chart") if getattr(self, name)]
        return found + list((self.extra or {}).keys())

    def __str__(self) -> str:
        return repr(self)

    def __repr__(self) -> str:
        return f"Result({self.text})" if self.text else f"Result(Formats: {', '.join(self.formats())})"


    def _repr_html_(self): return self.html
    def _repr_markdown_(self): return self.markdown
    def _repr_svg_(self): return self.svg
    def _repr_png_(self): return self.png
    def _repr_jpeg_(self): return self.jpeg
    def _repr_pdf_(self): return self.pdf
    def _repr_latex_(self): return self.latex
    def _repr_json_(self): return self.json
    def _repr_javascript_(self): return self.javascript


@dataclass
class Logs:
    stdout: List[str] = field(default_factory=list)
    stderr: List[str] = field(default_factory=list)

    def __init__(self, stdout=None, stderr=None, **kwargs):
        self.stdout, self.stderr = stdout or [], stderr or []

    def __repr__(self): return f"Logs(stdout: {self.stdout}, stderr: {self.stderr})"
    def to_json(self): return json.dumps({"stdout": self.stdout, "stderr": self.stderr})


@dataclass
class Execution:
    results: List[Result] = field(default_factory=list)
    logs: Logs = field(default_factory=Logs)
    error: Optional[ExecutionError] = None
    execution_count: Optional[int] = None

    def __init__(self, results=None, logs=None, error=None, execution_count=None, **kwargs):
        self.results, self.logs = results or [], logs or Logs()
        self.error, self.execution_count = error, execution_count

    def __repr__(self): return f"Execution(Results: {self.results}, Logs: {self.logs}, Error: {self.error})"

    def to_json(self):
        results = []
        for result in self.results:
            value = {key: (result.chart.to_dict() if key == "chart" else result[key]) for key in result.formats()}
            value["text"] = result.text
            results.append(value)
        return json.dumps({"results": results, "logs": self.logs.to_json(),
                           "error": self.error.to_json() if self.error else None})

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

    def __init__(self, context_id: str, language: str, cwd: str, **kwargs):
        self.id, self.language, self.cwd = context_id, language, cwd

    @classmethod
    def from_json(cls, data):
        return cls(data["id"], data["language"], data["cwd"])

