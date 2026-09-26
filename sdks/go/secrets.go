package withruntime

import (
	"context"
	"net/http"
	"net/url"
	"time"
)

// Secret is a value your sandboxes use without seeing it. Every sandbox of the
// organization has an environment variable of the secret's name holding
// Placeholder; the egress proxy puts the value into HTTPS requests to Hosts,
// or sets Header on every such request. The value is never returned.
type Secret struct {
	Name        string    `json:"name"`
	Hosts       []string  `json:"hosts"`
	Header      string    `json:"header,omitempty"`
	Format      string    `json:"format,omitempty"`
	Placeholder string    `json:"placeholder"`
	ValueBytes  int       `json:"valueBytes"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
	// Enforced is set on Set and Delete: the hosts confirmed the change.
	Enforced bool `json:"enforced,omitempty"`
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
}

// SecretService is client.Secrets.
type SecretService struct{ c *Client }

func secretPath(name string) string { return "/v1/egress-secrets/" + url.PathEscape(name) }

// Set stores or replaces a secret. Replacing keeps its placeholder.
func (s *SecretService) Set(ctx context.Context, name string, opts SetSecretOptions) (*Secret, error) {
	var secret Secret
	return &secret, s.c.do(ctx, &call{method: http.MethodPut, path: secretPath(name), body: opts}, &secret)
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
