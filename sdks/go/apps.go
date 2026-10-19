package withruntime

import (
	"context"
	"encoding/json"
	"fmt"
	"iter"
	"net/http"
	"net/url"
	"slices"
	"time"
)

// Apps and Functions are in private beta: an account outside the beta is
// refused with product_in_beta (403, errors.Is ErrPermissionDenied). They
// are one client at two paths: an App can keep copies awake (MinCopies), a
// Function always sleeps when idle.

// ResourceError is why a resource failed.
type ResourceError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// App is an App or a Function: servers of one image or build, woken by
// requests. A deployment's completion follows its own record (AppDeploy),
// not the App's state.
type App struct {
	ID     string            `json:"id"`
	Name   *string           `json:"name"`
	Labels map[string]string `json:"labels"`
	// State is waiting, live, failed, deleting or deleted.
	State       string `json:"state"`
	MinCopies   int    `json:"minCopies"`
	MaxCopies   int    `json:"maxCopies"`
	Concurrency int    `json:"concurrency"`
	Spares      int    `json:"spares"`
	VCPU        int    `json:"vcpu"`
	MemoryMiB   int    `json:"memoryMiB"`
	Port        int    `json:"port"`
	HealthPath  string `json:"healthPath,omitempty"`
	// ReleaseWatch is what Runtime does when a new version's errors or
	// speed get clearly worse in its first 15 minutes: alert (tell the
	// owners), rollback (go back and tell them) or off.
	ReleaseWatch    string         `json:"releaseWatch,omitempty"`
	CreatedAt       int64          `json:"createdAt"`
	UpdatedAt       int64          `json:"updatedAt"`
	DeletedAt       *int64         `json:"deletedAt"`
	Error           *ResourceError `json:"error"`
	LiveVersion     *int           `json:"liveVersion"`
	PreviousVersion *int           `json:"previousVersion"`
}

// CreateAppOptions are an App's or a Function's settings. Defaults belong
// to the API, so the SDK leaves unset fields out.
type CreateAppOptions struct {
	// Name is up to 128 letters, digits, dots, dashes or underscores,
	// alphanumeric first.
	Name string `json:"name,omitempty"`
	// Labels: at most 32, each value at most 256 characters.
	Labels map[string]string `json:"labels,omitempty"`
	// MinCopies is how many copies an App keeps awake: 0 unless set, no
	// greater than MaxCopies. Only Apps have it: leave it nil for a Function.
	MinCopies *int `json:"minCopies,omitempty"`
	// MaxCopies is required, 1 to 1000: the bound on awake copies.
	MaxCopies int `json:"maxCopies"`
	// VCPU is required, 1 to 16.
	VCPU int `json:"vcpu"`
	// MemoryMiB is required, 128 to 65536.
	MemoryMiB int `json:"memoryMiB"`
	// Concurrency is 1 to 10000 requests per copy; 100 unless set.
	Concurrency int `json:"concurrency,omitempty"`
	// Spares is 0 to 16 copies kept ready; 2 unless set.
	Spares *int `json:"spares,omitempty"`
	// Port is 1 to 65535; 8080 unless set.
	Port int `json:"port,omitempty"`
	// HealthPath starts with /, no whitespace, at most 256 characters.
	// Leave it empty to check whether the port accepts connections.
	HealthPath string `json:"healthPath,omitempty"`
	// ReleaseWatch is alert unless set; rollback is opted into.
	ReleaseWatch   string `json:"releaseWatch,omitempty"`
	IdempotencyKey string `json:"-"`
}

