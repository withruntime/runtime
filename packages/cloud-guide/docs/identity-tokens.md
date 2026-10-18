# Identity tokens

Code in a sandbox can prove which sandbox it is, without a stored key. Runtime
signs a short-lived OpenID Connect token that names the sandbox, its
organization and its image. Your AWS or Google Cloud account trusts Runtime
once, then lets a sandbox assume a role with the token. Your own API can accept
it too. It works like GitHub Actions' OIDC tokens, and it is free.

## Get a token

Inside a sandbox, with no API key:

```bash no-run
runtime sandboxes identity-token --audience sts.amazonaws.com
```

```ts check
import { Sandbox } from "withruntime";

const { token, subject } = await Sandbox.identityToken({ audience: "sts.amazonaws.com" });
console.log(subject, token.length);
```

```python check
from withruntime import Sandbox

token = Sandbox.identity_token("sts.amazonaws.com")
print(len(token))
```

Or with curl, the way GitHub Actions does it. A new sandbox made from the
current default image has these two variables ready for its first accepted
command, valid while it runs. A [scheduled job](./jobs)'s run has them in its
command's environment too, so a job can get tokens the same ways. Retained
older-image sandboxes keep their original guest software:

```bash no-run
curl -H "Authorization: Bearer $RUNTIME_ID_TOKEN_REQUEST_TOKEN" \
  "$RUNTIME_ID_TOKEN_REQUEST_URL?audience=sts.amazonaws.com"
```

- `audience` is required: who the token is for. Use `sts.amazonaws.com` for
  AWS, your workload identity provider's name for Google Cloud, or your API's
  name.
- A token lasts 10 minutes. Ask for 60 to 3600 seconds with `lifetimeSeconds`
  (`--lifetime` in the CLI). Get a fresh one when it runs out.
- The options can also go in a JSON body (`Content-Type: application/json`)
  of at most 4 KiB. A body that has not arrived within 5 seconds is answered
  408 `request_timeout`; nothing was issued, so send it again.
- `RUNTIME_ID_TOKEN_REQUEST_TOKEN` is the sandbox's own proof of who it is. It
  can get tokens only for this sandbox, only while it is running, and stops
  when the sandbox stops or pauses. Treat it like a password anyway: anyone who
  copies it can get tokens as this sandbox until then.
- The request token changes with each renewal of the sandbox's lease, and a
  fork's programs keep the source's. A program that runs a long time, or was
  copied, reads the current one again from
  `http://runtime.internal/v1/environment` (JSON, with both variables); the
  JavaScript and Python SDKs do this for you when a token they hold is refused.
- Use the supplied `RUNTIME_ID_TOKEN_REQUEST_URL`. It points to Runtime's
  internal token relay, which accepts only this sandbox's current request
  token. You do not need to allow access to the host's public address.

## What a token says

| Claim          | Example                                                |
| -------------- | ------------------------------------------------------ |
| `iss`          | `https://withruntime.com/oidc`                         |
| `sub`          | `org:<org-id>:image:<image>:sandbox:<sandbox-id>`      |
| `aud`          | The audience you asked for                             |
| `org_id`       | Your organization's id (`runtime whoami` shows it)     |
| `sandbox_id`   | The sandbox's id                                       |
| `sandbox_name` | Its name, if it has one                                |
| `image`        | The image's name, its id if it has no name, or `base`  |
| `image_id`     | The image's id, for a sandbox made from one            |
| `image_digest` | `sha256:...` of the image, for a sandbox made from one |
| `funding`      | `paid` or `trial`                                      |
| `region`       | Where the sandbox runs                                 |
| `exp`, `iat`   | When it expires and when it was issued                 |

A scheduled job's run also says which job it is:

| Claim              | What it is                                                   |
| ------------------ | ------------------------------------------------------------ |
| `job_id`           | The job's id                                                 |
| `job_name`         | Its name                                                     |
| `job_version`      | Its version, which grows with each change                    |
| `job_run_id`       | This run                                                     |
| `job_made_by`      | The agent or person that made it                             |
| `job_made_by_kind` | `agent` or `person`                                          |
| `job_vouched_by`   | The owner or admin who vouched for it, while it is unchanged |

