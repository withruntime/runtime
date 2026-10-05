/* Every value this SDK sends the API for a bounded time field when the caller
 * names none, in one place. packages/cloud/tests/sdk-defaults.test.ts holds
 * each inside the range the API's registry gives that field, and the same
 * names in the Python, Go, Java and Ruby SDKs to theirs. The suffix is the
 * unit; a new default goes here, under a name that test maps to its field. */

/** A server-side wait for a state (`GET /v1/sandboxes/{id}?waitFor=`). */
export const WAIT_FOR_TIMEOUT_SECONDS = 60;
/** A streamed exec's command limit when none is given: the API's longest. */
export const STREAMED_EXEC_TIMEOUT_MS = 86_400_000;
/** The time keepAlive keeps ahead of a time limit, and so the most it extends by. */
export const KEEP_ALIVE_MARGIN_SECONDS = 600;
/** A webhook watch runs until stopped. */
export const WEBHOOK_WATCH_TIMEOUT_MS = 0;
/** A job run's limit, and the time added to it for its sandbox to start. */
export const JOB_TIMEOUT_SECONDS = 1800;
export const JOB_START_SECONDS = 60;
/** A command the framework-free tools run without a timeout of its own. */
export const TOOL_EXEC_TIMEOUT_SECONDS = 300;
/** A command the AI SDK harness runs without a timeout of its own. */
export const AI_HARNESS_COMMAND_TIMEOUT_MS = 3_600_000;
/** A command the OpenAI Agents sandbox runs without a timeout of its own. */
export const OPENAI_AGENTS_EXEC_TIMEOUT_MS = 3_600_000;