// UpdateAppOptions change settings in place; nil fields stay as they are.
type UpdateAppOptions struct {
	Name *string `json:"name,omitempty"`
	// ClearName removes the name.
	ClearName bool `json:"-"`
	// Labels replaces every label; an empty, non-nil map removes them all.
	Labels map[string]string `json:"labels,omitempty"`
	// MinCopies is for Apps only.
	MinCopies      *int    `json:"minCopies,omitempty"`
	MaxCopies      *int    `json:"maxCopies,omitempty"`
	Concurrency    *int    `json:"concurrency,omitempty"`
	Spares         *int    `json:"spares,omitempty"`
	VCPU           *int    `json:"vcpu,omitempty"`
	MemoryMiB      *int    `json:"memoryMiB,omitempty"`
	Port           *int    `json:"port,omitempty"`
	HealthPath     *string `json:"healthPath,omitempty"`
	ReleaseWatch   *string `json:"releaseWatch,omitempty"`
	IdempotencyKey string  `json:"-"`
}

// AppDeployError is why a deploy failed or was superseded.
type AppDeployError struct {
	// Code is deploy_build_failed, deploy_health_failed or deploy_superseded.
	Code       string `json:"code"`
	Message    string `json:"message"`
	Hint       string `json:"hint"`
	LastOutput string `json:"lastOutput"`
}

// AppDeploy is one deploy: a new version on its way to live.
type AppDeploy struct {
	ID      string `json:"id"`
	Version int    `json:"version"`
	URL     string `json:"url"`
	// State is building, warming, switching, live, failed or superseded.
	State string `json:"state"`
	// Error is set once it failed or was superseded.
	Error *AppDeployError `json:"error,omitempty"`
}

// WaitOptions bound a wait that follows a resource or a deploy.
type WaitOptions struct {
	// Timeout covers the write, its retries and every read: 5 minutes when
	// 0, only the context's deadline when negative.
	Timeout time.Duration
	// Poll is the pause between reads: 250 ms when 0.
	Poll time.Duration
	// IdempotencyKey is the write's key, made for you when empty. A wait
	// that timed out can be retried after a restart with the same key.
	IdempotencyKey string
}

// DeployAppOptions deploy exactly one of Image or Build.
type DeployAppOptions struct {
	// Image is an image of this account (id, name, name:tag or
	// name@version), ready; the version records its id.
	Image string `json:"image,omitempty"`
	// Build is a succeeded build's id.
	Build string            `json:"build,omitempty"`
	Env   map[string]string `json:"env,omitempty"`
	// KeepEnv carries the last deploy's environment, still sealed. With Env,
	// that environment with Env's names set: change one value without
	// sending the rest (needs a key that may reveal the App's secrets,
	// secrets_reveal; else 403). For a build: only one a push to the
	// production branch made, from the repository the environment came
	// with. For an image: only from a key that may reveal the App's secrets,
	// and only an environment named with an image deploy. Otherwise refused
	// with keep_env_refused (409).
	KeepEnv    bool   `json:"keepEnv,omitempty"`
	Port       int    `json:"port,omitempty"`
	HealthPath string `json:"healthPath,omitempty"`
	// Wait returns the deploy once live, failed or superseded, with its URL
	// and version or its failure.
	Wait        bool `json:"-"`
	WaitOptions `json:"-"`
}

// AppVersion is one deployed version.
type AppVersion struct {
	Version  int  `json:"version"`
	Live     bool `json:"live"`
	Previous bool `json:"previous"`
	Saved    bool `json:"saved"`
	// Deploy is its deploy's id, for GetDeploy.
	Deploy string `json:"deploy"`
	// Build is the build it was deployed from, nil for an image.
	Build *string `json:"build"`
}

// AppCopy is one running copy.
type AppCopy struct {
	ID      string `json:"id"`
	Version int    `json:"version"`
	Region  string `json:"region"`
	// State is starting, serving, draining, frozen or parked.
	State string `json:"state"`
	Since int64  `json:"since"`
}

// AppGetOptions let the server hold the answer until the resource reaches
// WaitFor, for up to TimeoutSeconds (1 to 60; 30 unless set). Check the
// returned state.
type AppGetOptions struct {
	WaitFor        string
	TimeoutSeconds int
}

// DeployGetOptions are AppGetOptions for a deploy: WaitFor is a deploy state.
type DeployGetOptions = AppGetOptions

