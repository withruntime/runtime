package withruntime

import (
	"context"
	"iter"
	"net/http"
	"net/url"
	"strconv"
)

// CI/CD is in private beta: an account outside the beta is refused with
// product_in_beta (403, errors.Is ErrPermissionDenied). A connected GitHub
// repository is checked on every push and pull request in sandboxes the
// runner drives for the account; only a full key connects one. Times are
// milliseconds since the epoch.

// CIRepository is a GitHub repository connected for checks.
type CIRepository struct {
	ID        string            `json:"id"`
	Name      *string           `json:"name"`
	Labels    map[string]string `json:"labels"`
	CreatedAt int64             `json:"createdAt"`
	UpdatedAt int64             `json:"updatedAt"`
	DeletedAt *int64            `json:"deletedAt"`
	Error     *ResourceError    `json:"error"`
	// Repository is owner/name on GitHub.
	Repository string `json:"repository"`
	// ProductionBranch is the branch whose pushes are checked as landed.
	ProductionBranch string `json:"productionBranch"`
	// ConfigPath is where in the repository its checks are written.
	ConfigPath string `json:"configPath"`
	// Installation is the organization's installation of Runtime's GitHub
	// App the repository is read through.
	Installation       int64  `json:"installation"`
	GithubRepositoryID *int64 `json:"githubRepositoryId"`
	// UndoCulprits is whether a red production branch's culprit is undone
	// by a pull request CI/CD opens: off until SetUndo turns it on.
	UndoCulprits bool `json:"undoCulprits"`
	// State is connected or disconnected.
	State string `json:"state"`
}

// ConnectCIRepositoryOptions connect a repository. Defaults belong to the
// API, so the SDK leaves unset fields out.
type ConnectCIRepositoryOptions struct {
	// ProductionBranch is main unless set.
	ProductionBranch string `json:"productionBranch,omitempty"`
	// ConfigPath is runtime.yml unless set.
	ConfigPath string `json:"configPath,omitempty"`
	// Installation is the GitHub App installation to read through; the
	// newest when 0.
	Installation   int               `json:"installation,omitempty"`
	Name           string            `json:"name,omitempty"`
	Labels         map[string]string `json:"labels,omitempty"`
	IdempotencyKey string            `json:"-"`
}

// CIRepositoryListOptions filter a list of repositories, every field optional.
type CIRepositoryListOptions struct {
	Name  string
	Label []string
	// State is connected or disconnected.
	State  []string
	Limit  int
	Cursor string
}

// CICheck is one check: a commit of a connected repository, run as its plan
// of jobs.
type CICheck struct {
	ID           string `json:"id"`
	RepositoryID string `json:"repositoryId"`
	// Repository is owner/name on GitHub.
	Repository string  `json:"repository"`
	Commit     string  `json:"commit"`
	Branch     *string `json:"branch"`
	// Event is push, pull_request, merge_group or rerun.
	Event       string  `json:"event"`
	PullRequest *int    `json:"pullRequest"`
	BaseCommit  *string `json:"baseCommit"`
	// Actor is the GitHub login that pushed, opened or re-ran it.
	Actor *string `json:"actor"`
	// Trusted is the repository's writers' code. A fork's pull request is
	// not, and runs nothing; a writer can open it again from a branch of the
	// repository.
	Trusted bool `json:"trusted"`
	// Waiting: queued for a writer's approval, nothing of it runs.
	Waiting    bool    `json:"waiting"`
	ApprovedBy *string `json:"approvedBy"`
	ApprovedAt *int64  `json:"approvedAt"`
	// Landed is writers' code on the production branch, or a merge group.
	Landed bool `json:"landed"`
	// State is queued, running, passed, failed or cancelled.
	State  string  `json:"state"`
	Reason *string `json:"reason"`
	// Counts is how many of its jobs are in each job state.
	Counts map[string]int `json:"counts"`
	// Machines is where its machines came from and how soon; nil until the
	// runner says.
	Machines  *CIMachines `json:"machines"`
	CreatedAt int64       `json:"createdAt"`
	UpdatedAt int64       `json:"updatedAt"`
	StartedAt *int64      `json:"startedAt"`
	EndedAt   *int64      `json:"endedAt"`
}

