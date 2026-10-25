package withruntime

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// Version is this SDK's version, sent as X-Runtime-Client.
const Version = "0.20.0"

// DefaultBaseURL is Runtime's API.
const DefaultBaseURL = "https://api.withruntime.com"

// Client is one client for every Runtime product. Make it once and share it:
// it is safe for concurrent use and keeps its connections open.
type Client struct {
	baseURL         string
	apiKey          string
	http            *http.Client
	timeout         time.Duration
	maxRetries      int
	waitForCapacity time.Duration
	slots           chan struct{}
	userAgent       string
	// pause waits out a retry's backoff; nil is the real clock (sleep). The
	// SDK's own tests set a clock that keeps the waits without spending them.
	pause func(ctx context.Context, d time.Duration) error

	// Sandboxes creates, finds and lists sandboxes.
	Sandboxes *SandboxService
	// Snapshots takes, reads, lists and deletes kept snapshots.
	Snapshots *SnapshotService
	// Images builds custom images to start sandboxes from.
	Images *ImageService
	// Volumes are persistent disks to attach when creating a sandbox.
	Volumes *VolumeService
	// Secrets are values sandboxes use on the way out without seeing them.
	Secrets *SecretService
	// Limits says what this key may do and spend.
	Limits *LimitService
	// Reservations book room for a burst, or keep standing room until
	// cancelled.
	Reservations *ReservationService
	// Emails are which of Runtime's optional emails this key's person gets.
	Emails *EmailService
	// Referrals is the account's referral link and what it earned.
	Referrals *ReferralService
	// Plans are monthly plans whose fee is prepaid usage.
	Plans *PlanService
	// Switching compares usage with a rival's rates and records a switch.
	Switching *SwitchingService
	// Events lists the account's lifecycle events.
	Events *EventService
	// Webhooks POSTs signed lifecycle events to your URL.
	Webhooks *WebhookService
	// Otel pushes events and metrics to an OpenTelemetry endpoint.
	Otel *OtelService
	// Audit reads the account's audit log.
	Audit *AuditService
	// Feedback tells the Runtime team something.
	Feedback *FeedbackService
	// Support asks Runtime support.
	Support *SupportService
	Domains *DomainService
	Ports   *PortService
	// IPs reserves dedicated outbound addresses.
	IPs *AddressService
	// Networks holds the account's networks: WireGuard into your sandboxes.
	Networks *NetworkService
	SSO      *SSOService
	MCP      *MCPService
	// Agents runs your agents, each piece of work a session in its own
	// sandbox (private beta: an account outside it is refused 403
	// product_in_beta).
	Agents *AgentService
	// Apps are servers of one image or build that scale with requests and
	// can keep copies awake. Private beta.
	Apps *AppService
	// Functions are Apps that sleep when idle. Private beta.
	Functions *AppService
	// Builds builds connected repositories. Private beta.
	Builds *BuildService
	// CI checks connected repositories on each push and pull request.
	// Private beta.
	CI *CIService
	// Containers run one OCI image's process each on its own microVM, at
	// the sandbox rates. Private beta.
	Containers *ContainerService

	// Deprecated: renamed IPs on 6 October 2026 (one plural word per
	// product); the old name is the same service until a release after its
	// 30 days of overlap removes it.
	Addresses *AddressService
	// Deprecated: renamed Networks.WireGuard on 6 October 2026; the old name
	// is the same service until a release after its 30 days of overlap
	// removes it.
	Tunnel *PrivateTunnelService
}

// NetworkService is the account's networks.
type NetworkService struct {
	// WireGuard is a tunnel from your own network into your sandboxes.
	WireGuard *PrivateTunnelService
}

// Option configures a Client.
type Option func(*Client) error

// WithAPIKey sets the key. Without it the client uses RUNTIME_API_KEY, and
// otherwise the connection `npx withruntime login` saved on this machine.
func WithAPIKey(key string) Option {
	return func(c *Client) error {
		if key == "" || strings.ContainsAny(key, " \t\r\n") {
			return errors.New("withruntime: the API key is empty or contains whitespace")
		}
		c.apiKey = key
		return nil
	}
}

// WithBaseURL points the client at another API origin. The default is
// RUNTIME_API_URL, then https://api.withruntime.com. Inside a Runtime sandbox,
// calls for https://api.withruntime.com go to http://runtime.internal.
func WithBaseURL(value string) Option {
	return func(c *Client) error {
		normalized, err := origin(value)
		c.baseURL = normalized
		return err
	}
}

