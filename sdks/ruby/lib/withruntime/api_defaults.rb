# frozen_string_literal: true

module WithRuntime
  # Every value this SDK sends the API for a bounded time field when the caller
  # names none, in one place. packages/cloud/tests/sdk-defaults.test.ts holds
  # each inside the range the API's registry gives that field, and the same
  # names in the JavaScript, Python, Go and Java SDKs to theirs. The suffix is
  # the unit; a new default goes here, under a name that test maps to its field.
  module ApiDefaults
    # A server-side wait for a state (GET /v1/sandboxes/{id}?waitFor=).
    WAIT_FOR_TIMEOUT_SECONDS = 60
    # A streamed exec's command limit when none is given: the API's longest.
    STREAMED_EXEC_TIMEOUT_SECONDS = 86_400
    # The lease keep_alive keeps ahead of now, and so the most it extends by.
    KEEP_ALIVE_MARGIN_SECONDS = 600
  end
end
