# Every value this SDK sends the API for a bounded time field when the caller
# names none, in one place. packages/cloud/tests/sdk-defaults.test.ts holds each
# inside the range the API's registry gives that field, and the same names in
# the JavaScript, Go, Java and Ruby SDKs to theirs. The suffix is the unit; a
# new default goes here, under a name that test maps to its field.

# A server-side wait for a state (GET /v1/sandboxes/{id}?waitFor=).
WAIT_FOR_TIMEOUT_SECONDS = 60
# A streamed exec's command limit when none is given: the API's longest.
STREAMED_EXEC_TIMEOUT_MS = 86_400_000
# The time keep_alive keeps ahead of a time limit, and so the most it extends by.
KEEP_ALIVE_MARGIN_SECONDS = 600
# A job run's limit, and the time added to it for its sandbox to start.
JOB_TIMEOUT_SECONDS = 1800
JOB_START_SECONDS = 60
# A command the framework-free tools run without a timeout of its own.
TOOL_EXEC_TIMEOUT_SECONDS = 300
# A command the Deep Agents backend runs without a timeout of its own.
DEEPAGENTS_EXEC_TIMEOUT_SECONDS = 1800
# A command the OpenAI Agents sandbox runs without a timeout of its own.
OPENAI_AGENTS_EXEC_TIMEOUT_SECONDS = 3600
