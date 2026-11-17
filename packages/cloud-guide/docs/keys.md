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

A key acts only with the actions its holder's grant allows, in one project when made with `projectId` (Growth and up), otherwise in every project its holder reaches. Each call's action is named on its reference page, such as `sandboxes:create` for [`POST /v2/sandboxes`](./reference/sandboxes#create-a-sandbox). Give a worker that only runs code a key without `sandboxes:delete`, and a dashboard a key that only reads.

## Inside a sandbox

Never put a Runtime key in a sandbox that runs code you don't trust. To let that code call another API, use a [secret](./secrets).

## Give this to your agent

Paste this into your coding agent:

> Read https://withruntime.com/docs/keys.md. Give this project its own Runtime API key with only the actions its code calls, store it as RUNTIME_API_KEY in its secret manager, and never write the key into code, logs or a sandbox.
>
> This page as Markdown: https://withruntime.com/docs/keys.md
