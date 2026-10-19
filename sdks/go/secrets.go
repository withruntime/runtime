package withruntime

import (
	"context"
	"net/http"
	"net/url"
	"time"
)

// SecretScope says which sandboxes get a secret: those whose labels hold every
// pair of any one selector in Labels (1 to 8 selectors of 1 to 8 pairs,
// including sandboxes created or labelled later), and those named in Sandboxes
// (1 to 100 ids of the organization). Any other sandbox sees no placeholder,
// and its requests never carry the value. The empty scope is every sandbox of
// the organization.
type SecretScope struct {
	Labels    []map[string]string `json:"labels,omitempty"`
	Sandboxes []string            `json:"sandboxes,omitempty"`
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
	Only        *SecretScope `json:"only,omitempty"`
	Placeholder string       `json:"placeholder"`
	ValueBytes  int          `json:"valueBytes"`
	CreatedAt   time.Time    `json:"createdAt"`
	UpdatedAt   time.Time    `json:"updatedAt"`
	// Enforced is set on Set, Scope, Narrow and Delete: the hosts confirmed the change.
	Enforced bool `json:"enforced,omitempty"`
}

// SecretRule is one kind of request a secret may ride on: Methods (every
// method when empty) and Paths, each exact or a prefix ending in "/*".
type SecretRule struct {
	Methods []string `json:"methods,omitempty"`
	Paths   []string `json:"paths"`
}

// NarrowSecretOptions are what a secret narrows to. Give Hosts, Rules or both.
type NarrowSecretOptions struct {
	Hosts []string     `json:"hosts,omitempty"`
	Rules []SecretRule `json:"rules,omitempty"`
}

// SetSecretOptions are a secret's fields. Value and Hosts are required.
type SetSecretOptions struct {
	// Value is visible ASCII and spaces, at most 8 KiB. Stored sealed.
	Value string `json:"value"`
	// Hosts are where the value may go: "api.openai.com", "*.github.com".
	Hosts []string `json:"hosts"`
	// Header is set on every request to the hosts, replacing the sandbox's own.
	Header string `json:"header,omitempty"`
	// Format is the header's value, with {value} where the secret goes.
	Format string `json:"format,omitempty"`
	// Only gives the secret to some sandboxes instead of all of them. Nil when
	// replacing a secret: the scope it has stays, so a new value never widens
	// who gets it. &SecretScope{} is every sandbox of the organization again.
	Only *SecretScope `json:"only,omitempty"`
}

// SecretService is client.Secrets.
type SecretService struct{ c *Client }

func secretPath(name string) string { return "/v1/egress-secrets/" + url.PathEscape(name) }

// Set stores or replaces a secret. Replacing keeps its placeholder.
func (s *SecretService) Set(ctx context.Context, name string, opts SetSecretOptions) (*Secret, error) {
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
