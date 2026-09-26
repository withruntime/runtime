package withruntime

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"iter"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// MetricPoint is one bucket of a sandbox's measured CPU and memory.
type MetricPoint struct {
	At             time.Time `json:"at"`
	CPUPercent     *float64  `json:"cpuPercent"`
	CPUCores       *float64  `json:"cpuCores"`
	CPUPeakPercent *float64  `json:"cpuPeakPercent"`
	MemoryBytes    int64     `json:"memoryBytes"`
	MemoryPeak     int64     `json:"memoryPeakBytes"`
	Samples        int       `json:"samples"`
}

// SandboxMetrics is a sandbox's CPU and memory over a range.
type SandboxMetrics struct {
	SandboxID        string        `json:"sandboxId"`
	Range            string        `json:"range"`
	StepSeconds      int           `json:"stepSeconds"`
	Since            time.Time     `json:"since"`
	Until            time.Time     `json:"until"`
	VCPU             int           `json:"vcpu"`
	MemoryLimitBytes int64         `json:"memoryLimitBytes"`
	DiskLimitBytes   int64         `json:"diskLimitBytes"`
	State            string        `json:"state"`
	Latest           *MetricPoint  `json:"latest"`
	Points           []MetricPoint `json:"points"`
}

// Metrics returns this sandbox's measured CPU and memory over rng: 15m, 1h,
// 6h, 24h, 7d or 30d ("" is the server's default).
func (s *Sandbox) Metrics(ctx context.Context, rng string) (*SandboxMetrics, error) {
	var metrics SandboxMetrics
	return &metrics, s.c.do(ctx, &call{method: http.MethodGet, path: s.path("/metrics"), query: setQuery(url.Values{}, "range", rng)}, &metrics)
}

// Event is a lifecycle event, as client.Events lists it and a webhook
// delivers it: sandbox.created, sandbox.running, sandbox.paused,
// sandbox.woken, sandbox.stopped, snapshot.ready, volume.ready and the rest.
type Event struct {
	ID         string    `json:"id"`
	Type       string    `json:"type"`
	CreatedAt  time.Time `json:"createdAt"`
	ResourceID *string   `json:"resourceId"`
	// Data is the resource as it was: data.sandbox, data.snapshot or data.volume.
	Data map[string]any `json:"data"`
}

// EventListOptions filter events.
type EventListOptions struct {
	ResourceID string
	Type       string
	Limit      int
}

// EventService is client.Events.
type EventService struct{ c *Client }

// List returns the first page of lifecycle events, newest first.
func (s *EventService) List(ctx context.Context, opts *EventListOptions) (*Page[Event], error) {
	query := url.Values{}
	if opts != nil {
		setQuery(query, "resourceId", opts.ResourceID, "type", opts.Type, "limit", itoa(opts.Limit))
	}
	return listPage[Event](ctx, s.c, "/v1/events", query, "")
}

// All walks every event a list with these options finds.
func (s *EventService) All(ctx context.Context, opts *EventListOptions) iter.Seq2[Event, error] {
	return walk(ctx, func() (*Page[Event], error) { return s.List(ctx, opts) })
}

// Webhook is an endpoint that receives signed events.
type Webhook struct {
	ID          string   `json:"id"`
	URL         string   `json:"url"`
	Description *string  `json:"description"`
	Events      []string `json:"events"`
	Enabled     bool     `json:"enabled"`
	// SecretHint is the secret's last four characters.
	SecretHint              string     `json:"secretHint"`
	PreviousSecretExpiresAt *time.Time `json:"previousSecretExpiresAt"`
	CreatedAt               time.Time  `json:"createdAt"`
	UpdatedAt               time.Time  `json:"updatedAt"`
	LastSuccessAt           *time.Time `json:"lastSuccessAt"`
	LastFailureAt           *time.Time `json:"lastFailureAt"`
	FailingSince            *time.Time `json:"failingSince"`
	// Secret is the signing secret, only on Create and RotateSecret. Keep it.
	Secret string `json:"secret,omitempty"`
}

// WebhookDelivery is one attempt, or series of attempts, to deliver an event.
type WebhookDelivery struct {
	ID             string     `json:"id"`
	EndpointID     string     `json:"endpointId"`
	EventID        string     `json:"eventId"`
	EventType      string     `json:"eventType"`
	ResourceID     *string    `json:"resourceId"`
	State          string     `json:"state"`
	Attempts       int        `json:"attempts"`
	MaxAttempts    int        `json:"maxAttempts"`
	NextAttemptAt  *time.Time `json:"nextAttemptAt"`
	LastStatus     *int       `json:"lastStatus"`
	LastError      *string    `json:"lastError"`
	LastDurationMs *int64     `json:"lastDurationMs"`
	LastAttemptAt  *time.Time `json:"lastAttemptAt"`
	DeliveredAt    *time.Time `json:"deliveredAt"`
	CreatedAt      time.Time  `json:"createdAt"`
}