// WithHTTPClient replaces the HTTP client. Its redirect policy is replaced:
// the API never redirects, so a redirect is refused. The default honours
// HTTPS_PROXY and NO_PROXY.
func WithHTTPClient(client *http.Client) Option {
	return func(c *Client) error {
		copied := *client
		c.http = &copied
		return nil
	}
}

// WithTimeout is the deadline for each call, retries included, unless the
// context's is sooner. Default 5 minutes.
func WithTimeout(d time.Duration) Option {
	return func(c *Client) error {
		c.timeout = d
		return nil
	}
}

// WithMaxRetries is how many times a transport failure, 429, 502, 503 or 504
// is retried, with the same idempotency key. Default 4.
func WithMaxRetries(n int) Option {
	return func(c *Client) error {
		if n < 0 {
			return errors.New("withruntime: max retries cannot be negative")
		}
		c.maxRetries = n
		return nil
	}
}

// WithWaitForCapacity is how long Sandboxes.Create keeps retrying, with the
// same key and input, when every slot without credit, the account's quota or the region
// is full (no_credit_running_limit, quota_exceeded, no_capacity and the like). Default two
// minutes; 0 fails at once.
func WithWaitForCapacity(d time.Duration) Option {
	return func(c *Client) error {
		if d < 0 {
			d = 0
		}
		c.waitForCapacity = d
		return nil
	}
}

// WithMaxConnections is how many calls may be in flight at once; more wait
// their turn and reuse connections. Streams do not count. Default 32.
func WithMaxConnections(n int) Option {
	return func(c *Client) error {
		if n < 1 {
			n = 1
		}
		c.slots = make(chan struct{}, n)
		return nil
	}
}

// New makes a client. The key is the one given with WithAPIKey, then
// RUNTIME_API_KEY, then the connection `npx withruntime login` saved for this
// machine; with none, New returns an *Error whose Code is missing_api_key.
func New(options ...Option) (*Client, error) {
	c := &Client{
		timeout:         5 * time.Minute,
		maxRetries:      4,
		waitForCapacity: 2 * time.Minute,
		slots:           make(chan struct{}, 32),
		userAgent:       "sdk-go/" + Version,
	}
	base := os.Getenv("RUNTIME_API_URL")
	if base == "" {
		base = DefaultBaseURL
	}
	normalized, err := origin(base)
	if err != nil {
		return nil, err
	}
	c.baseURL = normalized
	for _, option := range options {
		if err := option(c); err != nil {
			return nil, err
		}
	}
	if c.http == nil {
		c.http = &http.Client{Transport: http.DefaultTransport}
	}
	c.http.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	if c.apiKey == "" {
		if env := os.Getenv("RUNTIME_API_KEY"); env != "" {
			if strings.ContainsAny(env, " \t\r\n") {
				return nil, errors.New("withruntime: RUNTIME_API_KEY is invalid")
			}
			c.apiKey = env
		} else {
			key, err := savedKey(c.baseURL)
			if err != nil {
				return nil, err
			}
			if key == "" {
				return nil, missingKey()
			}
			c.apiKey = key
		}
	}
	// The saved key above is found by the origin as given; the calls go where
	// that origin is reachable from here.
	c.baseURL = reachable(c.baseURL, inRuntimeSandbox)
	c.Sandboxes = &SandboxService{c: c}
	c.Snapshots = &SnapshotService{c: c}
	c.Images = &ImageService{c: c, Registries: &RegistryService{c: c}}
	c.Volumes = &VolumeService{c: c}
	c.Secrets = &SecretService{c: c}
	c.Limits = &LimitService{c: c}
	c.Reservations = &ReservationService{c: c}
	c.Emails = &EmailService{c: c}
	c.Referrals = &ReferralService{c: c}
	c.Plans = &PlanService{c: c}
	c.Switching = &SwitchingService{c: c}
	c.Events = &EventService{c: c}
	c.Webhooks = &WebhookService{c: c}
	c.Otel = &OtelService{c: c}
	c.Audit = &AuditService{c: c}
	c.Feedback = &FeedbackService{c: c}
	c.Support = &SupportService{c: c}
	c.Domains = &DomainService{c: c}
	c.Ports = &PortService{c: c}
	c.IPs = &AddressService{c: c}
	c.Networks = &NetworkService{WireGuard: &PrivateTunnelService{c: c}}
	c.Addresses = c.IPs
	c.Tunnel = c.Networks.WireGuard
	c.SSO = &SSOService{c: c}
	c.MCP = &MCPService{c: c}
	c.Agents = newAgentService(c)
	c.Apps = &AppService{c: c, base: "/v1/apps", apps: true}
	c.Functions = &AppService{c: c, base: "/v1/functions"}
	c.Builds = &BuildService{c: c, Repositories: &RepositoryService{c: c}}
	c.CI = newCIService(c)
	c.Containers = &ContainerService{c: c}
	return c, nil
}

