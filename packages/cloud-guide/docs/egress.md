# Outbound traffic

For anyone who runs a website, an API or a mail server and sees traffic from
Runtime: where it comes from, what Runtime never lets out, and who to write to.

## Runtime's addresses

Sandboxes send from the addresses listed at
[withruntime.com/egress.json](https://withruntime.com/egress.json), IPv4 and
IPv6, with the time the list last changed. The list changes when a server joins
or leaves, so read it rather than copy it once.

```bash no-run
curl -s https://withruntime.com/egress.json
# {"ipv4":["203.0.113.10", ...],"ipv6":["2001:db8::10", ...],"updatedAt":"..."}
```

An account can hold its own address, which no other account sends from
([Dedicated outbound addresses](/docs/networking#dedicated-outbound-addresses)).
To admit one customer and nobody else, ask them for theirs.

## Shared addresses and per-address limits

Each server's sandboxes send from that server's shared addresses, an account
always from the same one of them. A service that limits callers by address
when they bring no key counts every account on that address together.

GitHub's API is the common case: calls without a token are capped at 60 an
hour per address, so `gh` without login, installers and release downloads
through `api.github.com`, and package resolvers that read GitHub answer
`API rate limit exceeded for <address>` once anyone on that address has used
the hour's 60. A token gives your account its own limit (5,000 an hour).
Store it as a secret that the network adds to every request to GitHub's API,
so tools need no change:

```bash no-run
printf %s "$GITHUB_TOKEN" | runtime secrets set GITHUB_TOKEN --host api.github.com --header Authorization --format "token {value}"
```

A fine-grained token with read access to public repositories is enough. For
`gh`, the placeholder in `GITHUB_TOKEN` works as it is
([secrets](/docs/security#secrets-sandboxes-never-see)). An account that needs an address no
other account shares can hold a
[dedicated outbound address](/docs/networking#dedicated-outbound-addresses).

## Signed requests

An account can have its sandboxes sign their HTTP requests as Runtime's,
with [Web Bot Auth](https://datatracker.ietf.org/doc/draft-meunier-web-bot-auth-architecture/)
(RFC 9421 HTTP message signatures). A site, or Cloudflare, Akamai or Vercel in
front of it, can then tell an agent on Runtime from anonymous traffic on a
hosting network. It is off until the account turns it on.

- **Signature-Agent** is `"https://withruntime.com"`. Runtime's keys are at
  [withruntime.com/.well-known/http-message-signatures-directory](https://withruntime.com/.well-known/http-message-signatures-directory).
- **Each signature** covers the site's authority and the Signature-Agent
  header, and lasts 5 minutes.
- **Only from a running sandbox** of an account that turned it on. Runtime
  never gives the key to a sandbox.

## What never leaves a sandbox

- **Mail.** Ports 25, 465 and 587 are closed to every sandbox. Support opens
  them for an account only on request, after review.
- **Scans.** A sandbox that tries many ports or many addresses the way only a
  scanner does has its network turned off.
- **Private addresses.** Private, internal and link-local addresses are
  refused, whoever asks.
- **Floods.** Each sandbox has limits on connections opened a second, on
  upload speed and on bytes a day; each account has limits on top.

Every outbound connection is recorded against the sandbox and the account that
made it, so a report with an address and a time finds its sender.

## Report abuse

Write to **abuse@withruntime.com** with the address or URL involved, the date,
time and time zone, and any logs you have. We find the sandbox, cut its network
and act on the account.