// CreateWebhookOptions are a webhook's fields. URL is required; Events
// defaults to every event ("*").
type CreateWebhookOptions struct {
	URL         string   `json:"url"`
	Events      []string `json:"events,omitempty"`
	Description string   `json:"description,omitempty"`
}

// UpdateWebhookOptions change a webhook; nil fields stay as they are.
type UpdateWebhookOptions struct {
	URL         *string  `json:"url,omitempty"`
	Events      []string `json:"events,omitempty"`
	Description *string  `json:"description,omitempty"`
	Enabled     *bool    `json:"enabled,omitempty"`
}

// WebhookService is client.Webhooks.
type WebhookService struct{ c *Client }

func webhookPath(id, verb string) string { return "/v1/webhooks/" + url.PathEscape(id) + verb }

// Create returns the webhook with its Secret, shown this once.
func (s *WebhookService) Create(ctx context.Context, opts CreateWebhookOptions) (*Webhook, error) {
	var hook Webhook
	return &hook, s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/webhooks", body: opts}, &hook)
}

// List returns the account's webhooks.
func (s *WebhookService) List(ctx context.Context) ([]Webhook, error) {
	page, err := listPage[Webhook](ctx, s.c, "/v1/webhooks", nil, "")
	if err != nil {
		return nil, err
	}
	return page.Data, nil
}

// Get reads a webhook.
func (s *WebhookService) Get(ctx context.Context, id string) (*Webhook, error) {
	var hook Webhook
	return &hook, s.c.do(ctx, &call{method: http.MethodGet, path: webhookPath(id, "")}, &hook)
}

// Update changes a webhook.
func (s *WebhookService) Update(ctx context.Context, id string, opts UpdateWebhookOptions) (*Webhook, error) {
	var hook Webhook
	return &hook, s.c.do(ctx, &call{method: http.MethodPost, path: webhookPath(id, ":update"), body: opts}, &hook)
}

// RotateSecret makes a new secret, returned once. The old one keeps signing
// beside it for keepPrevious (nil is a day; a week at most; 0 ends it now).
func (s *WebhookService) RotateSecret(ctx context.Context, id string, keepPrevious *time.Duration) (*Webhook, error) {
	body := map[string]any{}
	if keepPrevious != nil {
		body["keepPreviousSeconds"] = int(keepPrevious.Seconds())
	}
	var hook Webhook
	return &hook, s.c.do(ctx, &call{method: http.MethodPost, path: webhookPath(id, ":rotate-secret"), body: body}, &hook)
}

// Delete deletes a webhook.
func (s *WebhookService) Delete(ctx context.Context, id string) error {
	return s.c.do(ctx, &call{method: http.MethodPost, path: webhookPath(id, ":delete"), body: map[string]any{}}, nil)
}

// Test sends a signed webhook.test now and says how your endpoint answered.
func (s *WebhookService) Test(ctx context.Context, id string) (*WebhookDelivery, error) {
	var delivery WebhookDelivery
	return &delivery, s.c.do(ctx, &call{method: http.MethodPost, path: webhookPath(id, ":test"), body: map[string]any{}, wait: 10}, &delivery)
}

// Deliveries returns the first page of a webhook's deliveries; state is
// pending, succeeded, failed, cancelled or "".
func (s *WebhookService) Deliveries(ctx context.Context, id, state string) (*Page[WebhookDelivery], error) {
	return listPage[WebhookDelivery](ctx, s.c, webhookPath(id, "/deliveries"), setQuery(url.Values{}, "state", state), "")
}

// Retry sends one delivery again, once, now.
func (s *WebhookService) Retry(ctx context.Context, deliveryID string) (*WebhookDelivery, error) {
	var delivery WebhookDelivery
	return &delivery, s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/webhook-deliveries/" + url.PathEscape(deliveryID) + ":retry", body: map[string]any{}}, &delivery)
}

// OtelExport pushes events (as logs) and CPU and memory (as metrics) to an
// OpenTelemetry endpoint over OTLP/HTTP.
type OtelExport struct {
	ID             string     `json:"id"`
	Endpoint       string     `json:"endpoint"`
	HeaderNames    []string   `json:"headerNames"`
	Signals        []string   `json:"signals"`
	Enabled        bool       `json:"enabled"`
	CreatedAt      time.Time  `json:"createdAt"`
	UpdatedAt      time.Time  `json:"updatedAt"`
	LastAttemptAt  *time.Time `json:"lastAttemptAt"`
	LastSuccessAt  *time.Time `json:"lastSuccessAt"`
	LastError      *string    `json:"lastError"`
	Failures       int        `json:"failures"`
	ExportedEvents int64      `json:"exportedEvents"`
	ExportedPoints int64      `json:"exportedPoints"`
}

