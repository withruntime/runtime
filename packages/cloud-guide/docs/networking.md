# Custom domains, TCP ports, dedicated addresses and private networks

Six ways to connect sandboxes to the rest of your world and to each other. A dedicated address
needs credit on the account; the others need a kept top-up, one paid and
not refunded, because spammers abuse them. Without one, a request gets
`payment_required` (402) saying which ([pricing](./pricing#how-many-at-once)).
A custom domain or a TCP port also needs the sandbox it serves to be a paid one.

- **Custom domain:** a sandbox's web port at your own hostname, with HTTPS.
- **TCP port:** a public `address:port` for anything that is not HTTP, such as
  Postgres, Redis, MQTT or a game server.
- **Dedicated outbound address:** every sandbox of your account sends from one
  address of its own, so you can allow-list it.
- **Private network:** a WireGuard tunnel from your own network, in any cloud or
  on your premises, into your sandboxes (`runtime tunnel`). This is the only
  "tunnel" on this page; `runtime sandbox ssh` and `port-forward` are a
  separate connection from your own computer ([SSH and editors](./editors)).
- **Sandboxes by name:** your sandboxes reach each other at
  `<name>.sandbox.internal`, free. It needs no tunnel: the CLI and MCP call it
  `network private` (`runtime network private on`), which is not the WireGuard
  private network above.
- **Your Tailscale network:** a sandbox joins your tailnet as a machine of its
  own, with your auth key.

None of them belongs to one sandbox alone, so each is its own product in the CLI,
the SDKs and MCP: `runtime domain`, `runtime port`, `runtime address` and
`runtime tunnel`; `runtime.domains`, `runtime.ports`, `runtime.addresses` and
`runtime.tunnel`; `runtime_domain_*`, `runtime_port_*`, `runtime_address_*` and
`runtime_tunnel_*`. A tailnet belongs to one sandbox: `runtime sandbox tailscale`,
`sbx.tailscale` and `runtime_sandbox_tailscale`. A dedicated IPv4 address and a tunnel each cost {{address-month}} per
30-day month, prorated to funded time. IPv6, custom domains, TCP ports and
joining a tailnet are included. See [pricing](./pricing).

## Private preview links

A [preview link](./sandbox-environment) shares an HTTP port without adding a
custom domain. Keep it private when only selected visitors should connect;
anyone holding its token can use it until it expires or you rotate it.

The API can issue a token with a relative `ttlSeconds` lifetime or an absolute
`expiresAt` ISO timestamp. With both, the earlier deadline wins; tokens issued
through a sandbox session also end when that session ends. An absolute deadline
is never rounded past the time you requested. Read the returned `tokenExpiresAt`
for its actual end time. See [private preview tokens](./api#private-preview-tokens)
for the supported API and MCP inputs.

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
  target. To stop serving it, `runtime domain rm app.example.com`. Either
  takes effect, open connections included, before the command returns.
- **Limits:** 50 domains per account, 20 added a day. Certificates are issued
  for proved names only.
- **Reports** reach Runtime through the `X-Runtime-Report` header on every
  answer and the abuse address, as for previews. Runtime can take a name down;
  it stops serving at once and stays down for every account.

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
  32 connections from any one client address.
- **Speed:** each sandbox's ports move up to {{paid-upload}} each way, {{paid-upload-sustained}} once
  {{paid-upload-burst}} has moved at that speed, and {{paid-daily-transfer}} a day, in and out together.
  When ports of several sandboxes on one address are sending at once, they
  share {{paid-upload}} in equal parts.
- **Use the address each port was given.** A port keeps its address for as
  long as it is open, but ports opened later may be given a different address
  from earlier ones, so read it from the answer (`address`, `connect`) rather
  than assuming one address for all of them.
- **A closed port rests for a day** before anyone else can be given it, so a
  client still pointed at it never reaches someone else's service.
- **A paused sandbox is woken** by a connection, and its connections end when
  it stops, pauses or is deleted.
- **What the sandbox sends back is outbound traffic**, on the account's
  monthly allowance and then at {{outbound-rate}} per GB, for sandboxes created
  from 5 October 2026; what clients send in is free. See
  [pricing](./pricing#network-products).
- `runtime port ls` lists them; `runtime port close <portId>` closes one, and
  its open connections, before it returns. A port you open listens before its
  address is returned.

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
- An address is served from one place, so while you hold one your sandboxes are
  started only where it can send from. If there is no room there just now, a
  create answers `no_capacity` (503) rather than start a sandbox that would send
  from a shared address; retry it with the same idempotency key.

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

## Reach your other sandboxes by name

Turn it on once, and every sandbox of your account reaches the others by name,
over TCP, on any port: a database in one, a queue in another, the agent in a
third. It is free, and off until you turn it on. The setting is named
`network private` in the CLI, the API (`/v1/network/private`) and MCP
(`runtime_network_private`); it has nothing to do with the WireGuard
[private network](#private-networks) below, which joins your own network to
your sandboxes.

```bash no-run
runtime network private on
# then, in any of your sandboxes:
psql -h db.sandbox.internal -p 5432 app
curl http://web.sandbox.internal:3000/
runtime network private status
runtime network private off                    # open connections are cut within seconds
```

- **The name** is the one the sandbox was created with (`name`), at
  `<name>.sandbox.internal`, or its id, at `<id>.sandbox.internal`. Names are
  matched without regard to case; use letters, digits, dots and dashes. If two
  of your sandboxes answer to the same name, use the id.
- **Only your own sandboxes answer.** Another account's sandbox of the same name
  is never reached, nor is anything outside Runtime: `.sandbox.internal` names
  are never looked up in public DNS.
- **Any port** the target listens on, except Runtime's own relays inside every
  sandbox (10800, 10802 and 10853). TCP only.
- **A paused sandbox wakes** when a connection reaches it. A stopped one does
  not: start it first.
- **A kept top-up, from paid sandboxes.** An account without one is told so when it
  turns it on; a connection from a sandbox without credit is refused with
  `private-network-paid-only`. A sandbox with its internet off reaches no other
  sandbox either.
- **Not billed:** these connections are not outbound traffic.

From the SDKs, `runtime.network.private` (MCP: `runtime_network_private_*`):

```ts check
import { Runtime } from "withruntime";
const runtime = new Runtime();
await runtime.network.private.set({ enabled: true });
const { enabled } = await runtime.network.private.get();
```

```python check
runtime.network.private.set(enabled=True)
```

A program that connects directly sees a refused connection close at once. Through
the proxy (`curl -x "$HTTP_PROXY"`, or any program that reads `HTTP_PROXY`), the
answer's `X-Runtime-Egress` header says why: `private-network-off` (turn it on), `private-network-no-sandbox` (no sandbox of
yours has that name or id), `private-network-not-running` (it is stopped, or
could not be woken) or `private-network-port-reserved`.

## Private networks

A WireGuard tunnel from a machine or router on your network into your
sandboxes (`runtime tunnel`, `runtime.tunnel`, `runtime_tunnel`). For your
sandboxes reaching each other, no tunnel is needed: see
[reach your other sandboxes by name](#reach-your-other-sandboxes-by-name). Every sandbox gets an address in the tunnel's subnet, and your
machines reach any port of it there.
While you have a tunnel, your sandboxes start where its gateway can reach them
both ways; with no room there just now, a create answers `no_capacity` (503),
and a retry with the same idempotency key goes ahead once there is.

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

## Your Tailscale network

A paid sandbox can join your own tailnet, so your machines, databases and
services on Tailscale reach it, and it reaches them, by their tailnet
addresses. Make an auth key in Tailscale's admin console: ephemeral, tagged,
and one-use unless the sandbox may pause for long (see below). Store it for
jobs, which is the copy a sandbox can be given, then join:

```bash no-run
printf %s "$TS_AUTHKEY" | runtime secrets set TS_AUTHKEY --jobs
runtime sandbox tailscale up <sandbox> --auth-key-secret TS_AUTHKEY --tag tag:agents
runtime sandbox tailscale status <sandbox>     # its 100.x address and name
runtime sandbox tailscale down <sandbox>       # removed from the tailnet at once
```

`--hostname` names the machine; the default is the sandbox's name. At create,
`tailscale: { authKeySecret: "TS_AUTHKEY", tags: ["tag:agents"] }` joins as
soon as it runs; a join that fails stops the new sandbox and answers why.

- **The key stays in memory.** It is read from your secret with your key's
  right to reveal it, and given to `tailscaled` in the sandbox on a memory-only
  mount. It is never in an answer, a log, the sandbox's disk or a command line.
  Code running as root in the sandbox could read it, as on any machine running
  Tailscale, which is why an ephemeral, tagged key is the one to use.
- **An ephemeral machine.** `down` logs it out and takes it off the tailnet at
  once. A stop or a delete does not log it out first: the machine goes offline
  with the sandbox, and Tailscale removes an ephemeral machine by itself once
  it has been offline a while, up to about an hour. To have it gone at once,
  run `down` before the stop, or remove it in Tailscale's admin console.
- **Pausing.** A paused sandbox is offline on the tailnet and back when it
  wakes. If Tailscale removed it meanwhile, the sandbox logs in again by itself
  with a reusable key; a one-use key cannot, so join again.
- **How it reaches the tailnet.** Where the sandbox's kernel allows a TUN
  device, which is the default image, it has a `tailscale0` interface and
  reaches 100.x addresses directly (`mode: "kernel"`). Otherwise
  (`mode: "userspace"`) your tailnet still reaches the sandbox's ports, and
  programs in it reach the tailnet through the SOCKS5 and HTTP proxy on
  `localhost:1055`.
- **MagicDNS.** Once an image with Runtime's Tailscale DNS bridge has been
  qualified and released, it can resolve `.ts.net`
  names in both kernel and userspace modes. Ordinary public names keep using
  the usual resolver. Older images stay connected and warn that MagicDNS
  needs an image with the bridge; use the 100.x address or rebuild the image
  before relying on tailnet names.
- **Your network rules still apply.** Tailscale's traffic leaves through the
  same proxy as everything else, so the sandbox needs `*.tailscale.com` and
  `pkgs.tailscale.com` on port 443, which paid sandboxes reach by default, and
  UDP for direct connections, which falls back to Tailscale's relays without
  it. What travels inside the tailnet is encrypted by Tailscale: your
  [secrets](./security#secrets-sandboxes-never-see) are never put into it, and
  your tailnet's access rules decide what the sandbox's tags reach.
- **Not copied from memory.** While a sandbox is on a tailnet, a fork or a
  memory snapshot of it is refused with `tailscale_joined`: the copy would be
  the same Tailscale machine and would hold the key. Take it off, copy it, and
  join each. A disk snapshot is taken as ever.
- **Sandboxes without credit** cannot join (`payment_required`). The first join
  downloads Tailscale into the sandbox, a few seconds more; later joins reuse it.

## Outbound UDP

Paid sandboxes send UDP to any public address and port: HTTP/3 and QUIC, DNS
to a resolver of your choice, time sync, game and media servers, WireGuard or
other VPN clients. Sandboxes without credit send TCP only. In a measurement on 25
September 2026 a paid sandbox got an NTP answer in 18 ms and a QUIC answer from
Google in 16 ms.

- Each flow has one destination, and only that destination's replies come
  back; nothing reaches a sandbox over UDP unasked.
- Private, link-local and cloud metadata addresses are refused, and so are the
  ports no sandbox reaches over TCP either. The sandbox's network rules apply.
- Datagrams are limited to 1,472 bytes. A sandbox sends and receives at most
  50,000 datagrams a second, enough for full-size traffic at its {{paid-upload}}
  upload peak, inside its upload limits and daily allowance.
- A flow that has sent 256 datagrams without an answer is closed, so a sandbox
  cannot flood a host that does not reply.
- NTP to port 123 accepts standard 48-byte client requests and matching server
  replies only.
- There is no public inbound UDP port, and UDP is not carried through a
  private tunnel or through your own upstream proxy.

## Errors

| Code                  | Status | Meaning                                                            |
| --------------------- | -----: | ------------------------------------------------------------------ |
| `payment_required`    |    402 | The account has no kept top-up, or the sandbox runs without credit |
| `tailscale_failed`    |    422 | Tailscale refused the login, or the sandbox could not reach it     |
| `tailscale_joined`    |    409 | A fork or memory snapshot of a sandbox on a tailnet                |
| `network_not_allowed` |    403 | Runtime turned network features off for the account                |
| `quota_exceeded`      |    409 | A limit above was reached                                          |
| `rate_limited`        |    429 | Too many added today                                               |
| `no_capacity`         |    503 | No public port or dedicated address is free just now               |
| `network_unavailable` |    503 | The feature is not switched on in this region yet                  |
