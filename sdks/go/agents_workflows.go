package withruntime

import (
	"context"
	"iter"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

/* Workflows: many sessions in phases. A workflow is data, not code: each
   phase names an agent (or uses the workflow's), an input template
   ({{input}}, {{item}}, {{index}}, and {{<phase>}} for an earlier phase's
   results) and the items it fans out over, a list or an earlier phase's
   result split as JSON or lines. A phase waits for every phase before it,
   unless Pipeline is set: then each item starts as soon as its own item in
   the source phase ends. MaxSessions, MaxConcurrent and MaxDollars bound
   it; past MaxDollars it fails with reason budget. It advances inside the
   database as each step ends, with no process of its own to pay for. */

// AgentWorkflowService is client.Agents.Workflows.
type AgentWorkflowService struct{ c *Client }

// AgentWorkflowSpec is a workflow to run.
type AgentWorkflowSpec struct {
	// Agent is the agent (id or name) of every phase that names none.
	Agent string `json:"agent,omitempty"`
	Name  string `json:"name,omitempty"`
	// Input is what {{input}} stands for in each phase's template.
	Input  string               `json:"input,omitempty"`
	Phases []AgentWorkflowPhase `json:"phases"`
	// MaxSessions caps the sessions it starts (default 100, at most 1000).
	MaxSessions int `json:"maxSessions,omitempty"`
	// MaxConcurrent caps its sessions open at once (default 20, at most 200).
	MaxConcurrent int `json:"maxConcurrent,omitempty"`
	// MaxDollars caps its sessions' cost (default 10, at most 10000).
	MaxDollars float64           `json:"maxDollars,omitempty"`
	Labels     map[string]string `json:"labels,omitempty"`
}

// AgentWorkflowPhase is one phase: one session per item, or one session
// when Each is nil.
type AgentWorkflowPhase struct {
	Name  string `json:"name"`
	Agent string `json:"agent,omitempty"`
	Input string `json:"input"`
	// Each is a list of items (1 to 1000), or an AgentWorkflowSource.
	Each any `json:"each,omitempty"`
	// Pipeline starts each item as its own item in the source phase ends,
	// instead of waiting for every phase before it.
	Pipeline bool `json:"pipeline,omitempty"`
}

// AgentWorkflowSource fans a phase out over an earlier phase's result.
type AgentWorkflowSource struct {
	From string `json:"from"`
	// Split is json (an array's items) or lines.
	Split string `json:"split,omitempty"`
}

// AgentWorkflowProgress is one phase's progress.
type AgentWorkflowProgress struct {
	Name    string `json:"name"`
	AgentID string `json:"agentId"`
	Total   int    `json:"total"`
	// Ready is false while its items are not all known yet.
	Ready   bool `json:"ready"`
	Pending int  `json:"pending"`
	Running int  `json:"running"`
	Done    int  `json:"done"`
	Failed  int  `json:"failed"`
}

// AgentWorkflowInfo is a workflow as the API returns it.
type AgentWorkflowInfo struct {
	ID   string  `json:"id"`
	Name *string `json:"name"`
	// State is running, done, failed or stopped.
	State string `json:"state"`
	// Reason says why it ended: done, failed, stopped, budget, quota,
	// parent_ended and others.
	Reason *string `json:"reason"`
	// Result is one step's result as it is, or a JSON array of the last
	// phase's results.
	Result          *string        `json:"result"`
	ParentSessionID *string        `json:"parentSessionId"`
	Spec            map[string]any `json:"spec"`
	MaxSessions     int            `json:"maxSessions"`
	MaxConcurrent   int            `json:"maxConcurrent"`
	MaxDollars      float64        `json:"maxDollars"`
	Started         int            `json:"started"`
	// Version increases on every change.
	Version   int64                   `json:"version"`
	Labels    map[string]string       `json:"labels"`
	Phases    []AgentWorkflowProgress `json:"phases"`
	Cost      AgentCost               `json:"cost"`
	CreatedAt time.Time               `json:"createdAt"`
	UpdatedAt time.Time               `json:"updatedAt"`
	EndedAt   *time.Time              `json:"endedAt"`
}

// Ended reports whether it is done, failed or stopped.
func (w AgentWorkflowInfo) Ended() bool { return w.State != "running" }

// AgentWorkflowStep is one item of one phase, and the session it started.
type AgentWorkflowStep struct {
	Phase    string  `json:"phase"`
	Item     int     `json:"item"`
	ItemText *string `json:"itemText"`
	// State is pending, running, done, failed, stopped or skipped.
	State     string     `json:"state"`
	Reason    *string    `json:"reason"`
	Result    *string    `json:"result"`
	SessionID *string    `json:"sessionId"`
	CreatedAt time.Time  `json:"createdAt"`
	StartedAt *time.Time `json:"startedAt"`
	EndedAt   *time.Time `json:"endedAt"`
}

// AgentWorkflowListOptions filter a list, every field optional.
type AgentWorkflowListOptions struct {
	States []string
	Cursor string
	Limit  int
}

// AgentWorkflow is a handle to one workflow.
type AgentWorkflow struct {
	c    *Client
	info AgentWorkflowInfo
}

// RunAgentWorkflowOptions are Run's optional fields.
type RunAgentWorkflowOptions struct {
	// IdempotencyKey: made for you when empty, and kept across retries.
	IdempotencyKey string
}

// Run starts a workflow now. An invalid spec is refused 400
// invalid_request, its details naming the field.
func (s *AgentWorkflowService) Run(ctx context.Context, spec AgentWorkflowSpec, opts *RunAgentWorkflowOptions) (*AgentWorkflow, error) {
	key := ""
	if opts != nil {
		key = opts.IdempotencyKey
	}
	var info AgentWorkflowInfo
	if err := s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/agents/workflows", body: spec, key: key}, &info); err != nil {
		return nil, err
	}
	return &AgentWorkflow{c: s.c, info: info}, nil
}

