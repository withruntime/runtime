package withruntime

// Every value this SDK sends the API for a bounded time field when the caller
// names none, in one place. packages/cloud/tests/sdk-defaults.test.ts holds
// each inside the range the API's registry gives that field, and the same
// names in the JavaScript, Python, Java and Ruby SDKs to theirs. The suffix is
// the unit; a new default goes here, under a name that test maps to its field.
const (
	// A server-side wait for a state (GET /v1/sandboxes/{id}?waitFor=).
	waitForTimeoutSeconds = 60
	// A streamed exec's command limit when none is given: the API's longest.
	streamedExecTimeoutMs = 86_400_000
	// The lease KeepAlive keeps ahead of now, and so the most it extends by.
	keepAliveMarginSeconds = 600
)
