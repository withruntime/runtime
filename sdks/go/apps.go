package withruntime

import (
	"context"
	"encoding/json"
	"errors"
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
	// CDN is whether Cloudflare's CDN is in front of the App's addresses
	// (its runtimehost.com address and its custom domains). False sends
	// visitors straight to Runtime's routers, with nothing cached.
	CDN bool `json:"cdn"`
	// ReleaseWatch is what Runtime does when a new version's errors or
	// speed get clearly worse in its first 15 minutes: alert (tell the
	// owners), rollback (go back and tell them) or off.
	ReleaseWatch string `json:"releaseWatch,omitempty"`
	// ReleaseStages is an App's: how a new version goes live. at_once
	// switches every copy together; staged starts one copy of it beside the
	// live version's, then about 10%, 50% and all of them, each stage
	// judged on its visitors' errors and speed before the next. Empty for a
	// Function.
	ReleaseStages string `json:"releaseStages,omitempty"`
	// ReleaseSoakSeconds is how long each stage runs once its copies serve
	// before it is judged: 60 to 3600. Zero for a Function.
	ReleaseSoakSeconds int `json:"releaseSoakSeconds,omitempty"`
	// StagedRelease is an App's staged release under way, or its last; nil
	// before its first.
	StagedRelease *StagedRelease `json:"stagedRelease,omitempty"`
	// SleepAfterMs is a Function's: 250 to 5000, zero for an App.
	SleepAfterMs int            `json:"sleepAfterMs,omitempty"`
	CreatedAt    int64          `json:"createdAt"`
	UpdatedAt    int64          `json:"updatedAt"`
	DeletedAt    *int64         `json:"deletedAt"`
	Error        *ResourceError `json:"error"`
	LiveVersion  *int           `json:"liveVersion"`
	// URL is its address for life, its name then its account's
	// (https://shop-3f9a1c2e7b04d915-acme1.runtimehost.com/). A rename leaves it as it is;
	// its id's address (https://<id without dashes>.runtimehost.com/)
	// answers too.
	URL             string `json:"url"`
	PreviousVersion *int   `json:"previousVersion"`
	// Line is where a copy short of room stands while it waits in its
	// region's line: its account's lane, its place (1 is next), how many
	// wait ahead by lane, and why. Higher lanes get room first. Nil while
	// nothing of it waits.
	Line *AppLine `json:"line,omitempty"`
}

// StagedRelease is an App's release in stages.
type StagedRelease struct {
	Version int `json:"version"`
	// From is the version live when it began, serving beside it.
	From int `json:"from"`
	// State is rolling; back (a stage did worse, and its copies leave while
	// the version before keeps serving); done (every copy runs it); failed
	// (it went back, or its copies failed their health check, and the
	// version failed); or ended (another deploy or a rollback took its
	// place).
	State  string `json:"state"`
	Stage  int    `json:"stage"`
	Stages int    `json:"stages"`
	// Copies of the new version the stage serves, of Of.
	Copies      int `json:"copies"`
	Of          int `json:"of"`
	SoakSeconds int `json:"soakSeconds"`
	// Detail is its last step, in words.
	Detail    string `json:"detail"`
	StartedAt int64  `json:"startedAt"`
	UpdatedAt int64  `json:"updatedAt"`
}

// AppLine is an App's place in its region's line for room.
type AppLine struct {
	Lane  string         `json:"lane"`
	Place int            `json:"place"`
	Ahead map[string]int `json:"ahead"`
	Words string         `json:"words"`
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
	// MaxCopies is required, 1 to the account's App copies at once (its plan's
	// sandboxes at once): the bound on awake copies.
	MaxCopies int `json:"maxCopies"`
	// VCPU is required, 1 to 16.
	VCPU int `json:"vcpu"`
	// MemoryMiB is required, 128 to 65536.
	MemoryMiB int `json:"memoryMiB"`
	// Concurrency is 1 to 10000 requests per copy; 100 unless set.
	Concurrency int `json:"concurrency,omitempty"`
	// Spares is 0 to 16 copies kept ready; 2 unless set.
	Spares *int `json:"spares,omitempty"`
	// SleepAfterMs is 250 to 5000, for Functions only (an App is refused
	// it); 1000 unless set. It is at most how long a copy stays awake after
	// its last request ends before it goes back to sleep: copies whose
	// requests come closer together than this stay awake between them, and
	// a lone first request may sleep sooner, from 250 ms. Awake time with
	// no request in flight is not billed.
	SleepAfterMs *int `json:"sleepAfterMs,omitempty"`
	// Port is 1 to 65535; 8080 unless set.
	Port int `json:"port,omitempty"`
	// HealthPath starts with /, no whitespace, at most 256 characters.
	// Leave it empty to check whether the port accepts connections.
	HealthPath string `json:"healthPath,omitempty"`
	// CDN puts Cloudflare's CDN in front of the App's addresses; on (true)
	// unless set. Point it at false to send visitors straight to Runtime's
	// routers, with nothing cached.
	CDN *bool `json:"cdn,omitempty"`
	// ReleaseWatch is alert unless set; rollback is opted into.
	ReleaseWatch string `json:"releaseWatch,omitempty"`
	// ReleaseStages is at_once unless set, or staged (Apps only; see App).
	ReleaseStages string `json:"releaseStages,omitempty"`
	// ReleaseSoakSeconds is 60 to 3600 (Apps only); 300 unless set.
	ReleaseSoakSeconds int    `json:"releaseSoakSeconds,omitempty"`
	IdempotencyKey     string `json:"-"`
}

