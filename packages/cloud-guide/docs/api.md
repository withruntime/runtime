# HTTPS API reference

One API for every Runtime Cloud product, at `https://api.withruntime.com`.

The SDKs, the CLI and MCP are thin layers over it. This page is the contract.
The machine-readable one is the public OpenAPI document at
`https://api.withruntime.com/v1/openapi.json`, generated from the same route
definitions the server validates with.

API version: **0.2.0**.

## Requests

Send the key as a bearer token. Keys stay in server-side secret storage; never in
a URL, a browser or a command line others can read. A browser uses a
[session](#sessions) instead.

```bash no-run
curl https://api.withruntime.com/v1/sandboxes \
  -H "Authorization: Bearer ${RUNTIME_API_KEY}" \
  -H "Content-Type: application/json" \
  -H "Prefer: wait=60" \
  -d '{}'
```

In a shell, put a variable before a colon in braces: `"${ID}:exec"`. zsh, the
macOS default, reads `$ID:e` as a modifier and sends `/xec`.

Never use `curl -v` or `--trace` with the key: they print the `Authorization`
header.

A key sees and uses what its own agent made: another key's sandbox answers 404
`not_found`. An account-wide key, which an owner or admin makes at
[API keys](https://withruntime.com/account/keys) or approves for
`runtime keys create --account-wide`, sees and uses everything in the account,
and `getOrCreate` returns a sandbox another key named. A key in a
[compartment](./security#compartments) sees what its compartment's keys made,
and nothing else. A full-access key of an owner or admin can make, list and revoke keys with
`/v1/keys`; no other key can ([run a swarm](./teams#run-a-swarm)).

```bash no-run
curl -sS "https://api.withruntime.com/v1/sandboxes/${ID}:exec" \
  -H "Authorization: Bearer ${RUNTIME_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"command": "python3 -c \"print(sum([125, 250, 375]))\""}'
```

- Resources live at `/v1/<plural>/{id}`. A change that is not a plain update is
  `POST /v1/<plural>/{id}:<verb>`: `:stop`, `:pause`, `:wake`, `:exec`.
- Field names are camelCase. Times are ISO 8601 in UTC. Money is integer
  microdollars: 1,000,000 is one US dollar.
- Unknown fields are refused, and every wrong field is named in one answer.
- `Prefer: wait=N` (seconds, at most 120) on a change answers once the resource
  has settled rather than at once. `GET /v1/sandboxes/{id}?waitFor=running&timeoutSeconds=60`
  waits for a state without polling.

## Responses and errors

Every response carries `x-request-id`. Every error has one shape:

```json
{
  "error": {
    "code": "no_credit_running_limit",
    "status": 429,
    "message": "An account without credit runs at most 4 sandboxes at once.",
    "hint": "... Stop or pause one you no longer need (runtime sandboxes stop <id>, or pause <id>), or wait for one to end, then retry. ... Adding credit lifts this. Only the account's owner adds credit, at https://withruntime.com/account/billing#add-credit, so tell them what was refused; an agent never adds or spends it on its own. Credit added within {{welcome-days}} days of signing up is matched, up to {{welcome-max}} in total. ...",
    "details": {
      "running": ["..."],
      "addCredit": {
        "url": "https://withruntime.com/account/billing#add-credit",
        "by": "owner",
        "givenCreditCounts": true,
        "welcomeMatch": { "withinDays": {{welcome-days}}, "upToUsd": {{welcome-max-usd}} }
      }
    },
    "requestId": "req_0mud1dtgjogtn2z8t6y",
    "retryable": true
  }
}
```

Follow the `hint`. Quote the `requestId` when you report a problem. A 5xx never
carries internal detail, only a fixed message and the request id.

**`retryable` says whether to send it again.** Every error has it. `true`
means the same request, sent again unchanged, may succeed: the answer then
always carries a `Retry-After` header, the seconds to wait first (and
`retryAfterMs` in the body when the wait is exact). `false` means something
must change first, and the same request gets the same answer; such an answer
never carries `Retry-After`. Each code has one status and one `retryable`,
listed below and in the OpenAPI document's `x-error-codes`; a code is never
renamed, so code that reads `code` keeps working.

**A refusal that adding credit lifts has one shape**, whatever the product, so
an agent can tell its person plainly what to do. It answers with one of
`no_credit_size_limit`, `no_credit_running_limit`, `no_credit_total_limit`,
`no_credit_kept_limit`, `no_credit_daily_limit`, `no_credit_key_limit`, `no_credit_domain_limit`, `no_credit_capacity_full`, `no_credit_build_limit`,
`included_usage_used_up`, `included_usage_unavailable`, `insufficient_funds`,
`payment_required`, `public_preview_not_allowed` or `connect_not_allowed`:

- `message`: what was refused, and the limit.
- `hint`: what you can do now without credit, then the one way past it: the
  account's owner adds credit at
  [Usage & billing](https://withruntime.com/account/billing#add-credit).
  Credit you add within {{welcome-days}} days of signing up is matched, up to {{welcome-max}} in total
  ([welcome match](./pricing#welcome-match)).
- `details.addCredit`: the same, for code. `givenCreditCounts` is `false` where
  only credit paid for lifts the refusal (public previews, ports beyond 80 and
  443, custom domains, public TCP ports and private networks); `welcomeMatch`
  holds the match's days and dollars.

An agent never adds or spends credit on its own: it tells the owner which
limit it met. The one exception is an account the agent opened itself with a
wallet, that no person pays for ([pay with stablecoins](./pricing)): there the
`hint` says to add credit yourself, with `npx withruntime billing topup <usd>`
or `POST /v1/billing/topups` and the account's own key, and
`details.addCredit` is `{"by": "agent", "command": ..., "api": ...,
"givenCreditCounts": ...}` with no `url`. `GET /v1/limits` says which kind of
account a key is on (`credit.addedBy`).

Such an account's claim code is its way back if its key is lost:
`npx withruntime billing claim <code> --new-key`, or
`POST https://withruntime.com/api/wallet/rekey` with `{"claimCode": "..."}`,
answers a new key, shown once, and every other key of the account stops working at once.
A claim code replaces its key at most three times in 24 hours, each time in
the account's audit log (`wallet.key_replaced`), and only until a person takes
the account over; after that, its people make keys on the website. Keep the
claim code as secret as the key. `connect_not_allowed` for an organization whose port access
Runtime turned off has no `addCredit`, since credit does not change it.

**A 5xx says whose fault it is.** A message that says the fault is ours, not
your request's, was reported to us automatically, with its `requestId`. A 500
is a fault a retry does not fix; a 502, 503 or 504 passes, so retry it with
the same key; write to us only if it keeps failing. A 501 is a product switched
off on this deployment.

The status follows HTTP's meaning, so a client or a retry library that reads
only the status does the right thing: 409 is only a state you change first (a
sandbox to wake, a name already held) or one that clears by itself; 429 is
your own limit (a rate, what runs at once, a quota, a daily cap); 503 is the
service briefly away or out of room.

<!-- error-codes:start (bun packages/cloud/src/api/error-codes-write.ts) -->

| Status | Retryable | Codes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Safe next step                                                                                                                                                                                                                                                                                                                                                  |
| ------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | no        | `confirmation_required`, `copies_invalid`, `cursor_ahead`, `disk_shrink`, `env_invalid`, `env_name_reserved`, `env_too_large`, `image_no_command`, `invalid_alert`, `invalid_archive`, `invalid_authority`, `invalid_backup_night`, `invalid_drill`, `invalid_env`, `invalid_host`, `invalid_journal`, `invalid_lease`, `invalid_packages`, `invalid_path`, `invalid_region`, `invalid_request`, `invalid_service`, `port_ambiguous`, `resize_needs_restart`, `scale_invalid`, `size_exceeded`, `switch_keeps_workspace_only`, `terms_required`, `volume_invalid`, `working_dir_invalid`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Fix the request as the message and `details` say                                                                                                                                                                                                                                                                                                                |
| 401    | no        | `invalid_identity`, `unauthorized`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Check the key                                                                                                                                                                                                                                                                                                                                                   |
| 402    | no        | `account_blocked`, `budget_exceeded`, `budget_reached`, `included_usage_unavailable`, `included_usage_used_up`, `insufficient_credit`, `insufficient_funds`, `payment_failed`, `payment_required`, `pilot_ended`, `pilot_hours_used`, `retention_unavailable`, `spending_limit_reached`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | It needs credit or money; the message says which, and `details.addCredit` how                                                                                                                                                                                                                                                                                   |
| 403    | no        | `agent_key_required`, `connect_not_allowed`, `forbidden`, `mode_not_applied`, `network_not_allowed`, `no_person`, `outside_compartment`, `permission_denied`, `plan_required`, `product_in_beta`, `public_preview_not_allowed`, `sandbox_halted`, `secret_not_shared`, `sign_in_unfinished`, `signed_requests_off`, `sso_refused`, `sso_required`, `wrong_source`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | This key or account may not; do not work around it                                                                                                                                                                                                                                                                                                              |
| 404    | no        | `file_not_found`, `image_not_found`, `not_available`, `not_found`, `path_not_found`, `process_not_found`, `route_not_found`, `sandbox_gone`, `snapshot_not_found`, `target_not_found`, `transfer_not_found`, `volume_not_found`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Check the id, name or path                                                                                                                                                                                                                                                                                                                                      |
| 405    | no        | `method_not_allowed`, `wrong_method`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Use a method the path accepts                                                                                                                                                                                                                                                                                                                                   |
| 408    | no        | `download_idle`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Send the request again, faster                                                                                                                                                                                                                                                                                                                                  |
| 408    | yes       | `request_timeout`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Send it again after `Retry-After`, with the same key                                                                                                                                                                                                                                                                                                            |
| 409    | no        | `already_exists`, `already_switched`, `already_topped_up`, `archive_unavailable`, `auto_wake_off`, `blobs_missing`, `browser_failed`, `checksum_mismatch`, `chunk_conflict`, `compartment_not_empty`, `conflict`, `desktop_not_running`, `directory_not_empty`, `file_trace_not_requested`, `file_trace_unavailable`, `fork_failed`, `guest_upgrade_required`, `image_in_use`, `image_unchanged`, `image_unnamed`, `insufficient_storage`, `invalid_state`, `is_a_directory`, `journal_full`, `legacy_email_requires_reconciliation`, `limit_reached`, `memory_full`, `name_conflict`, `name_taken`, `no_credit_kept_limit`, `no_credit_key_limit`, `no_memory_scope`, `no_space`, `not_a_directory`, `not_a_regular_file`, `not_a_terminal`, `not_installed`, `not_pausable`, `not_paused`, `not_resumable`, `not_running`, `offset_mismatch`, `operation_conflict`, `operation_outcome_unknown`, `payment_used`, `process_running`, `rebase_copy_failed`, `rebase_copy_timeout`, `repository_disconnected`, `repository_taken`, `resize_disk_cold`, `resize_needs_disk`, `resource_stopped`, `restart_unavailable`, `rollback_unavailable`, `root_unavailable`, `sandbox_in_use`, `sandbox_not_paused`, `sandbox_not_running`, `sandbox_paused`, `sandbox_stopped`, `second_step_already_on`, `second_step_not_started`, `second_step_off`, `second_step_required_by_account`, `secrets_mismatch`, `service_conflict`, `service_resume_unavailable`, `session_ended`, `session_open`, `session_stopping`, `size_unchanged`, `snapshot_metadata_changed`, `snapshot_unsupported`, `stdin_closed`, `switch_needs_disk`, `tailscale_joined`, `time_limit_too_short`, `trigger_paused`, `unmount_failed`, `unsupported_operation`, `upload_incomplete`, `version_conflict`, `volume_attached`, `volume_change_refused`, `webhook_disabled` | Change the state the message names (wake, stop, detach, rename), then send it again. A count you hold at its limit (`no_credit_kept_limit`, `no_credit_key_limit`, `limit_reached`, and `quota_exceeded` on what is kept: volumes, images, snapshots, secrets, kept sandboxes) is one too: delete one, or raise the limit; sending it again alone does not help |
| 409    | yes       | `backup_not_ready`, `browser_installing`, `desktop_installing`, `file_changed`, `image_building`, `image_not_ready`, `operation_pending`, `resize_during_snapshot`, `resize_not_halted`, `run_in_progress`, `sandbox_not_ready`, `snapshot_capturing`, `snapshot_in_progress`, `snapshot_not_ready`, `switch_not_paused`, `volume_not_ready`, `volume_releasing`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Clears by itself: send it again after `Retry-After`, with the same key                                                                                                                                                                                                                                                                                          |
| 410    | no        | `deleted`, `host_lost`, `link_expired`, `link_revoked`, `name_retired`, `secret_revoked`, `snapshot_expired`, `snapshot_lost`, `upgrade_required`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Gone for good: make a new one, or use the name the hint gives                                                                                                                                                                                                                                                                                                   |
| 413    | no        | `body_too_large`, `file_too_large`, `too_large`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Send less, or use the chunked upload                                                                                                                                                                                                                                                                                                                            |
| 415    | no        | `unsupported_media_type`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Send `Content-Type: application/json`                                                                                                                                                                                                                                                                                                                           |
| 416    | no        | `range_not_satisfiable`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Ask for a range inside the file; the message says its length                                                                                                                                                                                                                                                                                                    |
| 422    | no        | `archive_failed`, `cwd_not_found`, `disk_too_small`, `idempotency_conflict`, `idempotency_key_reused`, `image_build_failed`, `image_config_invalid`, `image_limit_too_small`, `image_on_another_host`, `image_platform_unsupported`, `image_port_invalid`, `image_registry_unsupported`, `interpreter_failed`, `invalid_volume_attachment`, `keep_env_refused`, `mcp_cleanup_failed`, `mcp_failed`, `no_credit_size_limit`, `passkey_limit`, `passkey_refused`, `recording_failed`, `ref_not_found`, `retention_too_long`, `scale_over_limit`, `second_step_wrong_code`, `subagent_depth`, `tailscale_failed`, `tunnel_overrun`, `tunnel_unavailable`, `unprocessable`, `upload_failed`, `volumes_apart`, `volumes_on_different_hosts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Well formed, but not possible as asked: change what the message names; a program in your sandbox that failed is named in `details`                                                                                                                                                                                                                              |
| 429    | yes       | `blob_store_full`, `blob_upload_limit`, `build_in_progress`, `context_limit`, `daily_limit`, `guest_busy`, `no_credit_build_limit`, `no_credit_daily_limit`, `no_credit_domain_limit`, `no_credit_running_limit`, `no_credit_total_limit`, `process_limit`, `quota_exceeded`, `rate_limited`, `resource_limit`, `sandbox_busy`, `second_step_locked`, `startup_application_limit`, `startup_cool_down`, `subagent_quota`, `transfer_limit`, `trial_signup_rate`, `watch_limit`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `quota_exceeded` for a limit on what runs at once (`details.limit` `sandbox.count`, `sandbox.vcpu`, `sandbox.memory_mib`, `sandbox.disk_mib`, `tunnel.count` or `instance.count`); on what is kept it is a 409. Your own limit: its rate, what runs at once, a quota or a daily cap. Retry after `Retry-After` with the same key, or end something it counts    |
| 451    | no        | `taken_down`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Taken down after a report; write to support if it was a mistake                                                                                                                                                                                                                                                                                                 |
| 499    | no        | `cancelled`, `client_closed`, `request_cancelled`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | You closed the connection first; nobody read this                                                                                                                                                                                                                                                                                                               |
| 500    | no        | `env_unreadable`, `guest_quarantined`, `internal_error`, `job_failed`, `operation_failed`, `price_unavailable`, `secrets_unconfirmed`, `snapshot_busy`, `snapshot_unusable`, `watch_failed`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Our fault, reported to us. Safe to send again with the same key, but it may fail the same way until we fix it                                                                                                                                                                                                                                                   |
| 501    | no        | `delete_unavailable`, `env_unavailable`, `feature_unavailable`, `file_links_unavailable`, `fork_unavailable`, `identity_unavailable`, `network_rules_unavailable`, `network_unavailable`, `previews_unavailable`, `resize_unavailable`, `schema_migration_required`, `secrets_unavailable`, `storage_unavailable`, `switch_image_unavailable`, `switching_paused`, `unavailable`, `unsupported`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Switched off on this deployment; sending it again does not help                                                                                                                                                                                                                                                                                                 |
| 502    | yes       | `billing_unavailable`, `download_incomplete`, `github_unavailable`, `guest_failed`, `image_unavailable`, `keys_unavailable`, `support_unavailable`, `upstream_failed`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | A service behind the API answered badly: retry after `Retry-After` with the same key                                                                                                                                                                                                                                                                            |
| 503    | yes       | `alert_in_flight`, `alert_unavailable`, `api_unavailable`, `base_image_unverified`, `body_stalled`, `builder_outdated`, `busy`, `capacity_unavailable`, `copies_unread`, `desktop_connection_unavailable`, `drill_unalerted`, `drill_unrecorded`, `email_unavailable`, `guest_not_ready`, `heartbeats_unreadable`, `host_busy`, `host_capacity`, `host_memory_pressure`, `host_not_ready`, `host_start_failed`, `host_unavailable`, `host_unknown`, `monitor_unavailable`, `no_capacity`, `no_credit_capacity_full`, `planned_release`, `resize_not_started`, `signing_unavailable`, `snapshot_restoring`, `switch_undone`, `wake_refused`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Briefly away or out of room: retry after `Retry-After` with the same key (the SDKs do)                                                                                                                                                                                                                                                                          |
| 504    | yes       | `host_timeout`, `upstream_timeout`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | A service behind the API did not answer in time: retry after `Retry-After` with the same key                                                                                                                                                                                                                                                                    |

<!-- error-codes:end -->

**Retryable answers are safe to send again.** `no_capacity`, `busy`,
`host_unavailable`, `rate_limited`, `no_credit_running_limit` and every other
code marked retryable above clear on their own: retry with the same key after
`Retry-After`, a growing delay and a bounded deadline.

- The SDKs retry every answer that says `retryable: true` themselves, after
  its `Retry-After`, up to `maxRetries`, but for `no_capacity`,
  `quota_exceeded` and `no_credit_running_limit`, which they wait out only
  where they wait for room (below) and otherwise return at once. A wait over
  a minute (a daily cap) is not slept on: the error is returned at once, with
  `retryAfterMs`, for you to schedule.
- `guest_busy`, `busy` and `rate_limited` mean nothing ran. The SDKs send such
  a call again, with the same key and a delay that grows from `Retry-After`
  to eight times it, until the call's own deadline, or for
  five minutes when it has none, however many retries `maxRetries` allows.
  Then the refusal itself is returned. A sandbox under heavy load can answer
  `guest_busy` for tens of seconds; the call is then slow, not failed.
- A `quota_exceeded` names the limit in its message and in `details`:
  `limit` (such as `volume.count`), `max` and how to `raise` it. Every limit
  is listed in [limits](./limits).
- A create or wake refused `no_capacity` holds a place in its region's line
  while it is sent again with the same `Idempotency-Key` (the SDKs do), and
  its message says the place, how many wait ahead and the account's lane: "in
  line at place 2: the region's room goes to higher lanes first: 1 waiting
  ahead (pro 1); this account's lane is free", and its `details.line` holds
  the same as `lane`, `place`, `ahead` (by lane) and `words`. Room that frees
  goes to the highest lane waiting first; see
  [waiting in line for room](./limits#waiting-in-line-for-room).
- An SDK create also waits out `no_credit_running_limit`, `quota_exceeded` and
  `no_capacity`, for up to two minutes by default, then returns the refusal.
  The error's `retryable` is `true` for `no_credit_running_limit`, `no_capacity`
  and a `quota_exceeded` on what runs at once (`sandbox.count`, `sandbox.vcpu`,
  `sandbox.memory_mib`, `sandbox.disk_mib`, `tunnel.count`, `instance.count`),
  for a loop of your own. A `quota_exceeded` on what you keep (volumes, images,
  snapshots, secrets, kept sandboxes) is a 409 that says `retryable: false`
  and has no `Retry-After`: it clears only when you delete something or raise
  the limit, and no SDK waits for it.
- `no_capacity` is a 503 with `Retry-After: 1`, and `no_credit_running_limit`
  and a retryable `quota_exceeded` are 429s with `Retry-After: 5`: the wait
  before a first retry, for a client that reads only HTTP. The SDKs keep their
  own growing delay. Until 17 October 2026 all three were 409s, with the same
  body.
- `no_credit_running_limit` clears when one of the {{trial-sandboxes}} running sandboxes without credit stops or pauses. A fork asking for more copies than that never fits.

## Retries and idempotency

Send `Idempotency-Key: <any unique string>` on a change. The server remembers the
key for 24 hours:

- The same key with the same body answers the first result again, marked
  `"replayed": true` and with the header `Idempotency-Replayed: true`. Nothing
  happens twice.
- A secret or token shown once (a rotated webhook secret, a preview or MCP
  token, a WireGuard key Runtime made) is left out of the replay; read the
  resource for a fresh token. A first answer over 32 KiB is not kept: its
  replay answers 409 `operation_conflict`, and nothing runs again.
- The same key with a different body is refused with 422 `idempotency_key_reused`.
- A refusal is not kept. A request refused before anything ran (`no_capacity`,
  `busy`, a limit) leaves its key unused, so the same key sent again runs the
  request afresh, and only an answer that did the work is replayed. A create
  refused `no_capacity` and retried with its key once there is room starts the
  sandbox; the next retry with that key replays it.
- `no_capacity` is 503 with `Retry-After` wherever it is answered (a create,
  a fork, a restart, a wake, a public port or a dedicated address), so a
  client that retries 5xx retries it, with the same key.
- A waited pause (`POST /v1/sandboxes/{id}:pause` with `Prefer: wait`)
  succeeds when its server's snapshot space is full: the server holds the
  sandbox's memory and saves it once there is room. Only a sandbox too near
  the end of its time to save it later answers `no_capacity` (503,
  `Retry-After: 60`): the pause was not taken, and the sandbox is still
  running with its memory and files. Unlike a create, that request did run,
  so pause again with a new `Idempotency-Key`; the same key only answers the
  sandbox as it is now.
- A new key is new work.

The SDKs send a key on every change and retry transport failures and every
answer marked `retryable: true` with it. A connection refused before the request left is sent again at
once; anything that may have reached a server waits first. Changing the body
while reusing a key is not a retry.

## Limits

These limits are protection, not quotas, and a refusal costs nothing.

- **Per key:** about 50 requests a second, in bursts of up to 200, with 128
  served at once. Past that, a request waits its turn for up to five seconds
  before it is refused. A key may have as many served at once as its
  organization (below) when that is more, and its rate and burst grow by
  the same share: an organization holding 40 sandboxes has 432 in flight,
  so each of its keys may send about 170 a second in bursts of 675, and at
  most 400 a second in bursts of 1,600.
- **Per address, for keys not yet seen to work:** until a request on a key
  has been accepted once, requests on it, and on wrong or missing keys, also
  count against the address they come from: about 50 a second in bursts of
  200 (`address_rate`). A key that has worked is never refused because of
  someone else's wrong keys.
- **Per organization:** 192 requests in flight across all its keys, and six
  more for each sandbox it holds that is not stopped, up to 1,024; when
  support has raised its sandbox quota past 138, six more for each running
  sandbox up to that quota (2,592 for 400 running), so every sandbox can
  stream four commands and
  two watches at once; a new sandbox's six come within half a minute. Also
  16 watch streams, 16 SSH logins and port forwards and 64 terminals open,
  each with two more for each such sandbox, up to 292 watch streams, 292
  logins and forwards and 340 terminals, or more as the quota allows (a
  pilot's agreed count sets more too), and at most 12 terminals in
  one sandbox. When the service as a whole holds as many as it can, a new one
  is refused for a moment with a retry delay. Requests beyond what an
  organization's sandboxes bring share one room: while it is
  three-quarters taken, an organization holding its fair share of it waits
  for its own requests to finish (`organization_fair_share`), so a busy
  account never crowds out the rest.
- **Per sandbox:** up to 1,024 commands and background processes running at
  once; the sandbox's memory is usually the closer limit. Past that, a new one
  is refused with `process_limit` (429), which names the number. A command's
  output stays readable by its own stream however many others end meanwhile.
  Processes and threads together: up to 16,384 in a sandbox, and up to 15,360
  for one command and all it starts, so a fork bomb in one leaves room for the
  command that ends it. Past that, Linux refuses a new one (`fork` or
  `pthread_create` fails with `EAGAIN`).
  A custom image keeps the limits of the day it was built: one built while the
  command limit was 16 keeps 16 until it is built again.
- **Per address:** 64 connections open to the API at once, and 50 new ones a
  second in bursts of 100. Once a request from the address carries a valid
  key, it may hold its organization's room instead for the next 10 minutes,
  renewed by each such request: 256 connections and 200 new ones a second, and
  more for an organization with more requests in flight. Past a limit a new
  connection is not answered, so the client's own retry brings it in a second
  or so later, once a connection closes or the address has its room. A streaming
  answer (a command's output, a download, a watch) holds its connection until
  it ends. The SDKs hold each client to 48 connections, calls and streams
  together, keep 8 of them for calls, and queue the rest, so a client waits
  for a connection rather than fail: a thousand streamed commands at once
  from one client are read 40 at a time.

Over a limit you get 429 with `Retry-After`.
Streaming responses count as requests in flight until their bodies finish or
you cancel them. Receiving the headers does not release a request slot. A
request you abandon, or one answered 503 because it ran past its deadline
(110 seconds from the end of its request body),
is stopped and counts against its key and organization until its work has
stopped: a read at once, a change once it is recorded, at most about four
minutes more. A command it started keeps running in the sandbox.

## Sandboxes

| Method and path                        | What it does                                                                                                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/sandboxes`                   | Create. Every field optional.                                                                                                                                  |
| `GET /v1/sandboxes`                    | List: `state`, `name`, `label=key:value` (repeat), `includeStopped`, `limit`, `cursor`                                                                         |
| `GET /v1/sandboxes/{id}`               | Read; `waitFor` and `timeoutSeconds` wait for a state                                                                                                          |
| `POST /v1/sandboxes/{id}:stop`         | Stop. Answers at once, where compute billing ends; a kept disk is written out after                                                                            |
| `DELETE /v1/sandboxes/{id}`            | Delete for good, in any state (see "Deleting a sandbox" below)                                                                                                 |
| `POST /v1/sandboxes/{id}:pause`        | Answers once the processors stop, where compute billing ends; memory and files are then saved                                                                  |
| `POST /v1/sandboxes/{id}:wake`         | Restore a paused sandbox; for one with a time limit, `timeoutSeconds` sets the new one                                                                         |
| `POST /v1/sandboxes/{id}:extend`       | `{"seconds": 600}` more before its time limit; a sandbox with none answers at once, unchanged                                                                  |
| `POST /v1/sandboxes/{id}:retention`    | `{"days": 30}` keeps a paused or stopped sandbox 1 to 365 days; `null`, the default, while you have credit                                                     |
| `POST /v1/sandboxes/{id}:restart`      | Start a stopped sandbox again from its kept disk                                                                                                               |
| `POST /v1/sandboxes/{id}:update`       | Change `name`, `labels`, `env`, `autoWake`, `idlePauseSeconds`, `persistent`, `maxTotalCostMicros`, `tailscale` (`null` leaves), `timeoutSeconds`, `onTimeout` |
| `POST /v1/sandboxes/{id}:switch-image` | Move it to another image, keeping `/workspace` (see "Switching its image" below)                                                                               |

The create body:

| Field                     | Default                                               | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`, `labels`          | none                                                  | Your own handle and up to 32 `key: value` tags                                                                                                                                                                                                                                                                                                                                                                                                              |
| `env`                     | none                                                  | Environment variables for every command, process, terminal, SSH session and image start command in it (see "Its environment" below)                                                                                                                                                                                                                                                                                                                         |
| `funding`                 | ignored                                               | Accepted and ignored: the free usage is spent first, then prepaid credit, and an account that holds credit gets paid limits                                                                                                                                                                                                                                                                                                                                 |
| `region`                  | the default region                                    | Use a region listed for your account                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `vcpu`                    | 2                                                     | At most 16 on a paid sandbox, 2 without credit                                                                                                                                                                                                                                                                                                                                                                                                              |
| `memoryMiB`               | 4096                                                  | At least 128; at most 65,536 (64 GiB) on a paid sandbox, 4,096 without credit; a size outside that is refused with `invalid_request` naming the field. An odd size is rounded up to the next even number (4095 becomes 4096), which is the size it gets, is billed at and is returned; resize rounds the same way                                                                                                                                           |
| `diskMiB`                 | 4096                                                  | At least 3,072; at most 409,600 ({{max-disk}}), and 10,240 without credit. A larger disk is refused with `invalid_request`, naming the maximum. A sandbox is placed only on a server with that much free disk                                                                                                                                                                                                                                               |
| `cpu`                     | `"shared"`                                            | `"reserved"` guarantees every vCPU: the same as `cpuFloorMillis` at `vcpu` x 1000, which it sets, ignoring any other `cpuFloorMillis`; not without credit                                                                                                                                                                                                                                                                                                   |
| `cpuFloorMillis`          | 50                                                    | Guaranteed CPU, in thousandths of a vCPU: at most `vcpu` x 1000 (16,000 at 16 vCPU), and 250 without credit. The highest, `vcpu` x 1000, is what `cpu: "reserved"` sets                                                                                                                                                                                                                                                                                     |
| `timeoutSeconds`          | 0, none                                               | A time limit you choose, 60 to 86,400 seconds (24 hours): it pauses or stops when that runs out, busy or not. Left out (or 0), it has none: it runs while it works and pauses when idle, until you stop it or credit or free usage runs out. A large sandbox needs time to wake its memory: 190 s for 65,536 MiB; shorter is refused, naming the least                                                                                                      |
| `onTimeout`, `onLeaseEnd` | `"pause"`                                             | `"pause"` keeps memory and files when its time limit, credit or free usage runs out; wake it later. `"stop"` stops it and keeps its disk for `:restart`; `"delete"` stops it and deletes its disk. `onLeaseEnd` is its older name                                                                                                                                                                                                                           |
| `idlePauseSeconds`        | {{idle-pause-seconds}}                                | Pause after this many seconds with nothing happening: no request, no command or terminal running, no open connection, no traffic and no CPU use. 0 is never, otherwise {{idle-pause-min}} to {{idle-pause-max}}. Not set on a `persistent` sandbox                                                                                                                                                                                                          |
| `autoWake`                | true                                                  | A request to a paused sandbox wakes it (see below)                                                                                                                                                                                                                                                                                                                                                                                                          |
| `persistent`              | false                                                 | Paid only: it runs until you stop it, while credit lasts, with no idle pause unless you set one. Its disk is billed as any sandbox's                                                                                                                                                                                                                                                                                                                        |
| `maxTotalCostMicros`      | none                                                  | The most the sandbox may cost over its whole life                                                                                                                                                                                                                                                                                                                                                                                                           |
| `maxCostMicros`           | none                                                  | Deprecated, still accepted from older clients: use `maxTotalCostMicros`                                                                                                                                                                                                                                                                                                                                                                                     |
| `pausable`                | ignored                                               | Deprecated, still accepted from older clients and ignored: every sandbox can pause, fork and be snapshotted. One created with `pausable: false` before 5 October 2026 can only be stopped; a pause, fork or snapshot of it answers `not_pausable`                                                                                                                                                                                                           |
| `getOrCreate`             | false                                                 | With `name`: answer the sandbox that holds the name (see below)                                                                                                                                                                                                                                                                                                                                                                                             |
| `network`                 | every public port (paid), 80 and 443 (without credit) | Same shape as `PUT /v1/sandboxes/{id}/network`                                                                                                                                                                                                                                                                                                                                                                                                              |
| `image`, `volumes`        | none                                                  | A ready image (its id, `name`, `name:tag` or `name@version`) and up to four `{volumeId, path, mode}`: `mode` `"rw"` (default) or `"snapshot"`, a read-only copy of the volume for any number of sandboxes, unrelated to sandbox snapshots ([storage](./storage#attaching-a-volume)). An image with a start command answers once its ready check passes, in `start`                                                                                          |
| `snapshot`                | none                                                  | A ready snapshot id: start as a copy of it. Not with `image`                                                                                                                                                                                                                                                                                                                                                                                                |
| `spreadFrom`              | none                                                  | One to 16 ids of your own sandboxes or snapshots: it starts on a server none of them is on (see "Keeping copies on several servers" below). Not with an id this key may not read: that is `400 invalid_request`                                                                                                                                                                                                                                             |
| `secrets`                 | every one that reaches it                             | The egress secrets it may use, by name, at most 64: only those of your secrets that would otherwise reach it, never one a secret's `only` keeps from it. `[]` is none; a name not stored yet takes effect once stored. Fixed for its life; a fork or a copy of a snapshot keeps its source's list and may only narrow it. A read answers it as `secrets` (`null` for none named). See [secrets sandboxes never see](./security#secrets-sandboxes-never-see) |
| `tailscale`               | none                                                  | Paid only: `{authKeySecret, hostname?, tags?}` joins your Tailscale network once it runs (see "On your tailnet" below)                                                                                                                                                                                                                                                                                                                                      |

Sizes are limits you ask for. The server checks their combinations against
account limits and the host's measured capacity.

**Placement.** Every sandbox and every snapshot answer has `placement`: an
opaque tag such as `pl_3f9a0c1b2d4e5f60`, or `null` before it is placed. Your
sandboxes and snapshots with the same tag are on the same server. It is never
the server's name, and another account's tags are unrelated to yours.

**Wake on request.** A paused sandbox with `autoWake` wakes by itself when a
command, file, process, terminal, desktop or interpreter call reaches it, and
the call runs once it is running, usually within a second. A visit
to one of its shared ports wakes it too: an API client's request waits up to
30 seconds, and a browser is shown a page that reloads itself. The wake is an
ordinary wake: it runs while it works again, or for a sandbox with a time limit
gets a fresh one of its own `timeoutSeconds`, or keeps the one it paused with when that ends later, billed from the moment it runs. With `autoWake: false` the call fails with `sandbox_paused`
until `:wake`. A wake that cannot be paid for fails with the refusal, such as
`insufficient_funds`, and leaves the sandbox paused.

**Names.** A name is unique in the account while its sandbox can still run:
starting, running, paused, or stopped and persistent. A
[compartment](./security#compartments) is its own namespace: its keys' names
are unique among its own sandboxes, so two compartments, and the account's
other keys, can each have a `main`. A create that names a
held name fails with `name_taken` (409); `details.sandboxId` names the holder
when your key can reach it. With `getOrCreate: true` the create answers the
holder instead, woken if paused and restarted if stopped and persistent, with
`reused: true`; the other fields apply only when it creates one. A sandbox that
is deleted, or stops without keeping its disk, gives its name up and keeps it
in its own record.

**How long it runs.** A sandbox runs while it works and pauses itself when idle;
there is no time limit unless you set one. Nothing needs extending: it runs on
credit, or, without credit, on the free usage. It pauses (or stops, with `onTimeout: "stop"`) when it is
idle for `idlePauseSeconds`, when you stop it, or when credit, free usage, a spending limit or `maxTotalCostMicros` run out. `endsAt` says when it will stop
or pause by itself, and is `null` when it never will: it has no time limit and
its funding goes on. It names a time when the sandbox has a time limit, or once
credit or a limit stops its funding.

**A time limit.** `timeoutSeconds` from 60 to 86,400 (24 hours) at create sets
one: the sandbox pauses or stops then, as `onTimeout` says, busy or not.
`:extend` moves it later, up to 24 hours ahead of now (the SDKs' `keepAlive`
does it for you), and `endsAt` answers the new end. `:update` with
`timeoutSeconds` sets a new limit counted from now, sooner or later than the
old one, or gives one to a sandbox made without; `0` takes the limit away, and
`onTimeout` changes what its end does. A paused sandbox counts the new limit
from its next wake. A change of `onTimeout` that falls in the last stretch the
sandbox has already paid for can end it up to about two minutes after the end
asked, never before. A wake starts the limit
again from the wake: the sandbox's own length, or the `timeoutSeconds` the wake
names. An extend of a sandbox with no time limit answers at once and changes
nothing, so older code that extends keeps working. A persistent sandbox has no
time limit, whatever `timeoutSeconds` says. Without credit, a limit longer than the free usage left is cut to it, and the answer's `timeoutSeconds` says so: the sandbox pauses when it ends either way.

**Keep it running until you stop it.** `persistent: true`, at create or with
`:update`, keeps it running with no idle pause (unless `idlePauseSeconds` sets
one) while the account has credit, up to `maxTotalCostMicros`. Its disk is
billed as any sandbox's, and a stop keeps it as any stop does. `:update` with
`{"persistent": false}` makes it an ordinary sandbox again.

**A stop keeps the disk; only a delete removes it.** A stopped sandbox reads
`diskKept: true`, is listed with the live ones, and is billed for its disk as
[paused storage](./pricing#paused-storage) until you delete it. `:restart`
starts it again from that disk, its memory gone, and runs its image's start
command again, reported in `start` as at create. A read-write volume stays
attached to it until it is deleted, so delete it before attaching the volume
elsewhere. One created with `onTimeout: "delete"` has its disk deleted when
its time limit ends. One stopped before it ever started has no disk to keep:
it reads `diskKept: false`, and a restart is refused, so create a new one.
A raw HTTP client
says it knows this with `x-runtime-client: http/2026-10-04`; a stop from a
client that names an older version, or none, keeps the disk as any stop does
in an account with credit, a card saved or a past purchase (at least 30 days
from the stop, even if its credit runs out), and in one with none of these
keeps it free for three days and then deletes it. To end a sandbox for good in any
state, delete it.

**Its environment.** `env` at create sets variables that every command,
background process, terminal, SSH session and the image's start command in the
sandbox is started with, for its whole life: through pauses, wakes and
restarts. A command's own `env` is put over them. `:update` with `env` changes
them: a value sets a variable, `null` removes it, and the rest stay; commands
started after the change get it, and running ones keep what they started with.
At most {{sandbox-env-vars}} variables and {{sandbox-env-size}} of names and values; past that the answer is
`env_too_large` (400), and a name that is not a letter or underscore followed by
letters, digits and underscores is `invalid_env` (400). A command whose own `env`
and the sandbox's together pass what one command can carry is refused with
`env_too_large` (400) before it runs. Values are write-only: answers carry only `envNames`, and no
list, log or audit entry holds a value. They are stored encrypted, and the
request fingerprint an `Idempotency-Key` is checked against holds a keyed hash
of them, never the values. Copies made by `:fork` keep them, because they are
the same machine and its processes already hold them; a sandbox created from a
snapshot takes only its own `env`. An SSH session gets every variable whose
value has no double quote, backslash or line break. A deployment that cannot
store them answers `env_unavailable` (501) and creates nothing.

**Deleting a sandbox.** `DELETE /v1/sandboxes/{id}` works in any state. It
stops the sandbox if it runs or is paused, deletes its disk and its paused
memory, revokes its previews and TCP ports, drops its environment, gives up its
name at once, and removes it from every list. Compute billing ends as a stop's
does; a disk kept for `:restart` is billed until its host confirms the
deletion, usually seconds. Its snapshots are separate and stay until you delete
them, and its usage, charges and audit entries stay. A custom domain pointed at
it stays yours: point it at another sandbox or remove it. The answer is
`{id, status: "deleted", state, deletedAt}`; afterwards the sandbox reads
nowhere, and `GET` answers `not_found`. Deleting it again answers the same, with
or without the same key. A read-only key cannot delete. A sandbox a job or a
managed service runs in is ended by that job or service instead.

**Switching its image.** `POST /v1/sandboxes/{id}:switch-image` with
`{"image": "web:v2"}` moves a sandbox to another image and
keeps its id and name, `/workspace` (its home: dotfiles, `pip install` and
`npm install -g`), volumes, environment, labels, previews and ports. Its
processes restart, and the new image's start command runs as at create.
Everything else on its old disk is lost (`sudo` and apt installs, `/etc`).
`keep: "workspace"`, which older clients send, is accepted and changes nothing;
any other `keep` is refused with `switch_keeps_workspace_only` (400) and
nothing changes. Snapshot it first to keep everything. A running sandbox is paused first; a paused one, or a stopped
persistent one, is switched as it is; a stopped ordinary one kept no disk
(`switch_needs_disk`, 409). It is charged as a wake. The answer comes once the
sandbox runs the new image. If anything fails, the switch is undone and the
answer is `switch_undone` (503): the sandbox is paused or stopped on its old image
with its files and memory as they were. The image must be ready, on the
sandbox's server (`image_on_another_host`, 422), different from the one it runs
(`image_unchanged`, 409) and fit its disk (`disk_too_small`, 422); copying
`/workspace` may take up to {{switch-copy-time}}.

**On your tailnet.** A paid sandbox can join your own Tailscale network.
Store an auth key for jobs (`printf %s "$TS_AUTHKEY" | runtime secrets set TS_AUTHKEY --jobs`),
then `POST /v1/sandboxes/{id}/tailscale` with `{"authKeySecret": "TS_AUTHKEY"}`,
and optionally `hostname` and `tags`, or pass the same object as `tailscale` at
create. The answer gives its tailnet `addresses`, `dnsName` and `mode`; `GET`
reads them again and `DELETE` logs the machine out. The key is never answered,
logged or written to the sandbox's disk. [Networking](./networking#your-tailscale-network) has the rest.

## Commands and processes

| Method and path                                        | What it does                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `POST /v1/sandboxes/{id}:exec`                         | Run and answer `{exitCode, stdout, stderr, timedOut}`                          |
| `POST /v1/sandboxes/{id}/processes`                    | Start in the background; add `"pty": {"cols", "rows"}` for a terminal          |
| `GET /v1/sandboxes/{id}/processes`                     | Running and recent processes                                                   |
| `GET /v1/sandboxes/{id}/processes/{processId}`         | One process                                                                    |
| `GET /v1/sandboxes/{id}/processes/{processId}/output`  | Output from `cursor`; `waitMs` long-polls; `follow=true` streams               |
| `POST /v1/sandboxes/{id}/processes/{processId}:write`  | `{"data"}` or `{"base64"}`, with `offset` and `eof`; offsets make retries safe |
| `POST /v1/sandboxes/{id}/processes/{processId}:signal` | `{"signal": "SIGTERM"}`                                                        |
| `POST /v1/sandboxes/{id}/processes/{processId}:resize` | `{"cols", "rows"}` for a pty                                                   |
| `GET /v1/sandboxes/{id}/processes/{processId}/files`   | What a process started with `traceFiles` read and wrote, once it has ended     |

The exec body is `command` (run under `bash -c`) or `argv` (no shell). Optional
fields are `cwd`, `env`, `stdin`, `user`, `timeoutMs` (default 60,000, or less when the sandbox's time limit, credit or free usage end sooner; at
most 24 hours),
`stream` and `traceFiles` (below). A timeout is a result with `timedOut: true`, not an error. `env`
is put over the sandbox's own environment; its values are never echoed and are
stored only as hashes. `user` is `"sandbox"` (the default: the user `runtime`,
uid 1000) or `"root"`, which runs the command as root through the sandbox's
passwordless `sudo`, with the same environment, `PATH` and working directory
and `HOME=/root` (unless `env` sets `HOME`), so no command needs a `sudo`
prefix. Starting a process takes `user` too, and every process answers which
it runs as in `user`.

**Files a command read.** With `"traceFiles": true` the answer, or the stream's
`exit` event, adds `files`: `read`, every file and directory the command and
anything it started opened (sorted absolute paths, links resolved, a directory
ending in `/`), `written`, every file it wrote, and `truncated`, which is `true`
when some paths are missing (past about 380 KB of paths). Key a cache by the
contents of `read` and a test reruns only when a file it really read changed. A
background process takes `traceFiles` too and answers its files at `…/files`
once it ends. Only the command's own opens count, never another process's on
the same sandbox. Opens through mounts the command itself makes, and lookups of
files that do not exist, are not seen. Each file costs 5 to 15 microseconds the
first time it is opened, and next to nothing after. A sandbox started before tracing
existed answers `409 unsupported_operation`, and nothing runs; stop and start
it. A sandbox that cannot trace the command answers 409
`file_trace_unavailable`, and nothing runs. Its `…/files` answers 409
`process_running` while the process still runs, and 409
`file_trace_not_requested` for a process started without `traceFiles`.

**Streaming.** With `"stream": true` the answer is NDJSON, one event a line:
`start`, `stdout`, `stderr` and `exit`. When a stream passes the server's time
limit it sends `continue` with a cursor, and `…/output?follow=true&cursor=`
resumes from it. A stream that fails ends with `error`, which carries the
`code` and `status` the answer would have had and the `cursor`; after a 429 or
a 5xx, follow again from that cursor, since the command runs on. The SDKs do,
for up to five minutes of failures in a row. A streamed command has no output
limit.

**Output limits.** The JSON answer holds at most 64 KiB (65,536 bytes) of each
stream for a command with a `timeoutMs` of 60,000 or less, and up to 1 MiB of
each for a longer one. Past that the rest is dropped, and `stdoutTruncated` or
`stderrTruncated` is `true`.

While a stream is being read, its command waits for the reader rather than lose
output, from its first byte. The sandbox keeps the latest 1 MiB of each
process's output; a reader away for more than 10 seconds while more than that
came out gets `{"type":"truncated","droppedBytes","resumeAt"}` before the output
that remains. For large output, stream it, or write it to a file and read
it with `GET …/files/content`.

## Terminals

`GET /v1/sandboxes/{id}/terminal` with `Upgrade: websocket` and the bearer header
opens a terminal: `cols`, `rows`, `command` (default `bash -l`), `cwd`,
`user=root` for a root shell, or
`processId` to attach to a process started with a pty. Binary frames are terminal
bytes both ways. Text frames are JSON: you send `{"type":"resize","cols":120,"rows":40}`;
the server sends `{"type":"ready","processId":...}` and `{"type":"exit","exitCode":...}`.

A browser's WebSocket cannot send an `Authorization` header, so the terminal on
a sandbox's page at withruntime.com offers a ticket instead:
`Sec-WebSocket-Protocol: runtime.terminal.v1, runtime.ticket.<ticket>`. The
server answers with `runtime.terminal.v1`. A ticket is accepted only from a page
on withruntime.com, opens one terminal in one sandbox and lasts 60 seconds; a
refused one answers `unauthorized` (401) or `forbidden` (403) and says why. Your
own code uses the bearer header. See
[the browser terminal](./security#the-browser-terminal).

## Tunnels

This is a connection from your code into one sandbox, not the WireGuard tunnel
that joins your own network to your sandboxes
([domains, TCP ports, addresses and the tunnel](#domains-tcp-ports-addresses-and-the-tunnel)).
`GET /v1/sandboxes/{id}/tunnel` with `Upgrade: websocket` and the bearer header
opens one into the sandbox: TCP connections to any port on its loopback,
and SSH logins, several at once over the one socket. It needs the key's `exec`
permission, like a command. The CLI (`runtime sandboxes ssh`, `runtime sandboxes port-forward`)
and the SDKs (`sbx.tunnel()`, `sbx.forwardPort()`, `forward_port()`) speak it
for you.

Binary frames both ways are one kind byte, a 32-bit big-endian stream number
and a payload. You send `o` to open a stream with `tcp PORT` or `ssh KEYTYPE
BASE64` (an OpenSSH public key), `d` data, `e` end of your input and `c` to
close. The server answers `o` opened, `d` data, `e` end of output, `c` closed
with a reason (`closed` when nothing listens), `l` sshd's error output, and `a`
on stream 0 with a 64-bit count of the data bytes the sandbox has taken. Keep
at most 1 MiB of data sent beyond the last `a`; a client that sends more is
disconnected. Text frames from the server are JSON: `{"type":"ready"}` first,
`{"type":"error","error":{...}}` before it closes on an error.
Empty and control frames also share a bounded pending queue. Flooding that
queue closes the socket even when data bytes remain below the credit limit.

## Files

| Method and path                                                 | What it does                                                                                                                                                                                            |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/sandboxes/{id}/files/content?path=`                    | The file's raw bytes, any size; `x-content-length` gives the length first (and `x-content-sha256` a small file's digest), so check it: a body that ends short failed                                    |
| `PUT /v1/sandboxes/{id}/files/content?path=`                    | Replace the file with the raw request body, up to 1 MiB (larger answers 413: use `/uploads`); makes parents; `mode=755` sets its permissions (644 by default)                                           |
| `GET /v1/sandboxes/{id}/files/list?path=`                       | Entries; `depth`, `glob`, `hidden`, `limit`                                                                                                                                                             |
| `GET /v1/sandboxes/{id}/files/stat?path=`                       | Type, size, mode and times, or `{"exists": false}`                                                                                                                                                      |
| `POST /v1/sandboxes/{id}/files:mkdir`                           | `{"path", "parents"}`                                                                                                                                                                                   |
| `POST /v1/sandboxes/{id}/files:remove`                          | `{"path", "recursive"}`                                                                                                                                                                                 |
| `POST /v1/sandboxes/{id}/files:rename`                          | `{"from", "to", "overwrite"}`                                                                                                                                                                           |
| `POST /v1/sandboxes/{id}/files:chmod`                           | `{"path", "mode": "755"}`                                                                                                                                                                               |
| `POST`, `GET /v1/sandboxes/{id}/files/watches`                  | Watch a directory: `{"path", "recursive", "events", "include", "exclude", "batchMs", "timeoutMs"}`; list the watches                                                                                    |
| `GET /v1/sandboxes/{id}/files/watches/{watchId}/events?cursor=` | Its events after a cursor (`waitMs` up to 8000), or `follow=true` for a stream                                                                                                                          |
| `DELETE /v1/sandboxes/{id}/files/watches/{watchId}`             | Stop a watch                                                                                                                                                                                            |
| `POST /v1/sandboxes/{id}/uploads`                               | Begin a large upload: `{"path", "size", "sha256", "mode"}`; `path` must be under `/workspace` (move it with exec after the commit)                                                                      |
| `PUT /v1/sandboxes/{id}/uploads/{uploadId}?offset=`             | One chunk of raw bytes; chunks may go in parallel                                                                                                                                                       |
| `POST /v1/sandboxes/{id}/uploads/{uploadId}:commit`             | Check the digest and move the file into place atomically                                                                                                                                                |
| `POST /v1/sandboxes/{id}/uploads/{uploadId}:abort`              | Give up                                                                                                                                                                                                 |
| `GET /v1/sandboxes/{id}/files/archive?path=`                    | A folder as tar, streamed; `gzip=true`, `user=sandbox` or `root`, and repeated relative `exclude` paths. A failed folder stream ends as an archive no tar reader accepts                                |
| `PUT /v1/sandboxes/{id}/files/archive?path=`                    | Unpack a tar (gzipped or not) of up to 1 MiB from the raw body into the folder, making it; merges with what is there                                                                                    |
| `POST /v1/sandboxes/{id}/files/archive/uploads`                 | Begin a larger one: `{"path", "gzip", "user"}`; `gzip` and `user` are optional; answers `uploadId`                                                                                                      |
| `PUT …/files/archive/uploads/{uploadId}?offset=`                | The next part, up to 1 MiB, in order; a part sent twice is not written twice                                                                                                                            |
| `POST …/files/archive/uploads/{uploadId}:commit`                | Answers once tar has unpacked it all (`:abort` stops it; what was unpacked stays)                                                                                                                       |
| `POST /v1/sandboxes/{id}/files:link`                            | A link anyone can open with no key: `{"path", "method": "GET" or "PUT", "expiresInSeconds", "filename", "maxBytes", "wake", "archive"}`; answers `{"url", "expiresAt"}` (see [File links](#file-links)) |
| `POST /v1/sandboxes/{id}/files:revoke-links`                    | End every link made for the sandbox so far                                                                                                                                                              |

Paths are absolute. File errors name the path: `file_not_found`,
`is_a_directory`, `not_a_directory`, `permission_denied`.

A watch's events are `create`, `write` (repeated writes folded, with a
`count`), `remove`, `rename` (with `oldPath`) and `chmod`, in batches every
`batchMs` (100 by default). Notices say when events were missed: `overflow`
(more than 5,000 a second, or the kernel's own queue) and `lost` (a reader more
than 1 MiB behind). A stream ends with `continue` and the cursor after 110
seconds, and with `paused` when the sandbox pauses; reading never wakes a
sandbox, and a read after it wakes carries on from the cursor with nothing lost.
At most four watches run in a sandbox, each for `timeoutMs` (one hour by
default, at most a day, or `0` to run until stopped).

A watch started with `"webhook": true` also sends its changes to your
account's webhooks as `sandbox.files.changed` events (see
[webhooks](./observability#webhooks)), so nothing in the sandbox or on your side
has to read it. Runtime reads it without waking the sandbox, at most once every
{{file-hook-window}}, and an account has at most {{file-hook-limit}} such
watches. A sandbox session cannot start one.

A folder moves as one tar archive, packed or unpacked by `tar` inside the
sandbox as the sandbox user by default, so a folder download needs only the
key's `read_file` permission and an upload `write_file`. `user=root` explicitly
uses passwordless `sudo` inside that sandbox, with the same file permissions;
an image without it refuses with `root_unavailable` before sending file bytes.
Downloads accept repeated `exclude` parameters for plain relative paths, not
glob patterns. `..`, empty or absolute paths are refused. A multipart upload
sets `user` when it begins; direct uploads detect gzip from the archive header. The sandbox needs `sh`,
`tar` and `base64` (and `gzip` for a compressed archive), which every image
from Runtime's base has. At most four folders move in each direction in a
sandbox at once. Like every file call, a folder call wakes a paused sandbox.
A download whose reader takes no bytes for 60 seconds ends with 408
`download_idle`; ask for it again.
An upload, chunk or any request whose body sends no bytes for 30 seconds is
answered 408 `request_timeout`; send it again (a chunk at its same offset).
A body that keeps arriving, however slowly, may take up to about 280 seconds
to arrive; the request then still has its own 110 seconds to answer. A body
still arriving after 280 seconds is answered 408 `request_timeout` too, and
its answer says how many bytes came. Chunks sent at once share the link, so
over a slow link send fewer at once. The SDKs and the CLI get 503
`body_stalled` instead of either 408, which they send again by themselves
with the same key.
The SDKs' `files.upload` and `files.download` and the CLI's `runtime sandboxes cp`
use these routes. The SDKs also expose `files.archive` and `files.unarchive`
for callers that need the archive bytes themselves.

```bash no-run
curl -sS "https://api.withruntime.com/v1/sandboxes/${ID}/files/archive?path=/workspace/app&gzip=true" \
  -H "Authorization: Bearer ${RUNTIME_API_KEY}" -o app.tar.gz
curl -sS -X PUT "https://api.withruntime.com/v1/sandboxes/${ID}/files/archive?path=/workspace/site" \
  -H "Authorization: Bearer ${RUNTIME_API_KEY}" --data-binary @site.tar.gz
```

### File links

A file link is an address for one file of a sandbox that works with no API
key, for a person's browser or another service: a report, a build, a video, a
dataset. `POST /v1/sandboxes/{id}/files:link` makes one and answers its `url`,
`https://files.<preview domain>/<token>/<name>`, and when it ends.

- `method: "GET"` (the default) downloads the file. Range requests work, so a
  video plays and a download resumes (`ETag` and `If-Range` keep a resume on
  the same version). A picture, video, sound or plain text shows in the
  browser; anything else (a PDF, a page, a program) downloads, and with
  `filename` everything downloads under that name. Nothing a link serves runs
  as a page, and every answer carries `X-Runtime-Report`, where to report it. `archive: true` links a
  folder, downloaded as `.tar.gz`. The file must exist when the link is made.
- `method: "PUT"` makes an upload link: `curl -T report.pdf "$URL"` writes the
  body to `path`, making its folder, whole or not at all (a reader sees the old
  file or the new one), and answers 201 with `{"path", "size", "sha256"}`. Up to
  `maxBytes`, 5 GiB by default and at most; the body must arrive within 5
  minutes.
- `expiresInSeconds` is 3600 unless given, 60 to 604800 (7 days).
- A paused sandbox wakes for a link as for any file call. `wake: false` never
  wakes it (the link answers 409 `sandbox_paused`); `wake: true` wakes it even
  when it was made with `autoWake: false`, and needs a key that may wake the
  sandbox itself (the `create` permission; otherwise 403).

A link needs the key's `read_file` permission to download and `write_file` to
upload, and acts as that key: revoking the key ends its links, and so does
`POST /v1/sandboxes/{id}/files:revoke-links` for every link of the sandbox, and
deleting the sandbox. A link that ended answers 410 (`link_expired`,
`link_revoked`), a deleted sandbox 404 `sandbox_gone`, a request with the
other method 405 `wrong_method`, a range past the end of the file 416
`range_not_satisfiable`, and an upload the sandbox could not write 422
`upload_failed` (nothing is written), and a sandbox Runtime took down after
a report 451 `taken_down`; refusals are plain text, or JSON when
the request accepts `application/json`. Each link made and each
revocation is in the audit log. The bytes a link serves count as the sandbox's
served traffic, as a preview's do: the same monthly allowance and price.

```bash no-run
URL=$(curl -sS -X POST "https://api.withruntime.com/v1/sandboxes/${ID}/files:link" \
  -H "Authorization: Bearer ${RUNTIME_API_KEY}" -H "Content-Type: application/json" \
  -d '{"path": "/workspace/report.pdf", "expiresInSeconds": 86400}' | jq -r .url)
curl -fLo report.pdf "$URL"  # no key
```

Links are for a sandbox's files. A link to a file on a volume with no sandbox
running is not available yet: mount the volume in a sandbox and link the file
there.

## Sessions

A session is a short-lived token a browser uses to reach one sandbox without
your key. A key that can run commands in the sandbox makes, lists and revokes
them:

| Method and path                                       | What it does                                                                                        |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `POST /v1/sandboxes/{id}/sessions`                    | `{"ttlSeconds", "origins", "name"}`; answers the session with its `token`, shown once, and `apiUrl` |
| `GET /v1/sandboxes/{id}/sessions`                     | Its sessions still active, and those that ended in the last day                                     |
| `POST /v1/sandboxes/{id}/sessions/{sessionId}:revoke` | End one now                                                                                         |

`ttlSeconds` is {{session-default-seconds}} unless given and
{{session-max-seconds}} at most. `origins` lists up to {{session-origins}}
exact origins, `https://host[:port]` or `http://localhost[:port]`.

Send the token as the bearer: `Authorization: Bearer rtsess_...`. It is served
the sandbox's routes under `:exec`, `/processes`, `/files`, `/uploads`,
`/interpreter`, `GET /v1/sandboxes/{id}` and `GET /v1/sandboxes/{id}/previews`,
for its own sandbox only; everything else answers `forbidden` (403), and an ended
session `unauthorized` (401). A preview token it is handed ends when it does.

The API answers CORS only for a session's own origins: a preflight from a page
some session of that sandbox lists, and the answers to that session's
requests, errors included. A session request from any other page is refused.
Requests with a key carry no CORS headers.

A replay of a create with the same `Idempotency-Key` answers the session with
`token: null`; revoke it and make another. The SDKs do that for you.

## Private preview tokens

`POST /v1/sandboxes/{id}/previews` accepts optional `ttlSeconds` and
`expiresAt` fields. `GET /v1/sandboxes/{id}/previews/{port}` accepts them as
query parameters; `runtime_sandboxes_previews_create` accepts the same fields.
`expiresAt` is an ISO timestamp with a timezone, at least a minute and at most
a week ahead. Invalid deadlines answer `invalid_request` (400) before changing
the preview.

With `expiresAt` alone, the token ends by that deadline. With both fields, it
ends by the earlier of the requested lifetime and deadline. Existing relative
lifetimes keep their rounding; an absolute deadline rounds down to whole seconds
and is never exceeded. Read `tokenExpiresAt` from the response rather than
calculating it yourself. A connection the token opened, such as a WebSocket or
a long download, ends when the token expires; open it again with a fresh token.
A preview token read through a sandbox session also
ends by that session's expiry. With less than a minute left, the session receives
no fresh token. Sessions still cannot create or rotate previews, or use MCP.

A token is not stored on the preview, and neither is its expiry. Every create
and every read signs its own token for that answer: a list, or a read without
`ttlSeconds` or `expiresAt`, signs one that lasts a day. So a create that asked
for a week and a list just after it show the same preview id with different
tokens and different `tokenExpiresAt` values, and both tokens work, each until
its own `tokenExpiresAt`. A later read never shortens or extends a token you
already hold; only `:rotate` (or a key's removal) ends it early.

## Other products

| Method and path                                                                                                                                                                                                                        | Product                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `POST /v1/sandboxes/{id}/interpreter:run`, `…/interpreter/contexts` (`language`: python, javascript, typescript, r, java, bash, go), `…/contexts/{context}:restart`, `:interrupt`, `DELETE`, `GET …/contexts/{context}/results/{file}` | Code interpreter                                                                               |
| `POST`, `GET /v1/sandboxes/{id}/mounts`, `…/mounts:unmount`                                                                                                                                                                            | Bucket mounts                                                                                  |
| `POST`, `GET`, `DELETE /v1/sandboxes/{id}/tailscale`                                                                                                                                                                                   | Your Tailscale network                                                                         |
| `POST`, `GET /v1/sandboxes/{id}/previews`, `…/previews/{port}`, `…/previews/{port}:rotate`                                                                                                                                             | Previews                                                                                       |
| `POST /v1/sandboxes/{id}/browser:start`, `GET /v1/sandboxes/{id}/browser`, `POST /v1/sandboxes/{id}/browser:stop`                                                                                                                      | A Chromium browser and its private CDP address ([JavaScript](./javascript#a-browser-over-cdp)) |
| `POST /v1/sandboxes/{id}/desktop:start`, `:stop`, `:act`, `GET …/desktop/screenshot`                                                                                                                                                   | Desktop                                                                                        |
| `POST`, `GET /v1/sandboxes/{id}/desktop/recordings`, `GET …/recordings/{recordingId}`, `…/video`, `:stop`, `DELETE`                                                                                                                    | Desktop recordings                                                                             |
| `GET /v1/mcp/catalog`; `POST`, `GET`, `DELETE /v1/sandboxes/{id}/mcp`                                                                                                                                                                  | MCP servers                                                                                    |
| `GET`, `PUT /v1/sandboxes/{id}/network`                                                                                                                                                                                                | Network rules                                                                                  |
| `GET /v1/egress-secrets`, `PUT`, `DELETE /v1/egress-secrets/{name}`, `PUT /v1/egress-secrets/{name}/sandboxes` and `/rules`                                                                                                            | Secrets                                                                                        |
| `GET`, `PUT`, `DELETE /v1/networks/upstream-proxy`                                                                                                                                                                                     | Your own proxy                                                                                 |
| `GET`, `PUT /v1/networks/private`                                                                                                                                                                                                      | Your sandboxes reach each other by name                                                        |
| `GET`, `PUT /v1/networks/signed-requests`                                                                                                                                                                                              | Your sandboxes sign requests as Runtime's agents                                               |
| `POST`, `GET /v1/feedback`                                                                                                                                                                                                             | Feedback                                                                                       |
| `POST /v1/support/messages`, `GET /v1/support/conversations/{id}`                                                                                                                                                                      | Support                                                                                        |
| `GET /v1/me`, `GET /v1/usage`, `GET /v1/usage/requests?range=24h`, `GET /v1/limits`, `GET /v1/audit`, `GET /v1/account/emails`, `POST /v1/account/emails:update`                                                                       | Account                                                                                        |
| `GET /v1/sso`                                                                                                                                                                                                                          | Single sign-on                                                                                 |
| `GET`, `PUT`, `DELETE /v1/billing/auto-top-up`                                                                                                                                                                                         | [Auto top-up](./pricing#auto-top-up)                                                           |
| `GET`, `POST /v1/identity/token?audience=` (from inside a sandbox, with its request token)                                                                                                                                             | Identity tokens                                                                                |
| `GET /v1/usage/compare?provider=e2b&days=30`, `GET /v1/switching`, `POST /v1/switching`                                                                                                                                                | Switching                                                                                      |
| `POST`, `GET /v1/images`, `GET /v1/images/{id}`, `…/logs?follow=true`, `:tag`, `:untag`, `:delete`, `GET /v1/images/resolve?ref=`                                                                                                      | Custom images                                                                                  |
| `POST /v1/images/context/missing`, `PUT /v1/images/context/{digest}`                                                                                                                                                                   | Image build contexts                                                                           |
| `GET`, `POST /v1/images/registries`, `POST /v1/images/registries:delete`                                                                                                                                                               | Private registries                                                                             |
| `POST`, `GET /v1/volumes`, `GET /v1/volumes/{id}`, `:delete`, `:backup`, `:backup-policy`; `GET /v1/volume-backups`, `…/{id}`, `:delete`                                                                                               | Volumes and backups                                                                            |
| `POST /v1/sandboxes/{id}:fork`, `POST /v1/sandboxes/{id}:snapshot`, `GET /v1/snapshots`, `…/{id}`, `:update` (name, labels), `:extend`, `:delete`                                                                                      | Forks and snapshots                                                                            |
| `GET /v1/sandboxes/{id}/metrics?range=1h`, `GET /v1/events`                                                                                                                                                                            | Metrics and events                                                                             |
| `POST`, `GET /v1/webhooks`, `GET /v1/webhooks/{id}`, `:update`, `:rotate-secret`, `:test`, `:delete`, `…/deliveries`, `POST /v1/webhook-deliveries/{id}:retry`                                                                         | Webhooks                                                                                       |
| `POST`, `GET /v1/otel-exports`, `GET /v1/otel-exports/{id}`, `:update`, `:flush`, `:delete`                                                                                                                                            | OpenTelemetry export                                                                           |

Snapshots accept `mode: "memory"` (the default) or `mode: "disk"` in
`POST /v1/sandboxes/{id}:snapshot`. Memory snapshots keep files and running
processes. Disk snapshots keep only the root filesystem; a sandbox created
from one boots fresh with no saved processes, at the `vcpu`, `memoryMiB` and
`diskMiB` the create asks for (each one left out is the snapshot's), with a
disk at least the saved size. A copy of a memory snapshot continues the saved
machine, so it is the snapshot's size; naming a different size is
`400 invalid_request`. Neither takes a source with attached volumes, and both
keep the same ownership, retention and storage pricing. A running source is
paused for the capture and woken after it; a disk snapshot's pause first
waits for the sandbox to write to its disk what it still holds in memory,
milliseconds when quiet and up to a few seconds while it writes. The returned snapshot includes its `mode`. Keep the
source paused until the snapshot's state is `ready` or `failed`; `Prefer: wait`
can return while capture is still in progress.

Where deferred compression has been qualified and enabled, a memory
snapshot may be `ready` with `compressionPending: true`, startable
on the same server from its captured raw state. `meteredBytes` is zero until
Runtime publishes the verified compressed allocation; temporary raw files
are not charged. While compression is pending, `backedUp` is false and
`durability.state` is `none`. Its off-server copy is queued after compression.
See [snapshot storage](./storage#snapshots-survive-their-server).

### Keeping copies on several servers

A copy of a snapshot starts on a server that holds the snapshot: the server it
was taken on, or one Runtime keeps a checked copy of it on. When none of those
has room, Runtime copies the snapshot to another server in the region and the
sandbox starts there once the copy is checked, usually within half a minute.
This works as soon as the snapshot is `ready`, even while its compression is
pending. A server starts at
most 4 copies a minute of one account's snapshot while that account's
sandboxes there are busy on CPU. Past that, the start moves to another server
holding the snapshot that has room, and is refused with `account_busy_here`
only when none has. To be sure copies start on several servers, keep several
warm sources on different servers.

`spreadFrom` lists 1 to 16 ids of your own sandboxes or snapshots. The new
sandbox starts on a server none of them is on, and stays apart if its start is
moved. With no other server that has room, the create answers 503
`no_capacity` (its message names `spreadFrom`), and nothing is made or
charged. An id that is not a sandbox or snapshot this key may read is
`400 invalid_request`. A copy of a snapshot whose `spreadFrom` names every
server holding that snapshot starts on another server, the snapshot copied
there first, as when those servers are full. Compare `placement` tags to see
which of yours share a server.

Three warm sources apart, then copies round-robin:

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const a = await runtime.sandboxes.create();
const b = await runtime.sandboxes.create({ spreadFrom: [a.id] });
const c = await runtime.sandboxes.create({ spreadFrom: [a.id, b.id] });

const snapshots = [];
for (const source of [a, b, c]) snapshots.push(await source.snapshot());

for (let i = 0; i < 12; i++) {
  await runtime.sandboxes.create({ snapshot: snapshots[i % 3]!.id });
}
```

```python check
from withruntime import Runtime

runtime = Runtime()
a = runtime.sandboxes.create()
b = runtime.sandboxes.create(spread_from=[a.id])
c = runtime.sandboxes.create(spread_from=[a.id, b.id])

snapshots = [source.snapshot() for source in (a, b, c)]

for i in range(12):
    runtime.sandboxes.create(snapshot=snapshots[i % 3]["id"])
```

Wakes and copies run on the source's server.

A copy of a snapshot that saved memory, and a wake, load all of that memory
within seconds, so a server counts each one at all of it from its start. Many
copies or wakes at once on one server take what memory it has; the ones past
that wait while it makes room, and if none comes in time they answer
`503 host_memory_pressure` with `Retry-After`. Send each again after it, with
the same `Idempotency-Key`, backing off if it is refused again, as the SDKs
do.

Forks:

- A fork's copies keep the source's size and CPU (`cpu` and `cpuFloorMillis`),
  and are quoted as a create with them would be.
- Copies keep the source's `labels` unless the fork names others. They get no
  name unless the fork gives one (`name`, then `name-1`, `name-2` for several),
  because names are unique in the account (or in a compartment). A snapshot taken without labels
  keeps its sandbox's, and a sandbox created from a snapshot keeps the
  snapshot's unless the create names others. The one exception is
  `share: made-keys`: copies, sandboxes and snapshots never inherit it. Set
  it on each snapshot you mean to share (see
  [Run a swarm](./teams#run-a-swarm)). A `share` label of any other value is
  yours and is copied as before.
- The snapshot a fork takes is deleted when the fork ends, whether every copy
  started or not, and is never billed, unless the request says
  `keepSnapshot: true`.
- A fork that fails after its snapshot answers with the failing step's error.
  Its `details.startedSandboxIds` names the copies that did start; they keep
  running until stopped. A retry with the same `Idempotency-Key` answers that
  same error.
- If a fork stops partway and left its source paused, the source stays paused.
  `GET /v1/notices` holds a `fork-left-paused` notice naming the sandbox, the
  fork's key and how to wake it.

Metrics, events, webhooks and OpenTelemetry export are in
[metrics and webhooks](./observability): what each field means, how deliveries
are signed and retried, and what an export sends.

The OpenAPI document has every field of every route.

<!-- launch: apps -->

### Commands and files in an App's copy (private beta)

Apps are open to organizations in their private beta. Each copy of an App is
a machine, and the sandbox routes for [commands](#commands-and-processes) and
[files](#files) reach it by its id: `POST /v1/sandboxes/{copyId}:exec`,
`…/processes`, and `GET` and `PUT …/files/content`, uploads included. Copy ids
come from `GET /v1/apps/{id}/copies`. Use one whose `state` is `serving`; the
copy of the `liveVersion` is the live one.

```bash no-run
copy=$(curl -sS "https://api.withruntime.com/v1/apps/${APP}/copies" \
  -H "Authorization: Bearer ${RUNTIME_API_KEY}" | jq -r '[.[] | select(.state == "serving")][0].id')
curl -sS "https://api.withruntime.com/v1/sandboxes/${copy}:exec" \
  -H "Authorization: Bearer ${RUNTIME_API_KEY}" \
  -H "Content-Type: application/json" -d '{"command": "tail -n 50 /srv/app.log"}'
```

- A copy holds the App's environment, its secrets included. Only a key of an owner or admin may reach into one. Any other key gets
  `403 forbidden`, even a developer's key that made the App.
- A copy that is not serving (frozen, starting or draining) answers
  `409 invalid_state`. A call never wakes it. A request to the App's URL wakes
  one, and `minCopies: 1` keeps one awake.
- A file written to a copy lasts only as long as that copy. A deploy replaces
  every copy with new ones from the version's image.
- The CLI does the same with `runtime apps exec <app> -- <command>` and
  `runtime apps cp <file> <app>:/<path>` ([CLI](./cli#apps-private-beta)).

### What an App's requests carry

Every request reaches an App's copies with headers Runtime's router sets
itself, replacing any a visitor sent under the same names:

| Header                 | Value                                           |
| ---------------------- | ----------------------------------------------- |
| `x-runtime-client-ip`  | The visitor's address                           |
| `x-runtime-ip-country` | The visitor's country, two letters, when known  |
| `x-runtime-ip-city`    | The visitor's city, percent-encoded, when known |
| `x-runtime-request-id` | 32 hex characters, new for each request         |

The `x-runtime-` names belong to the router: any other `x-runtime-*` header a
visitor sends is removed before the request reaches the App, as is every
`x-vercel-*` header, so an App can trust every `x-runtime-*` header it reads.
The answer carries the same `x-runtime-request-id`, which finds the request
in the App's logs.

### App and Function addresses

Every App and Function answers at its own readable address:
its name, 16 random characters, then your account's handle, one name under
`runtimehost.com`. The App `shop` of the account Acme is, for example,
`https://shop-3f9a1c2e7b04d915-acme1.runtimehost.com/`. It is the `url` of the App
(`GET /v1/apps/{id}`) and of each of its deploys. An App made before 20
October 2026 was given one then. It is kept for life: renaming the App or the account leaves it where it
is, so no link you shared breaks, and a deleted App's address is never any
App's again. Your account's handle is made from its name at its first App,
letters then a number, and is never anyone else's, even after your account
is closed. An account named from the email it signed up with has the handle
`acct<number>`, so no part of an email address is ever in an address. An App
without a name, or whose name holds a word sign-in pages are trusted for or a
well-known brand's name, is `app-<16 random>-acme1` (`function-…` for a
Function).

The random part means an address can't be guessed from your App's and
company's names, but an address is not a secret: anyone you give it to has
it. Protect an App that must be private with its own sign-in or a firewall.
Every App also keeps answering at its id's address,
`https://<id without dashes>.runtimehost.com/`. Your own domains are added beside it (see
[Networking](./networking)).

### App and Function CDN

Every App and Function has a `cdn` setting, `true` unless you set it: Cloudflare's
CDN sits in front of its addresses, the `runtimehost.com` one and its custom
domains. `false` sends visitors straight to Runtime's routers, with nothing
cached. Set it when you create the App (`POST /v1/apps`, `POST /v1/functions`)
or change it later (`POST /v1/apps/{id}:update`); every read answers it. It is
part of the price of Apps and Functions, with no separate fee. In the SDKs it is
`cdn` (`CDN` in Go, `cdn:` in Ruby, `cdn(...)` in Java), in the CLI
`--cdn on|off`, and the MCP tools take `cdn` as the routes do.

### App and Function logs

`GET /v1/apps/{id}/logs` (and `GET /v1/functions/{id}/logs`) answers what the
App's copies printed to standard output and error, as `lines`, oldest first:
`at` (Unix milliseconds), `stream`, `copy` (the copy's id), `version` and
`text`. A page is the newest `limit` lines (1 to 500, default 100) of the
window, with `nextCursor` and `hasMore`; pass `nextCursor` back as `cursor`,
with the same filters, for the page before it.

- `since`: a time (`2026-10-18T20:00:00Z`) or a duration back from now
  (`30s`, `15m`, `2h`, `7d`); an hour when left out. Lines are kept 14 days.
- `version`, `copy` (an id from `GET /v1/apps/{id}/copies`) and `stream`
  (`stdout` or `stderr`) narrow it.
- `follow=true` answers NDJSON: the page's lines, then each new one as it is
  printed. Each event is a `line` or a `gap` (lines lost before they could be
  read), with a `cursor` to resume after it. One call lasts at most two
  minutes and ends with a `continue` event; call again with its `cursor`. The
  SDKs do this themselves and give each line once.

Reading logs needs a key that may read files (`read_file`, so a read-only key
may). Another account's App, or one the key's agent does not act for, is
`404 not_found`. A `cursor` that does not continue the read is
`400 invalid_request`; a read the log store cannot answer just now is
`503 api_unavailable`, safe to retry; on a deployment without the log store
the read is `501 unavailable`. The MCP tools are `runtime_apps_logs` and
`runtime_functions_logs` (the `logs` action of `runtime_apps` and
`runtime_functions`); there a page's size is `lines` and its cursor `before`,
since `limit` and `cursor` are the list's. In the SDKs: `apps.logs(id, options)`, with
`follow: true` (JavaScript) or `follow=True` (Python) to stream;
`Logs` and `FollowLogs` (Go); `logs` and `follow_logs` (Ruby); `logs` and
`followLogs` (Java). A follow that loses its connection more than three
times in a row stops with `app_log_interrupted`, and one that reads an event
it does not understand with `app_log_invalid`; each error's
`details.cursor` is where to follow again from.
<!-- /launch: apps -->

<!-- launch: apps -->

### Apps with a volume

Give an App `volume: {volumeId, path}` on create or update to mount one of
your volumes (`POST /v1/volumes`) read-write in its copy. `path` is under
`/data`, `/mnt`, `/state`, `/storage` or `/volumes`, with no `.` or `..`
segments. A volume has one writer, so the App runs one copy: `minCopies` 1,
`maxCopies` 1 and `spares` 0, or `400 volume_invalid`. The copy runs on the
volume's server. A volume that is another App's, or attached to a sandbox,
is `409 volume_attached`; while the App holds it, the volume is not deleted,
resized or attached elsewhere. A volume is added or taken off only before
the App's first deploy (`409 volume_change_refused`).

The volume's files reach the App's environment, so once any version of the
App has a sealed environment or uses account secrets, every write that
moves its copy needs a key that may reveal them (`secrets_reveal`): setting
or moving the volume, and each deploy, rollback and restart. Any other key
is answered `403 forbidden`. What such an App wrote stays as secret: once
its copy has used the volume, attaching that volume to a sandbox, or a
volume restored from one of its backups, needs a key that may reveal that
App's secrets, even after the App is deleted or has moved to another
volume (else `403 forbidden`).

Every deploy, rollback and restart of such an App stops, then starts:

- The live copy leaves the route (requests wait), gets SIGTERM, and has
  `stopGraceSeconds` (0 to 900, 30 by default) to exit before it is stopped
  and the volume let go.
- The new copy boots fresh from the version's image, or a build's files with
  its start command, with the volume mounted. It never resumes saved memory
  and never runs beside the old one.
- Its health check decides. A copy that fails, or does not serve within the
  start time, fails the version (`deploy_health_failed`), and the version
  that was live is started again the same way. The failed deploy's
  `lastOutput` holds the server's last lines only for a key that may reveal
  the App's secrets, since they ran with its environment; any other key
  reads a sentence saying they are held.
- If the old copy never stops and lets the volume go within 30 minutes (its
  server was lost, and the volume has not yet come back on another server
  from its replica or its backup), the deploy fails with
  `deploy_stop_failed` and nothing of it starts. The version that was live
  starts again on the volume as soon as it is free.
- If the new copy serves but the switch to it is not recorded within 5
  minutes, the deploy fails with `deploy_switch_failed` and the version that
  was live starts again on the volume.
- The deploy record says `downtime`: `stopMs`, `bootMs` and `totalMs`.

### Restart and replaced copies

`POST /v1/apps/{id}:restart` (and `POST /v1/functions/{id}:restart`) starts
the live version afresh and answers a deploy record of its own, with
`restartOf` naming that version. It works on any App or Function: one
without a volume warms the new copies beside the old, as a deploy does.
Nothing live is `409 restart_unavailable`. A live version that names its
image by name rather than id resolves the name again, so with a sealed
environment or account secrets its restart needs a key that may reveal them
(`403 forbidden`); deploy the image by id to restart it with any key. The MCP tools are
`runtime_apps_restart` and `runtime_functions_restart`. In the SDKs:
`apps.restart(id)` and `functions.restart(id)`, in JavaScript and Python;
in the CLI, `runtime apps restart <app>`.

A live copy that every router has had out of rotation for its App's or
Function's `healthFailSeconds` (10 to 3600, 60 by default; set on create or
update, as for an App), or whose process ended, is replaced by a copy of the
same version. The version's `replacements` list
each one: `at`, `reason` (`health` or `exited`) and, with a volume,
`downtimeMs`.
<!-- /launch: apps -->

## Account

`GET /v1/me` says who a key is: `orgId`, `principalId`, `credentialId`, the
account's `orgName`, and the `role` of the member who made the key (`owner`,
`admin`, `developer` or `billing`), which bounds what the key may do.
`GET /v1/usage` says what the account has and has used. Money is integer
microdollars in strings (1,000,000 is one dollar), exact however large:

| Field        | What it is                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------------- |
| `credited`   | Every credit ever added: purchases and grants                                                       |
| `spent`      | Settled usage, including what refunds and disputes took back                                        |
| `expired`    | Credit that expired, or grant credit taken back                                                     |
| `available`  | What can still be spent, after what running sandboxes are about to use                              |
| `takenBack`  | The part of `spent` that refunds and disputes took                                                  |
| `trial`      | Machine time without credit: `{totalMs, usedMs, reservedMs, availableMs, offer, renewsAt}`, or null |
| `allowances` | This month's free usage, one row per pool, below                                                    |
| `outbound`   | This month's outbound traffic, below                                                                |
| `kinds`      | Every resource, however many, a row a kind: `{kind, resources, chargedMicros, heldMicros}`          |
| `resources`  | The newest hundred resources, with what each used and was charged                                   |

Each resource carries `resourceId`, `name`, `kind`, `state`, `createdAt`,
`vcpu` and `memoryMiB` (null for a kind with no size), `runningSeconds` (the
billed running time), `activeCpuSeconds`, `memoryGiBSeconds`, `rates` and
`chargedMicros`. `chargedMicros` covers every meter, outbound
traffic included. Divide it by `runningSeconds` for what a run cost a second.

`outbound` is the account's outbound traffic this calendar month, UTC:
`month` (`2026-09`), `sentBytes`, `freeBytes` (what the allowance covered),
`billableBytes`, `allowanceBytes` ({{outbound-allowance}}), and `chargedMicros` and
`writtenOffMicros` as strings. `writtenOffMicros` is traffic your balance or a
spending limit could not cover; it is never charged later
([pricing](./pricing#network-products)).

### Export settled usage

`GET /v1/usage/export?since=2026-09-01T00:00:00Z&until=2026-10-01T00:00:00Z`
reads settled usage for every product visible to the key. `since` is inclusive
and `until` exclusive, both UTC ISO timestamps ending in `Z`; the filter uses
when an interval settled, rather than when its resource was created.

The answer is `{since, until, data, nextCursor, finalThrough, csv}`. Rows name the interval
and resource, kind, meter, funding, interval start/end, settlement time, billed
milliseconds, `chargedMicros`, quoted component rates and measurement evidence.
Money and quantities are exact decimal strings. `billedMilliseconds`,
measurements and evidence can be null when unavailable.

Each interval is one row, written once when it settles; a later read never
changes or repeats it. Before the first page, a read settles your running
sandboxes through about a minute ago, so their use is in the export, not just
what ran up to their last hourly window: up to 100 sandboxes per read, the
longest unsettled first, and only sandboxes paid from credit (a trial's are
not). Storage (a paused sandbox's memory and disk, a stopped sandbox's disk,
images, snapshots, volumes and volume backups) is paid an hour at a time, and
each hour is in the export within a minute of its end, usually seconds.
Pending holds, the credit set aside for work still running (`heldMicros` in
`GET /v1/usage`), are not in the export; a hold becomes a row when it settles.

`finalThrough` is a UTC timestamp before which nothing can still change: no row
with `settledAt` earlier than it can still appear, and rows never change once
written. A range whose `until` is at or before `finalThrough` is complete for
good; usage that settles later is stamped at or after it. It is null only when
the marker could not be taken in time; read again. Each row's `final` (and the
CSV's last column) is true once its resource is deleted, nothing of it is still
running or open, and every charge it will ever have settled before
`finalThrough`. A volume's backups are resources of their own and bill until
their retention ends, so they are not final when the volume is.

Follow `nextCursor` with the same range until it is null. Each page rechecks
the key's `usage` permission and resource visibility. These are live reads;
usage that settles after an earlier page can appear on a later page. The
server's `csv` includes a header on its first page only, so concatenate the
pages unchanged, in order. This range export covers more than the newest
hundred resources in `GET /v1/usage`.

`GET /v1/limits` says what this key may do and what its agent may still spend:

```json
{
  "access": "full",
  "daily": {
    "limitMicros": "25000000",
    "usedMicros": "3100000",
    "remainingMicros": "21900000",
    "window": "24h"
  },
  "trial": null,
  "credit": {
    "availableMicros": "42500000",
    "dailyPaceMicros": "6100000",
    "runwayDays": 6,
    "lowBelowDays": 5,
    "state": "ok",
    "addedBy": "owner"
  }
}
```

- `access` is `full` (every action in every product), `read` (a read-only key:
  every read, no change and no spending) or `selected` (the actions the key
  names).
- `daily.limitMicros` is the most the key's agent may commit in any 24 hours,
  or null when the owner set no limit. `usedMicros` counts what is charged and
  what its running sandboxes are about to use.
- Past the limit, a create, wake, extension or renewal fails with 402
  `spending_limit_reached` and charges nothing.
- `trial` is the machine time the account can run without credit, the same figures as `GET /v1/usage`, in milliseconds, or null when the account has none, as here. `availableMs` is what a new sandbox without credit can still use. `offer` is `monthly` for the free usage, or `hours` for an account given free hours before 5 October 2026, which keeps what is left of them; `renewsAt` is when the next month starts, and an account that has never paid has its free machine time once, until `freeUntil` on its `allowances` rows. The field keeps its older name so code that reads it goes on working.

- `credit` is the account's credit: `availableMicros` left now (as
  `GET /v1/usage`'s `available`), `dailyPaceMicros`, a day at this month's
  pace (last month's while this one is under three days old; null when
  nothing is spent), and `runwayDays`, the whole days it lasts at that pace,
  as the console's Home says it. `state` is `low` under `lowBelowDays` days
  and `empty` at none: running paid sandboxes then pause and new ones are
  refused. The `credit.low` and `credit.empty` [webhooks](./observability)
  are sent at the same moments. `addedBy` is `owner` (a person adds credit,
  on the website) or `agent`: the account was opened with a wallet and no
  person pays for it, so its own agent adds credit with
  `npx withruntime billing topup <usd>` before `runwayDays` reaches 0.

A limit is set, changed or removed only on the website, at
[API keys](https://withruntime.com/account/keys): by the member who made the key,
or by an owner or admin. A key can only make keys with a daily limit that fits
within its own, and cannot change its own.

`GET /v1/audit` is the account's audit log, newest first: member and role
changes, keys, connections, limits, credit, network rules, secrets and
deletions, each with `actor`, `at`, `ip`, `requestId`, `via` and `sandbox`
(the sandbox the call came from, when code in it called
`http://runtime.internal`; otherwise null). Filter with
`action` (`key.created`, or a group such as `member.`), page with
`before=<next>` and `limit` (1 to 200). It needs a key with full access or a
read-only key, made by an owner or admin; see [teams](./teams).

`GET /v1/sso` is the account's single sign-on: each identity provider, its
domain and whether DNS has proven it, the role people join with, whether
single sign-on is required, and SCIM directory sync. It is read only, with the
same keys as the audit log; an owner changes it on the website. See
[single sign-on](./single-sign-on).

`GET /v1/identity/token?audience=sts.amazonaws.com` is for code inside a
sandbox. It takes the sandbox's `RUNTIME_ID_TOKEN_REQUEST_TOKEN` as the bearer,
not an API key, and answers `{"token", "expiresAt", "issuer", "subject",
"audience"}`: an OIDC token naming that sandbox, for 10 minutes by default
(`lifetimeSeconds` 60 to 3600). See [identity tokens](./identity-tokens).

## Domains, TCP ports, addresses and the tunnel

Paid accounts only; see [networking](./networking). Each is its own product,
not a sandbox's:

| Route                                           | What it does                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------ |
| `POST /v1/domains`                              | `{hostname, sandboxId, port}`: claim a hostname; answers its DNS records |
| `POST /v1/domains/{hostname}:verify`            | Check the TXT record; `active` when it matches                           |
| `GET`, `DELETE /v1/domains/{hostname}`          | One domain; stop serving it                                              |
| `POST /v1/ports`                                | `{sandboxId, port}`: a public TCP port; answers `connect`                |
| `GET /v1/ports`, `DELETE /v1/ports/{id}`        | List (`?sandboxId=`); close                                              |
| `POST /v1/ips`                                  | `{family}`: reserve a dedicated outbound address (4 or 6)                |
| `GET /v1/ips`, `DELETE /v1/ips/{id}`            | List; release                                                            |
| `POST`, `GET`, `DELETE /v1/networks/wireguard`  | Create (`{subnet}`), read or delete the WireGuard tunnel                 |
| `POST /v1/networks/wireguard/peers`             | `{name, publicKey?, routes?}`: add a peer; answers its wg-quick `config` |
| `POST /v1/networks/wireguard/peers/{id}:rotate` | `{publicKey?}`: a new key for the peer                                   |
| `DELETE /v1/networks/wireguard/peers/{id}`      | Remove a peer                                                            |

A dedicated address needs credit on the account; the rest need a kept top-up. Without it a request gets `payment_required` (402).

## Pages

A list that can grow answers `{"data": [...], "nextCursor": "..."}`. Pass
`nextCursor` back as `cursor`; `null` ends the list. `limit` is 1 to 100, and
up to 500 for `GET /v1/feedback`.

Short lists answer `{"data": [...]}` whole, with no cursor: a sandbox's file
watches, mounts, interpreter contexts and desktop recordings, registry
credentials and the MCP catalogue. A few are shaped their own way:

- **The audit log,** `GET /v1/audit`, answers `{"events": [...], "next": "..."}`,
  newest first. Pass `next` back as `before`; `null` ends the log. `limit` is 1
  to 200.
- **Secrets,** `GET /v1/egress-secrets`, answers `{"secrets": [...]}`.
- **Single sign-on,** `GET /v1/sso`, answers `connections`, `scim` and `manage`.
- **Process output and file-watch events** carry their own `nextCursor` beside
  the chunks or events, and **build logs** answer `lines` with `nextAfter`.

## Versions

This is 0.2.0. The OpenAPI document's `info.version` is the version you are
talking to.

The 0.1.0 routes under `/v1/resources` were removed on 22 September 2026. Each
answers 410 `upgrade_required`, and `details.replacement` names the route that
replaced it. [The migration guide](./migrate) maps each old call to its new one.

Each product has one plural name in every path, SDK call, command and MCP tool:
`/v1/sandboxes`, `runtime.sandboxes`, `runtime sandboxes`, `runtime_sandboxes`.
When a name changes, the old one keeps working for 30 days. Each answer to it
carries a `Warning` header with the new name and a `Link` to the new path; the
SDKs and the CLI print the warning once, and an MCP answer carries it as
`warning`. Once the day it stops is set, answers also carry `Deprecation` and
`Sunset` (that day), and the warning names it. From that day the old name
answers 410 `name_retired`, and its `hint` names the new one.
