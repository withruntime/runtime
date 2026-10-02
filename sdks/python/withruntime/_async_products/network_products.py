# Custom domains, public TCP ports, dedicated outbound addresses and the
# WireGuard tunnel into your sandboxes. Paid accounts only: an account that has
# not added credit gets ``payment_required`` (402).
#
#     domain = await runtime.domains.add("app.example.com", sandbox_id=sbx.id, port=3000)
#     # set domain["records"] at your DNS provider, then
#     await runtime.domains.verify("app.example.com")
#     db = await runtime.ports.open(sandbox_id=sbx.id, port=5432)   # db["connect"]
#     ip = await runtime.addresses.reserve()                         # ip["address"]
#     await runtime.tunnel.create()
#     office = await runtime.tunnel.add_peer("office", routes=["10.0.0.0/16"])
#     # office["config"] is a wg-quick file: sudo wg-quick up ./runtime.conf
from __future__ import annotations

from typing import Any, Optional, TypedDict, Literal
from urllib.parse import quote

from .private_network import AsyncPrivateNetwork


class NetworkFunding(TypedDict):
    """False funding disables traffic but keeps the reservation until release.
    The quote is immutable, in millionths of a US dollar per month.
    fundedUntil is the last funded-through ISO timestamp, possibly past.
    None means no meter exists. Free IPv6 also has renewable deadlines.
    """
    funded: bool
    fundedUntil: Optional[str]
    rateMicros: int
    rateUnit: Literal["unit_month"]


class AddressResult(NetworkFunding):
    id: str
    address: str
    family: int
    createdAt: str


class TunnelResult(NetworkFunding):
    id: str
    subnet: str
    gatewayAddress: str
    endpoint: str
    gatewayPublicKey: Optional[str]
    disabled: bool
    peers: list[dict[str, Any]]
    sandboxes: list[dict[str, Any]]
    createdAt: str


class TunnelPeerResult(TypedDict):
    tunnel: TunnelResult
    peer: dict[str, Any]
    config: Optional[str]
    configReady: bool
    hint: str


class AsyncDomains:
    """``runtime.domains``: serve a sandbox's port at your own hostname, with HTTPS."""

    def __init__(self, t: Any) -> None:
        self._t = t

    async def add(self, hostname: str, *, sandbox_id: str, port: int) -> dict[str, Any]:
        """Claims the hostname and answers the DNS records to set: a TXT record
        that proves the name is yours, and a CNAME (an A record for an apex
        name). Calling it again with another sandbox or port points it there."""
        return await self._t.json("POST", "/v1/domains",
                                  body={"hostname": hostname, "sandboxId": sandbox_id, "port": port})

    async def verify(self, hostname: str) -> dict[str, Any]:
        """Checks the TXT record now; the name goes live when it matches."""
        return await self._t.json("POST", f"/v1/domains/{quote(hostname, safe='')}:verify")

    async def get(self, hostname: str) -> dict[str, Any]:
        return await self._t.json("GET", f"/v1/domains/{quote(hostname, safe='')}")

    async def list(self) -> list[dict[str, Any]]:
        return (await self._t.json("GET", "/v1/domains"))["data"]

    async def remove(self, hostname: str) -> dict[str, Any]:
        return await self._t.json("DELETE", f"/v1/domains/{quote(hostname, safe='')}")


class AsyncPorts:
    """``runtime.ports``: a public TCP port to a port of a sandbox."""

    def __init__(self, t: Any) -> None:
        self._t = t

    async def open(self, *, sandbox_id: str, port: int) -> dict[str, Any]:
        """Returns ``connect`` (address:port). Calling it again for the same
        sandbox and port returns the same public port."""
        return await self._t.json("POST", "/v1/ports", body={"sandboxId": sandbox_id, "port": port})

    async def list(self, *, sandbox_id: Optional[str] = None) -> list[dict[str, Any]]:
        path = "/v1/ports" + (f"?sandboxId={quote(sandbox_id, safe='')}" if sandbox_id else "")
        return (await self._t.json("GET", path))["data"]

    async def close(self, port_id: str) -> dict[str, Any]:
        return await self._t.json("DELETE", f"/v1/ports/{quote(port_id, safe='')}")