// UpdateAppOptions change settings in place; nil fields stay as they are.
type UpdateAppOptions struct {
	Name *string `json:"name,omitempty"`
	// ClearName removes the name.
	ClearName bool `json:"-"`
	// Labels replaces every label; an empty, non-nil map removes them all.
	Labels map[string]string `json:"labels,omitempty"`
	// MinCopies is for Apps only; SleepAfterMs (250 to 5000) for Functions only.
	MinCopies    *int    `json:"minCopies,omitempty"`
	MaxCopies    *int    `json:"maxCopies,omitempty"`
	Concurrency  *int    `json:"concurrency,omitempty"`
	Spares       *int    `json:"spares,omitempty"`
	SleepAfterMs *int    `json:"sleepAfterMs,omitempty"`
	VCPU         *int    `json:"vcpu,omitempty"`
	MemoryMiB    *int    `json:"memoryMiB,omitempty"`
	Port         *int    `json:"port,omitempty"`
	HealthPath   *string `json:"healthPath,omitempty"`
	CDN          *bool   `json:"cdn,omitempty"`
	ReleaseWatch *string `json:"releaseWatch,omitempty"`
	// ReleaseStages (at_once or staged) and ReleaseSoakSeconds (60 to
	// 3600) are for Apps only.
	ReleaseStages      *string `json:"releaseStages,omitempty"`
	ReleaseSoakSeconds *int    `json:"releaseSoakSeconds,omitempty"`
	IdempotencyKey     string  `json:"-"`
}

