# Custom domains, TCP ports, dedicated addresses and private networks

Four ways to connect sandboxes to the rest of your world. They are for paid
accounts: an account that has not added credit gets `payment_required` (402).
A custom domain or a TCP port also needs the sandbox it serves to be a paid one.

- **Custom domain:** a sandbox's web port at your own hostname, with HTTPS.
- **TCP port:** a public `address:port` for anything that is not HTTP, such as
  Postgres, Redis, MQTT or a game server.
- **Dedicated outbound address:** every sandbox of your account sends from one
  address of its own, so you can allow-list it.
- **Private network:** a WireGuard tunnel from your own network, in any cloud or
  on your premises, into your sandboxes.

None of them belongs to one sandbox alone, so each is its own product in the CLI,
the SDKs and MCP: `runtime domain`, `runtime port`, `runtime address` and
`runtime tunnel`; `runtime.domains`, `runtime.ports`, `runtime.addresses` and
`runtime.tunnel`; `runtime_domain_*`, `runtime_port_*`, `runtime_address_*` and
`runtime_tunnel_*`. A dedicated IPv4 address and a tunnel each cost $5 per
30-day month, prorated to funded time. IPv6, custom domains and TCP ports are
included. See [pricing](./pricing).

## Custom domains

```bash no-run
runtime domain add app.example.com <sandbox> 3000
```

The answer lists two DNS records to set at your DNS provider:

| Record | Name                                 | Value                     | What it does              |
| ------ | ------------------------------------ | ------------------------- | ------------------------- |
| TXT    | `_runtime-challenge.app.example.com` | `runtime-verify=<token>`  | Proves the name is yours  |
| CNAME  | `app.example.com`                    | `domains.runtimehost.com` | Sends visitors to Runtime |

A name with no subdomain (`example.com`, `example.co.uk`) cannot have a CNAME;
the answer gives an A record (and an AAAA for an IPv6 address) with the
addresses to set instead. Then check:

```bash no-run
runtime domain verify app.example.com
```

The name goes live when the TXT record matches. The first visit gets its
certificate from Let's Encrypt, which takes a few seconds. Your server must
listen on `0.0.0.0` or `localhost` inside the sandbox, as for a
[preview link](./sandbox-environment), and be started with `spawn`, which keeps
it running. WebSockets work, and a paused sandbox is
woken by a visit, like a preview.

- **Ownership is the TXT record.** A CNAME pointing at Runtime proves nothing,
  so a record someone forgot to delete cannot be used to take their name. Each
  claim has its own token.
- **The DNS owner wins.** If another account proves the same name later, it
  takes the name over and your claim ends.
- **To move the name to another sandbox or port,** run `add` again with the new
  target. To stop serving it, `runtime domain rm app.example.com`.
- **Limits:** 50 domains per account, 20 added a day. Certificates are issued
  for proved names only.
- **Reports** reach Runtime through the `X-Runtime-Report` header on every
  answer and the abuse address, as for previews. Runtime can take a name down;
  it then stays down for every account.

## TCP ports

```bash no-run
runtime port open <sandbox> 5432
# 203.0.113.10:23456
psql "postgres://app@203.0.113.10:23456/app?sslmode=require"
```

A TCP port carries raw TCP from a public address and port to a port inside the
sandbox. Opening the same sandbox and port again returns the same public port.

- **Anyone who knows the address can connect.** Use your service's own
  authentication and TLS.
