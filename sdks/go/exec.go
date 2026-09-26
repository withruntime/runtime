package withruntime

import (
	"context"
	"encoding/base64"
	"iter"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// ExecOptions are a command's options, every one optional.
type ExecOptions struct {
	// Cwd is the working directory. Default /workspace.
	Cwd string
	// Env is merged over the sandbox's environment. Put secrets here, never
	// in the command: it is never echoed back.
	Env map[string]string
	// Stdin is given to standard input, then closed.
	Stdin []byte
	// Timeout is the command's limit. Default 60 seconds; up to 24 hours. A
	// timeout is a result (TimedOut), not an error.
	Timeout time.Duration
	// OnStdout and OnStderr receive output as it happens. Either one, or a
	// Timeout over 60 seconds, streams the command; the result then keeps
	// everything it printed.
	OnStdout func(text string)
	OnStderr func(text string)
	// Check returns a *CommandError when the exit code is not 0 or the
	// command timed out.
	Check          bool
	IdempotencyKey string
}

type command struct {
	shell string
	argv  []string
}

func commandBody(cmd command, opts *ExecOptions, defaultTimeout time.Duration) map[string]any {
	body := map[string]any{}
	if cmd.argv != nil {
		body["argv"] = cmd.argv
	} else {
		body["command"] = cmd.shell
	}
	if opts.Cwd != "" {
		body["cwd"] = opts.Cwd
	}
	if opts.Env != nil {
		body["env"] = opts.Env
	}
	if opts.Stdin != nil {
		body["stdinBase64"] = base64.StdEncoding.EncodeToString(opts.Stdin)
	}
	timeout := opts.Timeout
	if timeout == 0 {
		timeout = defaultTimeout
	}
	if timeout > 0 {
		body["timeoutMs"] = timeout.Milliseconds()
	}
	return body
}

// Exec runs a command under `bash -c` and returns its exit code and output.
// opts may be nil.
func (s *Sandbox) Exec(ctx context.Context, cmd string, opts *ExecOptions) (*CommandResult, error) {
	return s.exec(ctx, command{shell: cmd}, opts)
}

// ExecArgv runs a program directly, with no shell: what you want for
// untrusted arguments.
func (s *Sandbox) ExecArgv(ctx context.Context, argv []string, opts *ExecOptions) (*CommandResult, error) {
	return s.exec(ctx, command{argv: append([]string{}, argv...)}, opts)
}

// httpTimeout is a command's deadline plus a minute for the answer to come back.
func httpTimeout(opts *ExecOptions) time.Duration {
	if opts.Timeout == 0 {
		return 0
	}
	return opts.Timeout + time.Minute
}

func (s *Sandbox) exec(ctx context.Context, cmd command, opts *ExecOptions) (*CommandResult, error) {
	if opts == nil {
		opts = &ExecOptions{}
	}
	var result CommandResult
	if opts.OnStdout == nil && opts.OnStderr == nil && opts.Timeout <= time.Minute {
		if err := s.c.do(ctx, &call{
			method:  http.MethodPost,
			path:    s.path(":exec"),
			body:    commandBody(cmd, opts, 0),
			key:     opts.IdempotencyKey,
			timeout: httpTimeout(opts),
		}, &result); err != nil {
			return nil, err
		}
	} else {
		var stdout, stderr strings.Builder
		dropped := false
		for event, err := range s.stream(ctx, cmd, opts) {
			if err != nil {
				return nil, err
			}
			switch event.Type {
			case "start":
				result.ProcessID = event.ProcessID
			case "stdout":
				stdout.WriteString(event.Data)
				if opts.OnStdout != nil {
					opts.OnStdout(event.Data)
				}
			case "stderr":
				stderr.WriteString(event.Data)
				if opts.OnStderr != nil {
					opts.OnStderr(event.Data)
				}
			case "truncated":
				dropped = true
			case "exit":
				result.ExitCode = event.ExitCode
				result.TimedOut = event.TimedOut
				result.DurationMs = event.DurationMs
			}
		}
		result.Stdout = stdout.String()
		result.Stderr = stderr.String()
		// A truncated event does not say which stream lost bytes, so both
		// flags carry it.
		result.StdoutTruncated = dropped
		result.StderrTruncated = dropped
	}
	if opts.Check && (result.TimedOut || result.ExitCode == nil || *result.ExitCode != 0) {
		return &result, commandError(&result)
	}
	return &result, nil
}

// ExecStream runs a command and yields its events as they happen: start,
// stdout, stderr, exit. It resumes by itself when the server ends a long
// stream, so it never drops output.
//
//	for event, err := range sbx.ExecStream(ctx, "npm test", nil) {
//		if err != nil {
//			return err
//		}
//		fmt.Print(event.Data)
//	}
func (s *Sandbox) ExecStream(ctx context.Context, cmd string, opts *ExecOptions) iter.Seq2[OutputEvent, error] {
	if opts == nil {
		opts = &ExecOptions{}
	}
	return s.stream(ctx, command{shell: cmd}, opts)
}

func (s *Sandbox) stream(ctx context.Context, cmd command, opts *ExecOptions) iter.Seq2[OutputEvent, error] {
	return func(yield func(OutputEvent, error) bool) {
		body := commandBody(cmd, opts, 24*time.Hour)
		body["stream"] = true
		timeout := 24 * time.Hour
		if opts.Timeout > 0 {
			timeout = opts.Timeout + time.Minute
		}
		for event, err := range events[OutputEvent](ctx, s.c, &call{
			method:  http.MethodPost,
			path:    s.path(":exec"),
			body:    body,
			key:     opts.IdempotencyKey,
			timeout: timeout,
		}) {
			if err != nil {
				yield(OutputEvent{}, err)
				return
			}
			switch event.Type {
			case "continue":
				for followed, err := range s.follow(ctx, event.ProcessID, event.Cursor) {
					if !yield(followed, err) || err != nil {
						return
					}
				}
				return
			case "error":
				yield(OutputEvent{}, streamError(event))
				return
			}
			if !yield(event, nil) {
				return
			}
		}
	}
}

func streamError(event OutputEvent) *Error {
	failure := &Error{Code: "stream_failed", Message: "The output stream failed."}
	if event.Error != nil {
		failure.Code = event.Error.Code
		failure.Message = event.Error.Message
		failure.RequestID = event.Error.RequestID
	}
	return failure
}

// follow yields a process's output events from cursor until it exits, across
// the server's stream slices.
func (s *Sandbox) follow(ctx context.Context, processID string, cursor int64) iter.Seq2[OutputEvent, error] {
	return func(yield func(OutputEvent, error) bool) {
		for {
			resumed := false
			for event, err := range events[OutputEvent](ctx, s.c, &call{
				method:  http.MethodGet,
				path:    s.path("/processes/" + url.PathEscape(processID) + "/output"),
				query:   url.Values{"cursor": {strconv.FormatInt(cursor, 10)}, "follow": {"true"}},
				timeout: 3 * time.Minute,
			}) {
				if err != nil {
					yield(OutputEvent{}, err)
					return
				}
				switch event.Type {
				case "continue":
					cursor = event.Cursor
					resumed = true
				case "stdout", "stderr":
					cursor = event.Offset + int64(len(event.Data))
				case "error":
					yield(OutputEvent{}, streamError(event))
					return
				}
				if resumed {
					break
				}
				if !yield(event, nil) || event.Type == "exit" {
					return
				}
			}
			if !resumed {
				return
			}
		}
	}
}

// SpawnOptions are a background process's options, every one optional.
type SpawnOptions struct {
	Cwd     string
	Env     map[string]string
	Timeout time.Duration
	// Stdin is given once, then closed. PipeStdin keeps input open for Write
	// instead.
	Stdin     []byte
	PipeStdin bool
	// PTY gives the process a terminal of this size.
	PTY            *PTY
	IdempotencyKey string
}

// PTY is a terminal's size.
type PTY struct {
	Cols int `json:"cols,omitempty"`
	Rows int `json:"rows,omitempty"`
}

// Spawn starts a background process (a server, a watcher, a REPL) under
// `bash -c` and returns at once. It outlives your connection; Process gets it
// back by id.
func (s *Sandbox) Spawn(ctx context.Context, cmd string, opts *SpawnOptions) (*Process, error) {
	return s.spawn(ctx, command{shell: cmd}, opts)
}

// SpawnArgv starts a background process with no shell.
func (s *Sandbox) SpawnArgv(ctx context.Context, argv []string, opts *SpawnOptions) (*Process, error) {
	return s.spawn(ctx, command{argv: append([]string{}, argv...)}, opts)
}

func (s *Sandbox) spawn(ctx context.Context, cmd command, opts *SpawnOptions) (*Process, error) {
	if opts == nil {
		opts = &SpawnOptions{}
	}
	body := commandBody(cmd, &ExecOptions{Cwd: opts.Cwd, Env: opts.Env, Timeout: opts.Timeout}, 0)
	if opts.PipeStdin {
		body["stdinMode"] = "pipe"
	} else if opts.Stdin != nil {
		body["stdinBase64"] = base64.StdEncoding.EncodeToString(opts.Stdin)
	}
	if opts.PTY != nil {
		body["pty"] = opts.PTY
	}
	var info ProcessInfo
	if err := s.c.do(ctx, &call{
		method: http.MethodPost,
		path:   s.path("/processes"),
		body:   body,
		key:    opts.IdempotencyKey,
	}, &info); err != nil {
		return nil, err
	}
	return &Process{sandbox: s, Info: info, inputOffset: info.StdinOffset}, nil
}

// Processes lists the sandbox's background processes.
func (s *Sandbox) Processes(ctx context.Context) ([]ProcessInfo, error) {
	var body struct {
		Data []ProcessInfo `json:"data"`
	}
	if err := s.c.do(ctx, &call{method: http.MethodGet, path: s.path("/processes")}, &body); err != nil {
		return nil, err
	}
	return body.Data, nil
}

// Process gets a background process back by id.
func (s *Sandbox) Process(ctx context.Context, id string) (*Process, error) {
	var info ProcessInfo
	if err := s.c.do(ctx, &call{method: http.MethodGet, path: s.path("/processes/" + url.PathEscape(id))}, &info); err != nil {
		return nil, err
	}
	return &Process{sandbox: s, Info: info, inputOffset: info.StdinOffset}, nil
}

// Process is a background process: its output, its input, its end. Use one
// Process from one goroutine at a time.
type Process struct {
	sandbox     *Sandbox
	Info        ProcessInfo
	inputOffset int64
}

// ID is the process's id.
func (p *Process) ID() string { return p.Info.ID }

func (p *Process) path(suffix string) string {
	return p.sandbox.path("/processes/" + url.PathEscape(p.Info.ID) + suffix)
}

// Output yields every output event from cursor (0 for the start) until the
// process exits.
func (p *Process) Output(ctx context.Context, cursor int64) iter.Seq2[OutputEvent, error] {
	return p.sandbox.follow(ctx, p.Info.ID, cursor)
}

// Wait waits for the process to end and returns its result.
func (p *Process) Wait(ctx context.Context) (*CommandResult, error) {
	var stdout, stderr strings.Builder
	result := &CommandResult{ProcessID: p.Info.ID}
	for event, err := range p.Output(ctx, 0) {
		if err != nil {
			return nil, err
		}
		switch event.Type {
		case "stdout":
			stdout.WriteString(event.Data)
		case "stderr":
			stderr.WriteString(event.Data)
		case "truncated":
			result.StdoutTruncated, result.StderrTruncated = true, true
		case "exit":
			result.ExitCode = event.ExitCode
			result.TimedOut = event.TimedOut
			result.DurationMs = event.DurationMs
		}
	}
	result.Stdout, result.Stderr = stdout.String(), stderr.String()
	return result, nil
}

// Write sends input. Offsets are tracked for you, so a retried write is never
// typed twice. eof closes the input after it.
func (p *Process) Write(ctx context.Context, data []byte, eof bool) error {
	sent := 0
	for {
		body := map[string]any{
			"base64": base64.StdEncoding.EncodeToString(data[sent:]),
			"offset": p.inputOffset,
		}
		if eof {
			body["eof"] = true
		}
		var reply struct {
			Offset int64 `json:"offset"`
		}
		if err := p.sandbox.c.do(ctx, &call{method: http.MethodPost, path: p.path(":write"), body: body}, &reply); err != nil {
			return err
		}
		progress := reply.Offset - p.inputOffset
		sent += int(progress)
		p.inputOffset = reply.Offset
		if sent >= len(data) {
			return nil
		}
		if progress <= 0 {
			return &Error{Code: "write_stalled", Message: "The process took none of the input.", Hint: "Check that its input is still open (Info.StdinOpen)."}
		}
	}
}

// Kill sends a signal: SIGTERM, SIGKILL, SIGINT, SIGHUP, SIGQUIT, SIGUSR1 or
// SIGUSR2.
func (p *Process) Kill(ctx context.Context, signal string) error {
	if signal == "" {
		signal = "SIGTERM"
	}
	return p.sandbox.c.do(ctx, &call{method: http.MethodPost, path: p.path(":signal"), body: map[string]any{"signal": signal}}, nil)
}

// Resize changes a PTY process's terminal size.
func (p *Process) Resize(ctx context.Context, cols, rows int) error {
	return p.sandbox.c.do(ctx, &call{method: http.MethodPost, path: p.path(":resize"), body: map[string]any{"cols": cols, "rows": rows}}, nil)
}

// Refresh reads the process again.
func (p *Process) Refresh(ctx context.Context) error {
	return p.sandbox.c.do(ctx, &call{method: http.MethodGet, path: p.path("")}, &p.Info)
}