// AppDeployError is why a deploy failed or was superseded.
type AppDeployError struct {
	// Code is deploy_build_failed, deploy_health_failed, deploy_stop_failed,
	// deploy_stage_failed (a stage of a staged release did worse and went
	// back), deploy_switch_failed or deploy_superseded.
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

// AppLogsOptions choose which lines Logs and FollowLogs read, every field
// optional.
type AppLogsOptions struct {
	// Since is an RFC 3339 time or a duration back from now (30s, 15m, 2h,
	// 7d): 1h unless set, at most 14 days back.
	Since string
	// Version keeps only that version's copies' lines.
	Version int
	// Copy keeps only one copy's lines, by its id.
	Copy string
	// Stream is stdout or stderr.
	Stream string
	// Limit is 1 to 500 lines; 100 unless set. A first follow starts with
	// the newest Limit lines.
	Limit int
	// Cursor reads the next older page (a page's NextCursor), or resumes a
	// follow where it stopped (an event's Cursor).
	Cursor string
}

// AppLogLine is one line a copy printed.
type AppLogLine struct {
	// At is Unix milliseconds.
	At int64 `json:"at"`
	// Stream is stdout or stderr.
	Stream  string  `json:"stream"`
	Copy    *string `json:"copy"`
	Version *int    `json:"version"`
	Text    string  `json:"text"`
}

// AppLogPage is the newest lines in the window, oldest first. NextCursor
// reads the next older page with the same options.
type AppLogPage struct {
	Lines      []AppLogLine `json:"lines"`
	NextCursor *string      `json:"nextCursor"`
	HasMore    bool         `json:"hasMore"`
}

// AppLogEvent is one event of a followed log. Type is line (AppLogLine's
// fields) or gap (lines were dropped before they could be read; the follow
// goes on). Cursor is where to resume.
type AppLogEvent struct {
	Type    string  `json:"type"`
	Cursor  *string `json:"cursor"`
	At      int64   `json:"at"`
	Stream  string  `json:"stream"`
	Copy    *string `json:"copy"`
	Version *int    `json:"version"`
	Text    string  `json:"text"`
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

func appLogQuery(opts *AppLogsOptions) url.Values {
	query := url.Values{}
	if opts != nil {
		setQuery(query, "since", opts.Since, "version", itoa(opts.Version), "copy", opts.Copy,
			"stream", opts.Stream, "limit", itoa(opts.Limit), "cursor", opts.Cursor)
	}
	return query
}

// Logs reads what its copies printed: the newest lines in the window
// (the last hour unless opts.Since says), oldest first. Pass NextCursor as
// opts.Cursor, with the same options, for the page before. opts may be nil.
func (s *AppService) Logs(ctx context.Context, id string, opts *AppLogsOptions) (*AppLogPage, error) {
	var page AppLogPage
	return &page, s.c.do(ctx, &call{method: http.MethodGet, path: s.path(id, "/logs"), query: appLogQuery(opts)}, &page)
}

// FollowLogs streams what its copies print until ctx is cancelled (which
// ends it with a timeout error, errors.Is context.Canceled). A first follow
// starts with the newest opts.Limit lines since opts.Since; opts.Cursor
// resumes from an event's Cursor instead. It reconnects by itself each time
// the server ends a follow, and from the last line it yielded when the
// connection drops (three times in a row at most, then app_log_interrupted).
// Every error's Details["cursor"] is where to resume. opts may be nil.
//
//	for event, err := range client.Apps.FollowLogs(ctx, id, nil) {
//		if err != nil { return err }
//		if event.Type == "line" { fmt.Println(event.Text) }
//	}
func (s *AppService) FollowLogs(ctx context.Context, id string, opts *AppLogsOptions) iter.Seq2[AppLogEvent, error] {
	if opts == nil {
		opts = &AppLogsOptions{}
	}
	return func(yield func(AppLogEvent, error) bool) {
		var cursor *string
		if opts.Cursor != "" {
			start := opts.Cursor
			cursor = &start
			if !validCursor(cursor) {
				yield(AppLogEvent{}, logFailure("invalid_log_options", "Use the Cursor of an event this follow yielded.", cursor))
				return
			}
		}
		// The server ends each follow after about 2 minutes: the request
		// must outlive it.
		timeout := max(3*time.Minute, s.c.timeout)
		// Opaque positions cannot be ordered or incremented: a line seen
		// before a reconnect is known by its cursor.
		seen := map[string]bool{}
		var order []string
		if cursor != nil {
			seen[*cursor] = true
			order = append(order, *cursor)
		}
		fail := func(err error) { yield(AppLogEvent{}, err) }
		invalid := func() { fail(logFailure("app_log_invalid", "Retry the follow from the last received cursor.", cursor)) }
		failures := 0
		for {
			if ctx.Err() != nil {
				fail(s.c.connectionError(ctx, false, "", ctx.Err()))
				return
			}
			query := appLogQuery(opts)
			query.Set("follow", "true")
			query.Del("cursor")
			if cursor != nil {
				query.Set("cursor", *cursor)
			}
			continued := false
			var lost error
		stream:
			for event, err := range events[json.RawMessage](ctx, s.c, &call{method: http.MethodGet, path: s.path(id, "/logs"), query: query, timeout: timeout}) {
				if err != nil {
					if ctx.Err() != nil {
						fail(s.c.connectionError(ctx, false, "", err))
						return
					}
					var syntax *json.SyntaxError
					if errors.As(err, &syntax) {
						fail(logFailure("app_log_invalid", "The log contained invalid JSON; retry from details.cursor.", cursor))
						return
					}
					// HTTP refusals are actionable, not connection loss; the
					// transport itself retried the retryable ones.
					if failure, ok := asError(err); !ok || failure.Status != 0 {
						fail(err)
						return
					}
					lost = err
					break stream
				}
				var e struct {
					AppLogEvent
					Code string `json:"code"`
					Hint string `json:"hint"`
				}
				if json.Unmarshal(event, &e) != nil {
					invalid()
					return
				}
				if e.Cursor != nil && !validCursor(e.Cursor) {
					invalid()
					return
				}
				switch e.Type {
				case "line":
					if (e.Stream != "stdout" && e.Stream != "stderr") || e.At < 0 || !validCursor(e.Cursor) {
						invalid()
						return
					}
					if seen[*e.Cursor] {
						continue
					}
					seen[*e.Cursor] = true
					order = append(order, *e.Cursor)
					if len(order) > 10_000 {
						delete(seen, order[0])
						order = order[1:]
					}
					cursor = e.Cursor
					failures = 0
					if !yield(e.AppLogEvent, nil) {
						return
					}
				case "gap":
					if !validCursor(e.Cursor) {
						invalid()
						return
					}
					cursor = e.Cursor
					if !yield(e.AppLogEvent, nil) {
						return
					}
				case "continue":
					// A null cursor: nothing was printed yet, so the next
					// follow starts where this one did.
					if e.Cursor != nil {
						cursor = e.Cursor
					}
					continued = true
					break stream
				case "error":
					if e.Code == "" || e.Hint == "" {
						invalid()
						return
					}
					fail(logFailure(e.Code, e.Hint, cursor))
					return
				default:
					invalid()
					return
				}
			}
			if !continued {
				failures++
				if failures > 3 {
					failure := logFailure("app_log_interrupted", "Reconnect with FollowLogs and AppLogsOptions{Cursor: details.cursor}.", cursor)
					failure.Err = lost
					fail(failure)
					return
				}
			}
			// A disconnected service or repeated continues must not busy-loop.
			if sleep(ctx, time.Duration(50*max(1, failures))*time.Millisecond) != nil {
				fail(s.c.connectionError(ctx, false, "", ctx.Err()))
				return
			}
		}
	}
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