// CIMachines is where a check's machines came from and how soon.
type CIMachines struct {
	// Reused were woken from its pull request's own, left paused by its last check.
	Reused int `json:"reused"`
	// Pooled were woken from the repository's warm pool.
	Pooled int `json:"pooled"`
	// Forked were copies made by Forks batch forks.
	Forked int `json:"forked"`
	Forks  int `json:"forks"`
	// Created were made one at a time from the warm snapshot.
	Created int `json:"created"`
	// Kept were left paused for its pull request's next push.
	Kept int `json:"kept"`
	// FirstMs is from its first ask for machines to the first one ready;
	// ReadyMs to as many as it asked for; FirstTestMs from the check's start
	// to its first test's.
	FirstMs     *int64 `json:"firstMs"`
	ReadyMs     *int64 `json:"readyMs"`
	FirstTestMs *int64 `json:"firstTestMs"`
	// LineMs is how long it waited in its account's line for machines.
	LineMs int64 `json:"lineMs"`
}

// CIJob is one job of a check's plan: a step, or one part of a step split
// in parts.
type CIJob struct {
	ID           string   `json:"id"`
	CheckID      string   `json:"checkId"`
	RepositoryID string   `json:"repositoryId"`
	Name         string   `json:"name"`
	Part         int      `json:"part"`
	Parts        int      `json:"parts"`
	Needs        []string `json:"needs"`
	Command      string   `json:"command"`
	CacheKey     *string  `json:"cacheKey"`
	// State is queued, running, passed, failed, flaky, cached, cancelled or
	// skipped.
	State string `json:"state"`
	// CachedFrom is the passed job a cached one stands on.
	CachedFrom *string `json:"cachedFrom"`
	ExitCode   *int    `json:"exitCode"`
	Reason     *string `json:"reason"`
	// SandboxIDs are the sandboxes it ran in. A failure's may be kept
	// paused: wake it, or exec in it, with the sandbox calls.
	SandboxIDs     []string `json:"sandboxIds"`
	GithubCheckRun *int64   `json:"githubCheckRun"`
	// Review is a review step's verdict on the commit; nil for a command's
	// job.
	Review    *CIReview `json:"review"`
	Ms        *int64    `json:"ms"`
	CreatedAt int64     `json:"createdAt"`
	UpdatedAt int64     `json:"updatedAt"`
	StartedAt *int64    `json:"startedAt"`
	EndedAt   *int64    `json:"endedAt"`
}

// CIReview is a review step's verdict on one commit: it passes only with
// no findings.
type CIReview struct {
	// Verdict is pass or block.
	Verdict string `json:"verdict"`
	Summary string `json:"summary"`
	// Findings stop the merge until they are fixed.
	Findings []CIReviewFinding `json:"findings"`
	// Notes are worth a look and block nothing.
	Notes []CIReviewNote `json:"notes"`
	// Agent is the Runtime Agent that judged (an agent step's; review: is
	// its short form), Model the model the step asked for ("" when none).
	Agent string `json:"agent"`
	Model string `json:"model"`
	// Account is the Claude account a verdict from before agent steps ran
	// on; "" for an agent step's.
	Account string `json:"account,omitempty"`
	// Session is the agent session that gave the verdict.
	Session string `json:"session"`
	// Cut is true when the diff was too long and its end was not read.
	Cut bool `json:"cut"`
}

// CIReviewNote is a place in the new file (Line 0: the whole file) and
// what to look at there.
type CIReviewNote struct {
	File string `json:"file"`
	Line int    `json:"line"`
	What string `json:"what"`
}

// CIReviewFinding is what a review found that blocks: its kind (bug,
// missed-case, data-at-risk, money-at-risk, auth-bypass, ... or other),
// its place and its fix.
type CIReviewFinding struct {
	Kind string `json:"kind"`
	File string `json:"file"`
	Line int    `json:"line"`
	What string `json:"what"`
	Fix  string `json:"fix"`
}

// CICheckDetail is a check with its jobs, in plan order and without logs.
type CICheckDetail struct {
	CICheck
	Jobs []CIJob `json:"jobs"`
}