// OtelOptions are an export's fields. Endpoint is required on create; on
// update, empty fields and a nil Enabled stay as they are.
type OtelOptions struct {
	// Endpoint is the OTLP/HTTP base URL, as OTEL_EXPORTER_OTLP_ENDPOINT.
	Endpoint string `json:"endpoint,omitempty"`
	// Headers authenticate to the endpoint; never shown back.
	Headers map[string]string `json:"headers,omitempty"`
	// Signals are "logs" and "metrics".
	Signals []string `json:"signals,omitempty"`
	Enabled *bool    `json:"enabled,omitempty"`
}

// OtelService is client.Otel.
type OtelService struct{ c *Client }

func otelPath(id, verb string) string { return "/v1/otel-exports/" + url.PathEscape(id) + verb }

// Create starts an export.
func (s *OtelService) Create(ctx context.Context, opts OtelOptions) (*OtelExport, error) {
	var export OtelExport
	return &export, s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/otel-exports", body: opts}, &export)
}

// List returns the account's exports.
func (s *OtelService) List(ctx context.Context) ([]OtelExport, error) {
	page, err := listPage[OtelExport](ctx, s.c, "/v1/otel-exports", nil, "")
	if err != nil {
		return nil, err
	}
	return page.Data, nil
}

// Get reads an export.
func (s *OtelService) Get(ctx context.Context, id string) (*OtelExport, error) {
	var export OtelExport
	return &export, s.c.do(ctx, &call{method: http.MethodGet, path: otelPath(id, "")}, &export)
}

// Update changes an export.
func (s *OtelService) Update(ctx context.Context, id string, opts OtelOptions) (*OtelExport, error) {
	var export OtelExport
	return &export, s.c.do(ctx, &call{method: http.MethodPost, path: otelPath(id, ":update"), body: opts}, &export)
}

// Flush pushes now instead of at the next interval.
func (s *OtelService) Flush(ctx context.Context, id string) (*OtelExport, error) {
	var export OtelExport
	return &export, s.c.do(ctx, &call{method: http.MethodPost, path: otelPath(id, ":flush"), body: map[string]any{}}, &export)
}

// Delete ends an export.
func (s *OtelService) Delete(ctx context.Context, id string) error {
	return s.c.do(ctx, &call{method: http.MethodPost, path: otelPath(id, ":delete"), body: map[string]any{}}, nil)
}

// ErrWebhookSignature is what VerifyWebhook returns, wrapped, when a delivery
// is not authentic or is too old.
var ErrWebhookSignature = errors.New("withruntime: webhook signature")

// VerifyWebhook checks a delivery's Runtime-Signature header against the raw
// body and your secret (or secrets, during a rotation), and returns the event.
// It refuses a signature older than tolerance (0 is five minutes), which stops
// a captured delivery being replayed. Pass the body exactly as received.
//
//	body, _ := io.ReadAll(r.Body)
//	event, err := withruntime.VerifyWebhook(body, r.Header.Get("Runtime-Signature"), []string{secret}, 0)
func VerifyWebhook(body []byte, header string, secrets []string, tolerance time.Duration) (*Event, error) {
	return verifyWebhookAt(body, header, secrets, tolerance, time.Now())
}

func verifyWebhookAt(body []byte, header string, secrets []string, tolerance time.Duration, now time.Time) (*Event, error) {
	fail := func(message string) error { return errors.Join(ErrWebhookSignature, errors.New(message)) }
	if header == "" {
		return nil, fail("missing Runtime-Signature header")
	}
	var stamp int64 = -1
	var given []string
	for _, part := range strings.Split(header, ",") {
		key, value, _ := strings.Cut(strings.TrimSpace(part), "=")
		switch key {
		case "t":
			if parsed, err := strconv.ParseInt(value, 10, 64); err == nil {
				stamp = parsed
			}
		case "v1":
			if value != "" {
				given = append(given, value)
			}
		}
	}
	if stamp < 0 || len(given) == 0 {
		return nil, fail("malformed Runtime-Signature header")
	}
	if tolerance <= 0 {
		tolerance = 5 * time.Minute
	}
	if age := now.Unix() - stamp; age > int64(tolerance.Seconds()) || -age > int64(tolerance.Seconds()) {
		return nil, fail("the signature is too old; the delivery may be a replay")
	}
	signed := []byte(strconv.FormatInt(stamp, 10) + "." + string(body))
	for _, secret := range secrets {
		mac := hmac.New(sha256.New, []byte(secret))
		mac.Write(signed)
		expected := hex.EncodeToString(mac.Sum(nil))
		for _, value := range given {
			if hmac.Equal([]byte(value), []byte(expected)) {
				var event Event
				if err := json.Unmarshal(body, &event); err != nil {
					return nil, fail("the body is not JSON")
				}
				return &event, nil
			}
		}
	}
	return nil, fail("no signature matches the secret")
}