// Get reads one workflow.
func (s *AgentWorkflowService) Get(ctx context.Context, id string) (*AgentWorkflow, error) {
	w := &AgentWorkflow{c: s.c, info: AgentWorkflowInfo{ID: id}}
	if err := w.Refresh(ctx); err != nil {
		return nil, err
	}
	return w, nil
}

// List returns the first page of workflows, newest first (opts may be nil).
func (s *AgentWorkflowService) List(ctx context.Context, opts *AgentWorkflowListOptions) (*Page[AgentWorkflowInfo], error) {
	query := url.Values{}
	cursor := ""
	if opts != nil {
		for _, state := range opts.States {
			query.Add("state", state)
		}
		setQuery(query, "limit", itoa(opts.Limit))
		cursor = opts.Cursor
	}
	return nextPage[AgentWorkflowInfo](ctx, s.c, "/v1/agents/workflows", query, cursor)
}

// All walks every workflow a list with these options finds, across pages.
func (s *AgentWorkflowService) All(ctx context.Context, opts *AgentWorkflowListOptions) iter.Seq2[AgentWorkflowInfo, error] {
	return walk(ctx, func() (*Page[AgentWorkflowInfo], error) { return s.List(ctx, opts) })
}

// ID is the workflow's id.
func (w *AgentWorkflow) ID() string { return w.info.ID }

// Info is the workflow as last read.
func (w *AgentWorkflow) Info() AgentWorkflowInfo { return w.info }

func (w *AgentWorkflow) path(suffix string) string {
	return "/v1/agents/workflows/" + url.PathEscape(w.info.ID) + suffix
}

// Refresh reads the workflow again.
func (w *AgentWorkflow) Refresh(ctx context.Context) error {
	var info AgentWorkflowInfo
	if err := w.c.do(ctx, &call{method: http.MethodGet, path: w.path("")}, &info); err != nil {
		return err
	}
	w.info = info
	return nil
}

// poll returns the workflow once its version passes after, it ends, or wait
// seconds pass.
func (w *AgentWorkflow) poll(ctx context.Context, after int64) (*AgentWorkflowInfo, error) {
	timeout := time.Duration(0)
	if limit := agentEventsWait*time.Second + 15*time.Second; w.c.timeout < limit {
		timeout = limit
	}
	var info AgentWorkflowInfo
	err := w.c.do(ctx, &call{
		method:  http.MethodGet,
		path:    w.path(""),
		query:   url.Values{"after": {strconv.FormatInt(after, 10)}, "wait": {strconv.Itoa(agentEventsWait)}},
		timeout: timeout,
	}, &info)
	return &info, err
}

// Follow yields each change after version after (0: from the start) as it
// happens, waiting on the server, and ends once the workflow has ended.
// Breaking out of the loop stops it.
func (w *AgentWorkflow) Follow(ctx context.Context, after int64) iter.Seq2[AgentWorkflowInfo, error] {
	return func(yield func(AgentWorkflowInfo, error) bool) {
		for {
			now, err := w.poll(ctx, after)
			if err != nil {
				yield(AgentWorkflowInfo{}, err)
				return
			}
			w.info = *now
			if now.Version > after {
				after = now.Version
				if !yield(*now, nil) {
					return
				}
			}
			if now.Ended() {
				return
			}
		}
	}
}

// Wait waits until the workflow has ended and returns it, Result set; a
// failed one is returned, not an error. It waits on the server, with no
// polling; ctx bounds it.
func (w *AgentWorkflow) Wait(ctx context.Context) (*AgentWorkflowInfo, error) {
	if err := w.Refresh(ctx); err != nil {
		return nil, err
	}
	for !w.info.Ended() {
		now, err := w.poll(ctx, w.info.Version)
		if err != nil {
			return nil, err
		}
		w.info = *now
	}
	info := w.info
	return &info, nil
}

// Steps returns the first page of its steps in phase and item order;
// states filter them (pending, running, done, failed, stopped, skipped).
func (w *AgentWorkflow) Steps(ctx context.Context, states ...string) (*Page[AgentWorkflowStep], error) {
	query := url.Values{}
	for _, state := range states {
		query.Add("state", state)
	}
	return nextPage[AgentWorkflowStep](ctx, w.c, w.path("/steps"), query, "")
}

// Stop stops it: nothing more starts, and its open sessions are asked to
// stop. An ended workflow is returned as it is.
func (w *AgentWorkflow) Stop(ctx context.Context) (*AgentWorkflowInfo, error) {
	var info AgentWorkflowInfo
	if err := w.c.do(ctx, &call{method: http.MethodPost, path: w.path("/stop"), body: map[string]any{}}, &info); err != nil {
		return nil, err
	}
	w.info = info
	return &info, nil
}
