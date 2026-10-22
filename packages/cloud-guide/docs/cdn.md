---
launch: apps
---

# CDN for Apps and Functions

Every App and Function is served through Cloudflare's CDN from the moment it
deploys: its `runtimehost.com` address and each of your custom domains. Your
visitors connect to a Cloudflare data center near them, files your App marks
public come straight back from there, and everything else travels Cloudflare's
network to your App. There is nothing to set up and no separate fee: it is part
of the price of Apps and Functions.

## What is cached

Only what your App says may be shared, by its own `Cache-Control` header. An
answer is kept when it says so for every visitor:

```http
Cache-Control: public, max-age=31536000, immutable
Cache-Control: s-maxage=60, stale-while-revalidate=300
```

Nothing else is kept, whatever its path or file type:

- an answer with no `Cache-Control`, or one marked `private`, `no-store` or
  `no-cache`;
- a plain `max-age` without `public`: frameworks send it for one browser's copy
  of a page they render per visitor, so it never reaches the next visitor;
- an answer that sets a cookie;
- any answer to a request that carries a cookie or an `Authorization` header;
- an answer whose `Vary` names anything but `Accept-Encoding`;
- an error from your App (5xx).

Runtime's routers see each request and its answer together and hold these
rules themselves, so a signed-in page cannot be cached by accident. Your
visitors' browsers get your App's headers exactly as it sent them. To give the
CDN a lifetime of its own, send `CDN-Cache-Control` (for example
`CDN-Cache-Control: max-age=600` beside `Cache-Control: no-cache`); it is read
in place of `Cache-Control` at the CDN, and the other rules still apply.

Each response says whether it came from the cache in `cf-cache-status`: `HIT`
from the CDN, `MISS` or `DYNAMIC` from your App.

## Every release starts fresh

Each deploy and each rollback empties the App's cache on every one of its
names, as soon as the new version serves every request: the next visitor's
page comes from the new version. Your App needs no versioned file names for
it, though content-hashed names (as Next.js, Vite and most bundlers write them)
still let browsers keep files for a year.

## Your visitors, as they are

Your App sees each visitor's own address in `x-runtime-client-ip`, as it would
without the CDN, and through the CDN their country too, in
`x-runtime-ip-country`. Firewalls and rate limits on the App work by visitor,
never by the CDN's addresses, and only Cloudflare's own network may say who a
visitor is: a visitor who sends those headers themselves is not believed.
WebSockets, server-sent events and streamed answers pass through.

## Custom domains

Point a custom domain at the name `runtime domains add` gives it,
`<token>.domains.runtimehost.com`. That name never changes: turning the CDN on
or off needs no change at your DNS provider. Runtime gets the domain's
certificate at the CDN over the `_acme-challenge` record you already set, and
sends the domain through the CDN only once that certificate is ready, so no
visitor ever meets a certificate warning.

An apex domain (`example.com`, not `www.example.com`) cannot be a CNAME. With
an A record it reaches your App directly, without the CDN; a DNS provider that
flattens a CNAME at the apex (ALIAS or ANAME records) can point it at the name
instead, and gets the CDN.

## Turning it off

Some Apps want every request to reach them directly: one that takes uploads
over 100 MB, or holds a request open longer than 100 seconds before it answers,
which Cloudflare's network does not carry. Turn the CDN off for that App:

```bash check
runtime apps update my-app --cdn off
```

In the API it is `cdn: false` on create or update (`POST /v1/apps/{id}:update`),
in every SDK the `cdn` setting, and in the console the switch in the App's
settings. Visitors reach the App directly within five minutes, as DNS
resolvers let go of the CDN's addresses. `--cdn on` puts it back.

## Price

The CDN costs nothing extra. Traffic your App sends out is billed at one price
whether a visitor got it from the CDN's cache or from your App (see
[pricing](./pricing)).