// CIJobDetail is a job with the tail of its output.
type CIJobDetail struct {
	CIJob
	// Log is at most 256 KiB, the oldest dropped first.
	Log string `json:"log"`
}

// CITestRun is one run of a test file.
type CITestRun struct {
	At    int64  `json:"at"`
	Check string `json:"check"`
	Job   string `json:"job"`
	// Outcome is passed, failed, flaky or skipped.
	Outcome string `json:"outcome"`
	Ms      *int64 `json:"ms"`
	// Writers is false for an approved outsider's run.
	Writers bool `json:"writers"`
}

// CITest is one test file of a repository: its recent time and last 20 runs.
type CITest struct {
	RepositoryID string `json:"repositoryId"`
	File         string `json:"file"`
	// Ms is its recent time, which splits jobs in parts.
	Ms int64 `json:"ms"`
	// QuarantinedSince is since when its failures do not fail a check; nil:
	// they do.
	QuarantinedSince *int64      `json:"quarantinedSince"`
	Runs             []CITestRun `json:"runs"`
	UpdatedAt        int64       `json:"updatedAt"`
}

// CITestResult is one run of a test file in a check, by commit and content
// key.
type CITestResult struct {
	File   string `json:"file"`
	Commit string `json:"commit"`
	Key    string `json:"key"`
	Passed bool   `json:"passed"`
	// Attempt is first, again (its run alone after a failure) or repeat (a
	// new test's 20, a flake's proof of 100).
	Attempt string  `json:"attempt"`
	Ms      *int64  `json:"ms"`
	Machine *string `json:"machine"`
	CheckID string  `json:"checkId"`
	JobID   string  `json:"jobId"`
	// Main is a run of the production branch's own commit.
	Main    bool    `json:"main"`
	Message *string `json:"message"`
	At      int64   `json:"at"`
}

// CIFlakeOwner is who a flake is handed to.
type CIFlakeOwner struct {
	// Login is a GitHub login, or org/team.
	Login string `json:"login"`
	// From is codeowners, last change (the pull request that last changed
	// the test) or handed (by a person).
	From        *string `json:"from"`
	PullRequest *int64  `json:"pullRequest"`
	Branch      *string `json:"branch"`
}

// CIFlakeProof is the key a flake both passed and failed under.
type CIFlakeProof struct {
	Key      string   `json:"key"`
	Commit   string   `json:"commit"`
	CheckID  string   `json:"checkId"`
	JobID    string   `json:"jobId"`
	FailedIn []string `json:"failedIn"`
	PassedIn []string `json:"passedIn"`
}

// CIFlake is a test that passed and failed on the same inputs, one run
// main's: quarantined at once (it still runs and reports, and blocks
// nothing), or still gating when protected; handed to an owner with 48
// hours to fix it or delete it with a reason; fixed once 100 runs of a main
// commit in parallel forks all pass.
type CIFlake struct {
	ID           string `json:"id"`
	RepositoryID string `json:"repositoryId"`
	File         string `json:"file"`
	// State is quarantined, gating, fixed or deleted.
	State string `json:"state"`
	Gates *struct {
		Why   string `json:"why"`
		Words string `json:"words"`
	} `json:"gates"`
	Proof   CIFlakeProof  `json:"proof"`
	Again   int64         `json:"again"`
	Owner   *CIFlakeOwner `json:"owner"`
	Since   int64         `json:"since"`
	DueAt   int64         `json:"dueAt"`
	Overdue bool          `json:"overdue"`
	Tried   *struct {
		Blob string `json:"blob"`
		At   int64  `json:"at"`
	} `json:"tried"`
	ProveAskedAt *int64  `json:"proveAskedAt"`
	DeleteReason *string `json:"deleteReason"`
	EndedAt      *int64  `json:"endedAt"`
	EndedCheckID *string `json:"endedCheckId"`
	UpdatedAt    int64   `json:"updatedAt"`
}

// CIFlakeFailure is one failed run's job, whose log Jobs.Get reads.
type CIFlakeFailure struct {
	JobID   string  `json:"jobId"`
	CheckID string  `json:"checkId"`
	Commit  string  `json:"commit"`
	Message *string `json:"message"`
	At      int64   `json:"at"`
}

