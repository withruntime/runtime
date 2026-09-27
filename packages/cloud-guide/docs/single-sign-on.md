# Single sign-on and directory sync

People in your company sign in to Runtime with your identity provider, over
SAML or OIDC. Your directory adds them, gives them roles through groups, and
removes them the moment they leave, over SCIM. Both are free on every account.

Okta, Microsoft Entra ID and Google Workspace are supported from day one, and
any provider that speaks SAML 2.0 or OpenID Connect works the same way.

An owner sets it up at
[Single sign-on](https://withruntime.com/account/single-sign-on). It takes
three steps: create an app in your identity provider, prove you own your email
domain with a DNS record, and choose who joins and how.

## How it works

- **One connection per email domain.** A connection is your identity provider
  for one domain, such as `company.com`. An account can have up to 10.
- **Nobody signs in until the domain is proven.** You add a TXT record at
  `_runtime-verify.<your domain>`. Only one Runtime account can hold a proven
  domain, so another company cannot sign in people from yours.
- **Your provider speaks only for your domain.** Runtime accepts a sign-in only
  for an address exactly on the proven domain. An identity provider that
  asserts any other address is refused before an account is made or linked.
- **People join on first sign-in.** Anyone with an address on your domain who
  signs in through your provider joins your account with the default role you
  choose (developer unless you change it). Someone who already uses Runtime
  keeps their own account and joins yours as well.
- **Removal sticks.** Someone an owner or admin removed does not come back by
  signing in again. Invite them, or reactivate them in your directory.
- **The audit log records it all.** Connections made, changed and removed,
  domains verified, SSO required or not, people joining, SCIM tokens, and every
  change your directory makes.

## Set up SAML

On the Single sign-on page, choose **Connect your identity provider**, pick
your provider, choose **SAML** and enter your email domain. The page shows the
values to give your provider before you save anything.

### Okta

1. In Okta, go to **Applications > Create App Integration > SAML 2.0**.
2. **Single sign-on URL:** the page's single sign-on URL (ACS). Tick **Use this
   for Recipient URL and Destination URL**.
3. **Audience URI (SP Entity ID):** the page's audience URI.
4. **Name ID format:** EmailAddress. **Application username:** Email.
5. Add attribute statements `email` (user.email), `firstName`
   (user.firstName) and `lastName` (user.lastName).
6. Leave the assertion signed (Okta's default). Save, then copy the app's
   **Metadata URL** from its Sign On tab into Runtime and save.

### Microsoft Entra ID

1. In Entra, go to **Enterprise applications > New application > Create your
   own application** (non-gallery), then **Single sign-on > SAML**.
2. **Identifier (Entity ID):** the page's audience URI. **Reply URL (Assertion
   Consumer Service URL):** the page's single sign-on URL.
3. Keep the default claims: they include the email address, given name and
   surname Runtime reads. Signing option: **Sign SAML assertion** (the default).
4. Copy the **App Federation Metadata Url** into Runtime and save.
5. Assign the users or groups who should have access.

### Google Workspace

1. In the Admin console, go to **Apps > Web and mobile apps > Add app > Add
   custom SAML app**.
2. Copy Google's **SSO URL**, **Entity ID** and **Certificate** into Runtime,
   using **Enter by hand**, or download the IdP metadata and paste it.
3. **ACS URL:** the page's single sign-on URL. **Entity ID:** the page's
   audience URI. **Name ID format:** EMAIL, **Name ID:** Basic Information >
   Primary email.
4. Optionally map First name to `firstName` and Last name to `lastName`.
5. Turn the app on for the people or groups who should have access.

## Set up OIDC

Choose **OIDC** instead, and give your provider the page's **sign-in redirect
URI**. Then enter the provider's issuer URL, client ID and client secret.
Runtime reads the provider's discovery document to find the rest.

| Provider         | Issuer URL                                           | Notes                                                             |
| ---------------- | ---------------------------------------------------- | ----------------------------------------------------------------- |
| Okta             | `https://<your-company>.okta.com`                    | Create an **OIDC Web Application**; grant type Authorization Code |
| Microsoft Entra  | `https://login.microsoftonline.com/<tenant-id>/v2.0` | Register an app; add the **email** optional claim to the ID token |
| Google Workspace | `https://accounts.google.com`                        | Create an OAuth client (Web application), user type Internal      |

Runtime asks for the `openid`, `email` and `profile` scopes, uses PKCE, and
checks the ID token's signature, issuer, audience and expiry. The client
secret is stored for the sign-in service only and is never shown again; leave
it empty when you change other settings to keep it.

## Prove your domain

Add the TXT record the page shows at your DNS provider:

| Type | Name                          | Value                    |
| ---- | ----------------------------- | ------------------------ |
| TXT  | `_runtime-verify.company.com` | `runtime-verify=<token>` |

Then choose **Check DNS**. A new record can take a few minutes to appear. Once
it is verified, the record can stay or go; the domain stays verified. If
another Runtime account already verified the domain, contact support.

## Sign in

- People choose **Use single sign-on (SSO)** on the sign-in page and enter their
  work email, or open the page's **initiate login URI**, which starts sign-in
  with your provider straight away.
- Runtime answers only sign-ins it started, so a SAML tile that posts straight
  to Runtime (IdP-initiated sign-in) is refused. For an app-list tile, point a
  bookmark app at the initiate login URI (OIDC apps take it as their initiate
  login URI directly).
- For SAML, Runtime checks the assertion's signature, audience, recipient and
  validity window, takes each assertion once, and refuses a response with more
  than one assertion.

## Require single sign-on

Tick **Require single sign-on** on a connection once its domain is verified.

- Members other than owners can then use the account only through your
  provider. A Google or email-link session is sent back to sign in.
- **Owners are exempt,** so a broken identity provider cannot lock you out of
  your own account.
- **API keys are not affected.** A key is not a sign-in. Revoke keys, or remove
  the person, to stop them.
- A person who also belongs to another Runtime account still reaches that one
  with their usual sign-in.

## Directory sync (SCIM)

Your directory creates, updates and deactivates people in Runtime.

1. On the Single sign-on page, choose **Make a SCIM token**. Copy it; it is
   shown once.
2. In your provider, turn on provisioning with:
   - **Base URL:** `https://withruntime.com/scim/v2`
   - **Authentication:** HTTP header, bearer token: the SCIM token
   - **Unique identifier:** `userName` (the email address)
3. Push the groups whose roles you want Runtime to follow, then choose on the
   Single sign-on page which role each group gives.

In **Okta**: the app's **Provisioning** tab, SCIM 2.0, with Push New Users,
Push Profile Updates, Push Groups and Deactivate Users. In **Entra ID**: the
enterprise app's **Provisioning**, mode Automatic, **Tenant URL** the base URL
and **Secret Token** the SCIM token. Google Workspace does not offer SCIM to
custom apps; with Google, people join on first sign-in.

What each change does:

- **A person deactivated or deleted** loses their membership at once, and
  every API key they made is revoked in the same step. What they created stays
  with the account.
- **Reactivated**, they come back with the role their groups give. Their old
  keys stay revoked.
- **Groups decide roles.** A person gets the highest role any of their groups
  gives: admin, then developer, then billing. With no mapped group, they get
  the connection's default role. A group never makes anyone an owner, and
  owners' roles are never changed by the directory.
- **Somebody your directory adds who has never signed in** joins at their first
  single sign-on, with their groups' role. If the directory has deactivated
  them first, they are refused.

A SCIM token acts with the authority of the owner who made it and stops if
they stop being an owner. An account has at most two live tokens, so you can
replace one without a gap. Runtime supports the filters and PATCH operations
Okta and Entra ID send: `eq` filters on `userName`, `externalId`, `emails` and
`displayName`, paging with `startIndex` and `count`, and `add`, `replace` and
`remove` on users and group members.

## From code

Single sign-on is changed by an owner on the website, never with a key. A key
made by an owner or admin can read it:

```bash no-run
npx withruntime sso
curl -H "Authorization: Bearer $RUNTIME_API_KEY" https://api.withruntime.com/v1/sso
```

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const { connections, scim } = await runtime.sso.get();
console.log(
  connections.map((c) => `${c.domain} ${c.domainVerifiedAt ? "verified" : "pending"}`),
  scim.users,
);
```

Python: `runtime.sso.get()`, the same fields. MCP: the `runtime_account`
tool's `sso` action.

## Troubleshooting

- **"Provider domain has not been verified":** check DNS on the Single sign-on
  page first.
- **"signed you in with an address outside your company's verified domain":**
  the address your provider sent is not on the connection's domain. Check the
  NameID or email attribute (SAML) or the `email` claim (OIDC).
- **"Invalid SAML response":** the certificate in Runtime does not match the
  one your provider signs with, or the assertion is not signed. Upload the
  current metadata again.
- **Audience or recipient mismatch:** the audience URI or single sign-on URL in
  your provider is not the one the page shows for this connection.
