// Package withruntime is the Go client for Runtime Cloud: Linux sandboxes for
// agents, and every other Runtime product as it launches.
//
//	client, err := withruntime.New() // RUNTIME_API_KEY, or this machine's saved connection
//	if err != nil {
//		return err
//	}
//	sbx, err := client.Sandboxes.Create(ctx, nil) // free trial, 2 vCPU / 4 GiB, waits until running
//	if err != nil {
//		return err
//	}
//	defer sbx.Stop(context.Background(), nil)
//	result, err := sbx.Exec(ctx, "python3 -c 'print(6 * 7)'", nil)
//
// Every call takes a context. Writes carry an idempotency key, made for you and
// kept across the client's own retries, so a retried create never makes two
// sandboxes. Errors are *Error, with a stable Code, a Hint that says what to
// do next and the RequestID to quote to support; errors.Is matches them
// against ErrNotFound, ErrRateLimited and the other sentinels.
//
// Money is integer microdollars (1,000,000 is one US dollar). The guide is at
// https://withruntime.com/docs/go.
package withruntime