// AppListOptions filter a list, every field optional. State defaults to
// waiting, live and failed; every label (key:value) must match.
type AppListOptions struct {
	Name  string
	Label []string
	State []string
	// Limit is 1 to 100; 50 unless set.
	Limit int
}

// DeleteAppOptions: with Wait, Delete returns once the resource is deleted.
type DeleteAppOptions struct {
	Wait bool
	WaitOptions
}

// RollbackOptions: with Wait, Rollback returns once its deploy ends.
type RollbackOptions = DeleteAppOptions

// AppService is client.Apps or client.Functions (private beta).
type AppService struct {
	c    *Client
	base string
	// apps: only Apps keep copies awake.
	apps bool
}

func (s *AppService) path(id string, verb string) string {
	return s.base + "/" + url.PathEscape(id) + verb
}

func (s *AppService) refuseMinCopies(minCopies *int) error {
	if s.apps || minCopies == nil {
		return nil
	}
	return &Error{
		Code:    "invalid_request",
		Message: "Only Apps can keep copies awake; a Function has no MinCopies.",
		Hint:    "Leave MinCopies nil, or create an App; nothing was sent.",
		Details: map[string]any{"field": "minCopies"},
	}
}

// Create makes one waiting for its first version: deploy to it next.
func (s *AppService) Create(ctx context.Context, opts CreateAppOptions) (*App, error) {
	if err := s.refuseMinCopies(opts.MinCopies); err != nil {
		return nil, err
	}
	var app App
	return &app, s.c.do(ctx, &call{method: http.MethodPost, path: s.base, body: opts, key: opts.IdempotencyKey}, &app)
}

// Get reads one. opts may be nil.
func (s *AppService) Get(ctx context.Context, id string, opts *AppGetOptions) (*App, error) {
	var app App
	return &app, s.c.do(ctx, &call{method: http.MethodGet, path: s.path(id, ""), query: serverWait(opts)}, &app)
}

func serverWait(opts *AppGetOptions) url.Values {
	query := url.Values{}
	if opts != nil {
		setQuery(query, "waitFor", opts.WaitFor, "timeoutSeconds", itoa(opts.TimeoutSeconds))
	}
	return query
}

// List returns the first page.
func (s *AppService) List(ctx context.Context, opts *AppListOptions) (*Page[App], error) {
	query := url.Values{}
	if opts != nil {
		query = listQuery(opts.Name, opts.Label, opts.State, opts.Limit)
	}
	return listPage[App](ctx, s.c, s.base, query, "")
}

// All walks every one a list with these options finds.
func (s *AppService) All(ctx context.Context, opts *AppListOptions) iter.Seq2[App, error] {
	return walk(ctx, func() (*Page[App], error) { return s.List(ctx, opts) })
}

// Update changes settings in place.
func (s *AppService) Update(ctx context.Context, id string, opts UpdateAppOptions) (*App, error) {
	if err := s.refuseMinCopies(opts.MinCopies); err != nil {
		return nil, err
	}
	body, err := fields(opts)
	if err != nil {
		return nil, err
	}
	// omitempty drops an empty map, and an empty map is how every label is
	// removed.
	if opts.Labels != nil {
		body["labels"] = opts.Labels
	}
	if opts.ClearName {
		body["name"] = nil
	}
	var app App
	return &app, s.c.do(ctx, &call{method: http.MethodPost, path: s.path(id, ":update"), body: body, key: opts.IdempotencyKey}, &app)
}

// Wait follows the resource to target (live or deleted), not a deploy: an
// older live version can survive a failed rollout of a newer one. Reaching
// failed, or the other target, is an error carrying the resource's own.
func (s *AppService) Wait(ctx context.Context, id, target string, opts *WaitOptions) (*App, error) {
	if opts == nil {
		opts = &WaitOptions{}
	}
	return following(ctx, *opts, func(ctx context.Context, pause func() error) (*App, error) {
		return s.follow(ctx, id, target, opts.IdempotencyKey, pause, nil)
	})
}

