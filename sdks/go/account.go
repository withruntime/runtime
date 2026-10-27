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

// EmailSetting says whether this key's person gets one of Runtime's optional
// emails, in this account: own-deletions (warnings for dates the account's own
// retention set), billing, usage or tips. Sign-in, support replies, credit
// expiry and deletions Runtime decides are always sent and are not listed.
type EmailSetting struct {
	Category  string  `json:"category"`
	Enabled   bool    `json:"enabled"`
	UpdatedAt *string `json:"updatedAt"`
}

// EmailService is client.Emails.
type EmailService struct{ c *Client }

// Get reads which optional emails this key's person gets for this account.
func (s *EmailService) Get(ctx context.Context) ([]EmailSetting, error) {
	var answer struct {
		Settings []EmailSetting `json:"settings"`
	}
	err := s.c.do(ctx, &call{method: http.MethodGet, path: "/v1/account/emails"}, &answer)
	return answer.Settings, err
}

// Set turns one optional email on or off for this key's person only, and
// answers all of them. It needs a key for every action.
func (s *EmailService) Set(ctx context.Context, category string, enabled bool) ([]EmailSetting, error) {
	var answer struct {
		Settings []EmailSetting `json:"settings"`
	}
	err := s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/account/emails:update",
		body: map[string]any{"category": category, "enabled": enabled}}, &answer)
	return answer.Settings, err
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
	// PayingCompanies is the referred companies with a matched payment still
	// standing.
	PayingCompanies int `json:"payingCompanies"`
	// ShareEarnedMicros is the share credit you kept, all time.
	ShareEarnedMicros string `json:"shareEarnedMicros"`
	// ShareBasisPoints is your share of what a referred company spends from
	// credit it paid for: 1000 is 10%.
	ShareBasisPoints int `json:"shareBasisPoints"`
	// ShareMonths is how long the share runs from a company's first matched
	// payment.
	ShareMonths int `json:"shareMonths"`
	// WindowDays is how long after sign-up a referred company's payments are
	// matched.
	WindowDays int `json:"windowDays"`
}

// ReferralService is client.Referrals.
type ReferralService struct{ c *Client }

// Get returns the referral link and its counts.
func (s *ReferralService) Get(ctx context.Context) (*ReferralSummary, error) {
	var summary ReferralSummary
	return &summary, s.c.do(ctx, &call{method: http.MethodGet, path: "/v1/referrals"}, &summary)
}

// Plan is one monthly plan: a fee that comes back as plan usage, spent first
// each month at the same measured prices, plus a bonus for committing. Money
// is integer microdollars in strings.
type Plan struct {
	// ID is what Choose takes.
	ID   string `json:"id"`
	Name string `json:"name"`
	// Card is shared by plans shown as one card with a switch, such as Pro
	// and its larger option; nil for a card of its own.
	Card *string `json:"card"`
	// FeeMicros is the monthly fee, before tax; "0" for Free.
	FeeMicros string `json:"feeMicros"`
	// YearlyFeeMicros is a year paid at once, ten months' fee for twelve; nil
	// without a yearly price.
	YearlyFeeMicros *string `json:"yearlyFeeMicros"`
	// BonusMicros is usage given on top of the fee each month.
	BonusMicros string `json:"bonusMicros"`
	// TrialDays is the days of trial; 0 for none. A trial saves a card and
	// charges the first period when it ends, unless cancelled before.
	TrialDays int `json:"trialDays"`
	// FirstPeriodDouble: the first month on the plan, and the first after an
	// upgrade to it, holds twice its usage.
	FirstPeriodDouble bool `json:"firstPeriodDouble"`
	// Support is docs, agent, slack or dedicated.
	Support string `json:"support"`
	// Collection is card (the fee is charged to the card the plan saves) or
	// invoice (a contract, invoiced).
	Collection string `json:"collection"`
	// Contract is true for a contract made for your organization alone.
	Contract bool `json:"contract"`
	// Position is the catalogue's order: the next plan up is next.
	Position int `json:"position"`
	// Included is usage the plan includes each month beside its fee.
	Included []PlanIncluded `json:"included"`
	// Limits is what the plan raises; a plan never lowers a limit you have.
	Limits []PlanLimit `json:"limits"`
	// Features is what the plan turns on: sso, roles, audit, support-agent...
	Features []string `json:"features"`
	// AddOns are what AddOn takes, charged monthly beside the fee.
	AddOns []PlanAddOn `json:"addOns"`
}

// PlanIncluded is usage a plan includes each month, such as Apps' traffic out.
type PlanIncluded struct {
	Product  string  `json:"product"`
	Meter    string  `json:"meter"`
	Quantity float64 `json:"quantity"`
	// Unit is such as GB.
	Unit string `json:"unit"`
}

// PlanLimit is one ceiling a plan raises.
type PlanLimit struct {
	// Limit is as GET /v1/limits and quota_exceeded name it: sandbox.count.
	Limit string `json:"limit"`
	// Max is nil for no limit at all.
	Max *int64 `json:"max"`
}

// PlanAddOn is an add-on a plan offers.
type PlanAddOn struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// FeeMicros is monthly, beside the plan's fee.
	FeeMicros string `json:"feeMicros"`
	// Limits is what it adds to a limit.
	Limits []PlanAddOnLimit `json:"limits"`
	// Feature is the feature it turns on, if any.
	Feature *string `json:"feature"`
}

// PlanAddOnLimit is how much an add-on adds to one limit.
type PlanAddOnLimit struct {
	Limit string `json:"limit"`
	Add   int64  `json:"add"`
}

