# API versions and deprecation

How the HTTP API is versioned, how a name that changes keeps working, and the
headers that tell your code a path is being retired. The same rules cover the SDKs,
the CLI and the MCP tools.

## Versions

Every path starts with `/v1`. The OpenAPI document at
`https://api.withruntime.com/v1/openapi.json` gives the version of the API in
`info.version`; it is 0.2.0.

The 0.1.0 routes under `/v1/resources` were removed on 22 September 2026. Each
returns `410` with the code `upgrade_required`, and `details.replacement` names
the route that replaced it. [The migration guide](./migrate) maps each old call
to its new one.

## When a name changes

Each product has one plural name in every path, SDK call, command and MCP tool:
`/v1/sandboxes`, `runtime.sandboxes`, `runtime sandboxes`, `runtime_sandboxes`.
When a name changes, the old one keeps working for 30 days:

1. **From the day the new name ships**, a request to the old path is served as
   the new one. Each response carries a `Warning` header with the new name and a
   `Link` to the new path (`rel="successor-version"`). The SDKs and the CLI print
   the warning once; an MCP response carries it as `warning`.
2. **Once the last day is set**, responses also carry `Deprecation` (RFC 9745, the
   day the rename shipped) and `Sunset` (RFC 8594, the last day), and the warning
   names that day.
3. **From the last day**, the old name returns `410` with the code
   `name_retired`, and its `hint` names the new one.

A field renamed in a response follows the same 30 days, with the same code once
it stops.

```http
HTTP/2 200
Warning: 299 runtime "/v1/tunnel is now /v1/networks/wireguard."
Link: </v1/networks/wireguard>; rel="successor-version"
```

## What to do

- Read `Warning` and `Sunset` on responses, or let the SDK print them. Move to
  the new name before its last day.
- Treat `410 name_retired` and `410 upgrade_required` as a sign that the code must
  change, never as a reason to retry. The `hint` names what to call instead.
- The [API reference](./api#versions) holds the same rules beside every route.
