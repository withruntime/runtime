# Limits

Every limit an account is held to, in one place. An account that holds credit
is charged for what it keeps rather than capped at it: the limits it has are
what runs at once, which is the fleet's room, and ceilings against a runaway
agent that no one using Runtime normally meets. An account without credit has
smaller limits, which adding credit lifts at once.

Your own account's limits, with how much of each you use, are on the
[Limits page of the console](https://withruntime.com/account/limits). A key
reads the same numbers from `GET /v1/limits` (`runtime.limits.get()` in the
SDK), in its `account` list: each row's `limit` (such as
`sandbox.memory_mib`), `max` and `used`, so an agent can see a limit coming
before a create is refused, and hold back new work while it is near. A key
limited to a compartment, or a worker key another key made, sees only its own
sandboxes, so its `account` is null.

## When you meet one

A create past a limit is refused with `quota_exceeded` (409) and costs
nothing. The message names the limit and its number, and the error's
`details` say the same for code:

```json
{
  "error": {
    "code": "quota_exceeded",
    "status": 409,
    "message": "This account holds up to 5 volumes. Delete one you no longer need, or write to support@withruntime.com to raise the limit.",
    "details": {
      "limit": "volume.count",
      "max": 5,
      "raise": "Write to support@withruntime.com to raise it.",
      "docs": "https://withruntime.com/docs/limits"
    }
  }
}
```

Retrying does not help. Delete or stop something the limit counts, add credit
if the account has none, or write to support@withruntime.com with the number
you need: any limit below can be raised for an account, usually the same day
([feedback and support](./feedback-and-support)).

## What an account holds and runs

`details.limit` names each row. Counts are per region, except sandboxes kept.

| Limit (`details.limit`)                                     | Without credit        | With credit                                             |
| ----------------------------------------------------------- | --------------------- | ------------------------------------------------------- |
| Sandboxes at once (`sandbox.count`)                         | {{trial-concurrency}} | {{paid-sandboxes}}, {{auto-sandboxes}} with auto top-up |
| vCPUs across running sandboxes (`sandbox.vcpu`)             | 8                     | {{account-vcpus}}, twice that with auto top-up          |
| Memory across running sandboxes (`sandbox.memory_mib`)      | 16 GiB                | {{account-memory}}, twice that with auto top-up         |
| Disk across running sandboxes (`sandbox.disk_mib`)          | 10 GiB each           | {{account-disk}}, twice that with auto top-up           |
| Sandboxes kept, running, paused or stopped (`sandbox.kept`) | 1,000                 | 1,000                                                   |
| Volumes (`volume.count`)                                    | 5                     | 10,000                                                  |
| Volume storage (`volume.disk_mib`)                          | 500 GiB               | No limit; charged by the GB                             |
| Volume backups (`volume-backup.count`)                      | 200                   | 10,000                                                  |
| Snapshots (`snapshot.count`)                                | 50                    | 10,000                                                  |
| Images (`image.count`)                                      | 20                    | 10,000                                                  |
| Image storage (`image.disk_mib`)                            | 200 GiB               | No limit; charged by the GB                             |
| Jobs, active or paused (`job.count`)                        | 1,000                 | 10,000                                                  |
| Secrets (`secret.count`)                                    | 1,000                 | 10,000                                                  |
| Dedicated outbound addresses (`address.count`)              | Needs credit          | 2                                                       |
| Private networks (`tunnel.count`)                           | Needs a kept top-up   | 1                                                       |

Without credit, a sandbox is at most 2 vCPU, 4 GiB of memory and a 10 GiB
disk, an account keeps {{no-credit-kept}} sandboxes, running, paused or stopped,
and makes {{no-credit-daily}} in any 24 hours, and it starts
{{trial-builds-a-day}} image builds a day; these
refusals have codes of their own, starting `no_credit_`
([included usage](./included-usage#without-credit)). With credit a sandbox is
up to {{max-vcpu}} vCPUs, {{max-memory}} of memory and a {{max-disk}} disk
([pricing](./pricing#how-many-at-once)). A disputed payment, a suspension or
an abuse report holds an account to {{restricted-sandboxes}} sandboxes at
once.

## Limits of one sandbox or one feature

These keep one sandbox or one host healthy, whatever the account pays. They
are refused with their own words, and support can raise most of them.

| Limit                                      | Number                        |
| ------------------------------------------ | ----------------------------- |
| Previews one sandbox shares                | 16 ports                      |
| TCP ports                                  | 5 a sandbox, 20 an account    |
| Custom domains                             | 50 an account, 20 added a day |
| Peers on a private network                 | 16                            |
| Image registry credentials                 | 20                            |
| Secrets with rules for sandboxes' requests | 50                            |
| Webhooks                                   | 16                            |
| OpenTelemetry exports                      | 3                             |
| Watches sending file changes at once       | 16                            |
| Image builds at once                       | 1 without credit, 4 with      |

API requests are limited per key and per account; a request past one is
`rate_limited` with a `Retry-After` ([API](./api)).