// CIFlakeDetail is a flake with its test file's newest 200 runs and its
// failures' jobs.
type CIFlakeDetail struct {
	CIFlake
	Runs     []CITestResult   `json:"runs"`
	Failures []CIFlakeFailure `json:"failures"`
}

// CIFlakeListOptions filter a list of flakes, newest first, every field
// optional.
type CIFlakeListOptions struct {
	RepositoryID string
	// State is quarantined, gating, fixed or deleted; the first two are the
	// open ones.
	State []string
	// Limit is 1 to 100, 50 when 0.
	Limit  int
	Cursor string
}

// CIReleaseStep is one step a release took, as it took it: a migration's
// copy test or apply, a deploy ref moved, a server's canary or release, the
// website's deploy or promote, or a wait and why.
type CIReleaseStep struct {
	ID           int64  `json:"id"`
	RepositoryID string `json:"repositoryId"`
	// Commit is the commit the release is of.
	Commit string `json:"commit"`
	// Source is who took it: mover, or the deploy target that walked it.
	Source string `json:"source"`
	// Host is the server it was on, nil when on none.
	Host *string `json:"host"`
	Line string  `json:"line"`
	// At is Unix milliseconds.
	At int64 `json:"at"`
}

// CIReleaseListOptions filters CI.Releases.List.
type CIReleaseListOptions struct {
	RepositoryID string
	// Commit keeps one release's steps.
	Commit string
	// Limit is 1 to 100, 50 when 0.
	Limit  int
	Cursor string
}

// CIFlakeUpdate is an owner's say on an open flake, every field optional.
type CIFlakeUpdate struct {
	// Prove asks for its 100 proof runs at main's next commit.
	Prove bool `json:"prove,omitempty"`
	// Owner hands it to a GitHub login, or org/team.
	Owner string `json:"owner,omitempty"`
	// DeleteReason says why its test is deleted; the flake ends once main
	// no longer holds the file.
	DeleteReason   string `json:"deleteReason,omitempty"`
	IdempotencyKey string `json:"-"`
}

// CICheckListOptions filter a list of checks, newest first, every field
// optional.
type CICheckListOptions struct {
	RepositoryID string
	// State is queued, running, passed, failed or cancelled.
	State  []string
	Branch string
	// Commit is a full SHA.
	Commit      string
	PullRequest int
	// Limit is 1 to 100, 50 when 0.
	Limit  int
	Cursor string
}

// CITestListOptions filter a repository's test files, every field optional.
type CITestListOptions struct {
	// Quarantined: true lists only quarantined files, false only gating ones.
	Quarantined *bool
	// Limit is 1 to 100, 50 when 0.
	Limit  int
	Cursor string
}

// CIService is client.CI (private beta).
type CIService struct {
	// Repositories are the connected repositories checks come from.
	Repositories *CIRepositoryService
	Checks       *CICheckService
	Jobs         *CIJobService
	Tests        *CITestService
	// Flakes are tests that passed and failed on the same inputs.
	Flakes *CIFlakeService
	// Releases are the steps each release took.
	Releases *CIReleaseService
}

// CIRepositoryService is client.CI.Repositories.
type CIRepositoryService struct{ c *Client }

// CICheckService is client.CI.Checks.
type CICheckService struct{ c *Client }

// CIJobService is client.CI.Jobs.
type CIJobService struct{ c *Client }

// CITestService is client.CI.Tests.
type CITestService struct{ c *Client }

// CIFlakeService is client.CI.Flakes.
type CIFlakeService struct{ c *Client }

// CIReleaseService is client.CI.Releases.
type CIReleaseService struct{ c *Client }

func newCIService(c *Client) *CIService {
	return &CIService{
		Repositories: &CIRepositoryService{c: c},
		Checks:       &CICheckService{c: c},
		Jobs:         &CIJobService{c: c},
		Tests:        &CITestService{c: c},
		Flakes:       &CIFlakeService{c: c},
		Releases:     &CIReleaseService{c: c},
	}
}

