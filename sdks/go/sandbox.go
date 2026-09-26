package withruntime

import (
	"context"
	"encoding/json"
	"fmt"
	"iter"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"time"
)

// SandboxService is client.Sandboxes.
type SandboxService struct{ c *Client }

// Create makes a sandbox and, unless NoWait is set, waits until it is
// running. opts may be nil. When every trial slot or the account's quota is
// taken it waits for one to free, up to the client's WaitForCapacity.
func (s *SandboxService) Create(ctx context.Context, opts *CreateOptions) (*Sandbox, error) {
	if opts == nil {
		opts = &CreateOptions{}
	}
	body, err := withExtra(opts, opts.Extra)
	if err != nil {
		return nil, err
	}
	room := s.c.waitForCapacity
	if opts.WaitForCapacity != nil {
		room = max(0, *opts.WaitForCapacity)
	}
	wait := 60
	if opts.NoWait {
		wait = 0
	}
	var info SandboxInfo
	if err := s.c.do(ctx, &call{
		method: http.MethodPost,
		path:   "/v1/sandboxes",
		body:   body,
		wait:   wait,
		key:    opts.IdempotencyKey,
		room:   room,
	}, &info); err != nil {
		return nil, err
	}
	sbx := newSandbox(s.c, info)
	if !opts.NoWait && info.State != "running" {
		if err := sbx.WaitFor(ctx, "running", 60*time.Second); err != nil {
			return sbx, err
		}
		if sbx.State() != "running" {
			return sbx, &Error{
				Code:    "start_failed",
				Message: fmt.Sprintf("Sandbox %s is %s, not running.", info.ID, sbx.State()),
				Hint:    "Read it with client.Sandboxes.Get(ctx, id); StopReason says why.",
			}
		}
	}
	return sbx, nil
}

// withExtra merges fields newer than this SDK into a request body.
func withExtra(body any, extra map[string]any) (any, error) {
	if len(extra) == 0 {
		return body, nil
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	merged := map[string]any{}
	if err := json.Unmarshal(encoded, &merged); err != nil {
		return nil, err
	}
	for key, value := range extra {
		merged[key] = value
	}
	return merged, nil
}

// GetOrCreate returns the sandbox named name, ready to use: running as it is,
// woken if paused, restarted if stopped and persistent, or created with opts
// when no sandbox has the name. Info().Reused says which. The other fields of
// opts apply only when it is created.
func (s *SandboxService) GetOrCreate(ctx context.Context, name string, opts *CreateOptions) (*Sandbox, error) {
	copied := CreateOptions{}
	if opts != nil {
		copied = *opts
	}
	copied.Name = name
	copied.GetOrCreate = true
	return s.Create(ctx, &copied)
}

// Get reconnects to a sandbox by id.
func (s *SandboxService) Get(ctx context.Context, id string) (*Sandbox, error) {
	var info SandboxInfo
	if err := s.c.do(ctx, &call{method: http.MethodGet, path: "/v1/sandboxes/" + url.PathEscape(id)}, &info); err != nil {
		return nil, err
	}
	return newSandbox(s.c, info), nil
}

// ListOptions filter a list. Every field is optional.
type ListOptions struct {
	// State keeps only these states.
	State []string
	// IncludeStopped lists stopped sandboxes too.
	IncludeStopped bool
	// Labels must all match.
	Labels map[string]string
	Name   string
	// Limit is the page size, up to 50.
	Limit int
}

// List returns the first page of live sandboxes, oldest first. Page.All
// walks every one.
func (s *SandboxService) List(ctx context.Context, opts *ListOptions) (*Page[*Sandbox], error) {
	query := url.Values{}
	if opts != nil {
		for _, state := range opts.State {
			query.Add("state", state)
		}
		if opts.IncludeStopped {
			query.Set("includeStopped", "true")
		}
		for key, value := range opts.Labels {
			query.Add("label", key+":"+value)
		}
		if opts.Name != "" {
			query.Set("name", opts.Name)
		}
		if opts.Limit > 0 {
			query.Set("limit", strconv.Itoa(opts.Limit))
		}
	}
	return s.page(ctx, query, "")
}

// All walks every sandbox a list with these options finds, across pages.
func (s *SandboxService) All(ctx context.Context, opts *ListOptions) iter.Seq2[*Sandbox, error] {
	return func(yield func(*Sandbox, error) bool) {
		page, err := s.List(ctx, opts)
		if err != nil {
			yield(nil, err)
			return
		}
		for sbx, err := range page.All(ctx) {
			if !yield(sbx, err) {
				return
			}
		}
	}
}

func (s *SandboxService) page(ctx context.Context, query url.Values, cursor string) (*Page[*Sandbox], error) {
	q := url.Values{}
	for key, values := range query {
		q[key] = values
	}
	if cursor != "" {
		q.Set("cursor", cursor)
	}
	var body struct {
		Data       []SandboxInfo `json:"data"`
		NextCursor *string       `json:"nextCursor"`
	}
	if err := s.c.do(ctx, &call{method: http.MethodGet, path: "/v1/sandboxes", query: q}, &body); err != nil {
		return nil, err
	}
	page := &Page[*Sandbox]{NextCursor: body.NextCursor}
	for _, info := range body.Data {
		page.Data = append(page.Data, newSandbox(s.c, info))
	}
	page.next = func(ctx context.Context, next string) (*Page[*Sandbox], error) {
		return s.page(ctx, query, next)
	}
	return page, nil
}

// Sandbox is a running (or stopped) sandbox. Its methods are safe for
// concurrent use.
type Sandbox struct {
	c    *Client
	mu   sync.RWMutex
	info SandboxInfo
	// Files reads and writes files in the sandbox.
	Files *Files
	// Previews shares the sandbox's ports at public HTTPS addresses.
	Previews *Previews
	// Network turns the sandbox's internet on or off, or narrows it.
	Network *SandboxNetwork
	// Interpreter runs Python and JavaScript cells whose variables persist.
	Interpreter *Interpreter
	// Desktop drives a Linux desktop in the sandbox.
	Desktop *Desktop
	Mounts  *MountService
	MCP     *SandboxMCP

	keepAlive context.CancelFunc
}

func newSandbox(c *Client, info SandboxInfo) *Sandbox {
	s := &Sandbox{c: c, info: info}
	s.Files = &Files{c: c, sandbox: s, Watches: &WatchService{sandbox: s}}
	s.Previews = &Previews{c: c, sandbox: s}
	s.Network = &SandboxNetwork{sandbox: s}
	s.Interpreter = &Interpreter{sandbox: s}
	s.Interpreter.Contexts = &InterpreterContexts{interpreter: s.Interpreter}
	s.Desktop = &Desktop{sandbox: s, Recordings: &RecordingService{sandbox: s}}
	s.Mounts = &MountService{sandbox: s}
	s.MCP = &SandboxMCP{sandbox: s}
	return s
}

// ID is the sandbox's id.
func (s *Sandbox) ID() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.info.ID
}