// follow reads the resource until it reaches target or settles elsewhere.
func (s *AppService) follow(ctx context.Context, id, target, key string, pause func() error, record *App) (*App, error) {
	for {
		if record == nil {
			read, err := s.Get(ctx, id, nil)
			if err != nil {
				return nil, err
			}
			record = read
		}
		if record.State == target {
			return record, nil
		}
		if slices.Contains([]string{"failed", "deleted", "live"}, record.State) {
			failure := &Error{
				Code:           "unexpected_state",
				Message:        fmt.Sprintf("Expected %s, but %s reached %s.", target, id, record.State),
				Hint:           "Read the resource and inspect its error before starting another change.",
				Details:        map[string]any{"id": id, "state": record.State, "target": target, "resource": record},
				IdempotencyKey: key,
			}
			if record.Error != nil {
				failure.Code, failure.Message = record.Error.Code, record.Error.Message
			}
			return nil, failure
		}
		if err := pause(); err != nil {
			return nil, err
		}
		record = nil
	}
}

// Delete deletes it. With opts.Wait it returns once deleted, under one
// idempotency key made before the first try. opts may be nil.
func (s *AppService) Delete(ctx context.Context, id string, opts *DeleteAppOptions) (*App, error) {
	if opts == nil {
		opts = &DeleteAppOptions{}
	}
	remove := func(ctx context.Context, key string) (*App, error) {
		var app App
		return &app, s.c.do(ctx, &call{method: http.MethodDelete, path: s.path(id, ""), key: key}, &app)
	}
	if !opts.Wait {
		return remove(ctx, opts.IdempotencyKey)
	}
	wait := withKey(opts.WaitOptions)
	return following(ctx, wait, func(ctx context.Context, pause func() error) (*App, error) {
		app, err := remove(ctx, wait.IdempotencyKey)
		if err != nil {
			return nil, err
		}
		return s.follow(ctx, id, "deleted", wait.IdempotencyKey, pause, app)
	})
}

// Deploy makes a new version from an image or a build. With opts.Wait it
// returns the deploy once live, failed or superseded (a failed deploy is an
// answer, not an error), under one idempotency key made before the first try.
func (s *AppService) Deploy(ctx context.Context, id string, opts DeployAppOptions) (*AppDeploy, error) {
	if (opts.Image == "") == (opts.Build == "") {
		return nil, &Error{
			Code:    "invalid_request",
			Message: "Deploy exactly one of Image or Build.",
			Hint:    "Set Image or Build, not both; nothing was sent.",
			Details: map[string]any{"field": "image"},
		}
	}
	return s.writeDeploy(ctx, id, "/deploys", opts, opts.Wait, opts.WaitOptions)
}

// Rollback makes the previous version live again. opts may be nil.
func (s *AppService) Rollback(ctx context.Context, id string, opts *RollbackOptions) (*AppDeploy, error) {
	if opts == nil {
		opts = &RollbackOptions{}
	}
	return s.writeDeploy(ctx, id, "/rollback", map[string]any{}, opts.Wait, opts.WaitOptions)
}

func (s *AppService) writeDeploy(ctx context.Context, id, verb string, body any, wait bool, opts WaitOptions) (*AppDeploy, error) {
	write := func(ctx context.Context, key string) (*AppDeploy, error) {
		var deploy AppDeploy
		return &deploy, s.c.do(ctx, &call{method: http.MethodPost, path: s.path(id, verb), body: body, key: key}, &deploy)
	}
	if !wait {
		return write(ctx, opts.IdempotencyKey)
	}
	opts = withKey(opts)
	return following(ctx, opts, func(ctx context.Context, pause func() error) (*AppDeploy, error) {
		deploy, err := write(ctx, opts.IdempotencyKey)
		if err != nil {
			return nil, err
		}
		return s.followDeploy(ctx, id, deploy, pause)
	})
}

