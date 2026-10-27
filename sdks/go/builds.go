package withruntime

import (
	"context"
	"encoding/json"
	"errors"
	"iter"
	"net/http"
	"net/url"
	"time"
)

// Builds is in private beta: an account outside the beta is refused with
// product_in_beta (403, errors.Is ErrPermissionDenied). A connected
// repository builds on every push to its production branch, and a build of
// one with a start command ends as a saved server an App deploys.

// Build is one build of a connected repository at a ref.
type Build struct {
	ID           string            `json:"id"`
	Name         *string           `json:"name"`
	Labels       map[string]string `json:"labels"`
	CreatedAt    int64             `json:"createdAt"`
	UpdatedAt    int64             `json:"updatedAt"`
	DeletedAt    *int64            `json:"deletedAt"`
	Error        *ResourceError    `json:"error"`
	RepositoryID string            `json:"repositoryId"`
	Ref          string            `json:"ref"`
	// Branch is the branch whose move asked for it, when the caller said.
	Branch *string `json:"branch"`
	Commit *string `json:"commit"`
	// State is queued, fetching, building, deploying, succeeded, failed,
	// cancelled or superseded.
	State  string  `json:"state"`
	Reason *string `json:"reason"`
	// Timings are milliseconds per step once the runner is done (install,
	// build, mirror, fork, snapshot, total, ...); nil until then.
	Timings map[string]float64 `json:"timings"`
	// OutputSnapshotID is the saved server an App deploys, once a build of a
	// repository with a start command succeeded; nil otherwise.
	OutputSnapshotID *string `json:"outputSnapshotId"`
	// Framework is the framework detected in the build folder for the
	// commands its repository leaves unset (nextjs, vite, fastapi, django,
	// rails, go, docker, ...); nil when none was or every command is set.
	Framework *string `json:"framework"`
}

// CreateBuildOptions build a connected repository at Ref.
type CreateBuildOptions struct {
	RepositoryID string `json:"repositoryId"`
	Ref          string `json:"ref"`
	// Branch: the same branch and commit is one build, and a newer build of
	// the branch supersedes older ones not yet ended.
	Branch         string            `json:"branch,omitempty"`
	Name           string            `json:"name,omitempty"`
	Labels         map[string]string `json:"labels,omitempty"`
	IdempotencyKey string            `json:"-"`
}

// BuildListOptions filter a list of builds, every field optional.
type BuildListOptions struct {
	Name  string
	Label []string
	State []string
	Limit int
}

// Repository is a connected repository.
type Repository struct {
	ID        string            `json:"id"`
	Name      *string           `json:"name"`
	Labels    map[string]string `json:"labels"`
	CreatedAt int64             `json:"createdAt"`
	UpdatedAt int64             `json:"updatedAt"`
	DeletedAt *int64            `json:"deletedAt"`
	Error     *ResourceError    `json:"error"`
	// Provider is github or git.
	Provider   string `json:"provider"`
	Repository string `json:"repository"`
	// Deploy is app:<name>, function:<name> or container:<name>.
	Deploy           string            `json:"deploy"`
	ProductionBranch string            `json:"productionBranch"`
	Previews         bool              `json:"previews"`
	RootDirectory    string            `json:"rootDirectory"`
	InstallCommand   *string           `json:"installCommand"`
	BuildCommand     *string           `json:"buildCommand"`
	StartCommand     *string           `json:"startCommand"`
	Port             int               `json:"port"`
	HealthPath       *string           `json:"healthPath"`
	BuildEnv         map[string]string `json:"buildEnv"`
	// State is connected or disconnected.
	State string `json:"state"`
}

// ConnectRepositoryOptions connect a repository. Defaults belong to the API,
// so the SDK leaves unset fields out.
type ConnectRepositoryOptions struct {
	// Provider is github or git.
	Provider   string `json:"provider"`
	Repository string `json:"repository"`
	// Deploy is app:<name>, function:<name> or container:<name>.
	Deploy string `json:"deploy"`
	// ProductionBranch is main unless set.
	ProductionBranch string `json:"productionBranch,omitempty"`
	// Previews builds other branches too; true unless set.
	Previews *bool `json:"previews,omitempty"`
	// RootDirectory is the folder the build runs in; the repository's root
	// unless set.
	RootDirectory string `json:"rootDirectory,omitempty"`
	// InstallCommand is chosen by the lockfile (bun, pnpm, Yarn or npm)
	// unless set.
	InstallCommand string `json:"installCommand,omitempty"`
	BuildCommand   string `json:"buildCommand,omitempty"`
	// StartCommand runs after the build with PORT set; the build ends as
	// this server, answering HealthPath with 200 and saved with its memory.
	StartCommand string `json:"startCommand,omitempty"`
	Port         int    `json:"port,omitempty"`
	HealthPath   string `json:"healthPath,omitempty"`
	// BuildEnv are settings install and build are given. Never a secret:
	// anyone who reads the repository sees them.
	BuildEnv       map[string]string `json:"buildEnv,omitempty"`
	Name           string            `json:"name,omitempty"`
	Labels         map[string]string `json:"labels,omitempty"`
	IdempotencyKey string            `json:"-"`
}

