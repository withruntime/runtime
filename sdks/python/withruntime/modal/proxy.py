"""modal.Proxy: a static egress IP, which Runtime sells as dedicated egress IPs."""
from __future__ import annotations
from .._compat import CompatibilityError
from ._dual import install

PROXY = "Runtime dedicated egress IPs: runtime.ips (the native SDK) gives sandboxes a fixed outbound address"


class Proxy:
    @staticmethod
    def from_name(name, *, environment_name=None, client=None):
        raise CompatibilityError(PROXY)

    @property
    def object_id(self):
        raise CompatibilityError(PROXY)

    @property
    def client(self):
        raise CompatibilityError(PROXY)

    def hydrate(self, client=None):
        raise CompatibilityError(PROXY)

    def get_dashboard_url(self):
        raise CompatibilityError(PROXY)


install(Proxy, ("from_name", "hydrate", "get_dashboard_url"), static=("from_name",), refused=True)
