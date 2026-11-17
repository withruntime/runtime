# Errors and retries

## The shape of an error

Every error has the same fields: `code`, `message`, `requestId`, `hint`, `retryable`, `param`, `details`. Branch on `code`, never on `message`; include `requestId` when you report a problem.

```json
{ "error": { "code": "not_found", "message": "No such sandbox.", "requestId": "req_1d0b14e4db018fed" } }
```

A command that fails inside a sandbox is not an error: [`POST /v2/sandboxes/{id}:exec`](./reference/sandboxes#exec) returns its result with a non-zero `exitCode`.

## What the SDKs retry

The SDKs send a call again, up to 3 times, on these answers:

| Status | Code | Retried |
| --- | --- | --- |
| 429 | `rate_limited` | When the answer names its wait (`Retry-After`) |
| 503 | `unavailable` | Always |
| 503 | `capacity_unavailable` | Always |

Every other error is returned to you. A call waits at most 60 seconds for its answer, and a retry waits at most 60 seconds.

## Make a retry safe

A create takes an `Idempotency-Key` header. Sent again with the same key, it returns what the first call made instead of making another. The SDKs send one with every change and reuse it when they retry; when you retry yourself, reuse your key.

## Versions

The SDKs send the `Runtime-Version` header with 2026-10-27, the version of the API they were generated from.

## Give this to your agent

Paste this into your coding agent:

> Read https://withruntime.com/docs/errors.md. Make this project's Runtime calls branch on the error's code, never its message, send an Idempotency-Key with every create so a retry never makes a second sandbox, and log the requestId of every error.
>
> This page as Markdown: https://withruntime.com/docs/errors.md
