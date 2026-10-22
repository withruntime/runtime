package withruntime

import (
	"context"
	"net/http"
	"net/url"
	"time"
)

// SecretRule says which requests to a secret's hosts carry it: Methods (every
// method when empty) and Paths, each exact ("/v1/chat/completions") or a prefix
// ending in "/*" ("/repos/acme/*"), written canonically: starting with "/", no
// "." or ".." segments, no ";" or "\", no encoded slash. A request whose path
// could be read two ways gets no secret that has rules. Needs credit on the
// account.
type SecretRule struct {
	Methods []string `json:"methods,omitempty"`
	Paths   []string `json:"paths"`
}

// SecretScope says which sandboxes get a secret: those whose labels hold every
// pair of any one selector in Labels (1 to 8 selectors of 1 to 8 pairs,
// including sandboxes created or labelled later), those named in Sandboxes
// (1 to 100 ids of the organization), and every copy of the Apps named in Apps
// (1 to 100 App ids, any version a key that may reveal secrets deployed). Any
// other sandbox sees no placeholder, and its requests never carry the value.
// The empty scope is every sandbox of the organization.
type SecretScope struct {
	Labels    []map[string]string `json:"labels,omitempty"`
	Sandboxes []string            `json:"sandboxes,omitempty"`
	Apps      []string            `json:"apps,omitempty"`
}

// SecretGithubApp is a GitHub App the servers act as. The secret's value is the
// App's private key (PEM); the servers make its installation tokens themselves,
// each for an hour. The key goes into no request, and each request the rules
// allow carries the current token: Authorization: Bearer to the API, and git's
// x-access-token to git over HTTPS. Takes no Header or Format.
type SecretGithubApp struct {
	// ID is the App's id.
	ID int64 `json:"id"`
	// Installation is the installation's id: where the App is installed.
	Installation int64 `json:"installation"`
	// Repositories are the repositories each token reaches, by name. Empty:
	// every repository of the installation.
	Repositories []string `json:"repositories,omitempty"`
	// Permissions is what each token may do, at most what the App holds
	// ("contents": "write"; read, write or admin). Empty: all the App's
	// permissions.
	Permissions map[string]string `json:"permissions,omitempty"`
	// API is the App's API on GitHub Enterprise Server (https://<host>/api/v3);
	// one of Hosts. Default https://api.github.com.
	API string `json:"api,omitempty"`
}

// SecretGit is what a git push over HTTPS carrying the secret may update. A
// push to any other ref, a tag, or a delete is refused before it leaves the
// server, in git's own words (! [remote rejected]).
type SecretGit struct {
	// Push are the branches a push may update: refs/heads/ then a name, with *
	// only at the end for any name that begins so, and {label.<key>} for the
	// sandbox's own label of that key (a sandbox without it pushes nothing it
	// names): "refs/heads/task/{label.task}", "refs/heads/task/{label.task}--*".
	// Empty: no push at all.
	Push []string `json:"push"`
}

// SecretGraphQL names the GraphQL mutations a request may make; a query always
// goes.
type SecretGraphQL struct {
	// Path is where GraphQL is served. Default /graphql.
	Path string `json:"path,omitempty"`
	// Mutations are the ones a request may make; any other is refused with 403.
	Mutations []string `json:"mutations"`
}

// SecretAPIPolicy is each sandbox's hour with the secret, the far end's
// reserve, GraphQL's mutations and shared copies.
type SecretAPIPolicy struct {
	// CallsPerHour is the most requests each sandbox makes with the secret in an
	// hour; past it, 429 with Retry-After.
	CallsPerHour *int `json:"callsPerHour,omitempty"`
	// WritesPerHour is the most writes (any method but GET, HEAD and OPTIONS; a
	// GraphQL mutation) each sandbox makes in an hour. 0: none.
	WritesPerHour *int `json:"writesPerHour,omitempty"`
	// Keep is calls the far end keeps for others: none is sent while its
	// x-ratelimit-remaining says this many or fewer are left, until its reset.
	Keep *int `json:"keep,omitempty"`
	// Copies answers reads (GET over HTTP/2) from the server's copy while the
	// far end answers 304 to its ETag, shared by every sandbox the secret reaches
	// on that server; past a sandbox's hour, from the copy unasked. Answers carry
	// x-runtime-copy.
	Copies bool `json:"copies,omitempty"`
	// Fresh, with Copies, is 1 to 300 seconds a copy is answered without asking
	// the far end, GraphQL queries included.
	Fresh *int `json:"fresh,omitempty"`
	// GraphQL names the mutations a request may make.
	GraphQL *SecretGraphQL `json:"graphql,omitempty"`
}

