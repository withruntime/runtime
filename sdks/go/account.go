package withruntime

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// LimitService is client.Limits.
type LimitService struct{ c *Client }

// Get says whether this key is read-only, and what its agent may still spend
// in the current 24 hours. An owner sets the limit at
// https://withruntime.com/account/keys; past it, a create, wake or extension
// fails with spending_limit_reached.
func (s *LimitService) Get(ctx context.Context) (*KeyLimits, error) {
	var limits KeyLimits
	return &limits, s.c.do(ctx, &call{method: http.MethodGet, path: "/v1/limits"}, &limits)
}

// ReferralSummary is the account's referral link and what it earned. Money is
// integer microdollars in strings.
type ReferralSummary struct {
	Code                 string `json:"code"`
	Link                 string `json:"link"`
	RewardMicros         string `json:"rewardMicros"`
	MaxRewardMicros      string `json:"maxRewardMicros"`
	MinPurchaseMicros    string `json:"minPurchaseMicros"`
	YearlyCapMicros      string `json:"yearlyCapMicros"`
	Enabled              bool   `json:"enabled"`
	Year                 int    `json:"year"`
	SignedUp             int    `json:"signedUp"`
	Pending              int    `json:"pending"`
	Paid                 int    `json:"paid"`
	Capped               int    `json:"capped"`
	Reversed             int    `json:"reversed"`
	EarnedMicros         string `json:"earnedMicros"`
	EarnedThisYearMicros string `json:"earnedThisYearMicros"`
	CapRemainingMicros   string `json:"capRemainingMicros"`
	ReferredBy           *struct {
		Status       string `json:"status"`
		CreditMicros string `json:"creditMicros"`
	} `json:"referredBy"`
}

// ReferralService is client.Referrals.
type ReferralService struct{ c *Client }

// Get returns the referral link and its counts.
func (s *ReferralService) Get(ctx context.Context) (*ReferralSummary, error) {
	var summary ReferralSummary
	return &summary, s.c.do(ctx, &call{method: http.MethodGet, path: "/v1/referrals"}, &summary)
}

// SwitchingSummary is whether a switch can be recorded and what it paid.
type SwitchingSummary struct {
	Enabled   bool     `json:"enabled"`
	MaxMicros string   `json:"maxMicros"`
	Providers []string `json:"providers"`
	Eligible  bool     `json:"eligible"`
	Switch    *struct {
		Provider      string    `json:"provider"`
		Status        string    `json:"status"`
		RefusedReason *string   `json:"refusedReason"`
		RecordedAt    time.Time `json:"recordedAt"`
		CreditMicros  string    `json:"creditMicros"`
	} `json:"switch"`
}

// UsageComparison is your settled usage priced on Runtime and at a rival's
// published rates. Money is integer microdollars in strings.
type UsageComparison struct {
	Provider string `json:"provider"`
	Rival    struct {
		Name    string   `json:"name"`
		Checked string   `json:"checked"`
		Rates   []string `json:"rates"`
		PlanFee string   `json:"planFee"`
		Sources []struct {
			Label string `json:"label"`
			URL   string `json:"url"`
		} `json:"sources"`
	} `json:"rival"`
	// Basis is "usage", or "example" when there is no usage in the window yet.
	Basis  string `json:"basis"`
	Window struct {
		Days int    `json:"days"`
		From string `json:"from"`
		To   string `json:"to"`
	} `json:"window"`
	Usage struct {
		Sandboxes         int     `json:"sandboxes"`
		RunSeconds        float64 `json:"runSeconds"`
		ActiveCPUSeconds  float64 `json:"activeCpuSeconds"`
		UnpricedSandboxes int     `json:"unpricedSandboxes"`
		TrialSandboxes    int     `json:"trialSandboxes"`
		TrialRunSeconds   float64 `json:"trialRunSeconds"`
	} `json:"usage"`
	RuntimeMicros string   `json:"runtimeMicros"`
	RivalMicros   string   `json:"rivalMicros"`
	SavingMicros  string   `json:"savingMicros"`
	SavingPercent *float64 `json:"savingPercent"`
	PerMonth      *struct {
		FromDays      float64 `json:"fromDays"`
		RuntimeMicros string  `json:"runtimeMicros"`
		RivalMicros   string  `json:"rivalMicros"`
		SavingMicros  string  `json:"savingMicros"`
	} `json:"perMonth"`
	Note      string           `json:"note"`
	Switching SwitchingSummary `json:"switching"`
}

// SwitchingService is client.Switching.
type SwitchingService struct{ c *Client }

// Compare prices your settled sandbox usage over the last days (0 is 30, at
// most 90) on Runtime and at provider (e2b, daytona, vercel, modal,
// cloudflare, fly, fly-machines).
func (s *SwitchingService) Compare(ctx context.Context, provider string, days int) (*UsageComparison, error) {
	var comparison UsageComparison
	query := setQuery(url.Values{}, "provider", provider, "days", itoa(days))
	return &comparison, s.c.do(ctx, &call{method: http.MethodGet, path: "/v1/usage/compare", query: query}, &comparison)
}

// Get says whether a switch can still be recorded, and what it paid.
func (s *SwitchingService) Get(ctx context.Context) (*SwitchingSummary, error) {
	var summary SwitchingSummary
	return &summary, s.c.do(ctx, &call{method: http.MethodGet, path: "/v1/switching"}, &summary)
}

// Record records the rival you are leaving, once, before the first top-up.
func (s *SwitchingService) Record(ctx context.Context, provider string) (*SwitchingSummary, error) {
	var summary SwitchingSummary
	return &summary, s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/switching", body: map[string]any{"provider": provider}}, &summary)
}