// Connect connects a GitHub repository (owner/name): its pushes and pull
// requests are checked. Only a full key connects one.
func (s *CIRepositoryService) Connect(ctx context.Context, repository string, opts *ConnectCIRepositoryOptions) (*CIRepository, error) {
	body := struct {
		Repository string `json:"repository"`
		ConnectCIRepositoryOptions
	}{Repository: repository}
	key := ""
	if opts != nil {
		body.ConnectCIRepositoryOptions = *opts
		key = opts.IdempotencyKey
	}
	var connected CIRepository
	return &connected, s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/ci/repositories", body: body, key: key}, &connected)
}

func (o *CIRepositoryListOptions) query() url.Values {
	query := url.Values{}
	if o != nil {
		query = listQuery(o.Name, o.Label, o.State, o.Limit)
	}
	return query
}

// List returns the first page of connected repositories, or the one after
// opts.Cursor.
func (s *CIRepositoryService) List(ctx context.Context, opts *CIRepositoryListOptions) (*Page[CIRepository], error) {
	cursor := ""
	if opts != nil {
		cursor = opts.Cursor
	}
	return listPage[CIRepository](ctx, s.c, "/v1/ci/repositories", opts.query(), cursor)
}

// All walks every repository a list with these options finds.
func (s *CIRepositoryService) All(ctx context.Context, opts *CIRepositoryListOptions) iter.Seq2[CIRepository, error] {
	return walk(ctx, func() (*Page[CIRepository], error) { return s.List(ctx, opts) })
}

// SetUndo turns on (or off) the undo of a red production branch's culprit:
// when main's check fails, CI/CD finds the first commit that fails it and
// opens a pull request reverting it, which lands once its own check passes.
// Off until set; only an owner's or admin's full key sets it.
func (s *CIRepositoryService) SetUndo(ctx context.Context, id string, on bool) (*CIRepository, error) {
	var repo CIRepository
	body := struct {
		UndoCulprits bool `json:"undoCulprits"`
	}{on}
	return &repo, s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/ci/repositories/" + url.PathEscape(id) + ":update", body: body}, &repo)
}

// Disconnect disconnects a repository; its checks still going are cancelled.
func (s *CIRepositoryService) Disconnect(ctx context.Context, id string) (*CIRepository, error) {
	var disconnected CIRepository
	return &disconnected, s.c.do(ctx, &call{method: http.MethodDelete, path: "/v1/ci/repositories/" + url.PathEscape(id)}, &disconnected)
}

// List returns the first page of checks, newest first, or the one after
// opts.Cursor.
func (s *CICheckService) List(ctx context.Context, opts *CICheckListOptions) (*Page[CICheck], error) {
	query, cursor := url.Values{}, ""
	if opts != nil {
		setQuery(query, "repositoryId", opts.RepositoryID, "branch", opts.Branch, "commit", opts.Commit,
			"pullRequest", itoa(opts.PullRequest), "limit", itoa(opts.Limit))
		if len(opts.State) > 0 {
			query["state"] = opts.State
		}
		cursor = opts.Cursor
	}
	return listPage[CICheck](ctx, s.c, "/v1/ci/checks", query, cursor)
}

// All walks every check a list with these options finds.
func (s *CICheckService) All(ctx context.Context, opts *CICheckListOptions) iter.Seq2[CICheck, error] {
	return walk(ctx, func() (*Page[CICheck], error) { return s.List(ctx, opts) })
}

// Get reads a check with its jobs in plan order.
func (s *CICheckService) Get(ctx context.Context, id string) (*CICheckDetail, error) {
	var check CICheckDetail
	return &check, s.c.do(ctx, &call{method: http.MethodGet, path: "/v1/ci/checks/" + url.PathEscape(id)}, &check)
}

// Cancel ends a queued or running check: its jobs end and its machines are
// let go. A check that has ended is answered as it is.
func (s *CICheckService) Cancel(ctx context.Context, id string) (*CICheckDetail, error) {
	var check CICheckDetail
	return &check, s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/ci/checks/" + url.PathEscape(id) + ":cancel"}, &check)
}