// Info is what the API last said about the sandbox. Refresh asks again.
func (s *Sandbox) Info() SandboxInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.info
}

// State is the sandbox's state as last read.
func (s *Sandbox) State() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.info.State
}

func (s *Sandbox) set(info SandboxInfo) {
	s.mu.Lock()
	s.info = info
	s.mu.Unlock()
}

func (s *Sandbox) path(suffix string) string {
	return "/v1/sandboxes/" + url.PathEscape(s.ID()) + suffix
}

// Refresh reads the sandbox again.
func (s *Sandbox) Refresh(ctx context.Context) error {
	var info SandboxInfo
	if err := s.c.do(ctx, &call{method: http.MethodGet, path: s.path("")}, &info); err != nil {
		return err
	}
	s.set(info)
	return nil
}

// WaitFor waits, on the server with no polling, until the sandbox reaches
// state (running, paused or stopped) or timeout passes, and returns with the
// state it read.
func (s *Sandbox) WaitFor(ctx context.Context, state string, timeout time.Duration) error {
	seconds := max(1, int(timeout.Seconds()))
	var info SandboxInfo
	if err := s.c.do(ctx, &call{
		method:  http.MethodGet,
		path:    s.path(""),
		query:   url.Values{"waitFor": {state}, "timeoutSeconds": {strconv.Itoa(seconds)}},
		timeout: timeout + time.Minute,
	}, &info); err != nil {
		return err
	}
	s.set(info)
	return nil
}

// LifecycleOptions are what every lifecycle call takes.
type LifecycleOptions struct {
	// NoWait returns once the change is accepted rather than settled.
	NoWait         bool
	IdempotencyKey string
}

