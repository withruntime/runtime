"""Runloop 2.0 contracts shared by the synchronous and asynchronous adapters."""
from .._compat import CompatibilityError


def stdin_body(text, signal, idempotency_key=None):
    if text is not None and (not isinstance(text, str) or not text):
        raise ValueError("Runloop stdin text must be a nonempty string")
    if signal is not None and signal not in ("EOF", "INTERRUPT"):
        raise ValueError("Runloop stdin signal must be EOF or INTERRUPT")
    if (text is not None) == (signal is not None):
        raise ValueError("Runloop stdin requires exactly one of nonempty text or a signal")
    if idempotency_key is not None:
        raise CompatibilityError("Runloop stdin idempotency keys cannot be preserved; use Runtime process input offsets")


class UnsupportedServices:
    """Refuse provider semantics absent on Runtime before any network request."""
    _alternatives = {
        "secrets": "duplicate-name secret rows and secret-ID handles; use the Runtime secrets API",
        "objects": "signed storage-object uploads; use Runtime sandbox files",
        "axons": "Axon registries and deleted event records; use the Runtime events API",
        "gateway_configs": "named gateway bindings; use the Runtime secrets API with direct service requests",
        "mcp_configs": "named MCP grants; use the Runtime secrets API with your MCP client",
        "network_policies": "reusable named network-policy bindings; use Runtime sandbox egress settings",
    }
    _aliases = {
        "secret": "secrets", "storage_object": "objects", "axon": "axons",
        "gateway_config": "gateway_configs", "mcp_config": "mcp_configs", "network_policy": "network_policies",
    }

    def __getattr__(self, name):
        feature = self._alternatives.get(self._aliases.get(name, name))
        if feature is not None:
            raise CompatibilityError(f"Runloop {feature}")
        raise AttributeError(name)
