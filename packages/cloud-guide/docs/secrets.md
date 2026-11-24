# Secrets

Code in a machine, such as an agent's, should never hold your API keys: anything it can read, it can leak. A secret keeps the key outside the machine. The machine holds a placeholder, and Runtime puts the real value in the request as it leaves for the hosts you name, over HTTPS.

## Store a secret

[`PUT /v2/secrets/{name}`](./reference/secrets#set) takes a [SecretSet](./reference/secrets#secretset):

| Field | |
| --- | --- |
| [`value`](./reference/secrets#secretset) | Its value, never answered. Hidden: 1 to 8192 visible ASCII characters and spaces, one line, since it goes into an HTTP header. Visible: 1 byte to 64 KiB of UTF-8 text with no NUL, newlines included (a PEM file, an SSH key, a service account's JSON). With it, the set stores the secret whole, as its fields say. Without it, the set changes only the hosts, `policies.rules` and scope it names, and keeps the rest: hosts and rules only narrow, since widening needs the value, and so does a visible secret's scope, whose machines hold its value; any other field is refused 400. |
| [`hosts`](./reference/secrets#secretset) | The hosts its value goes to on HTTPS: a name, or `*.` and a name for every name under it. Required unless visible; refused when visible. |
| [`header`](./reference/secrets#secretset) | The header it is set in on every request to its hosts; when omitted, its placeholder is replaced in the credential headers (Authorization, x-api-key and the like). Hidden secrets only. |
| [`format`](./reference/secrets#secretset) | The header's value, `{value}` replaced by the secret; `{value}` when omitted. Hidden secrets only. |
| [`envName`](./reference/secrets#secretset) | The environment variable that holds its placeholder (or, when visible, its value) in each machine it reaches; its name when omitted. When two secrets that reach one machine name the same variable, it holds the one first by name. |
| [`scope`](./reference/secrets#secretset) | The machines that may use it; every machine of the organization when omitted. |

The answer, a [Secret](./reference/secrets#secret), never holds the value: [`placeholder`](./reference/secrets#secret) is what a machine holds in its place.

```bash
curl -X PUT https://api.withruntime.com/v2/secrets/OPENAI_API_KEY \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"value": "sk-...", "hosts": ["api.openai.com"], "scope": {"labelsAny": [{"team": "agents"}]}}'
```

## Which machines get it

- Scope every secret. When [`scope`](./reference/secrets#secretset) is left out, The machines that may use it; every machine of the organization when omitted. Scope a secret to the labels of the machines that need it: Machines with every label of any one of these sets. Give this or `none`.
- A machine can narrow what it gets further at create: [`secrets`](./reference/sandboxes#sandboxcreate): The secrets it may get, by name, at most 64: only those of them whose scope admits it; [] none; every one whose scope admits it when omitted. A name with no secret yet takes effect once that secret is created. Fixed for its life: a fork or a copy of a snapshot keeps it.
- [`PUT /v2/secrets/{name}`](./reference/secrets#set) without the value changes a stored secret's hosts, rules or scope and keeps the rest: hosts and rules only narrow, since widening needs the value.
- [`DELETE /v2/secrets/{name}`](./reference/secrets#delete-a-secret) removes it. Machines that held its placeholder can no longer use it.

## Give this to your agent

Paste this into your coding agent:

> Read https://withruntime.com/docs/secrets.md. Store each API key this project's code on Runtime uses as a Runtime secret for the hosts it calls, scope each to the machines that need it, and remove the keys from the machines' environment and files.
>
> This page as Markdown: https://withruntime.com/docs/secrets.md