// UpdateRepositoryOptions change a connected repository's settings in
// place; its id and builds stay. Nil fields stay as they are.
type UpdateRepositoryOptions struct {
	Name             *string `json:"name,omitempty"`
	Repository       *string `json:"repository,omitempty"`
	Deploy           *string `json:"deploy,omitempty"`
	ProductionBranch *string `json:"productionBranch,omitempty"`
	Previews         *bool   `json:"previews,omitempty"`
	RootDirectory    *string `json:"rootDirectory,omitempty"`
	InstallCommand   *string `json:"installCommand,omitempty"`
	BuildCommand     *string `json:"buildCommand,omitempty"`
	StartCommand     *string `json:"startCommand,omitempty"`
	Port             *int    `json:"port,omitempty"`
	HealthPath       *string `json:"healthPath,omitempty"`
	// Labels and BuildEnv replace every entry; an empty, non-nil map
	// removes them all.
	Labels   map[string]string `json:"labels,omitempty"`
	BuildEnv map[string]string `json:"buildEnv,omitempty"`
	// Clear names the fields to remove: name, installCommand, buildCommand,
	// startCommand or healthPath.
	Clear          []string `json:"-"`
	IdempotencyKey string   `json:"-"`
}

// RepositoryListOptions filter a list of repositories, every field optional.
type RepositoryListOptions struct {
	Name  string
	Label []string
	// State is connected or disconnected.
	State []string
	Limit int
}

