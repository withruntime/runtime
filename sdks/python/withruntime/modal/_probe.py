"""modal.Probe: what Sandbox.wait_until_ready runs until it succeeds."""
from __future__ import annotations
from dataclasses import dataclass
from typing import Optional
from .exception import InvalidError


def _interval(value, method):
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise InvalidError(f"Probe.{method}() expects an integer `interval_ms` > 0, got {value!r}")
    return value


def _port(value):
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 65535:
        raise InvalidError(f"Probe.with_tcp() expects an integer `port` in [1, 65535], got {value!r}")
    return value


def _argv(values):
    if not values or not all(isinstance(value, str) for value in values):
        raise InvalidError("Probe.with_exec() requires at least one argument, all strings")
    return tuple(values)


@dataclass(frozen=True)
class Probe:
    tcp_port: Optional[int] = None
    exec_argv: Optional[tuple] = None
    interval_ms: int = 100

    def __post_init__(self):
        if (self.tcp_port is None) == (self.exec_argv is None):
            raise InvalidError("Probe must be created with Probe.with_tcp(...) or Probe.with_exec(...)")

    @classmethod
    def with_tcp(cls, port, *, interval_ms=100):
        return cls(tcp_port=_port(port), interval_ms=_interval(interval_ms, "with_tcp"))

    @classmethod
    def with_exec(cls, *argv, interval_ms=100):
        return cls(exec_argv=_argv(argv), interval_ms=_interval(interval_ms, "with_exec"))

    def _command(self):
        if self.tcp_port is not None:
            return ["bash", "-c", f"</dev/tcp/127.0.0.1/{self.tcp_port}"]
        return list(self.exec_argv)

    def _label(self):
        import json
        kind = {"tcp": self.tcp_port} if self.tcp_port is not None else {"exec": list(self.exec_argv)}
        return json.dumps({**kind, "interval": self.interval_ms})


def from_label(text):
    import json
    value = json.loads(text)
    if "tcp" in value:
        return Probe(tcp_port=value["tcp"], interval_ms=value["interval"])
    return Probe(exec_argv=tuple(value["exec"]), interval_ms=value["interval"])