// GetDeploy reads one deploy. opts may be nil.
func (s *AppService) GetDeploy(ctx context.Context, id, deployID string, opts *DeployGetOptions) (*AppDeploy, error) {
	var deploy AppDeploy
	return &deploy, s.c.do(ctx, &call{method: http.MethodGet, path: s.path(id, "/deploys/"+url.PathEscape(deployID)), query: serverWait(opts)}, &deploy)
}

// WaitDeploy follows a deploy by its id until it is live, failed or
// superseded: resume after a restart without making another version.
func (s *AppService) WaitDeploy(ctx context.Context, id, deployID string, opts *WaitOptions) (*AppDeploy, error) {
	if opts == nil {
		opts = &WaitOptions{}
	}
	return following(ctx, *opts, func(ctx context.Context, pause func() error) (*AppDeploy, error) {
		deploy, err := s.GetDeploy(ctx, id, deployID, nil)
		if err != nil {
			return nil, err
		}
		return s.followDeploy(ctx, id, deploy, pause)
	})
}

func deployEnded(state string) bool {
	return state == "live" || state == "failed" || state == "superseded"
}

func (s *AppService) followDeploy(ctx context.Context, id string, deploy *AppDeploy, pause func() error) (*AppDeploy, error) {
	for !deployEnded(deploy.State) {
		next, err := s.GetDeploy(ctx, id, deploy.ID, &DeployGetOptions{WaitFor: "live", TimeoutSeconds: 60})
		if err != nil {
			return nil, err
		}
		deploy = next
		if !deployEnded(deploy.State) {
			if err := pause(); err != nil {
				return nil, err
			}
		}
	}
	return deploy, nil
}

// Versions lists its deployed versions.
func (s *AppService) Versions(ctx context.Context, id string) ([]AppVersion, error) {
	var versions []AppVersion
	return versions, s.c.do(ctx, &call{method: http.MethodGet, path: s.path(id, "/versions")}, &versions)
}

// Copies lists its running copies.
func (s *AppService) Copies(ctx context.Context, id string) ([]AppCopy, error) {
	var copies []AppCopy
	return copies, s.c.do(ctx, &call{method: http.MethodGet, path: s.path(id, "/copies")}, &copies)
}

// withKey makes the write's idempotency key before the first try, so every
// retry and a resumed wait share it.
func withKey(opts WaitOptions) WaitOptions {
	if opts.IdempotencyKey == "" {
		opts.IdempotencyKey = newKey()
	}
	return opts
}

// following runs a write and the reads that follow it under one deadline.
// A read's failure keeps the write's key, so a caller who lost the answer
// can recover; a deadline or a cancel is a timeout carrying it.
func following[T any](ctx context.Context, opts WaitOptions, work func(ctx context.Context, pause func() error) (T, error)) (T, error) {
	timeout, poll := opts.Timeout, opts.Poll
	if timeout == 0 {
		timeout = 5 * time.Minute
	}
	if poll <= 0 {
		poll = 250 * time.Millisecond
	}
	waiting, cancel := ctx, context.CancelFunc(func() {})
	if timeout > 0 {
		waiting, cancel = context.WithTimeout(ctx, timeout)
	}
	defer cancel()
	result, err := work(waiting, func() error { return sleep(waiting, poll) })
	if err == nil {
		return result, nil
	}
	var zero T
	if waiting.Err() != nil {
		return zero, &Error{
			Code:           "timeout",
			Message:        "Waiting was cancelled or reached its deadline; the resource may still change.",
			Hint:           "Read the resource to resume waiting. Retry a write with the same idempotency key.",
			IdempotencyKey: opts.IdempotencyKey,
			Err:            err,
		}
	}
	if failure, ok := asError(err); ok && opts.IdempotencyKey != "" && failure.IdempotencyKey == "" {
		keyed := *failure
		keyed.IdempotencyKey = opts.IdempotencyKey
		keyed.Err = failure
		return zero, &keyed
	}
	return zero, err
}

// fields is a request body's JSON fields as a map, for a caller to add the
// nulls and empty maps omitempty leaves out.
func fields(value any) (map[string]any, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	body := map[string]any{}
	return body, json.Unmarshal(encoded, &body)
}