// Secret is a value your sandboxes use without seeing it. Every sandbox of the
// organization has an environment variable of the secret's name holding
// Placeholder; the egress proxy puts the value into HTTPS requests to Hosts,
// or sets Header on every such request. Rules, when present, limit it to the
// requests a rule allows. The value is never returned.
type Secret struct {
	Name   string       `json:"name"`
	Hosts  []string     `json:"hosts"`
	Header string       `json:"header,omitempty"`
	Format string       `json:"format,omitempty"`
	Rules  []SecretRule `json:"rules,omitempty"`
	// Only is who gets the secret; nil is every sandbox of the organization.
	Only *SecretScope `json:"only,omitempty"`
	// Env is the environment variable sandboxes see it in, when not the secret's
	// name. Secrets scoped to different sandboxes may share one, such as one
	// GITHUB_TOKEN per repository.
	Env         string    `json:"env,omitempty"`
	Placeholder string    `json:"placeholder"`
	ValueBytes  int       `json:"valueBytes"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
	// GithubApp, Git and API are as they were set; nil when not set.
	GithubApp *SecretGithubApp `json:"githubApp,omitempty"`
	Git       *SecretGit       `json:"git,omitempty"`
	API       *SecretAPIPolicy `json:"api,omitempty"`
	// Enforced is set on Set, Scope, Narrow and Delete: the hosts confirmed the change.
	Enforced bool `json:"enforced,omitempty"`
}

// NarrowSecretOptions are what a secret narrows to. Give Hosts, Rules or both.
type NarrowSecretOptions struct {
	Hosts []string     `json:"hosts,omitempty"`
	Rules []SecretRule `json:"rules,omitempty"`
}

// SetSecretOptions are a secret's fields. Value and Hosts are required.
type SetSecretOptions struct {
	// Value is visible ASCII and spaces, at most 8 KiB (with GithubApp, the
	// App's PEM private key). Stored sealed.
	Value string `json:"value"`
	// Hosts are where the value may go: "api.openai.com", "*.github.com".
	Hosts []string `json:"hosts"`
	// Header is set on every request to the hosts, replacing the sandbox's own.
	Header string `json:"header,omitempty"`
	// Format is the header's value, with {value} where the secret goes.
	Format string `json:"format,omitempty"`
	// Rules limit the value to the requests a rule allows (1 to 16). Empty:
	// every request to the hosts; replacing a secret without rules clears them.
	Rules []SecretRule `json:"rules,omitempty"`
	// Only gives the secret to these sandboxes. Nil when replacing a secret: the
	// scope it has stays, so a new value never widens who gets it. An empty
	// SecretScope: every sandbox of the organization again.
	Only *SecretScope `json:"only,omitempty"`
	// GithubApp makes Value a GitHub App's private key (PEM); the servers make
	// the App's installation tokens themselves. Takes no Header or Format.
	GithubApp *SecretGithubApp `json:"githubApp,omitempty"`
	// Git limits what a git push over HTTPS carrying the secret may update. Nil:
	// the secret limits no push.
	Git *SecretGit `json:"git,omitempty"`
	// API sets each sandbox's hour with the secret, the far end's reserve,
	// GraphQL's mutations and shared copies.
	API *SecretAPIPolicy `json:"api,omitempty"`
	// Env is the environment variable sandboxes see it in, when not the secret's
	// name. Secrets scoped to different sandboxes may share one, such as one
	// GITHUB_TOKEN per repository; a write that would put two in one sandbox is
	// refused (409). Empty when replacing: the variable it has stays.
	Env string `json:"env,omitempty"`
}

// SecretService is client.Secrets.
type SecretService struct{ c *Client }

func secretPath(name string) string { return "/v1/egress-secrets/" + url.PathEscape(name) }

// Set stores or replaces a secret. Replacing keeps its placeholder.
func (s *SecretService) Set(ctx context.Context, name string, opts SetSecretOptions) (*Secret, error) {
	if opts.Git != nil && opts.Git.Push == nil {
		// An empty list means no push at all; it is sent as [], never null.
		opts.Git = &SecretGit{Push: []string{}}
	}
	var secret Secret
	return &secret, s.c.do(ctx, &call{method: http.MethodPut, path: secretPath(name), body: opts}, &secret)
}

// Scope changes which sandboxes get a secret, without its value:
// &SecretScope{} is every sandbox of the organization again. Enforced is set
// on the secret returned.
func (s *SecretService) Scope(ctx context.Context, name string, only SecretScope) (*Secret, error) {
	var secret Secret
	return &secret, s.c.do(ctx, &call{method: http.MethodPut, path: secretPath(name) + "/sandboxes", body: only}, &secret)
}

// Narrow limits a secret's hosts and/or rules without its value. Only
// strictly narrower ones are accepted; widening needs the value (call Set again
// with it).
func (s *SecretService) Narrow(ctx context.Context, name string, opts NarrowSecretOptions) (*Secret, error) {
	var secret Secret
	return &secret, s.c.do(ctx, &call{method: http.MethodPut, path: secretPath(name) + "/rules", body: opts}, &secret)
}

// List returns names, hosts and placeholders. Never values.
func (s *SecretService) List(ctx context.Context) ([]Secret, error) {
	var body struct {
		Secrets []Secret `json:"secrets"`
	}
	err := s.c.do(ctx, &call{method: http.MethodGet, path: "/v1/egress-secrets"}, &body)
	return body.Secrets, err
}

// Delete erases a secret's value; its placeholder stops working.
func (s *SecretService) Delete(ctx context.Context, name string) error {
	return s.c.do(ctx, &call{method: http.MethodDelete, path: secretPath(name)}, nil)
}
