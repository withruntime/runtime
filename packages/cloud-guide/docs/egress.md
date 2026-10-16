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