func (s *Sandbox) lifecycle(ctx context.Context, verb string, opts *LifecycleOptions, body map[string]any, settle bool) error {
	if opts == nil {
		opts = &LifecycleOptions{}
	}
	wait := 60
	if opts.NoWait || !settle {
		wait = 0
	}
	if body == nil {
		body = map[string]any{}
	}
	var info SandboxInfo
	if err := s.c.do(ctx, &call{
		method: http.MethodPost,
		path:   s.path(":" + verb),
		body:   body,
		wait:   wait,
		key:    opts.IdempotencyKey,
	}, &info); err != nil {
		return err
	}
	s.set(info)
	return nil
}

// Stop stops the sandbox and ends its charges. opts may be nil. It also ends
// a KeepAlive.
func (s *Sandbox) Stop(ctx context.Context, opts *LifecycleOptions) error {
	s.StopKeepAlive()
	return s.lifecycle(ctx, "stop", opts, nil, true)
}

// Update changes its name, labels, automatic wake, idle pause, persistence or
// lifetime cost cap; nil fields stay as they are.
func (s *Sandbox) Update(ctx context.Context, settings SandboxSettings, opts *LifecycleOptions) error {
	encoded, err := json.Marshal(settings)
	if err != nil {
		return err
	}
	body := map[string]any{}
	if err := json.Unmarshal(encoded, &body); err != nil {
		return err
	}
	if settings.RemoveMaxTotalCost {
		body["maxTotalCostMicros"] = nil
	} else if settings.MaxTotalCostMicros != nil {
		body["maxTotalCostMicros"] = *settings.MaxTotalCostMicros
	}
	return s.lifecycle(ctx, "update", opts, body, false)
}

// KeepAliveOptions are how KeepAlive extends the lease.
type KeepAliveOptions struct {
	// Every is how often it checks. Default a minute; at least 10 seconds.
	Every time.Duration
	// Margin is how much lease it keeps ahead of now (a minute to an hour).
	// Default 10 minutes.
	Margin time.Duration
	// OnError receives an error an extension met; the loop carries on.
	OnError func(error)
}

// KeepAlive keeps a running sandbox's lease ahead of now, in the background,
// until Stop, StopKeepAlive or ctx ends it: every Every it extends the lease
// so that Margin remains, never more than the hour ahead the API allows.
// Running time is billed as it is used, as for any extension. A paused
// sandbox is left paused; a stopped one ends the loop.
func (s *Sandbox) KeepAlive(ctx context.Context, opts *KeepAliveOptions) {
	if opts == nil {
		opts = &KeepAliveOptions{}
	}
	every := max(10*time.Second, opts.Every)
	if opts.Every == 0 {
		every = time.Minute
	}
	margin := opts.Margin
	if margin == 0 {
		margin = 10 * time.Minute
	}
	margin = min(time.Hour, max(time.Minute, margin))
	loop, cancel := context.WithCancel(ctx)
	s.mu.Lock()
	if s.keepAlive != nil {
		s.keepAlive()
	}
	s.keepAlive = cancel
	s.mu.Unlock()
	go func() {
		defer cancel()
		for {
			if err := s.Refresh(loop); err != nil {
				if loop.Err() != nil {
					return
				}
				if opts.OnError != nil {
					opts.OnError(err)
				}
			} else {
				info := s.Info()
				if info.State == "stopped" || info.State == "stopping" {
					return
				}
				if info.State == "running" && info.ExpiresAt != nil {
					need := margin - time.Until(*info.ExpiresAt)
					if need >= time.Second {
						if err := s.Extend(loop, min(time.Hour, need.Round(time.Second)+time.Second), nil); err != nil && loop.Err() == nil && opts.OnError != nil {
							opts.OnError(err)
						}
					}
				}
			}
			if sleep(loop, every) != nil {
				return
			}
		}
	}()
}

// StopKeepAlive ends a KeepAlive, if one runs.
func (s *Sandbox) StopKeepAlive() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.keepAlive != nil {
		s.keepAlive()
		s.keepAlive = nil
	}
}

// Pause saves the sandbox's memory and files; compute billing stops. Wake
// carries on from exactly there.
func (s *Sandbox) Pause(ctx context.Context, opts *LifecycleOptions) error {
	return s.lifecycle(ctx, "pause", opts, nil, true)
}

// Wake carries on a paused sandbox, with its memory and processes, on its own
// host. timeout, when not zero, is its new lease.
func (s *Sandbox) Wake(ctx context.Context, timeout time.Duration, opts *LifecycleOptions) error {
	body := map[string]any{}
	if timeout > 0 {
		body["timeoutSeconds"] = int(timeout.Seconds())
	}
	return s.lifecycle(ctx, "wake", opts, body, true)
}

