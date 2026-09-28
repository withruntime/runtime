# Security and compliance

Runtime runs every sandbox in its own Firecracker virtual machine on dedicated
servers in audited data centers, encrypts every backup to keys the storage
provider never sees, and publishes how it works: this page is the summary a
security review asks for, with links to the detail.

For a questionnaire, a data processing agreement or anything this page does not
answer, write to security@withruntime.com.

## Where your data lives

Everything runs in one region, in Virginia, United States
([speed](./speed) has the measurements).

| What                                         | Who                   | Their certifications, checked 27 September 2026 |
| -------------------------------------------- | --------------------- | ----------------------------------------------- |
| Sandboxes, their disks and memory            | OVHcloud US, Virginia | SOC 1, SOC 2 and SOC 3 Type 2; ISO 27001        |
| Accounts, billing, audit log, sealed secrets | Neon                  | SOC 2 Type 2; ISO 27001 and 27701               |
| The website, the API and the console         | Vercel                | SOC 2 Type 2; ISO 27001                         |
| Encrypted backups                            | Backblaze B2          | SOC 2 Type 2                                    |
| Card payments                                | Stripe                | PCI DSS Level 1                                 |
| Email in and out                             | Cloudflare, Resend    | SOC 2 Type II; Cloudflare also ISO 27001        |

The full list, with what each company does and where, is on the
[subprocessors](/legal/subprocessors) page, and the
[data processing addendum](/legal/dpa) is part of the terms for every account.

## How your work is kept apart

- **Each sandbox is its own virtual machine**, with its own Linux kernel, disk
  and memory. CPU, memory, network rules and leases are enforced on the host,
  outside the guest.
- **Sandboxes reach the public internet only.** Private and internal addresses
  are refused, and any sandbox's network can be cut at once.
- **Secrets your sandboxes use are never inside them.** A sandbox sees a
  placeholder, and the host puts the real value in on the way out
  ([secrets sandboxes never see](./security#secrets-sandboxes-never-see)).
- **Customers are separated in the database** by row-level security tied to the
  organization, and each part of the system connects with its own role holding
  only what that part needs.

[Isolation and account boundaries](./security) has the detail.

## Encryption

- **In transit:** every connection to Runtime, and from Runtime to its
  database, uses TLS, and the database's certificate is verified.
- **Backups of your sandboxes and volumes** are encrypted with a key that
  belongs to your organization alone, before they leave the server. Deleting
  the organization destroys that key first, so every copy becomes unreadable at
  once ([storage and backups](./storage#encryption-and-deletion)).
- **The nightly copy of our database** is encrypted to a key held offline, so
  neither the storage provider nor the website can read it.
- **Stored secrets** are sealed, never returned by any API, and never written
  into a sandbox.

## Sign-in and access

- **Single sign-on** over SAML or OIDC and **directory sync** over SCIM, free on
  every account ([single sign-on](./single-sign-on)).
- **Two-step sign-in** with an authenticator app, which an owner can require of
  everyone in the account ([two-step sign-in](./security#two-step-sign-in)).
- **Four roles** (owner, admin, developer, billing) and keys scoped to named
  operations, read-only keys and daily spending limits per key.
- **An audit log** of every change to the account, who made it, from where and
  how, kept at least 400 days ([teams and the audit log](./teams)).

## Availability and recovery

- **The status page** publishes the API's uptime, checked from outside every two
  minutes, and a real sandbox started from outside every ten
  ([status](https://withruntime.com/status)).
- **Paid accounts are promised {{uptime-promise}} API uptime** every month, with
  service credit paid automatically when a month falls short
  ([uptime promise](/legal/sla)).
- **The database** can be rewound to any moment in the last 24 hours, and a
  sealed copy goes off-site every night and is kept 30 days, locked so it cannot
  be deleted early. A restore from that copy is drilled every month.
- **Volumes are backed up off their server every day**, and snapshots as soon
  as they are taken, so they survive the loss of the server
  ([storage and backups](./storage)).

## How Runtime is run

These are the practices every change and every operator follows.

- **Access.** Production is reached only with named keys, never passwords, and
  only by the people who operate it. Who holds access to each system is
  reviewed every quarter.
- **Change.** Every change to the service is in version control, and the rule
  is that it passes formatting, a check of every dependency against published
  security advisories, linting, type checks, a full build and the test suite
  before it is pushed. Going live is a separate, deliberate step.
- **Vulnerabilities.** Dependencies are checked against published advisories on
  every change. Reports go to security@withruntime.com, as
  [security.txt](https://withruntime.com/.well-known/security.txt) says
  ([report a vulnerability](./security#report-a-vulnerability)).
- **Incidents.** A written procedure covers containing an incident, keeping the
  evidence, finding who is affected and telling them without undue delay, as
  the [data processing addendum](/legal/dpa) promises.
- **Suppliers.** Every company that handles customer data is on the
  [subprocessors](/legal/subprocessors) page before it starts, under a data
  processing agreement.
- **Retention and deletion.** What is kept, and for how long, is in the
  [privacy policy](/legal/privacy).
- **Review.** Risks and these practices are reviewed every year, and after any
  incident.

| Check                              | How often     | Last done         |
| ---------------------------------- | ------------- | ----------------- |
| Who holds access to each system    | Every quarter | 27 September 2026 |
| Restore the database from its copy | Every month   | 27 September 2026 |
| Risks and these practices          | Every year    | 27 September 2026 |
