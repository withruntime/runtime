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

GitHub's API is the common case. Calls without a token are capped at 60 an
hour per address. This affects `gh` without login, installers and release
downloads through `api.github.com`, and package resolvers that read GitHub.
They return `API rate limit exceeded for <address>` once anyone on that address
has used the hour's 60. A token gives your account its own limit (5,000 an hour).
Store it as a secret that the network adds to every request to GitHub's API,
so tools need no change:

```bash no-run
printf %s "$GITHUB_TOKEN" | runtime secrets set GITHUB_TOKEN --host api.github.com --header Authorization --format "token {value}"
```

A fine-grained token with read access to public repositories is enough. For
`gh`, the placeholder in `GITHUB_TOKEN` works unchanged
([secrets](/docs/security#secrets-sandboxes-never-see)). An account that needs an address no
other account shares can hold a
[dedicated outbound address](/docs/networking#dedicated-outbound-addresses).

An account whose sandboxes reach sites the way a scraper does sends from
addresses kept for scrapers instead of the shared ones, so a site that blocks
scrapers does not block the other accounts on the same server. Those addresses
are in the same list, and a sandbox keeps its internet whichever it sends from.

## Connections to one site

A sandbox opens up to 20 new connections a second to one site, after a burst
of 200, and an account's sandboxes on one server up to 100 a second together,
after a burst of 1,000. A site is its registered name: `www.example.com` and
`api.example.com` count together. The addresses a connection reaches count
too, by network (a /24, or a /64), at two and a half times those figures, so a
site's addresses asked for by number share its count. On HTTPS, a connection
whose TLS hello names another site than the one it asked for counts for that
site as well. Only new connections count, never bytes, so a download or a
stream over a connection already open is never slowed.

Package registries, code hosts, container registries, storage APIs (S3, R2,
Google Cloud Storage), model hubs, AI APIs and Runtime's own sites have their
own far higher figures: 200 a second for a sandbox and 2,000 for an account on
one server. An install, a clone or a download from many sandboxes at the same time
never reaches them. A site hosted on a provider's servers (an S3 website,
CloudFront, GitHub Pages) counts as a site of its own.

Past a count, the connection is refused with `429 Too Many Requests`,
`Retry-After: 1` and the header `X-Runtime-Egress: rate-limited:destination-sandbox`
(or `-org` for the account's), with a sentence naming the site. Reuse
connections (HTTP keep-alive, one client per process) or wait and retry. If
your work needs more to one site, write to support@withruntime.com.

## Sites that block by address

Some sites respond to an address that sends them too much traffic with a CAPTCHA
or a block, for everyone on that address: Google, Bing, DuckDuckGo, Yahoo,
Yandex, Baidu, Amazon, LinkedIn, Instagram, Facebook, X, TikTok, Zillow,
Indeed, Walmart, eBay, Booking.com and Airbnb. Your sandboxes on a server
share its outbound addresses with other customers, so each address a server
sends from for more than one account opens at most 150 new connections an
hour to each of these sites, after a burst of 50, for all accounts together,
and at most 100 an hour, after a burst of 30, for any one account. Past its
limit on its usual address, an account's connections leave from the server's
address for heavy traffic when it has one, under the same limits there.
Otherwise they are refused with `429 Too Many Requests`, the header
`X-Runtime-Egress: rate-limited:guarded-site` and `Retry-After: 36` (the
account's limit) or `Retry-After: 24` (the address's). An account that sends
from the addresses kept for scrapers reaches these sites only from those,
under the same limits: on a server that has none, its connections to them are
refused the same way, with `Retry-After: 600`, and its new sandboxes go first
to servers that have one. Reuse connections (HTTP keep-alive) to do more
within the limits. A
[dedicated outbound address](./networking#dedicated-outbound-addresses) is
yours alone and never counted.

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
- **Floods.** Each sandbox has limits on connections opened a second, to any
  site and to one site, on upload speed and on bytes a day; each account has
  limits on top.

Every outbound connection is recorded against the sandbox and the account that
made it, so a report with an address and a time finds its sender.

## Report abuse

Write to **abuse@withruntime.com** with the address or URL involved, the date,
time and time zone, and any logs you have. We find the sandbox, cut its network
and act on the account.