// Extend gives the sandbox more time before its lease ends, at most an hour
// ahead of now.
func (s *Sandbox) Extend(ctx context.Context, by time.Duration, opts *LifecycleOptions) error {
	return s.lifecycle(ctx, "extend", opts, map[string]any{"seconds": int(by.Seconds())}, false)
}

// SetRetention is how many days (1 to 365) a paused sandbox is kept before it
// is deleted.
func (s *Sandbox) SetRetention(ctx context.Context, days int, opts *LifecycleOptions) error {
	return s.lifecycle(ctx, "retention", opts, map[string]any{"days": days}, false)
}

// Restart starts a stopped persistent sandbox again from its disk. Memory is
// not kept.
func (s *Sandbox) Restart(ctx context.Context, opts *LifecycleOptions) error {
	return s.lifecycle(ctx, "restart", opts, nil, true)
}

// ForkOptions are a fork's fields, every one optional.
type ForkOptions struct {
	// Count is how many copies, 1 to 10. Default 1.
	Count  int               `json:"count,omitempty"`
	Name   string            `json:"name,omitempty"`
	Labels map[string]string `json:"labels,omitempty"`
	// KeepSnapshot keeps the snapshot the fork takes (it is billed as
	// storage); otherwise it is deleted when the fork ends.
	KeepSnapshot bool `json:"keepSnapshot,omitempty"`
	// Funding is what the copies run on, as for a create. Omitted, they keep
	// the source's.
	Funding        string `json:"funding,omitempty"`
	IdempotencyKey string `json:"-"`
}

// Fork starts copies of this sandbox as it is now (files, memory, running
// processes), each its own sandbox, on the same server, and answers once they
// run. A running sandbox is paused for the moment its snapshot takes. If a
// copy fails, the error's Details["startedSandboxIds"] names the copies that
// did start.
func (s *Sandbox) Fork(ctx context.Context, opts *ForkOptions) ([]*Sandbox, error) {
	if opts == nil {
		opts = &ForkOptions{}
	}
	var reply struct {
		Sandboxes []SandboxInfo `json:"sandboxes"`
	}
	if err := s.c.do(ctx, &call{
		method: http.MethodPost,
		path:   s.path(":fork"),
		body:   opts,
		wait:   60,
		key:    opts.IdempotencyKey,
	}, &reply); err != nil {
		return nil, err
	}
	copies := make([]*Sandbox, 0, len(reply.Sandboxes))
	for _, info := range reply.Sandboxes {
		copies = append(copies, newSandbox(s.c, info))
	}
	return copies, nil
}

// SnapshotOptions are a snapshot's fields, every one optional.
type SnapshotOptions struct {
	Name          string            `json:"name,omitempty"`
	Labels        map[string]string `json:"labels,omitempty"`
	RetentionDays int               `json:"retentionDays,omitempty"`
	// IdempotencyKey is the snapshot call's key.
	IdempotencyKey string `json:"-"`
}

// Snapshot keeps this sandbox's whole machine (files, memory, running
// processes) to start new sandboxes from, with CreateOptions.Snapshot. A
// running sandbox is paused for the moment it takes, then woken; a paused one
// stays paused. A sandbox with volumes cannot be snapshotted.
func (s *Sandbox) Snapshot(ctx context.Context, opts *SnapshotOptions) (*Snapshot, error) {
	if opts == nil {
		opts = &SnapshotOptions{}
	}
	if err := s.Refresh(ctx); err != nil {
		return nil, err
	}
	// Straight after a fork or a wake the sandbox is still resuming, and
	// after a pause still pausing: wait for where it is going, or a snapshot
	// of it is refused as not paused.
	switch s.State() {
	case "resuming", "starting":
		if err := s.WaitFor(ctx, "running", time.Minute); err != nil {
			return nil, err
		}
	case "pausing":
		if err := s.WaitFor(ctx, "paused", time.Minute); err != nil {
			return nil, err
		}
	}
	running := s.State() == "running"
	if running {
		if err := s.Pause(ctx, nil); err != nil {
			return nil, err
		}
	}
	var snapshot Snapshot
	err := s.c.do(ctx, &call{
		method: http.MethodPost,
		path:   s.path(":snapshot"),
		body:   opts,
		wait:   10,
		key:    opts.IdempotencyKey,
	}, &snapshot)
	if running {
		if wakeErr := s.Wake(ctx, 0, nil); err == nil && wakeErr != nil {
			return &snapshot, wakeErr
		}
	}
	if err != nil {
		return nil, err
	}
	return &snapshot, nil
}