// GithubInstall is a link to install Runtime's GitHub App, so private
// repositories build.
type GithubInstall struct {
	URL       string    `json:"url"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// BuildLine is one line a build wrote.
type BuildLine struct {
	Cursor *string `json:"cursor"`
	At     int64   `json:"at"`
	Step   *string `json:"step"`
	Text   string  `json:"text"`
	// Stream is stdout or stderr.
	Stream string `json:"stream"`
}

// FailingStep is the step a failed build failed in, with its last lines.
type FailingStep struct {
	Name      string   `json:"name"`
	ExitCode  *int     `json:"exitCode"`
	LastLines []string `json:"lastLines"`
}

// BuildLog is the last 200 lines of a build, or a page of older ones.
type BuildLog struct {
	Lines       []BuildLine  `json:"lines"`
	Cursor      *string      `json:"cursor"`
	State       string       `json:"state"`
	Reason      *string      `json:"reason"`
	FailingStep *FailingStep `json:"failingStep"`
	HasMore     bool         `json:"hasMore"`
	NextCursor  *string      `json:"nextCursor"`
}

// BuildLogOptions read one page: Cursor reads from a position, PageCursor
// pages older search results.
type BuildLogOptions struct {
	Cursor     string
	PageCursor string
}

// BuildLogEvent is one event of a followed log. Type is line (BuildLine's
// fields), gap (lines before EarliestCursor are gone) or terminal (the build
// ended: State, Reason and, for a failure, FailingStep). Cursor is where to
// resume.
type BuildLogEvent struct {
	Type   string  `json:"type"`
	Cursor *string `json:"cursor"`
	At     int64   `json:"at"`
	Step   *string `json:"step"`
	Text   string  `json:"text"`
	Stream string  `json:"stream"`
	// EarliestCursor is a gap's first line still kept.
	EarliestCursor string       `json:"earliestCursor"`
	State          string       `json:"state"`
	Reason         string       `json:"reason"`
	FailingStep    *FailingStep `json:"failingStep"`
}

// FollowBuildLogOptions resume a follow from Cursor. Timeout bounds the
// whole follow, reconnections included: 2 minutes when 0, only the
// context's deadline when negative.
type FollowBuildLogOptions struct {
	Cursor  string
	Timeout time.Duration
}

// BuildService is client.Builds (private beta).
type BuildService struct {
	c *Client
	// Repositories are the connected repositories builds come from.
	Repositories *RepositoryService
}

// RepositoryService is client.Builds.Repositories.
type RepositoryService struct{ c *Client }

func buildPath(id, verb string) string { return "/v1/builds/" + url.PathEscape(id) + verb }

func listQuery(name string, label, state []string, limit int) url.Values {
	query := setQuery(url.Values{}, "name", name, "limit", itoa(limit))
	if len(label) > 0 {
		query["label"] = label
	}
	if len(state) > 0 {
		query["state"] = state
	}
	return query
}

// Create builds a connected repository at a ref.
func (s *BuildService) Create(ctx context.Context, opts CreateBuildOptions) (*Build, error) {
	var build Build
	return &build, s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/builds", body: opts, key: opts.IdempotencyKey}, &build)
}

// Get reads a build.
func (s *BuildService) Get(ctx context.Context, id string) (*Build, error) {
	var build Build
	return &build, s.c.do(ctx, &call{method: http.MethodGet, path: buildPath(id, "")}, &build)
}

// List returns the first page of builds.
func (s *BuildService) List(ctx context.Context, opts *BuildListOptions) (*Page[Build], error) {
	query := url.Values{}
	if opts != nil {
		query = listQuery(opts.Name, opts.Label, opts.State, opts.Limit)
	}
	return listPage[Build](ctx, s.c, "/v1/builds", query, "")
}

// All walks every build a list with these options finds.
func (s *BuildService) All(ctx context.Context, opts *BuildListOptions) iter.Seq2[Build, error] {
	return walk(ctx, func() (*Page[Build], error) { return s.List(ctx, opts) })
}

// Cancel cancels a build; one that ended stays as it is.
func (s *BuildService) Cancel(ctx context.Context, id string) (*Build, error) {
	var build Build
	return &build, s.c.do(ctx, &call{method: http.MethodPost, path: buildPath(id, ":cancel"), body: map[string]any{}}, &build)
}

// Logs reads the last 200 lines and the failing step, or a page from a
// cursor. opts may be nil.
func (s *BuildService) Logs(ctx context.Context, id string, opts *BuildLogOptions) (*BuildLog, error) {
	query := url.Values{}
	if opts != nil {
		setQuery(query, "cursor", opts.Cursor, "pageCursor", opts.PageCursor)
	}
	var log BuildLog
	return &log, s.c.do(ctx, &call{method: http.MethodGet, path: buildPath(id, "/logs"), query: query}, &log)
}

// buildLogEnded are the states a terminal event may carry.
var buildLogEnded = map[string]bool{"succeeded": true, "failed": true, "cancelled": true, "superseded": true}

func logFailure(code, hint string, cursor *string) *Error {
	var at any
	if cursor != nil {
		at = *cursor
	}
	return &Error{Code: code, Message: hint, Hint: hint, Details: map[string]any{"cursor": at}}
}

// validCursor: an opaque position, 1 to 4096 characters, no control ones.
func validCursor(cursor *string) bool {
	if cursor == nil || len(*cursor) == 0 || len(*cursor) > 4096 {
		return false
	}
	for _, c := range *cursor {
		if c < 0x20 || c == 0x7f {
			return false
		}
	}
	return true
}

func sameCursor(a, b *string) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}

// validFailure: nil, or a step with at most 20 last lines.
func validFailure(step *FailingStep) bool {
	return step == nil || (step.LastLines != nil && len(step.LastLines) <= 20)
}

// FollowLogs streams a build's log until it ends, from opts.Cursor when set,
// and reconnects from the last line it yielded when the connection drops
// (three times in a row at most, then build_log_interrupted). Every error's
// Details["cursor"] is where to resume. opts may be nil.
//
//	for event, err := range client.Builds.FollowLogs(ctx, id, nil) {
//		if err != nil { return err }
//		if event.Type == "line" { fmt.Println(event.Text) }
//	}
func (s *BuildService) FollowLogs(ctx context.Context, id string, opts *FollowBuildLogOptions) iter.Seq2[BuildLogEvent, error] {
	if opts == nil {
		opts = &FollowBuildLogOptions{}
	}
	return func(yield func(BuildLogEvent, error) bool) {
		var cursor *string
		if opts.Cursor != "" {
			start := opts.Cursor
			cursor = &start
			if !validCursor(cursor) {
				yield(BuildLogEvent{}, logFailure("invalid_log_options", "Use an opaque cursor for follow; pageCursor is only for search pages.", cursor))
				return
			}
		}
		timeout := opts.Timeout
		if timeout == 0 {
			timeout = 2 * time.Minute
		}
		if timeout > 0 {
			var cancel context.CancelFunc
			ctx, cancel = context.WithTimeout(ctx, timeout)
			defer cancel()
		}
		// Opaque positions cannot be ordered or incremented: a line seen
		// before a reconnect is known by its cursor.
		seen := map[string]bool{}
		var order []string
		if cursor != nil {
			seen[*cursor] = true
			order = append(order, *cursor)
		}
		fail := func(err error) { yield(BuildLogEvent{}, err) }
		invalid := func() { fail(logFailure("build_log_invalid", "Retry the log from the last received cursor.", cursor)) }
		failures := 0
		for {
			if ctx.Err() != nil {
				fail(s.c.connectionError(ctx, false, "", ctx.Err()))
				return
			}
			query := url.Values{"follow": {"true"}}
			if cursor != nil {
				query.Set("cursor", *cursor)
			}
			continued := false
			var lost error
		stream:
			for event, err := range events[json.RawMessage](ctx, s.c, &call{method: http.MethodGet, path: buildPath(id, "/logs"), query: query, timeout: max(timeout, s.c.timeout)}) {
				if err != nil {
					if ctx.Err() != nil {
						fail(s.c.connectionError(ctx, false, "", err))
						return
					}
					var syntax *json.SyntaxError
					if errors.As(err, &syntax) {
						fail(logFailure("build_log_invalid", "The log contained invalid JSON; retry from details.cursor.", cursor))
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
					BuildLogEvent
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
					if !yield(e.BuildLogEvent, nil) {
						return
					}
				case "gap":
					if !validCursor(&e.EarliestCursor) || (cursor != nil && !sameCursor(e.Cursor, cursor)) {
						invalid()
						return
					}
					cursor = e.Cursor
					if !yield(e.BuildLogEvent, nil) {
						return
					}
				case "terminal":
					if (cursor != nil && !sameCursor(e.Cursor, cursor)) || !buildLogEnded[e.State] || e.Reason == "" ||
						!validFailure(e.FailingStep) || (e.State != "failed" && e.FailingStep != nil) {
						invalid()
						return
					}
					yield(e.BuildLogEvent, nil)
					return
				case "continue":
					if cursor != nil && !sameCursor(e.Cursor, cursor) {
						fail(logFailure("build_log_gap", "Resume from details.cursor; report a persistent missing log line.", cursor))
						return
					}
					cursor = e.Cursor
					continued = true
					break stream
				case "error":
					if !sameCursor(e.Cursor, cursor) || e.Code == "" || e.Hint == "" {
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
					failure := logFailure("build_log_interrupted", "Reconnect with FollowLogs and FollowBuildLogOptions{Cursor: details.cursor}.", cursor)
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

// Connect connects a repository: every push to its production branch builds it.
func (s *RepositoryService) Connect(ctx context.Context, opts ConnectRepositoryOptions) (*Repository, error) {
	var repository Repository
	return &repository, s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/repositories", body: opts, key: opts.IdempotencyKey}, &repository)
}

// List returns the first page of connected repositories.
func (s *RepositoryService) List(ctx context.Context, opts *RepositoryListOptions) (*Page[Repository], error) {
	query := url.Values{}
	if opts != nil {
		query = listQuery(opts.Name, opts.Label, opts.State, opts.Limit)
	}
	return listPage[Repository](ctx, s.c, "/v1/repositories", query, "")
}

// All walks every repository a list with these options finds.
func (s *RepositoryService) All(ctx context.Context, opts *RepositoryListOptions) iter.Seq2[Repository, error] {
	return walk(ctx, func() (*Page[Repository], error) { return s.List(ctx, opts) })
}

// clearable are the repository fields Clear may remove.
var clearable = map[string]bool{"name": true, "installCommand": true, "buildCommand": true, "startCommand": true, "healthPath": true}

// Update changes a connected repository's settings; its id and builds stay.
func (s *RepositoryService) Update(ctx context.Context, id string, opts UpdateRepositoryOptions) (*Repository, error) {
	body, err := fields(opts)
	if err != nil {
		return nil, err
	}
	if opts.Labels != nil {
		body["labels"] = opts.Labels
	}
	if opts.BuildEnv != nil {
		body["buildEnv"] = opts.BuildEnv
	}
	for _, field := range opts.Clear {
		if !clearable[field] {
			return nil, &Error{
				Code:    "invalid_request",
				Message: field + " cannot be cleared.",
				Hint:    "Clear name, installCommand, buildCommand, startCommand or healthPath; nothing was sent.",
				Details: map[string]any{"field": field},
			}
		}
		body[field] = nil
	}
	var repository Repository
	return &repository, s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/repositories/" + url.PathEscape(id) + ":update", body: body, key: opts.IdempotencyKey}, &repository)
}

// Disconnect disconnects a repository; its builds stay.
func (s *RepositoryService) Disconnect(ctx context.Context, id string) (*Repository, error) {
	var repository Repository
	return &repository, s.c.do(ctx, &call{method: http.MethodDelete, path: "/v1/repositories/" + url.PathEscape(id)}, &repository)
}

// InstallGithub returns a link to install Runtime's GitHub App, so private
// repositories build. Open it in a browser within 15 minutes, install the
// App on the account and repositories Runtime may read, and confirm the
// organization; then Connect a repository with Provider github.
func (s *RepositoryService) InstallGithub(ctx context.Context) (*GithubInstall, error) {
	var install GithubInstall
	return &install, s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/repositories/github:install", body: map[string]any{}}, &install)
}
