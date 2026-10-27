package withruntime

import (
	"context"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"time"
)

// Browsers is in private beta: an account outside the beta is refused with
// product_in_beta (403, errors.Is ErrPermissionDenied). A browser run is a
// task in plain words, done by an agent that browses in a sandbox with
// Chromium, at /v1/browsers/runs:
//
//	run, err := client.Browsers.Run(ctx, withruntime.BrowserRunOptions{Task: "Find the price of the cheapest plan on withruntime.com"})
//	fmt.Println(run.State, run.Output, run.Error)
//
// The model's key is your egress secret: ANTHROPIC_API_KEY for claude-
// models (the default, claude-sonnet-5-5), OPENAI_API_KEY for gpt- and
// o-series, GEMINI_API_KEY for gemini-. A run is billed as its sandbox's
// time, at the sandbox rates; the model's use is on your key.

// BrowserRun is one run.
type BrowserRun struct {
	ID string `json:"id"`
	// State is queued, running, done, failed or stopped.
	State    string  `json:"state"`
	Task     *string `json:"task"`
	Model    *string `json:"model"`
	StartURL *string `json:"startUrl"`
	// Output is the agent's answer, once done.
	Output *string `json:"output"`
	// Error is why it failed, and what to do.
	Error *string `json:"error"`
	Steps int     `json:"steps"`
	// URL is the page the browser ended on.
	URL       *string           `json:"url"`
	SandboxID *string           `json:"sandboxId"`
	Labels    map[string]string `json:"labels"`
	CreatedAt string            `json:"createdAt"`
	StartedAt *string           `json:"startedAt"`
	EndedAt   *string           `json:"endedAt"`
}

// BrowserRunStep is one step of a run: the page the agent saw and what it
// did.
type BrowserRunStep struct {
	// N is 0 for the page before the first step; the last is the page at the end.
	N       int     `json:"n"`
	URL     *string `json:"url"`
	Title   *string `json:"title"`
	Goal    *string `json:"goal"`
	Actions []any   `json:"actions"`
	// Frame is the page as a base64 JPEG; nil when asked without frames.
	Frame *string `json:"frame"`
	At    string  `json:"at"`
	// Seq is its place in the run's log: pass it as After.
	Seq int64 `json:"seq"`
}

// BrowserRunSteps is one page of a run's steps.
type BrowserRunSteps struct {
	Data  []BrowserRunStep `json:"data"`
	After int64            `json:"after"`
	// Ended: the run has ended, and no step comes after the last.
	Ended bool `json:"ended"`
}

// BrowserRunOptions start a run. Task is required; defaults belong to the
// API, so the SDK leaves unset fields out.
type BrowserRunOptions struct {
	// Task is what to do, in plain words; at most 16 KiB.
	Task string `json:"task"`
	// StartURL is opened before the agent's first step.
	StartURL string `json:"startUrl,omitempty"`
	// Model is a claude-, gpt-, o1, o3, o4 or gemini- model.
	Model string `json:"model,omitempty"`
	// MaxSteps is 1 to 200; 30 unless set.
	MaxSteps int `json:"maxSteps,omitempty"`
	// AllowedDomains limits the pages it opens (example.com, *.example.com).
	AllowedDomains []string          `json:"allowedDomains,omitempty"`
	Labels         map[string]string `json:"labels,omitempty"`
	IdempotencyKey string            `json:"-"`
}

// BrowserRunStepsOptions page a run's steps. Frames (each step's page) is
// true unless NoFrames; Wait (seconds, up to 30) holds the answer on the
// server for a step.
type BrowserRunStepsOptions struct {
	After    int64
	Limit    int
	NoFrames bool
	Wait     int
}

// BrowserService is client.Browsers (private beta).
type BrowserService struct {
	c *Client
	// Runs starts, reads, follows and stops runs.
	Runs *BrowserRunService
}

// BrowserRunService is client.Browsers.Runs.
type BrowserRunService struct{ c *Client }

func browserRunPath(id, verb string) string {
	return "/v1/browsers/runs/" + url.PathEscape(id) + verb
}