// BaseURL is the API origin this client calls.
func (c *Client) BaseURL() string { return c.baseURL }

// Me says who this key is: organization, agent and credential.
func (c *Client) Me(ctx context.Context) (*Me, error) {
	var me Me
	return &me, c.do(ctx, &call{method: http.MethodGet, path: "/v1/me"}, &me)
}

// Usage is the account's credit, holds, free time and per-resource charges.
func (c *Client) Usage(ctx context.Context) (*Usage, error) {
	var usage Usage
	return &usage, c.do(ctx, &call{method: http.MethodGet, path: "/v1/usage"}, &usage)
}

// UsageExportOptions select settled usage by when it settled: Since is
// inclusive and Until exclusive, UTC times ending in Z. Cursor is the last
// page's NextCursor; Limit is the page size (0 is the server's).
type UsageExportOptions struct {
	Since  string
	Until  string
	Cursor string
	Limit  int
}

// UsageExportRow is one settled interval. Money and quantities are exact
// decimal strings.
type UsageExportRow struct {
	IntervalID string  `json:"intervalId"`
	ResourceID string  `json:"resourceId"`
	Name       *string `json:"name"`
	Kind       string  `json:"kind"`
	Meter      string  `json:"meter"`
	// FundedBy is credit, trial or allowance (the month's free usage).
	FundedBy           string  `json:"fundedBy"`
	StartsAt           string  `json:"startsAt"`
	EndsAt             string  `json:"endsAt"`
	SettledAt          string  `json:"settledAt"`
	BilledMilliseconds *string `json:"billedMilliseconds"`
	ChargedMicros      string  `json:"chargedMicros"`
	QuotedRates        []struct {
		Component  string `json:"component"`
		Unit       string `json:"unit"`
		RateMicros string `json:"rateMicros"`
	} `json:"quotedRates"`
	// MeasurementsJSON is exact JSON text, or nil.
	MeasurementsJSON *string `json:"measurementsJson"`
	// Evidence is measured, partial or missing, or nil.
	Evidence *string `json:"evidence"`
	// Final: the resource is deleted and every charge it will ever have
	// settled before the page's FinalThrough. A volume's backups bill on
	// until their retention ends.
	Final bool `json:"final"`
}

// UsageExportPage is one page of the export.
type UsageExportPage struct {
	Since      string           `json:"since"`
	Until      string           `json:"until"`
	Data       []UsageExportRow `json:"data"`
	NextCursor *string          `json:"nextCursor"`
	// FinalThrough: no row settled before it can still appear or change;
	// the range is final once it reaches Until. Nil when it could not be
	// taken in time: read again.
	FinalThrough *string `json:"finalThrough"`
	// CSV: concatenate pages in order; only the first has the header.
	CSV string `json:"csv"`
}

// UsageExport reads one page of settled usage for every product the key
// sees. Follow NextCursor with the same range until it is nil.
func (c *Client) UsageExport(ctx context.Context, options UsageExportOptions) (*UsageExportPage, error) {
	var page UsageExportPage
	query := setQuery(url.Values{}, "since", options.Since, "until", options.Until, "cursor", options.Cursor, "limit", itoa(options.Limit))
	return &page, c.do(ctx, &call{method: http.MethodGet, path: "/v1/usage/export", query: query}, &page)
}

// RequestOptions are what Request takes, every field optional.
type RequestOptions struct {
	Query url.Values
	// Body is sent as JSON.
	Body any
	// IdempotencyKey: made for you on a write when empty.
	IdempotencyKey string
	// Wait is how many seconds the server may hold the answer (Prefer: wait=N).
	Wait    int
	Timeout time.Duration
}

// Request calls any API path with this client's key, retries, idempotency
// keys and errors, and decodes the JSON answer into out (which may be nil).
// It is for an endpoint newer than this SDK; the typed services cover the rest.
//
//	var page map[string]any
//	err := client.Request(ctx, "GET", "/v1/volumes", nil, &page)
func (c *Client) Request(ctx context.Context, method, path string, opts *RequestOptions, out any) error {
	if opts == nil {
		opts = &RequestOptions{}
	}
	if !strings.HasPrefix(path, "/") {
		return errors.New("withruntime: the path must start with /")
	}
	body := opts.Body
	if body == nil && method != http.MethodGet && method != http.MethodDelete {
		body = map[string]any{}
	}
	return c.do(ctx, &call{method: method, path: path, query: opts.Query, body: body, key: opts.IdempotencyKey, wait: opts.Wait, timeout: opts.Timeout}, out)
}