An owner or admin vouches for a job on its page in the console, signed in. No
API key can. Only runs that start after the vouch carry the name. Any change
to the job's command, schedule or size clears the vouch, even if the job is
later put back as it was, until someone vouches again. A job that uses secrets cannot be vouched
for. If anything other than the job
reached a run's sandbox (a command or file call, a preview, a port or
domain, a snapshot, or an attached volume), that run's tokens name no job at
all, since what runs there may not be the job's. The next run starts fresh. A token that names a voucher lives five minutes at most, whatever you ask for. So an API that does something only a person should allow can accept a
job's call only when `job_vouched_by` is there, as Runtime's own billing jobs
do.

`sub` is built for trust policies: `org:<org-id>:*` matches every sandbox of
your organization, and `org:<org-id>:image:api-worker:*` only those made from
the image `api-worker`. No part of it can contain a colon.

Tokens are signed with RS256. The discovery document is at
`https://withruntime.com/oidc/.well-known/openid-configuration` and the keys at
`https://withruntime.com/oidc/jwks`. Runtime publishes a new key an hour before
it signs with it and keeps an old one published for two hours after it stops,
so a verifier that caches the keys never misses one.

## AWS

1. In IAM, add an **OpenID Connect** identity provider: provider URL
   `https://withruntime.com/oidc`, audience `sts.amazonaws.com`.
2. Create a role with this trust policy, with your account and organization
   ids:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::123456789012:oidc-provider/withruntime.com/oidc"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": { "withruntime.com/oidc:aud": "sts.amazonaws.com" },
        "StringLike": { "withruntime.com/oidc:sub": "org:<your-org-id>:*" }
      }
    }
  ]
}
```

3. In the sandbox, let the AWS CLI and SDKs pick it up:

```bash no-run
runtime sandboxes identity-token --audience sts.amazonaws.com --lifetime 3600 > /tmp/aws-token
export AWS_ROLE_ARN=arn:aws:iam::123456789012:role/runtime-sandbox
export AWS_WEB_IDENTITY_TOKEN_FILE=/tmp/aws-token
aws sts get-caller-identity
```

Write the file again before the token expires for work that runs longer than
an hour.

## Google Cloud

Create a workload identity pool and an OIDC provider that trusts Runtime,
mapping the subject and the organization:

```bash no-run
gcloud iam workload-identity-pools create runtime --location=global
gcloud iam workload-identity-pools providers create-oidc runtime \
  --location=global --workload-identity-pool=runtime \
  --issuer-uri=https://withruntime.com/oidc \
  --attribute-mapping="google.subject=assertion.sub,attribute.org_id=assertion.org_id,attribute.image=assertion.image" \
  --attribute-condition="assertion.org_id == '<your-org-id>'"
```

Grant the pool's principals access (for example
`roles/iam.workloadIdentityUser` on a service account), then in the sandbox ask
for a token whose audience is the provider's full name,
`//iam.googleapis.com/projects/<number>/locations/global/workloadIdentityPools/runtime/providers/runtime`,
and exchange it with Google's STS, or point a credential configuration file at
a file holding the token.

## Your own API

Verify the token with any OIDC library: fetch the keys from
`https://withruntime.com/oidc/jwks`, and check the signature, that `iss` is
`https://withruntime.com/oidc`, that `aud` is your API's name, and that it has
not expired. Then trust `org_id`, `sandbox_id` and `image`.

```js
// With the jose library (npm install jose).
import { createRemoteJWKSet, jwtVerify } from "jose";

const keys = createRemoteJWKSet(new URL("https://withruntime.com/oidc/jwks"));
export async function sandboxOf(token) {
  const { payload } = await jwtVerify(token, keys, {
    issuer: "https://withruntime.com/oidc",
    audience: "https://api.example.com",
  });
  return { org: payload.org_id, sandbox: payload.sandbox_id };
}
```

## Limits

- Tokens are for sandboxes today, a job's runs included. Code outside a
  sandbox has nothing to ask with, and no API key can get one.
- Microsoft Entra ID's federated credentials match an exact subject, and every
  sandbox's subject is different, so Azure is not supported yet. Tell us with
  `npx withruntime feedback "identity tokens: Azure"` if you need it.
