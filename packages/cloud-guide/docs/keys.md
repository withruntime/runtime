# API keys and access

Every call sends an API key as a bearer token:

```bash
curl https://api.withruntime.com/v2/me -H "Authorization: Bearer $RUNTIME_API_KEY"
```

The SDKs, the CLI and the MCP server read the key from `RUNTIME_API_KEY`. The base URL is https://api.withruntime.com; set `RUNTIME_API_URL` to call another.

## Keys

- [`POST /v2/keys`](./reference/keys#create-a-key) makes a key. Its secret is returned once: store it in your secret manager.
- [`GET /v2/keys`](./reference/keys#list-keys) lists the organization's keys (every key for an owner or an admin, the caller's own otherwise), and [`DELETE /v2/keys/{id}`](./reference/keys#delete-a-key) revokes one at once.
- [`GET /v2/me`](./reference/me#get-a-me) returns who the key is: the agent it acts as, its organization, project and role. Every key may call it.

A key acts only with the actions its holder's grant allows, in one project when made with `projectId` (Growth and up), otherwise in every project its holder reaches. Each call's action is named on its reference page, such as `sandboxes:create` for [`POST /v2/sandboxes`](./reference/sandboxes#create-a-sandbox).

Make a key with `actions` to hold exactly the actions its code calls, on every plan:

```bash
curl https://api.withruntime.com/v2/keys -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "worker", "actions": ["sandboxes:create", "sandboxes:exec", "sandboxes:get"]}'
```

It acts as an agent of its own, granted a role of exactly those actions, both listed under its name by [`GET /v2/identities`](./reference/identities#list-identities) and [`GET /v2/roles`](./reference/roles#list-roles). It acts in every project you reach, or in one with `projectId` (Growth and up; a key that reaches one project alone makes keys held to it, also Growth and up). Each action must be one you may do yourself where the key acts: one you may not is refused 403, and one no call has is refused 400. It is held to your own limits too: a spend cap, rate, allowed addresses or end on the grant that lets you act is on its grant as well, and what it spends counts with yours. A key made with it holds the same actions, as an agent of its own, so a key rotated by making its next with it keeps working once the first is deleted.

Its role goes as soon as the key stops working (deleted, revoked or expired), so its agent can do nothing; its agent goes with the key. A key made with another key is kept, revoked, while that key's spend cap still counts it: 30 days after it is deleted, or longer while keys made with it live. A worker that only runs code gets a key without `sandboxes:delete`, and a dashboard a key of reads alone.

To change what a key may do without replacing it, change its role in place with [`POST /v2/roles/{id}:actions`](./reference/roles#actions):

```bash
curl https://api.withruntime.com/v2/roles/$ROLE_ID:actions -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"add": ["images:get", "images:delete"], "remove": ["sandboxes:delete"]}'
```

Every key that holds the role has the new actions from its next call, and its secret does not change. Only an owner or an admin may change a role's actions, and only to add actions they may perform themselves across the whole organization. Each change is an entry in the audit log, `roles:actions`, that lists the actions added and removed.

## Inside a machine

Never put a Runtime key in a machine that runs code you don't trust. To let that code call another API, use a [secret](./secrets).

## Give this to your agent

Paste this into your coding agent:

> Read https://withruntime.com/docs/keys.md. Give this project its own Runtime API key with only the actions its code calls, store it as RUNTIME_API_KEY in its secret manager, and never write the key into code, logs or a machine.
>
> This page as Markdown: https://withruntime.com/docs/keys.md