// AuditEvent is one entry of the account's audit log.
type AuditEvent struct {
	Seq    string    `json:"seq"`
	ID     string    `json:"id"`
	At     time.Time `json:"at"`
	Action string    `json:"action"`
	Actor  struct {
		Kind   string  `json:"kind"`
		ID     *string `json:"id"`
		Name   *string `json:"name"`
		Person *string `json:"person"`
	} `json:"actor"`
	Target struct {
		Type *string `json:"type"`
		ID   *string `json:"id"`
	} `json:"target"`
	Detail    map[string]any `json:"detail"`
	IP        *string        `json:"ip"`
	RequestID *string        `json:"requestId"`
	Via       string         `json:"via"`
}

// AuditPage is one page of the audit log; pass Next as Before for the next.
type AuditPage struct {
	Events []AuditEvent `json:"events"`
	Next   *string      `json:"next"`
}

// AuditListOptions filter the log.
type AuditListOptions struct {
	// Action is an action ("key.created") or a group ending in a dot ("member.").
	Action string
	// Limit is 1 to 200; 50 by default.
	Limit  int
	Before string
}

// AuditService is client.Audit.
type AuditService struct{ c *Client }

// List returns the audit log, newest first. It needs a key for every product
// or a read-only key, made by an owner or admin.
func (s *AuditService) List(ctx context.Context, opts *AuditListOptions) (*AuditPage, error) {
	query := url.Values{}
	if opts != nil {
		setQuery(query, "action", opts.Action, "limit", itoa(opts.Limit), "before", opts.Before)
	}
	var page AuditPage
	return &page, s.c.do(ctx, &call{method: http.MethodGet, path: "/v1/audit", query: query}, &page)
}

// FeedbackOptions are a report's fields. Kind and Summary are required.
type FeedbackOptions struct {
	// Kind is bug, missing_feature, competitor_gap, migration_blocker, docs,
	// pricing, praise or other.
	Kind       string         `json:"kind"`
	Summary    string         `json:"summary"`
	Detail     string         `json:"detail,omitempty"`
	Competitor string         `json:"competitor,omitempty"`
	ResourceID string         `json:"resourceId,omitempty"`
	RequestID  string         `json:"requestId,omitempty"`
	Context    map[string]any `json:"context,omitempty"`
}

// FeedbackReceipt says a report arrived.
type FeedbackReceipt struct {
	ID        string `json:"id"`
	Duplicate bool   `json:"duplicate"`
	Message   string `json:"message,omitempty"`
}

// FeedbackReport is a report and where it stands.
type FeedbackReport struct {
	ID      string          `json:"id"`
	Kind    string          `json:"kind"`
	Summary string          `json:"summary"`
	Status  string          `json:"status"`
	Sorted  bool            `json:"sorted"`
	Note    string          `json:"note"`
	Item    json.RawMessage `json:"item"`
}

// FeedbackService is client.Feedback.
type FeedbackService struct{ c *Client }

// Submit tells the Runtime team something: a bug, a missing feature, what
// another provider does better, what blocks a migration.
func (s *FeedbackService) Submit(ctx context.Context, opts FeedbackOptions) (*FeedbackReceipt, error) {
	var receipt FeedbackReceipt
	return &receipt, s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/feedback", body: opts}, &receipt)
}

// List returns this account's reports and where each stands.
func (s *FeedbackService) List(ctx context.Context, limit int) ([]FeedbackReport, error) {
	var body struct {
		Data []FeedbackReport `json:"data"`
	}
	query := url.Values{}
	if limit > 0 {
		query.Set("limit", strconv.Itoa(limit))
	}
	err := s.c.do(ctx, &call{method: http.MethodGet, path: "/v1/feedback", query: query}, &body)
	return body.Data, err
}

// SupportMessage is a message to support, or an answer to an action it asked
// to take. Every field is optional, but send at least one.
type SupportMessage struct {
	Message          string `json:"message,omitempty"`
	ConversationID   string `json:"conversationId,omitempty"`
	ApproveActionID  string `json:"approveActionId,omitempty"`
	ApproveInputHash string `json:"approveInputHash,omitempty"`
	DenyActionID     string `json:"denyActionId,omitempty"`
}

// SupportReply is support's answer. When Status is "working", Read it again
// in a minute.
type SupportReply struct {
	ConversationID string `json:"conversationId"`
	// Status is answered, working, escalated, waiting_customer or capped.
	Status         string `json:"status"`
	Reply          string `json:"reply,omitempty"`
	PendingActions []struct {
		ID         string    `json:"id"`
		Action     string    `json:"action"`
		ResourceID string    `json:"resourceId,omitempty"`
		Summary    string    `json:"summary"`
		InputHash  string    `json:"inputHash"`
		ExpiresAt  time.Time `json:"expiresAt"`
	} `json:"pendingActions,omitempty"`
}

// SupportService is client.Support.
type SupportService struct{ c *Client }

// Message asks Runtime support. It is not retried (support cannot
// deduplicate a message) and may take up to two minutes.
func (s *SupportService) Message(ctx context.Context, message SupportMessage) (*SupportReply, error) {
	var reply SupportReply
	return &reply, s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/support/messages", body: message, noRetry: true, timeout: 2 * time.Minute}, &reply)
}

// Read reads a conversation again.
func (s *SupportService) Read(ctx context.Context, conversationID string) (*SupportReply, error) {
	var reply SupportReply
	return &reply, s.c.do(ctx, &call{method: http.MethodGet, path: "/v1/support/conversations/" + url.PathEscape(conversationID)}, &reply)
}
