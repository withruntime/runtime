package withruntime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"time"
)

// ExecutionResult is one rich result of a cell: a MIME bundle (text/plain,
// text/html, image/png as base64, application/json, and
// application/vnd.runtime.table+json for a DataFrame).
type ExecutionResult struct {
	Main bool                 `json:"main"`
	Data map[string]any       `json:"data"`
	Refs map[string]ResultRef `json:"refs"`
}

// ResultRef names a result too large to travel inline; Interpreter.Result
// reads its bytes.
type ResultRef struct {
	Path   string `json:"path"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
}

// ExecutionError is a cell's exception.
type ExecutionError struct {
	Name      string `json:"name"`
	Value     string `json:"value"`
	Traceback string `json:"traceback"`
}

// Execution is a finished cell.
type Execution struct {
	ID             string `json:"id"`
	ContextID      string `json:"contextId"`
	Language       string `json:"language"`
	ExecutionCount *int   `json:"executionCount"`
	// Status is ok, error, interrupted, timeout or lost.
	Status   string            `json:"status"`
	Stdout   string            `json:"stdout"`
	Stderr   string            `json:"stderr"`
	Results  []ExecutionResult `json:"results"`
	Error    *ExecutionError   `json:"error"`
	Overflow []struct {
		Stream  string  `json:"stream"`
		Path    *string `json:"path"`
		Bytes   int64   `json:"bytes"`
		Dropped int64   `json:"dropped"`
	} `json:"overflow"`
	DurationMs     int64 `json:"durationMs"`
	ContextStarted bool  `json:"contextStarted"`
	LostBytes      int64 `json:"lostBytes"`
}

// InterpreterContext is a running interpreter whose variables persist between
// runs, like a notebook's kernel.
type InterpreterContext struct {
	ID        string `json:"id"`
	Language  string `json:"language"`
	ProcessID string `json:"processId"`
	Cwd       string `json:"cwd"`
	State     string `json:"state"`
	StartedAt int64  `json:"startedAt"`
}

// RunOptions are a cell's options, every one optional.
type RunOptions struct {
	// Language is "python" (the default) or "javascript".
	Language string
	// Context is a context id; "python" and "javascript" are started on first use.
	Context string
	Timeout time.Duration
	// With any callback, output streams as it happens.
	OnStdout func(text string)
	OnStderr func(text string)
	OnResult func(result ExecutionResult)
	OnError  func(err ExecutionError)
}

// Interpreter is sbx.Interpreter: a stateful Python and JavaScript
// interpreter in the sandbox.
type Interpreter struct {
	sandbox  *Sandbox
	Contexts *InterpreterContexts
}

func (i *Interpreter) path(suffix string) string { return i.sandbox.path("/interpreter" + suffix) }

// Run runs a cell. Variables persist between runs of the same context.
func (i *Interpreter) Run(ctx context.Context, code string, opts *RunOptions) (*Execution, error) {
	if opts == nil {
		opts = &RunOptions{}
	}
	body := map[string]any{"code": code}
	if opts.Language != "" {
		body["language"] = opts.Language
	}
	if opts.Context != "" {
		body["context"] = opts.Context
	}
	if opts.Timeout > 0 {
		body["timeoutMs"] = opts.Timeout.Milliseconds()
	}
	timeout := time.Duration(0)
	if opts.Timeout > 0 {
		timeout = opts.Timeout + time.Minute
	}
	if opts.OnStdout == nil && opts.OnStderr == nil && opts.OnResult == nil && opts.OnError == nil {
		var execution Execution
		return &execution, i.sandbox.c.do(ctx, &call{method: http.MethodPost, path: i.path(":run"), body: body, timeout: timeout}, &execution)
	}
	body["stream"] = true
	type event struct {
		K         string               `json:"k"`
		Text      string               `json:"text"`
		Main      bool                 `json:"main"`
		Data      map[string]any       `json:"data"`
		Refs      map[string]ResultRef `json:"refs"`
		Name      string               `json:"name"`
		Value     string               `json:"value"`
		Traceback string               `json:"traceback"`
		Execution json.RawMessage      `json:"execution"`
		Code      string               `json:"code"`
		Message   string               `json:"message"`
	}
	for e, err := range events[event](ctx, i.sandbox.c, &call{method: http.MethodPost, path: i.path(":run"), body: body, timeout: timeout}) {
		if err != nil {
			return nil, err
		}
		switch e.K {
		case "stdout":
			if opts.OnStdout != nil {
				opts.OnStdout(e.Text)
			}
		case "stderr":
			if opts.OnStderr != nil {
				opts.OnStderr(e.Text)
			}
		case "result":
			if opts.OnResult != nil {
				opts.OnResult(ExecutionResult{Main: e.Main, Data: e.Data, Refs: e.Refs})
			}
		case "error":
			if opts.OnError != nil {
				opts.OnError(ExecutionError{Name: e.Name, Value: e.Value, Traceback: e.Traceback})
			}
		case "execution":
			var execution Execution
			if err := json.Unmarshal(e.Execution, &execution); err != nil {
				return nil, fmt.Errorf("withruntime: unexpected execution: %w", err)
			}
			return &execution, nil
		case "failure":
			return nil, &Error{Code: e.Code, Message: e.Message}
		}
	}
	return nil, errors.New("withruntime: the interpreter stream ended without a result")
}

var resultPath = regexp.MustCompile(`^/workspace/\.runtime/interpreter/([a-z0-9][a-z0-9-]*)/out/([A-Za-z0-9][A-Za-z0-9_.-]*)$`)

// Result returns the bytes of a result too large to travel inline.
func (i *Interpreter) Result(ctx context.Context, ref ResultRef) ([]byte, error) {
	match := resultPath.FindStringSubmatch(ref.Path)
	if match == nil {
		return nil, errors.New("withruntime: not an interpreter result path")
	}
	return i.sandbox.c.bytes(ctx, &call{method: http.MethodGet, path: i.path("/contexts/" + match[1] + "/results/" + match[2]), accept: "application/octet-stream"})
}

// InterpreterContexts is sbx.Interpreter.Contexts.
type InterpreterContexts struct{ interpreter *Interpreter }

// ContextOptions are a new context's fields, every one optional.
type ContextOptions struct {
	ID       string            `json:"id,omitempty"`
	Language string            `json:"language,omitempty"`
	Cwd      string            `json:"cwd,omitempty"`
	Env      map[string]string `json:"env,omitempty"`
}

// List returns the running contexts.
func (c *InterpreterContexts) List(ctx context.Context) ([]InterpreterContext, error) {
	var body struct {
		Data []InterpreterContext `json:"data"`
	}
	err := c.interpreter.sandbox.c.do(ctx, &call{method: http.MethodGet, path: c.interpreter.path("/contexts")}, &body)
	return body.Data, err
}

// Create starts a context.
func (c *InterpreterContexts) Create(ctx context.Context, opts *ContextOptions) (*InterpreterContext, error) {
	if opts == nil {
		opts = &ContextOptions{}
	}
	var context InterpreterContext
	return &context, c.interpreter.sandbox.c.do(ctx, &call{method: http.MethodPost, path: c.interpreter.path("/contexts"), body: opts}, &context)
}

// Restart starts a context afresh; its variables are lost.
func (c *InterpreterContexts) Restart(ctx context.Context, id string) (*InterpreterContext, error) {
	var context InterpreterContext
	return &context, c.interpreter.sandbox.c.do(ctx, &call{method: http.MethodPost, path: c.interpreter.path("/contexts/" + url.PathEscape(id) + ":restart"), body: map[string]any{}}, &context)
}

// Interrupt stops the cell a context is running, as Ctrl-C would.
func (c *InterpreterContexts) Interrupt(ctx context.Context, id string) (bool, error) {
	var reply struct {
		Interrupted bool `json:"interrupted"`
	}
	err := c.interpreter.sandbox.c.do(ctx, &call{method: http.MethodPost, path: c.interpreter.path("/contexts/" + url.PathEscape(id) + ":interrupt"), body: map[string]any{}}, &reply)
	return reply.Interrupted, err
}

// Remove ends a context.
func (c *InterpreterContexts) Remove(ctx context.Context, id string) (bool, error) {
	var reply struct {
		Deleted bool `json:"deleted"`
	}
	err := c.interpreter.sandbox.c.do(ctx, &call{method: http.MethodDelete, path: c.interpreter.path("/contexts/" + url.PathEscape(id))}, &reply)
	return reply.Deleted, err
}