// Run does a task in a browser and returns the run once it has ended:
// Output once done, Error once failed.
func (s *BrowserService) Run(ctx context.Context, opts BrowserRunOptions) (*BrowserRun, error) {
	started, err := s.Runs.Create(ctx, opts)
	if err != nil {
		return nil, err
	}
	return s.Runs.Wait(ctx, started.ID)
}

// Create starts a run and returns it at once (state queued).
func (s *BrowserRunService) Create(ctx context.Context, opts BrowserRunOptions) (*BrowserRun, error) {
	var run BrowserRun
	return &run, s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/browsers/runs", body: opts, key: opts.IdempotencyKey}, &run)
}

// Get reads one run.
func (s *BrowserRunService) Get(ctx context.Context, id string) (*BrowserRun, error) {
	var run BrowserRun
	return &run, s.c.do(ctx, &call{method: http.MethodGet, path: browserRunPath(id, "")}, &run)
}

// List returns the first page of runs, newest first. limit is 1 to 100; 0
// for the API's.
func (s *BrowserRunService) List(ctx context.Context, limit int) (*Page[BrowserRun], error) {
	query := url.Values{}
	if limit > 0 {
		query.Set("limit", strconv.Itoa(limit))
	}
	return listPage[BrowserRun](ctx, s.c, "/v1/browsers/runs", query, "")
}

// Steps reads one page of a run's steps. opts may be nil.
func (s *BrowserRunService) Steps(ctx context.Context, id string, opts *BrowserRunStepsOptions) (*BrowserRunSteps, error) {
	if opts == nil {
		opts = &BrowserRunStepsOptions{}
	}
	query := url.Values{"after": {strconv.FormatInt(opts.After, 10)}}
	if opts.Limit > 0 {
		query.Set("limit", strconv.Itoa(opts.Limit))
	}
	if opts.NoFrames {
		query.Set("frames", "false")
	}
	timeout := time.Duration(0)
	if opts.Wait > 0 {
		query.Set("wait", strconv.Itoa(opts.Wait))
		// The long poll's deadline is its wait's plus a margin.
		if limit := time.Duration(opts.Wait)*time.Second + 15*time.Second; s.c.timeout < limit {
			timeout = limit
		}
	}
	var page BrowserRunSteps
	return &page, s.c.do(ctx, &call{method: http.MethodGet, path: browserRunPath(id, "/steps"), query: query, timeout: timeout}, &page)
}

// Follow calls each with every step after after (0 for all), as each comes,
// until the run ends: its recording. Each read waits on the server, not a
// timer. A false from each stops it.
func (s *BrowserRunService) Follow(ctx context.Context, id string, after int64, frames bool, each func(BrowserRunStep) bool) error {
	for {
		page, err := s.Steps(ctx, id, &BrowserRunStepsOptions{After: after, NoFrames: !frames, Wait: 30})
		if err != nil {
			return err
		}
		for _, step := range page.Data {
			if !each(step) {
				return nil
			}
		}
		after = page.After
		if page.Ended && len(page.Data) == 0 {
			return nil
		}
	}
}

// Stop stops a run; its sandbox is deleted and its steps are kept.
func (s *BrowserRunService) Stop(ctx context.Context, id string) (*BrowserRun, error) {
	var run BrowserRun
	return &run, s.c.do(ctx, &call{method: http.MethodPost, path: browserRunPath(id, ":stop"), body: map[string]any{}}, &run)
}

// Wait returns the run once it has ended (done, failed or stopped; a failed
// run is returned, not an error: read Error).
func (s *BrowserRunService) Wait(ctx context.Context, id string) (*BrowserRun, error) {
	run, err := s.Get(ctx, id)
	if err != nil || slices.Contains([]string{"done", "failed", "stopped"}, run.State) {
		return run, err
	}
	if err := s.Follow(ctx, id, 0, false, func(BrowserRunStep) bool { return true }); err != nil {
		return nil, err
	}
	return s.Get(ctx, id)
}