- **Only TCP is carried.** UDP (most game servers' own traffic, QUIC) is not.
- **Limits:** 5 ports per sandbox, 20 per account and 50 opened a day. Each
  sandbox's ports share 256 open connections, 50 new connections a second, and
  32 connections from any one client address. Traffic through a port has its
  own limits, whatever the sandbox's outbound tier: 100 Mbit/s, 20 Mbit/s once
  2 GiB has moved at that speed, and 50 GiB a day, in and out together.
- **A closed port rests for a day** before anyone else can be given it, so a
  client still pointed at it never reaches someone else's service.
- **A paused sandbox is woken** by a connection, and its connections end when
  it stops, pauses or is deleted.
- `runtime port ls` lists them; `runtime port close <portId>` closes one.

## Dedicated outbound addresses

```bash no-run
runtime address reserve
# 203.0.113.50
```

From then on every sandbox of your account sends from that address, on every
port, so a database, an API provider or a firewall can admit exactly you. No
other account sends from it while you hold it.

- One IPv4 address per account, and one IPv6 with `--ipv6`.
- If funding expires, traffic stops while the reservation remains yours. There
  is no fallback to a shared address and no charge for the unpaid interval.
- `funded` reports whether traffic is funded now. `fundedUntil` is the last
  funded-through time and may be in the past; it is null when no meter exists.
  `rateMicros` and `rateUnit` give the reserved address's price. Check your
  balance, spending limits and permissions if renewal is blocked.
- `runtime address release <addressId>` gives it back, and your sandboxes send
  from the shared addresses again at once. A released address rests for 30 days
  before any other account gets it. Remove it from your allow-lists first.
- Addresses are added to Runtime as accounts need them. If none is free, the
  answer is `no_capacity` (503): write to support.

## Your own upstream proxy

Your sandboxes' outbound connections can go through your own HTTP or HTTPS
proxy, after Runtime's own rules allow them, so your proxy's controls and logs
apply.

```bash no-run
runtime network upstream-proxy set http://proxy.example.com:3128 --host '*.internal.example.com'
runtime network upstream-proxy get
runtime network upstream-proxy remove
```

It is a setting of the whole account, so it lives under `runtime network`, as
`runtime.network.upstreamProxy` in JavaScript, `runtime.network.upstream_proxy`
in Python and `runtime_network_upstream_proxy_*` in MCP; the CLI and SDK lines
arrived in `withruntime` 0.7.0, and the API and MCP tools work
now. Without `--host`, every connection goes through it. A proxy that fails
fails the connection; nothing goes around it.
[Security](./security#your-own-proxy) has the rest: proxy credentials, what your
proxy sees, and UDP.

## Private networks

A WireGuard tunnel from a machine or router on your network into your
sandboxes. Every sandbox gets an address in the tunnel's subnet, and your
machines reach any port of it there.

```bash no-run
runtime tunnel create                                # subnet 10.250.0.0/16 by default
runtime tunnel peer add office --route 10.0.0.0/16   # writes runtime.conf
sudo wg-quick up ./runtime.conf
runtime tunnel get                                   # each sandbox's address
psql -h 10.250.0.32 app
```

`runtime tunnel peer add` makes the WireGuard key pair on your machine; the
private key goes only into `runtime.conf`, which only you can read. Any
WireGuard client works with a complete file: `wg-quick` on Linux and macOS, the
WireGuard apps on Windows, macOS, iOS and Android, or your router. To use a
key you already have, pass `--public-key`. If the gateway key is not ready,
`configReady` is false and the file is a draft: keep its private key, add the
server key once available, and follow the CLI instructions before bringing it up.
Do not generate another peer just to retrieve the same private key.

- **Choose a subnet your network does not use,** from `/16` to `/24`, when you
  create the tunnel: `--subnet 172.30.0.0/16`.
- **`--route`** names your own ranges behind the peer. List them when your
  sandboxes will reach your network through the peer. TCP connections work in
  both directions; UDP is not carried by this tunnel.
- **What a peer reaches:** your own account's sandboxes, at their tunnel
  addresses, on any port except Runtime's own relays inside the sandbox (10800,
  10802 and 10853). Nothing else: not another account's sandboxes, not Runtime's
  servers, not the internet. Only TCP is carried.
- **Rotate a key** with `runtime tunnel peer rotate <peerId>`: the old key stops
  working within seconds, and connections opened with it end.
  `runtime tunnel peer rm <peerId>` removes a peer the same way.
- **Funding:** an unfunded tunnel stops traffic but keeps its reservation and
  peers until you delete it. Unpaid time is never billed. `funded`,
  `fundedUntil`, `rateMicros` and `rateUnit` report its current funding and quote.
- **Limits:** one tunnel per account, 16 peers. A paused sandbox is woken by a
  connection.

From the SDKs:

```ts check
import { Runtime } from "withruntime";
const runtime = new Runtime();
await runtime.tunnel.create();
const office = await runtime.tunnel.addPeer({ name: "office", routes: ["10.0.0.0/16"] });
// office.config is the wg-quick file; with no publicKey given, it holds the
// private key Runtime generated for you, shown once.
```

```python check
runtime.tunnel.create()
office = runtime.tunnel.add_peer("office", routes=["10.0.0.0/16"])
```

## Outbound UDP

Paid sandboxes send UDP to any public address and port: HTTP/3 and QUIC, DNS
to a resolver of your choice, time sync, game and media servers, WireGuard or
other VPN clients. Trial sandboxes send TCP only. In a measurement on 25
September 2026 a paid sandbox got an NTP answer in 18 ms and a QUIC answer from
Google in 16 ms.

- Each flow has one destination, and only that destination's replies come
  back; nothing reaches a sandbox over UDP unasked.
- Private, link-local and cloud metadata addresses are refused, and so are the
  ports no sandbox reaches over TCP either. The sandbox's network rules apply.
- Datagrams are limited to 1,472 bytes. A sandbox sends and receives at most
  50,000 datagrams a second, enough for full-size traffic at its 500 Mbit/s
  peak, inside its bandwidth limits and daily allowance.
- A flow that has sent 256 datagrams without an answer is closed, so a sandbox
  cannot flood a host that does not reply.
- NTP to port 123 accepts standard 48-byte client requests and matching server
  replies only.
- There is no public inbound UDP port, and UDP is not carried through a
  private tunnel or through your own upstream proxy.

## Errors

| Code                  | Status | Meaning                                                         |
| --------------------- | -----: | --------------------------------------------------------------- |
| `payment_required`    |    402 | The account has not added credit, or the sandbox is a trial one |
| `network_not_allowed` |    403 | Runtime turned network features off for the account             |
| `quota_exceeded`      |    409 | A limit above was reached                                       |
| `rate_limited`        |    429 | Too many added today                                            |
| `no_capacity`         |    503 | No public port or dedicated address is free just now            |
| `network_unavailable` |    503 | The feature is not switched on in this region yet               |
