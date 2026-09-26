package withruntime

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Error is every failure the client returns. Code is stable and
// machine-readable, Hint says what to do next, and RequestID is what to quote
// in a report (runtime feedback, or support).
type Error struct {
	// Code is the API's error code, such as "not_found", "trial_busy" or
	// "missing_api_key"; "connection_error" and "timeout" when no answer came.
	Code    string
	Message string
	// Status is the HTTP status, or 0 when no answer arrived or the error is
	// the client's own.
	Status    int
	Hint      string
	RequestID string
	Details   map[string]any
	// IdempotencyKey is the key the client sent. Retrying with it never
	// repeats the effect.
	IdempotencyKey string
	// RetryAfter is how long the server asked the client to wait, when it did.
	RetryAfter time.Duration
	// Err is the underlying cause, for a connection failure.
	Err error
}

func (e *Error) Error() string {
	var b strings.Builder
	b.WriteString("withruntime: ")
	b.WriteString(e.Code)
	if e.Status != 0 {
		fmt.Fprintf(&b, " (%d)", e.Status)
	}
	b.WriteString(": ")
	b.WriteString(e.Message)
	if e.Hint != "" {
		b.WriteString(" Hint: ")
		b.WriteString(e.Hint)
	}
	if e.RequestID != "" {
		b.WriteString(" Request: ")
		b.WriteString(e.RequestID)
	}
	return b.String()
}

func (e *Error) Unwrap() error { return e.Err }

// deliberate are 503s that are a deliberate state, not a passing one: a
// product switched off here. Retrying cannot change them.
var deliberate = map[string]bool{"fork_unavailable": true, "previews_unavailable": true, "unavailable": true}

// passing are refusals that clear by themselves: a host frees room, a trial
// slot frees.
var passing = map[string]bool{"no_capacity": true, "trial_busy": true}

// waitsForRoom are refusals of a create that clear when a sandbox stops or
// pauses or a host frees room. Sandboxes.Create waits them out, retrying with
// the same key and input, for up to the client's WaitForCapacity.
var waitsForRoom = map[string]bool{
	"trial_busy":         true,
	"trial_domain_limit": true,
	"trial_capacity":     true,
	"quota_exceeded":     true,
	"no_capacity":        true,
}

// Retryable reports whether retrying this exact call (with the same
// idempotency key) is safe and may work.
func (e *Error) Retryable() bool {
	if deliberate[e.Code] {
		return false
	}
	if passing[e.Code] {
		return e.Details["field"] != "count"
	}
	switch e.Status {
	case 0, 429, 502, 503, 504:
		return true
	}
	return false
}

// Is lets errors.Is match an *Error against the sentinels below by status.
func (e *Error) Is(target error) bool {
	kind, ok := target.(*errorKind)
	if !ok {
		return false
	}
	return kind.match(e)
}

type errorKind struct {
	name  string
	match func(*Error) bool
}

func (k *errorKind) Error() string { return "withruntime: " + k.name }

// Sentinels for errors.Is. The same classes as the JavaScript and Python SDKs.
var (
	ErrAuthentication     error = &errorKind{"authentication", func(e *Error) bool { return e.Status == 401 || e.Code == "missing_api_key" }}
	ErrPermissionDenied   error = &errorKind{"permission denied", func(e *Error) bool { return e.Status == 403 }}
	ErrNotFound           error = &errorKind{"not found", func(e *Error) bool { return e.Status == 404 }}
	ErrConflict           error = &errorKind{"conflict", func(e *Error) bool { return e.Status == 409 }}
	ErrInvalidRequest     error = &errorKind{"invalid request", func(e *Error) bool { return e.Status == 400 || e.Status == 413 || e.Status == 422 }}
	ErrRateLimited        error = &errorKind{"rate limited", func(e *Error) bool { return e.Status == 429 }}
	ErrServiceUnavailable error = &errorKind{"service unavailable", func(e *Error) bool { return e.Status >= 500 }}
	// ErrConnection: no answer arrived. A write may or may not have happened;
	// retrying with the same idempotency key settles it safely.
	ErrConnection error = &errorKind{"connection", func(e *Error) bool { return e.Status == 0 && (e.Code == "connection_error" || e.Code == "timeout") }}
)

// CommandError is returned by Exec with Check set when the command exits
// non-zero or times out. It carries the output. errors.As also finds the
// *Error inside, whose Code is command_failed or command_timeout.
type CommandError struct {
	Err      *Error
	ExitCode *int
	Stdout   string
	Stderr   string
}

func (e *CommandError) Error() string { return e.Err.Error() }
func (e *CommandError) Unwrap() error { return e.Err }

func commandError(result *CommandResult) *CommandError {
	message := "Command timed out."
	code := "command_timeout"
	if !result.TimedOut {
		code = "command_failed"
		exit := "no exit code"
		if result.ExitCode != nil {
			exit = fmt.Sprint(*result.ExitCode)
		}
		message = "Command exited with " + exit + "."
		if tail := strings.TrimSpace(result.Stderr); tail != "" {
			if len(tail) > 500 {
				tail = tail[len(tail)-500:]
			}
			message += " " + tail
		}
	}
	return &CommandError{
		Err:      &Error{Code: code, Message: message},
		ExitCode: result.ExitCode,
		Stdout:   result.Stdout,
		Stderr:   result.Stderr,
	}
}

// errorFor reads the API's one error shape: {"error": {code, message, hint, requestId, details, retryAfterMs}}.
func errorFor(status int, body []byte, key string) *Error {
	var parsed struct {
		Error struct {
			Code         string         `json:"code"`
			Message      string         `json:"message"`
			Hint         string         `json:"hint"`
			RequestID    string         `json:"requestId"`
			Details      map[string]any `json:"details"`
			RetryAfterMs *float64       `json:"retryAfterMs"`
		} `json:"error"`
	}
	err := &Error{Status: status, IdempotencyKey: key}
	if json.Unmarshal(body, &parsed) == nil {
		err.Code = parsed.Error.Code
		err.Message = parsed.Error.Message
		err.Hint = parsed.Error.Hint
		err.RequestID = parsed.Error.RequestID
		err.Details = parsed.Error.Details
		if parsed.Error.RetryAfterMs != nil {
			err.RetryAfter = time.Duration(*parsed.Error.RetryAfterMs * float64(time.Millisecond))
		}
	} else if text := strings.TrimSpace(string(body)); text != "" {
		if len(text) > 500 {
			text = text[:500]
		}
		err.Message = text
	}
	if err.Code == "" {
		err.Code = "request_failed"
	}
	if err.Message == "" {
		err.Message = fmt.Sprintf("Runtime request failed (%d).", status)
	}
	return err
}

func missingKey() *Error {
	return &Error{
		Code:    "missing_api_key",
		Message: "No Runtime key found: RUNTIME_API_KEY is not set and this machine is not connected.",
		Hint:    "Run `npx -y withruntime login` (a browser approval; nothing to copy), set RUNTIME_API_KEY to a key from https://withruntime.com/account/keys, or pass WithAPIKey.",
	}
}

// asError returns err as an *Error when it is one.
func asError(err error) (*Error, bool) {
	var target *Error
	ok := errors.As(err, &target)
	return target, ok
}
