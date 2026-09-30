package com.withruntime;

/*
 * Every value this SDK sends the API for a bounded time field when the caller names none, in one
 * place. packages/cloud/tests/sdk-defaults.test.ts holds each inside the range the API's registry
 * gives that field, and the same names in the JavaScript, Python, Go and Ruby SDKs to theirs. The
 * suffix is the unit; a new default goes here, under a name that test maps to its field.
 */
final class ApiDefaults {
  private ApiDefaults() {}

  /** A server-side wait for a state (GET /v1/sandboxes/{id}?waitFor=). */
  static final int WAIT_FOR_TIMEOUT_SECONDS = 60;

  /** A streamed exec's command limit when none is given: the API's longest. */
  static final long STREAMED_EXEC_TIMEOUT_MS = 86_400_000L;
}