class AsyncAddresses:
    """``runtime.addresses``: a dedicated outbound address every sandbox of the
    account sends from, for allow-lists."""

    def __init__(self, t: Any) -> None:
        self._t = t

    async def reserve(self, *, family: int = 4) -> AddressResult:
        return await self._t.json("POST", "/v1/addresses", body={"family": family})

    async def list(self) -> list[AddressResult]:
        return (await self._t.json("GET", "/v1/addresses"))["data"]

    async def release(self, address_id: str) -> dict[str, Any]:
        return await self._t.json("DELETE", f"/v1/addresses/{quote(address_id, safe='')}")


class AsyncTunnel:
    """``runtime.tunnel``: a WireGuard tunnel from your own network into your sandboxes."""

    def __init__(self, t: Any) -> None:
        self._t = t

    async def get(self) -> TunnelResult:
        return await self._t.json("GET", "/v1/tunnel")

    async def create(self, *, subnet: Optional[str] = None) -> TunnelResult:
        """Idempotent: returns the tunnel you have."""
        return await self._t.json("POST", "/v1/tunnel", body={} if subnet is None else {"subnet": subnet})

    async def delete(self) -> dict[str, Any]:
        return await self._t.json("DELETE", "/v1/tunnel")

    async def add_peer(self, name: str, *, public_key: Optional[str] = None,
                       routes: Optional[list[str]] = None) -> TunnelPeerResult:
        """Adds a machine or router of yours and returns its wg-quick file in
        ``config``. Leave ``public_key`` out and Runtime generates the pair: the
        private key is then in ``config``, shown once. ``routes`` are your own
        ranges behind it that sandboxes may reach."""
        body: dict[str, Any] = {"name": name, "routes": routes or []}
        if public_key is not None:
            body["publicKey"] = public_key
        return await self._t.json("POST", "/v1/tunnel/peers", body=body)

    async def rotate_peer(self, peer_id: str, *, public_key: Optional[str] = None) -> TunnelPeerResult:
        """A new key; the old one stops working within seconds."""
        return await self._t.json("POST", f"/v1/tunnel/peers/{quote(peer_id, safe='')}:rotate",
                                  body={} if public_key is None else {"publicKey": public_key})

    async def remove_peer(self, peer_id: str) -> TunnelResult:
        return await self._t.json("DELETE", f"/v1/tunnel/peers/{quote(peer_id, safe='')}")


class AsyncUpstreamProxy:
    """``runtime.network.upstream_proxy``: send your sandboxes' outbound
    connections through your own HTTP or HTTPS proxy. After Runtime's own rules
    allow a connection, the host reaches it with CONNECT through your proxy, so
    your proxy's controls and logs apply. A proxy that refuses or cannot be
    reached fails the connection (upstream-proxy-failed); nothing goes around
    it. Paid accounts only.

        await runtime.network.upstream_proxy.set("http://proxy.example.com:3128")
    """

    def __init__(self, t: Any) -> None:
        self._t = t

    async def set(self, url: str, *, secret: Optional[str] = None,
                  hosts: Optional[list[str]] = None) -> dict[str, Any]:
        """``url`` is ``http://host:port`` or ``https://host:port``. ``secret``
        names one of your secrets, sent as the Proxy-Authorization header's
        whole value; its hosts must name the proxy's host. ``hosts`` (1 to 16,
        names or ``*.domain``) limit which destinations go through it; every
        destination when left out. Replaces any proxy set before."""
        body: dict[str, Any] = {"url": url}
        if secret is not None:
            body["secret"] = secret
        if hosts is not None:
            body["hosts"] = hosts
        return await self._t.json("PUT", "/v1/network/upstream-proxy", body=body)

    async def get(self) -> dict[str, Any]:
        """The proxy in use. Raises ``NotFoundError`` when none is set."""
        return await self._t.json("GET", "/v1/network/upstream-proxy")

    async def remove(self) -> dict[str, Any]:
        """Connections leave directly again, within seconds. Raises
        ``NotFoundError`` when none is set."""
        return await self._t.json("DELETE", "/v1/network/upstream-proxy")


class AsyncAccountNetwork:
    """``runtime.network``: the network settings of the whole account. A
    sandbox's own rules are ``sandbox.network``."""

    def __init__(self, t: Any) -> None:
        self.upstream_proxy = AsyncUpstreamProxy(t)
        self.private = AsyncPrivateNetwork(t)
