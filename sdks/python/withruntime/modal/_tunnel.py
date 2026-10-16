"""modal.Tunnel from a native public preview: HTTPS on port 443."""
from __future__ import annotations
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlparse
from .exception import InvalidError


@dataclass(frozen=True)
class Tunnel:
    host: str
    port: int
    unencrypted_host: Optional[str] = None
    unencrypted_port: Optional[int] = None

    @property
    def url(self):
        return f"https://{self.host}" + ("" if self.port == 443 else f":{self.port}")

    @property
    def tls_socket(self):
        return (self.host, self.port)

    @property
    def tcp_socket(self):
        raise InvalidError("Runtime previews are HTTPS only: use tls_socket or url")


def from_preview(preview):
    parsed = urlparse(preview["url"])
    return Tunnel(parsed.hostname, parsed.port or 443)