// PlanNow is the plan your organization holds.
type PlanNow struct {
	PlanID string `json:"planId"`
	Name   string `json:"name"`
	// Status is incomplete, trialing, active, past_due or canceled.
	Status string `json:"status"`
	// Interval is month or year.
	Interval    string     `json:"interval"`
	PeriodStart *time.Time `json:"periodStart"`
	// PeriodEnd is the next fee, or the end of a cancelled plan.
	PeriodEnd *time.Time `json:"periodEnd"`
	// TrialEndsAt is when a trial ends and its first period is charged; nil
	// outside one.
	TrialEndsAt *time.Time `json:"trialEndsAt"`
	// CancelAtPeriodEnd is true once a cancel takes effect at PeriodEnd.
	CancelAtPeriodEnd bool `json:"cancelAtPeriodEnd"`
	// NextPlanID is the plan a downgrade moves to at PeriodEnd.
	NextPlanID *string        `json:"nextPlanId"`
	StartedAt  time.Time      `json:"startedAt"`
	AddOns     []PlanAddOnNow `json:"addOns"`
	// AutoUpgrade: an owner said yes to moving up a plan when a limit refuses.
	AutoUpgrade bool `json:"autoUpgrade"`
	// PlanUsage is this period's plan usage, spent before any credit; nil
	// with none.
	PlanUsage *PlanUsage `json:"planUsage"`
}

// PlanAddOnNow is an add-on the plan holds.
type PlanAddOnNow struct {
	ID       string `json:"id"`
	Quantity int64  `json:"quantity"`
	// EndsAt is when a removed add-on stops; nil while it renews.
	EndsAt *time.Time `json:"endsAt"`
}

// PlanUsage is this period's plan usage; it ends with the period.
type PlanUsage struct {
	GrantedMicros string    `json:"grantedMicros"`
	LeftMicros    string    `json:"leftMicros"`
	ExpiresAt     time.Time `json:"expiresAt"`
}

// Plans is what List answers: the plan you are on (nil with none) and every
// plan you may choose.
type Plans struct {
	Current *PlanNow `json:"current"`
	Plans   []Plan   `json:"plans"`
}

// PlanChange is what every change answers: a link where a person starts a
// first plan or a trial in the browser, or the plan as changed.
type PlanChange struct {
	CheckoutURL *string  `json:"checkoutUrl"`
	Current     *PlanNow `json:"current"`
}

// PlanChooseOptions are Choose's options; nil is monthly.
type PlanChooseOptions struct {
	// Interval is month or year (ten months' fee for twelve); monthly when
	// empty.
	Interval string
}

// PlanService is client.Plans: monthly plans whose fee is prepaid usage. The
// fee comes back as plan usage, spent first each month at the same measured
// prices; plan usage left at the period's end ends with it.
type PlanService struct{ c *Client }

func (s *PlanService) change(ctx context.Context, method, path string, body any) (*PlanChange, error) {
	var change PlanChange
	return &change, s.c.do(ctx, &call{method: method, path: path, body: body}, &change)
}

// List returns the plan you are on and every plan you may choose.
func (s *PlanService) List(ctx context.Context) (*Plans, error) {
	var plans Plans
	return &plans, s.c.do(ctx, &call{method: http.MethodGet, path: "/v1/plans"}, &plans)
}

// Choose starts a plan by id, or moves to another. With no plan, it answers
// CheckoutURL, where a person starts it. A dearer plan starts at once,
// prorated; a cheaper one at PeriodEnd (NextPlanID).
func (s *PlanService) Choose(ctx context.Context, plan string, opts *PlanChooseOptions) (*PlanChange, error) {
	body := map[string]any{"plan": plan}
	if opts != nil && opts.Interval != "" {
		body["interval"] = opts.Interval
	}
	return s.change(ctx, http.MethodPost, "/v1/plans/choose", body)
}

// Cancel ends the plan at PeriodEnd.
func (s *PlanService) Cancel(ctx context.Context) (*PlanChange, error) {
	return s.change(ctx, http.MethodPost, "/v1/plans/cancel", map[string]any{})
}

// Resume keeps a plan you cancelled, before PeriodEnd.
func (s *PlanService) Resume(ctx context.Context) (*PlanChange, error) {
	return s.change(ctx, http.MethodPost, "/v1/plans/resume", map[string]any{})
}

// AddOn adds an add-on by id: charged now for the rest of the period,
// prorated, then with the plan.
func (s *PlanService) AddOn(ctx context.Context, addOn string) (*PlanChange, error) {
	return s.change(ctx, http.MethodPost, "/v1/plans/add-ons", map[string]any{"addOn": addOn})
}

// RemoveAddOn removes an add-on: its charge stops now, and it holds to
// PeriodEnd.
func (s *PlanService) RemoveAddOn(ctx context.Context, addOn string) (*PlanChange, error) {
	return s.change(ctx, http.MethodDelete, "/v1/plans/add-ons/"+url.PathEscape(addOn), nil)
}

// AutoUpgrade turns on or off moving up a plan by itself when a limit
// refuses. Owners, and keys an owner made.
func (s *PlanService) AutoUpgrade(ctx context.Context, on bool) (*PlanChange, error) {
	return s.change(ctx, http.MethodPut, "/v1/plans/auto-upgrade", map[string]any{"on": on})
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
	// Sandbox is the sandbox the request came from, when code in it called
	// the API at http://runtime.internal.
	Sandbox *string `json:"sandbox"`
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