// Rerun runs a check again, as GitHub's Re-run does: a new check of the same
// commit (a pull request's as it would land now), trusted only as the
// commit's last check was. A check still going is answered as it is.
func (s *CICheckService) Rerun(ctx context.Context, id string) (*CICheckDetail, error) {
	var check CICheckDetail
	return &check, s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/ci/checks/" + url.PathEscape(id) + ":rerun"}, &check)
}

// Get reads a job with the tail of its output (the last 256 KiB).
func (s *CIJobService) Get(ctx context.Context, id string) (*CIJobDetail, error) {
	var job CIJobDetail
	return &job, s.c.do(ctx, &call{method: http.MethodGet, path: "/v1/ci/jobs/" + url.PathEscape(id)}, &job)
}

// List returns the first page of a repository's test files by name, or the
// one after opts.Cursor. opts may be nil.
func (s *CITestService) List(ctx context.Context, repositoryID string, opts *CITestListOptions) (*Page[CITest], error) {
	query, cursor := setQuery(url.Values{}, "repositoryId", repositoryID), ""
	if opts != nil {
		setQuery(query, "limit", itoa(opts.Limit))
		if opts.Quarantined != nil {
			query.Set("quarantined", strconv.FormatBool(*opts.Quarantined))
		}
		cursor = opts.Cursor
	}
	return listPage[CITest](ctx, s.c, "/v1/ci/tests", query, cursor)
}

// All walks every test file a list with these options finds.
func (s *CITestService) All(ctx context.Context, repositoryID string, opts *CITestListOptions) iter.Seq2[CITest, error] {
	return walk(ctx, func() (*Page[CITest], error) { return s.List(ctx, repositoryID, opts) })
}

// List returns the first page of flakes, newest first, or the one after
// opts.Cursor. opts may be nil.
func (s *CIFlakeService) List(ctx context.Context, opts *CIFlakeListOptions) (*Page[CIFlake], error) {
	query, cursor := url.Values{}, ""
	if opts != nil {
		setQuery(query, "repositoryId", opts.RepositoryID, "limit", itoa(opts.Limit))
		if len(opts.State) > 0 {
			query["state"] = opts.State
		}
		cursor = opts.Cursor
	}
	return listPage[CIFlake](ctx, s.c, "/v1/ci/flakes", query, cursor)
}

// All walks every flake a list with these options finds.
func (s *CIFlakeService) All(ctx context.Context, opts *CIFlakeListOptions) iter.Seq2[CIFlake, error] {
	return walk(ctx, func() (*Page[CIFlake], error) { return s.List(ctx, opts) })
}

// Get reads a flake with its test file's newest 200 runs and its failures'
// jobs.
func (s *CIFlakeService) Get(ctx context.Context, id string) (*CIFlakeDetail, error) {
	var flake CIFlakeDetail
	return &flake, s.c.do(ctx, &call{method: http.MethodGet, path: "/v1/ci/flakes/" + url.PathEscape(id)}, &flake)
}

// Update asks for a flake's 100 proof runs again, hands it on, or says why
// its test is deleted.
func (s *CIFlakeService) Update(ctx context.Context, id string, change CIFlakeUpdate) (*CIFlakeDetail, error) {
	var flake CIFlakeDetail
	return &flake, s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/ci/flakes/" + url.PathEscape(id) + ":update", body: change, key: change.IdempotencyKey}, &flake)
}

// List returns the first page of release steps, newest first, or the one
// after opts.Cursor. opts may be nil.
func (s *CIReleaseService) List(ctx context.Context, opts *CIReleaseListOptions) (*Page[CIReleaseStep], error) {
	query, cursor := url.Values{}, ""
	if opts != nil {
		setQuery(query, "repositoryId", opts.RepositoryID, "commit", opts.Commit, "limit", itoa(opts.Limit))
		cursor = opts.Cursor
	}
	return listPage[CIReleaseStep](ctx, s.c, "/v1/ci/releases", query, cursor)
}

// All walks every step a list with these options finds.
func (s *CIReleaseService) All(ctx context.Context, opts *CIReleaseListOptions) iter.Seq2[CIReleaseStep, error] {
	return walk(ctx, func() (*Page[CIReleaseStep], error) { return s.List(ctx, opts) })
}
