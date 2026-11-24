# Identity tokens

Code in a machine can prove which machine it is without a stored key. Runtime signs a short-lived OpenID Connect ID token that names the machine, its organization, its project and its image. Your AWS or Google Cloud account trusts Runtime's issuer once, then lets a machine assume a role with the token. Your own API can accept it too.

## Get a token

Inside a machine, with no API key. Every machine's environment has `RUNTIME_ID_TOKEN_REQUEST_URL` and `RUNTIME_ID_TOKEN_REQUEST_TOKEN`:

```bash
curl -H "Authorization: Bearer $RUNTIME_ID_TOKEN_REQUEST_TOKEN" \
  "$RUNTIME_ID_TOKEN_REQUEST_URL?audience=sts.amazonaws.com"
```

```ts
const url = `${process.env.RUNTIME_ID_TOKEN_REQUEST_URL}?audience=sts.amazonaws.com`;
const answer = await fetch(url, {
  headers: { Authorization: `Bearer ${process.env.RUNTIME_ID_TOKEN_REQUEST_TOKEN}` },
});
const { token, subject, expiresAt } = await answer.json();
```

```python
import json
import os
import urllib.request

url = os.environ["RUNTIME_ID_TOKEN_REQUEST_URL"] + "?audience=sts.amazonaws.com"
auth = {"Authorization": "Bearer " + os.environ["RUNTIME_ID_TOKEN_REQUEST_TOKEN"]}
with urllib.request.urlopen(urllib.request.Request(url, headers=auth)) as answer:
    token = json.load(answer)["token"]
```

The answer is JSON: `token`, `expiresAt`, `issuer`, `subject` and `audience`.

- `audience` is required: who the token is for. Use `sts.amazonaws.com` for AWS, your workload identity provider's name for Google Cloud, or your API's name.
- `lifetimeSeconds` sets how long the token lasts, 60 to 3,600 seconds. Ask for a fresh one when it expires.
- Only a running machine gets a token, and only for itself: Runtime knows the machine by the connection it asks on, never by anything the request says.
- A program started without the two variables reads them from `http://runtime.internal/v1/environment` (JSON).

## What a token says

| Claim | |
| --- | --- |
| `iss` | `https://withruntime.com/oidc` |
| `sub` | `org:<org-id>:image:<image>:sandbox:<sandbox-id>` |
| `aud` | The audience you asked for |
| `org_id`, `project_id` | The machine's organization and project |
| `sandbox_id`, `sandbox_name` | The machine, and its name if it has one |
| `image`, `image_id` | The image's name (`base` for none of your own) and its id |
| `funding`, `region`, `runtime_environment` | `paid`, where it runs, and `production` |
| `iat`, `nbf`, `exp`, `jti` | When it was issued, from when and until when it holds, and its own id |

A trust policy matches on `sub`: `org:<org-id>:*` is every machine of an organization, and `org:<org-id>:image:<name>:*` every machine made from one image.

## Trust Runtime in AWS

Add an OpenID Connect identity provider with the provider URL `https://withruntime.com/oidc` and the audience `sts.amazonaws.com`. Give a role this trust policy:

```json
{
  "Effect": "Allow",
  "Principal": { "Federated": "arn:aws:iam::<account>:oidc-provider/withruntime.com/oidc" },
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringEquals": { "withruntime.com/oidc:aud": "sts.amazonaws.com" },
    "StringLike": { "withruntime.com/oidc:sub": "org:<org-id>:*" }
  }
}
```

In the machine, write the token to a file and set `AWS_WEB_IDENTITY_TOKEN_FILE` and `AWS_ROLE_ARN`: every AWS SDK and the CLI then assume the role by themselves.

## Trust Runtime in Google Cloud

Create a workload identity pool with an OIDC provider: issuer `https://withruntime.com/oidc`, attribute mapping `google.subject=assertion.sub` and `attribute.org_id=assertion.org_id`, and an attribute condition such as `assertion.org_id == '<org-id>'`. Use the provider's full name as the audience, and exchange the token at Google's Security Token Service.

## Check a token in your own API

The issuer's discovery document is `https://withruntime.com/oidc/.well-known/openid-configuration` and its keys are at `https://withruntime.com/oidc/jwks`. Check the RS256 signature with the key its `kid` names, then `iss`, `aud` and `exp`, as any JWT library does.

## Give this to your agent

Paste this into your coding agent:

> Read https://withruntime.com/docs/identity-tokens.md. Replace every cloud access key this project's code on Runtime holds with an identity token: trust Runtime's issuer once in the cloud account, give the role a trust policy that names this organization's machines, and get credentials from the token in the machine.
>
> This page as Markdown: https://withruntime.com/docs/identity-tokens.md
