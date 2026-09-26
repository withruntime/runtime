package withruntime

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// Preview is a public HTTPS address for a port inside a sandbox, under
// runtimehost.com.
type Preview struct {
	ID        string `json:"id"`
	SandboxID string `json:"sandboxId"`
	Port      int    `json:"port"`
	// Visibility is "private" (a token is needed) or "public".
	Visibility string `json:"visibility"`
	URL        string `json:"url"`
	// Token is a private preview's fresh signed token. Send it as the
	// x-runtime-preview-token header.
	Token          *string    `json:"token"`
	TokenExpiresAt *time.Time `json:"tokenExpiresAt"`
	// URLWithToken is a link that carries the token once, for a browser.
	URLWithToken *string   `json:"urlWithToken"`
	Disabled     bool      `json:"disabled"`
	CreatedAt    time.Time `json:"createdAt"`
	Hint         string    `json:"hint,omitempty"`
}

// PreviewOptions are a preview's options.
type PreviewOptions struct {
	// Visibility is "private" (the default) or "public". A browser sees a
	// one-time warning page naming Runtime on a public one.
	Visibility string `json:"visibility,omitempty"`
	// TTL is how long the returned token lasts, 60 s to 7 days (default a day).
	TTL time.Duration `json:"-"`
}

// Previews shares a sandbox's ports. WebSockets work; the server must listen
// on 0.0.0.0 or localhost.
type Previews struct {
	c       *Client
	sandbox *Sandbox
}

func (p *Previews) path(suffix string) string { return p.sandbox.path("/previews" + suffix) }

// Create shares port, or changes its visibility if it is shared already.
func (p *Previews) Create(ctx context.Context, port int, opts *PreviewOptions) (*Preview, error) {
	body := map[string]any{"port": port}
	if opts != nil {
		if opts.Visibility != "" {
			body["visibility"] = opts.Visibility
		}
		if opts.TTL > 0 {
			body["ttlSeconds"] = int(opts.TTL.Seconds())
		}
	}
	var preview Preview
	return &preview, p.c.do(ctx, &call{method: http.MethodPost, path: p.path(""), body: body}, &preview)
}

// List returns every shared port, each private one with a fresh token.
func (p *Previews) List(ctx context.Context) ([]Preview, error) {
	var body struct {
		Data []Preview `json:"data"`
	}
	err := p.c.do(ctx, &call{method: http.MethodGet, path: p.path("")}, &body)
	return body.Data, err
}

// Get returns one preview, with a fresh token of ttl (when not zero) if it is
// private.
func (p *Previews) Get(ctx context.Context, port int, ttl time.Duration) (*Preview, error) {
	var query url.Values
	if ttl > 0 {
		query = url.Values{"ttlSeconds": {strconv.Itoa(int(ttl.Seconds()))}}
	}
	var preview Preview
	return &preview, p.c.do(ctx, &call{method: http.MethodGet, path: p.path("/" + strconv.Itoa(port)), query: query}, &preview)
}

// Rotate refuses every token issued for this port so far and returns a new one.
func (p *Previews) Rotate(ctx context.Context, port int) (*Preview, error) {
	var preview Preview
	return &preview, p.c.do(ctx, &call{method: http.MethodPost, path: p.path("/" + strconv.Itoa(port) + ":rotate")}, &preview)
}

// Delete stops sharing port. Open connections close within seconds.
func (p *Previews) Delete(ctx context.Context, port int) error {
	return p.c.do(ctx, &call{method: http.MethodDelete, path: p.path("/" + strconv.Itoa(port))}, nil)
}
