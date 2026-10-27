package withruntime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"iter"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"time"
)

/* Agents (private beta): an agent is a definition (what to run, in what
   sandbox, with which secrets), and each piece of work is a session of it,
   with its own sandbox and a log of events. An account outside the beta is
   refused 403 product_in_beta (errors.Is ErrPermissionDenied). */

// AgentService is client.Agents: agents, their sessions and their triggers.
type AgentService struct {
	c *Client
	// Sessions finds and lists sessions of every agent.
	Sessions *AgentSessionService
	// Triggers start sessions from Slack, GitHub, a schedule or a webhook.
	Triggers *AgentTriggerService
	// Slack is Runtime's Slack app in your workspaces, for slack triggers.
	Slack *AgentSlackService
	// Templates are ready definitions for the harnesses Runtime knows, and
	// the presets for the two uses (your customers, your team).
	Templates *AgentTemplateService
	// Memory is each agent's built-in memory: text files its sessions keep
	// across sessions and search, shared or one key's alone.
	Memory *AgentMemoryService
	// Asks is the account's inbox: what its sessions need answered to go
	// on, one row per step however many sessions ask it.
	Asks *AgentAskService
	// Workflows run many sessions in phases, fanned out and pipelined,
	// with limits and a cost cap.
	Workflows *AgentWorkflowService
}

// AnthropicOptions is Claude Managed Agents' API on Runtime: the base URL
// and key Anthropic's Go SDK takes, so code written for it runs here
// unchanged:
//
//	o := client.Agents.Anthropic()
//	anthropicClient := anthropic.NewClient(option.WithBaseURL(o.BaseURL), option.WithAPIKey(o.APIKey))
//
// Sessions call the model with the account's own Anthropic key, the egress
// secret ANTHROPIC_API_KEY (runtime secrets set ANTHROPIC_API_KEY --host
// api.anthropic.com).
type AnthropicOptions struct {
	BaseURL string
	APIKey  string
}

// Anthropic answers the AnthropicOptions for this client's origin and key.
func (s *AgentService) Anthropic() AnthropicOptions {
	return AnthropicOptions{BaseURL: s.c.baseURL + "/anthropic", APIKey: s.c.apiKey}
}

func newAgentService(c *Client) *AgentService {
	return &AgentService{
		c:         c,
		Sessions:  &AgentSessionService{c: c},
		Triggers:  &AgentTriggerService{c: c},
		Slack:     &AgentSlackService{c: c},
		Templates: &AgentTemplateService{},
		Memory:    &AgentMemoryService{c: c},
		Asks:      &AgentAskService{c: c},
		Workflows: &AgentWorkflowService{c: c},
	}
}

// AgentDefinition is what an agent runs: Command is required, every other
// field optional (the API fills in 4 vCPU, 8192 MiB, a 60 s idle pause, a day
// per session, 10 sessions at once, $5 a session's tree and $100 a day). A
// change makes a new version, which only later sessions use.
type AgentDefinition struct {
	// Command starts the harness in the sandbox.
	Command string `json:"command,omitempty"`
	// From is the image, snapshot or repository the sandbox starts from.
	From *AgentFrom `json:"from,omitempty"`
	// VCPU is 1, 2, 4, 8 or 16 (4 unless set). A definition From a snapshot
	// takes no VCPU or MemoryMiB (400 invalid_request): a snapshot keeps its
	// own size.
	VCPU int `json:"vcpu,omitempty"`
	// MemoryMiB is 512 to 65536, a multiple of 256 (8192 unless set).
	MemoryMiB int `json:"memoryMiB,omitempty"`
	// Instructions are the agent's own words to the harness.
	Instructions string            `json:"instructions,omitempty"`
	Env          map[string]string `json:"env,omitempty"`
	// Secrets are egress secrets (client.Secrets) the sandbox uses without
	// seeing them, such as ANTHROPIC_API_KEY.
	Secrets []string `json:"secrets,omitempty"`
	// Pool is 1 to 16 Claude accounts, each an egress secret's name: a
	// subscription token, or an API key for a name holding API_KEY. Each
	// session takes the one with the most usage left; the review template
	// moves to the next when one is out of usage.
	Pool    []string         `json:"pool,omitempty"`
	MCP     []AgentMCPServer `json:"mcp,omitempty"`
	Volumes []AgentVolume    `json:"volumes,omitempty"`
	// Network is where each session's sandbox may connect, enforced by its
	// network rules from its first packet: with Allow, only those hosts.
	// Nil: anywhere.
	Network *AgentNetwork `json:"network,omitempty"`
	// IdlePauseSeconds pauses a session's sandbox once it has been idle this
	// long (10 to 86400).
	IdlePauseSeconds int `json:"idlePauseSeconds,omitempty"`
	// MaxSessionSeconds ends a session that runs this long (60 to 604800).
	MaxSessionSeconds int `json:"maxSessionSeconds,omitempty"`
	// MaxConcurrent is how many of its sessions may run at once (1 to 1000).
	MaxConcurrent int `json:"maxConcurrent,omitempty"`
	// MaxSessionDollars caps a session and every session under it (more
	// than 0, at most 10000, default 5); the root's covers its whole tree. A
	// tree at it stops (reason "budget") and spawns no more children.
	MaxSessionDollars float64 `json:"maxSessionDollars,omitempty"`
	// MaxDayDollars caps the agent's sessions started that UTC day (more
	// than 0, at most 100000, default 100): past it, it starts nothing new
	// (402 budget_reached) until the next day.
	MaxDayDollars float64 `json:"maxDayDollars,omitempty"`
	// MaxChildren is how many sessions one session's harness may start
	// (1 to 1000, default 100).
	MaxChildren int `json:"maxChildren,omitempty"`
	// Advisor is a model its sessions may ask for advice with the advise
	// tool; each call is kept in the session's log as a note.
	Advisor *AgentAdvisor `json:"advisor,omitempty"`
	// Template is the use it was made for: "support" or "team".
	Template string `json:"template,omitempty"`
	// Model is the model the harness runs (such as claude-opus-5-5); empty,
	// the harness's default. The harness reads it as RUNTIME_AGENT_MODEL,
	// and Claude Code, the Claude Agent SDK, Codex, Gemini CLI and the
	// OpenAI Agents SDK each by their own setting.
	Model string `json:"model,omitempty"`
	// SessionOverrides is what a session's start may override
	// (StartAgentOptions.Overrides); nil, the defaults.
	SessionOverrides *AgentSessionOverrideLimits `json:"sessionOverrides,omitempty"`
	// Permissions say which tool calls of the harness run, wait for a
	// person, or are refused; nil: every call runs.
	Permissions *AgentPermissions `json:"permissions,omitempty"`
	// Extra holds fields newer than this SDK: kept when read, sent when
	// written, so a definition read and written back loses nothing.
	Extra map[string]any `json:"-"`
}

// AgentSessionOverrideLimits are the limits an agent's owner sets on its
// sessions' overrides. A session may always narrow its MCP servers and
// disallow tools.
type AgentSessionOverrideLimits struct {
	// Models a session may name; nil, any.
	Models []string `json:"models,omitempty"`
	// Instructions is "append" (the default: a session adds to the agent's),
	// "replace" (it may also replace them) or "none".
	Instructions string `json:"instructions,omitempty"`
	// MaxVCPU, MaxMemoryMiB and MaxSessionDollars are the most a session may
	// ask for; zero, the agent's own.
	MaxVCPU           int     `json:"maxVcpu,omitempty"`
	MaxMemoryMiB      int     `json:"maxMemoryMiB,omitempty"`
	MaxSessionDollars float64 `json:"maxSessionDollars,omitempty"`
}

// AgentSessionOverrides are one session's own model, instructions, MCP
// servers, disallowed tools, size and budget, within its agent's
// SessionOverrides. They are recorded on the session (Overrides) and noted
// in its log. Fields left empty are not sent.
type AgentSessionOverrides struct {
	Model string `json:"model,omitempty"`
	// Instructions are added after the agent's, or in their place with
	// InstructionsMode "replace".
	Instructions     string `json:"instructions,omitempty"`
	InstructionsMode string `json:"instructionsMode,omitempty"`
	// MCP names the agent's MCP servers the session keeps; nil keeps them
	// all, an empty non-nil slice none.
	MCP []string `json:"mcp,omitempty"`
	// DisallowedTools are tools the harness may not use: Runtime's own
	// ("spawn", "pr", ...; never wait, reply or done) and the harness's
	// ("Bash", "mcp__github").
	DisallowedTools   []string `json:"disallowedTools,omitempty"`
	VCPU              int      `json:"vcpu,omitempty"`
	MemoryMiB         int      `json:"memoryMiB,omitempty"`
	MaxSessionDollars float64  `json:"maxSessionDollars,omitempty"`
}

// MarshalJSON sends MCP when it is set, even empty (keep no server).
func (o AgentSessionOverrides) MarshalJSON() ([]byte, error) {
	type fields AgentSessionOverrides
	if o.MCP == nil || len(o.MCP) > 0 {
		return json.Marshal(fields(o))
	}
	body, err := withExtra(fields(o), map[string]any{"mcp": []string{}})
	if err != nil {
		return nil, err
	}
	return json.Marshal(body)
}

// AgentAdvisor is a stronger or different model a session asks for advice.
// Provider is inferred from Model when empty (anthropic, openai, google,
// openrouter, or openai-compatible with BaseURL); Secret is the egress
// secret holding its key, that provider's usual one (ANTHROPIC_API_KEY,
// OPENAI_API_KEY, ...) when empty, and must be among Secrets or Pool.
type AgentAdvisor struct {
	Model    string `json:"model"`
	Provider string `json:"provider,omitempty"`
	Secret   string `json:"secret,omitempty"`
	BaseURL  string `json:"baseUrl,omitempty"`
	// MaxCalls caps the advise calls of one session (1 to 200, default 20).
	MaxCalls     int    `json:"maxCalls,omitempty"`
	Instructions string `json:"instructions,omitempty"`
}

// AgentPermissions hold tool calls for a person. Each call is a tool_call
// event in the session's log; one that waits is an ask of the inbox with the
// options Allow and Deny (Asks.Approve, Asks.Deny), and only that call waits.
// A policy is "always_allow" (it runs), "always_ask" (it waits for a person)
// or "auto" (Runtime reads it: it runs, is refused as high_risk, or waits).
type AgentPermissions struct {
	// Default is the policy of a call no entry of Tools names
	// ("always_allow" unless set).
	Default string `json:"default,omitempty"`
	// Tools give a policy by the most particular name that matches: the
	// harness's own tool name (Bash, Edit, apply_patch, run_shell_command,
	// mcp__github__create_issue), an MCP server (mcp:github), or a family
	// (shell, edit, read, web, mcp).
	Tools map[string]string `json:"tools,omitempty"`
}

// AgentFrom is where a session's sandbox starts, one of the three: an image,
// a snapshot id, or a GitHub repository connected to CI/CD ("owner/name"),
// whose warm snapshot each session starts as a copy of: checked out at
// /workspace/repo at its production branch's last passing commit, set up,
// the harness run there.
type AgentFrom struct {
	Image    string `json:"image,omitempty"`
	Snapshot string `json:"snapshot,omitempty"`
	Repo     string `json:"repo,omitempty"`
}

// AgentMCPServer is a remote MCP server (an https URL) the harness may use.
type AgentMCPServer struct {
	Name string `json:"name"`
	URL  string `json:"url"`
}

// AgentVolume attaches a volume at Path in each session's sandbox.
type AgentVolume struct {
	Volume string `json:"volume"`
	Path   string `json:"path"`
}

// AgentNetwork is an agent's sandbox network rules: Internet, and with
// Allow only those hosts.
type AgentNetwork struct {
	Internet bool     `json:"internet"`
	Allow    []string `json:"allow,omitempty"`
}

type agentDefinitionFields AgentDefinition

// MarshalJSON writes the definition with its Extra fields.
func (d AgentDefinition) MarshalJSON() ([]byte, error) {
	body, err := withExtra(agentDefinitionFields(d), d.Extra)
	if err != nil {
		return nil, err
	}
	return json.Marshal(body)
}

// UnmarshalJSON reads the definition and keeps fields it does not know in
// Extra.
func (d *AgentDefinition) UnmarshalJSON(data []byte) error {
	var fields agentDefinitionFields
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	var all map[string]any
	if err := json.Unmarshal(data, &all); err != nil {
		return err
	}
	for _, known := range []string{"command", "from", "vcpu", "memoryMiB", "instructions", "env", "secrets", "pool", "mcp",
		"volumes", "idlePauseSeconds", "maxSessionSeconds", "maxConcurrent", "maxSessionDollars", "maxDayDollars", "template",
		"model", "sessionOverrides", "maxChildren", "advisor", "permissions"} {
		delete(all, known)
	}
	fields.Extra = nil
	if len(all) > 0 {
		fields.Extra = all
	}
	*d = AgentDefinition(fields)
	return nil
}

// Agent is an agent: a name and its definition's current version.
type Agent struct {
	ID         string            `json:"id"`
	Name       string            `json:"name"`
	Version    int               `json:"version"`
	Definition AgentDefinition   `json:"definition"`
	Labels     map[string]string `json:"labels"`
	// Warnings are things the API advises about this agent, such as
	// "subscription_for_customers": a subscription login (a Claude Code
	// token, say) used for an agent that serves your customers, which the
	// providers' terms keep to your own team's agents; use an API key.
	// Empty when there is nothing to say.
	Warnings  []string  `json:"warnings"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type agentFields Agent

// UnmarshalJSON reads an agent; Warnings is empty, never nil.
func (a *Agent) UnmarshalJSON(data []byte) error {
	var fields agentFields
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	if fields.Warnings == nil {
		fields.Warnings = []string{}
	}
	*a = Agent(fields)
	return nil
}

// AgentSessionInfo is a session as the API last described it.
type AgentSessionInfo struct {
	ID           string  `json:"id"`
	AgentID      string  `json:"agentId"`
	AgentVersion int     `json:"agentVersion"`
	Key          *string `json:"key"`
	// Trigger is what started it: api, slack, github, schedule, webhook, or
	// spawn (a child session its parent's harness started).
	Trigger string `json:"trigger"`
	// State is queued, running, waiting, done, failed or stopped.
	State string `json:"state"`
	// Reason says why it ended; among others "budget" (its tree reached
	// MaxSessionDollars), "parent_ended", and "deleted" on a deleted record.
	Reason *string `json:"reason"`
	// Result is what it ended with, as the agent said it (a pull request's
	// address, an answer).
	Result    *string           `json:"result"`
	SandboxID *string           `json:"sandboxId"`
	LastSeq   int64             `json:"lastSeq"`
	Labels    map[string]string `json:"labels"`
	// Overrides is what its start overrode of its agent's definition; nil,
	// nothing.
	Overrides *AgentSessionOverrides `json:"overrides"`
	CreatedAt time.Time              `json:"createdAt"`
	StartedAt *time.Time             `json:"startedAt"`
	EndedAt   *time.Time             `json:"endedAt"`
	// ParentSessionID is the session that spawned it; nil for a top session.
	ParentSessionID *string `json:"parentSessionId"`
	// RootSessionID is the top of its tree: its own ID for a top session.
	RootSessionID string `json:"rootSessionId"`
	// Depth is 0 for a top session, and one more for each parent above it
	// (at most 3).
	Depth int `json:"depth"`
	// Cost is what this session has used so far; TreeCost is it and every
	// session under it. A delete keeps both: it never frees budget.
	Cost     AgentCost `json:"cost"`
	TreeCost AgentCost `json:"treeCost"`
	// HistoryBytes is its log's size, counted as storage and kept until the
	// session is deleted.
	HistoryBytes int64 `json:"historyBytes"`
	// AttachmentBytes is its files' and screenshots' size, counted as
	// storage.
	AttachmentBytes int64 `json:"attachmentBytes"`
	// StopWhy is why a stop was asked: "stopped", "budget" or
	// "parent_ended"; nil when none was.
	StopWhy *string `json:"stopWhy"`
	// DeletedAt is set once its history was deleted (Sessions.Delete).
	DeletedAt *time.Time `json:"deletedAt"`
	// WorkflowID is the workflow that started it as one of its steps.
	WorkflowID *string `json:"workflowId"`
}

// AgentCost is what a session (or its tree) has used.
type AgentCost struct {
	Dollars     float64 `json:"dollars"`
	VCPUSeconds float64 `json:"vcpuSeconds"`
	GiBSeconds  float64 `json:"gibSeconds"`
}

// Ended reports whether the session is done, failed or stopped.
func (i AgentSessionInfo) Ended() bool {
	return i.State == "done" || i.State == "failed" || i.State == "stopped"
}

// AgentEvent is one entry of a session's log.
type AgentEvent struct {
	Seq int64 `json:"seq"`
	// Kind is input, answer, reply, ask, status, result, error, note,
	// child (a child session's end, posted into its parent's log), turn (a
	// model turn) or tool (a tool call): the trace's spans, whose fields
	// are in Body (see AgentSpan).
	Kind string `json:"kind"`
	// Actor is who: a principal's id for the API, slack:<user>,
	// github:<login>, agent for the harness, runtime for the runner.
	Actor     string         `json:"actor"`
	Body      map[string]any `json:"body"`
	CreatedAt time.Time      `json:"createdAt"`
}

// Text is the event's words (Body["text"]), or "" when it has none.
func (e AgentEvent) Text() string {
	text, _ := e.Body["text"].(string)
	return text
}

// AgentTokens counts tokens and their cost at the provider's list price.
type AgentTokens struct {
	// InputTokens leaves out tokens read from or written to the prompt cache.
	InputTokens      int64   `json:"inputTokens"`
	OutputTokens     int64   `json:"outputTokens"`
	CacheReadTokens  int64   `json:"cacheReadTokens"`
	CacheWriteTokens int64   `json:"cacheWriteTokens"`
	CostUSD          float64 `json:"costUsd"`
}

// AgentToolCallRef is a tool call a turn asked for.
type AgentToolCallRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// AgentSpan is one span of a session's trace: a model turn (Kind "turn")
// or a tool call (Kind "tool"). The fields of the other kind are zero.
type AgentSpan struct {
	Seq       int64     `json:"seq"`
	Kind      string    `json:"kind"`
	ID        string    `json:"id"`
	StartedAt time.Time `json:"startedAt"`
	// DurationMS is the turn's time in the model, or the tool call's from
	// the turn that asked for it to the request that carried its result.
	DurationMS int64 `json:"durationMs"`

	// A turn's.
	Provider         string `json:"provider,omitempty"`
	Model            string `json:"model,omitempty"`
	FirstTokenMS     *int64 `json:"firstTokenMs,omitempty"`
	InputTokens      int64  `json:"inputTokens,omitempty"`
	OutputTokens     int64  `json:"outputTokens,omitempty"`
	CacheReadTokens  int64  `json:"cacheReadTokens,omitempty"`
	CacheWriteTokens int64  `json:"cacheWriteTokens,omitempty"`
	// CostUSD is nil for a model with no known list price.
	CostUSD    *float64           `json:"costUsd,omitempty"`
	StopReason *string            `json:"stopReason,omitempty"`
	Status     int                `json:"status,omitempty"`
	ToolCalls  []AgentToolCallRef `json:"toolCalls,omitempty"`

	// A tool call's: Turn is the ID of the turn that asked for it; Input
	// and Output are at most 2,000 characters each.
	Name   string  `json:"name,omitempty"`
	Turn   *string `json:"turn,omitempty"`
	Input  string  `json:"input,omitempty"`
	Output string  `json:"output,omitempty"`

	// Error is a turn's error message (a JSON string) or whether a tool
	// call failed (a JSON boolean).
	Error json.RawMessage `json:"error,omitempty"`
}

// AgentTrace is a page of a session's trace: the whole session's totals,
// by model and by tool, and the spans after the page's after. NextAfter is
// where the next page starts, nil when the log held no more.
type AgentTrace struct {
	SessionID string `json:"sessionId"`
	Totals    struct {
		AgentTokens
		Turns           int64 `json:"turns"`
		ToolCalls       int64 `json:"toolCalls"`
		UnpricedTurns   int64 `json:"unpricedTurns"`
		FailedTurns     int64 `json:"failedTurns"`
		FailedToolCalls int64 `json:"failedToolCalls"`
		ModelMS         int64 `json:"modelMs"`
		ToolMS          int64 `json:"toolMs"`
	} `json:"totals"`
	Models []struct {
		AgentTokens
		Model         string `json:"model"`
		Provider      string `json:"provider"`
		Turns         int64  `json:"turns"`
		UnpricedTurns int64  `json:"unpricedTurns"`
	} `json:"models"`
	Tools []struct {
		Name       string `json:"name"`
		Calls      int64  `json:"calls"`
		Failed     int64  `json:"failed"`
		DurationMS int64  `json:"durationMs"`
	} `json:"tools"`
	Spans     []AgentSpan `json:"spans"`
	NextAfter *int64      `json:"nextAfter"`
}

// AgentTraceOTLP is a page of a session's trace as OpenTelemetry traces.
type AgentTraceOTLP struct {
	// Request is an OTLP/JSON ExportTraceServiceRequest, to POST as it is to
	// any collector's /v1/traces; the first page holds the session's root.
	Request   json.RawMessage
	NextAfter *int64
}

// AgentTrigger starts sessions of its agent from outside the API.
type AgentTrigger struct {
	ID      string `json:"id"`
	AgentID string `json:"agentId"`
	// Kind is slack, github, schedule or webhook.
	Kind string `json:"kind"`
	// Config is the kind's settings; see SlackTrigger, GitHubTrigger,
	// ScheduleTrigger and WebhookTrigger.
	Config map[string]any `json:"config"`
	// Rules are its rules; the zero value is every default.
	Rules     AgentTriggerRules `json:"rules"`
	PausedAt  *time.Time        `json:"pausedAt"`
	PausedWhy *string           `json:"pausedWhy"`
	CreatedAt time.Time         `json:"createdAt"`
}

// AgentTriggerRules are a trigger's rules, every one optional.
type AgentTriggerRules struct {
	// Priority, -100 to 100, orders its sessions in the agent's queue when
	// its maxConcurrent is full: higher first, then oldest. Default 0.
	Priority *int `json:"priority,omitempty"`
	// MaxStartsPerHour caps the sessions it starts in an hour; a call past
	// it is held for you. Joining an open session is never capped.
	MaxStartsPerHour *int `json:"maxStartsPerHour,omitempty"`
	// OnEnded is what a call does when its key's last session has ended:
	// "start" a new one (the default), "note" it in that session's log and
	// run nothing, or "ask" you (the call is held until you start it).
	OnEnded string `json:"onEnded,omitempty"`
	// Notify is where a held call is told: "email" to who added the trigger
	// (the default), or "webhook", the account's webhooks' agent.call.held.
	Notify string `json:"notify,omitempty"`
	// Key, a webhook's only, is the key of a call that sends none, from its
	// JSON's fields: "{cause}", "{alert.host}:{check}".
	Key string `json:"key,omitempty"`
}

// AgentTriggerCall is one call to a webhook trigger.
type AgentTriggerCall struct {
	Text string `json:"text"`
	// Key joins the open session with it, or starts one under it.
	Key    string            `json:"key,omitempty"`
	Labels map[string]string `json:"labels,omitempty"`
	// IdempotencyKey makes a retry the same call; one is made when empty.
	IdempotencyKey string `json:"-"`
}

// AgentTriggerCallOutcome is what a call did.
type AgentTriggerCallOutcome struct {
	// Outcome is started, joined (its key's open session), noted (in its
	// key's ended session's log) or held (for you; Why says why).
	Outcome   string  `json:"outcome"`
	SessionID *string `json:"sessionId"`
	Seq       *int64  `json:"seq"`
	CallID    *string `json:"callId"`
	Why       *string `json:"why"`
	Replayed  bool    `json:"replayed"`
}

// AgentHeldCall is a call a trigger held for you because no session could
// take it. None is ever dropped.
type AgentHeldCall struct {
	ID        string            `json:"id"`
	TriggerID string            `json:"triggerId"`
	AgentID   string            `json:"agentId"`
	Key       *string           `json:"key"`
	Text      string            `json:"text"`
	Labels    map[string]string `json:"labels"`
	// Why is paused, rate (past maxStartsPerHour), ended (its key's session
	// had ended and onEnded is ask), budget, quota or closed.
	Why string `json:"why"`
	// State is held, started or dismissed.
	State      string     `json:"state"`
	SessionID  *string    `json:"sessionId"`
	Notify     string     `json:"notify"`
	CreatedAt  time.Time  `json:"createdAt"`
	ResolvedAt *time.Time `json:"resolvedAt"`
}

// HeldCallListOptions: State narrows to held, started or dismissed; Cursor
// and Limit page.
type HeldCallListOptions struct {
	State  string
	Cursor string
	Limit  int
}

// SlackTrigger is a "slack" trigger's config: a channel of a workspace that
// has Runtime's Slack app installed for this account (else 409
// not_installed).
type SlackTrigger struct {
	// Team is the workspace id (T...).
	Team string `json:"team"`
	// Channel is the channel id (C... or G...).
	Channel string `json:"channel"`
}

// GitHubTrigger is a "github" trigger's config: a repository of your own
// installation of Runtime's GitHub App (else 409 not_installed).
type GitHubTrigger struct {
	// Repository is owner/name.
	Repository string `json:"repository"`
	// Installation is the GitHub App installation's id; required.
	Installation int64 `json:"installation"`
	// Events narrows which of the repository's events start a session.
	Events []string `json:"events,omitempty"`
}

// ScheduleTrigger is a "schedule" trigger's config: a session with Input on
// every Cron tick.
type ScheduleTrigger struct {
	Cron string `json:"cron"`
	// Timezone is an IANA name; UTC when empty.
	Timezone string `json:"timezone,omitempty"`
	Input    string `json:"input"`
}

// WebhookTrigger is a "webhook" trigger's config: it has no settings.
type WebhookTrigger struct{}

// CreateAgentOptions are Create's optional fields.
type CreateAgentOptions struct {
	Labels map[string]string
	// IdempotencyKey: made for you when empty.
	IdempotencyKey string
}

// AgentListOptions: Cursor resumes a list where an earlier page's NextCursor
// left it; Limit caps a page (0: the API's default).
type AgentListOptions struct {
	Cursor string
	Limit  int
}

// StartAgentOptions are Start's optional fields; those left empty are not
// sent.
type StartAgentOptions struct {
	// Key is your own name for the conversation (a Slack thread, a pull
	// request, one of your customers such as "customer:42"): a start with the
	// key of an open session joins it (its input becomes the next message)
	// instead of starting another.
	Key    string
	Labels map[string]string
	// Overrides give this session its own model, instructions, MCP servers,
	// disallowed tools, size and budget within the agent's
	// SessionOverrides: one it does not allow is refused (403
	// permission_denied, naming what it allows).
	Overrides *AgentSessionOverrides
	// IdempotencyKey: made for you when empty.
	IdempotencyKey string
}

// Create makes an agent. A name already used is refused with name_taken
// (409); the names sessions, triggers, templates and approvals are refused,
// since they are paths beside the agents.
//
//	def, err := client.Agents.Templates.Definition("claude-code", "team")
//	agent, err := client.Agents.Create(ctx, "reviewer", def, nil)
func (s *AgentService) Create(ctx context.Context, name string, definition AgentDefinition, opts *CreateAgentOptions) (*Agent, error) {
	if opts == nil {
		opts = &CreateAgentOptions{}
	}
	body := map[string]any{"name": name, "definition": definition}
	if opts.Labels != nil {
		body["labels"] = opts.Labels
	}
	var agent Agent
	return &agent, s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/agents", body: body, key: opts.IdempotencyKey}, &agent)
}

// Get reads an agent by id or name.
func (s *AgentService) Get(ctx context.Context, agent string) (*Agent, error) {
	var out Agent
	return &out, s.c.do(ctx, &call{method: http.MethodGet, path: agentPath(agent)}, &out)
}

// List returns the first page of agents (opts may be nil). Page.All walks
// every one.
func (s *AgentService) List(ctx context.Context, opts *AgentListOptions) (*Page[Agent], error) {
	query := url.Values{}
	cursor := ""
	if opts != nil {
		setQuery(query, "limit", itoa(opts.Limit))
		cursor = opts.Cursor
	}
	return nextPage[Agent](ctx, s.c, "/v1/agents", query, cursor)
}

// All walks every agent, across pages.
func (s *AgentService) All(ctx context.Context) iter.Seq2[Agent, error] {
	return walk(ctx, func() (*Page[Agent], error) { return s.List(ctx, nil) })
}

// Update replaces an agent's definition, whole, as its next version.
func (s *AgentService) Update(ctx context.Context, agent string, definition AgentDefinition) (*Agent, error) {
	var out Agent
	return &out, s.c.do(ctx, &call{method: http.MethodPatch, path: agentPath(agent), body: map[string]any{"definition": definition}}, &out)
}

// Delete deletes an agent: its triggers go, and its open sessions are asked
// to stop.
func (s *AgentService) Delete(ctx context.Context, agent string) error {
	return s.c.do(ctx, &call{method: http.MethodDelete, path: agentPath(agent)}, nil)
}

// Start starts a session of an agent with input as its first words, or, when
// opts.Key names an open session, joins that one (Joined says so).
func (s *AgentService) Start(ctx context.Context, agent, input string, opts *StartAgentOptions) (*AgentSession, error) {
	if opts == nil {
		opts = &StartAgentOptions{}
	}
	body := map[string]any{"input": input}
	if opts.Key != "" {
		body["key"] = opts.Key
	}
	if opts.Labels != nil {
		body["labels"] = opts.Labels
	}
	if opts.Overrides != nil {
		body["overrides"] = opts.Overrides
	}
	var out struct {
		Session AgentSessionInfo `json:"session"`
		Joined  bool             `json:"joined"`
		Seq     int64            `json:"seq"`
	}
	if err := s.c.do(ctx, &call{method: http.MethodPost, path: agentPath(agent) + "/sessions", body: body, key: opts.IdempotencyKey}, &out); err != nil {
		return nil, err
	}
	return &AgentSession{c: s.c, info: out.Session, joined: out.Joined, seq: out.Seq}, nil
}

func agentPath(agent string) string { return "/v1/agents/" + url.PathEscape(agent) }

// AgentSessionService is client.Agents.Sessions.
type AgentSessionService struct{ c *Client }

// AgentSessionListOptions filter a list, every field optional.
type AgentSessionListOptions struct {
	// Agent is an agent's id or name.
	Agent string
	// State is one of queued, running, waiting, done, failed or stopped.
	State string
	// Parent is a session's id: its direct children.
	Parent string
	// Root is a top session's id: its whole tree, the root included.
	Root string
	// Deleted includes deleted records, which a list hides otherwise.
	Deleted bool
	Cursor  string
	// Limit caps a page (0: the API's default).
	Limit int
}

// Get reconnects to a session by id.
func (s *AgentSessionService) Get(ctx context.Context, id string) (*AgentSession, error) {
	session := &AgentSession{c: s.c, info: AgentSessionInfo{ID: id}}
	if err := session.Refresh(ctx); err != nil {
		return nil, err
	}
	session.seq = session.Info().LastSeq
	return session, nil
}

// Delete deletes an ended session's history: its log, and every log under it
// in its tree. Until then the history is kept, counted as storage. The
// session is kept as a deleted record: Get still reads it, with DeletedAt
// set, Reason "deleted", Key and Result cleared and its cost kept (a delete
// never frees budget), and its log reads empty. An open session or tree is
// refused with 409 session_open (errors.Is ErrConflict): stop it first.
func (s *AgentSessionService) Delete(ctx context.Context, id string) error {
	return s.c.do(ctx, &call{method: http.MethodDelete, path: "/v1/agents/sessions/" + url.PathEscape(id)}, nil)
}

// List returns the first page of sessions, newest first (opts may be nil).
// Page.All walks every one.
func (s *AgentSessionService) List(ctx context.Context, opts *AgentSessionListOptions) (*Page[AgentSessionInfo], error) {
	query := url.Values{}
	cursor := ""
	if opts != nil {
		setQuery(query, "agent", opts.Agent, "state", opts.State, "parent", opts.Parent, "root", opts.Root,
			"limit", itoa(opts.Limit))
		if opts.Deleted {
			query.Set("deleted", "true")
		}
		cursor = opts.Cursor
	}
	return nextPage[AgentSessionInfo](ctx, s.c, "/v1/agents/sessions", query, cursor)
}

// All walks every session a list with these options finds, across pages.
func (s *AgentSessionService) All(ctx context.Context, opts *AgentSessionListOptions) iter.Seq2[AgentSessionInfo, error] {
	return walk(ctx, func() (*Page[AgentSessionInfo], error) { return s.List(ctx, opts) })
}

// AgentSession is one session of an agent. Its methods are safe for
// concurrent use.
type AgentSession struct {
	c      *Client
	mu     sync.RWMutex
	info   AgentSessionInfo
	joined bool
	seq    int64
}

// ID is the session's id.
func (s *AgentSession) ID() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.info.ID
}

// Info is what the API last said about the session. Refresh asks again.
func (s *AgentSession) Info() AgentSessionInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.info
}

// Joined reports whether Start joined an open session with the same key
// rather than starting one.
func (s *AgentSession) Joined() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.joined
}

// Seq is the seq of the input Start wrote, or the session's last seq when it
// was found with Sessions.Get.
func (s *AgentSession) Seq() int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.seq
}

func (s *AgentSession) set(info AgentSessionInfo) {
	s.mu.Lock()
	s.info = info
	s.mu.Unlock()
}

func (s *AgentSession) path(suffix string) string {
	return "/v1/agents/sessions/" + url.PathEscape(s.ID()) + suffix
}

// Refresh reads the session again.
func (s *AgentSession) Refresh(ctx context.Context) error {
	var info AgentSessionInfo
	if err := s.c.do(ctx, &call{method: http.MethodGet, path: s.path("")}, &info); err != nil {
		return err
	}
	s.set(info)
	return nil
}

// Children returns the first page of its direct children, the sessions its
// harness started (Trigger "spawn"), newest first. Page.All walks every one;
// Sessions.List with Root reads a whole tree.
func (s *AgentSession) Children(ctx context.Context) (*Page[AgentSessionInfo], error) {
	return nextPage[AgentSessionInfo](ctx, s.c, "/v1/agents/sessions", url.Values{"parent": {s.ID()}}, "")
}

// AgentSendOptions are Send's optional fields.
type AgentSendOptions struct {
	// IdempotencyKey: made for you when empty, and kept across retries, so
	// a retried send is never two messages.
	IdempotencyKey string
}

// Send writes text into the session as its next message and returns that
// event's seq. A session that has ended refuses it (409 session_ended).
func (s *AgentSession) Send(ctx context.Context, text string, opts *AgentSendOptions) (int64, error) {
	if opts == nil {
		opts = &AgentSendOptions{}
	}
	var out struct {
		Seq int64 `json:"seq"`
	}
	err := s.c.do(ctx, &call{method: http.MethodPost, path: s.path("/messages"), body: map[string]any{"text": text}, key: opts.IdempotencyKey}, &out)
	return out.Seq, err
}

// agentEventsWait is how long one read of the log waits for new events.
const agentEventsWait = 30

type agentEventPage struct {
	Data  []AgentEvent `json:"data"`
	Ended bool         `json:"ended"`
}

// events reads the log after a seq, the server holding the answer up to wait
// seconds for a new event. Its deadline is the long poll's plus a margin.
func (s *AgentSession) events(ctx context.Context, after int64, wait int) (*agentEventPage, error) {
	timeout := time.Duration(0)
	if limit := time.Duration(wait)*time.Second + 15*time.Second; s.c.timeout < limit {
		timeout = limit
	}
	var page agentEventPage
	err := s.c.do(ctx, &call{
		method:  http.MethodGet,
		path:    s.path("/events"),
		query:   url.Values{"after": {strconv.FormatInt(after, 10)}, "wait": {strconv.Itoa(wait)}},
		timeout: timeout,
	}, &page)
	return &page, err
}

// Events walks the session's log in order from after the given seq (0 for
// the whole log), waiting for new events as they come, and ends once the
// session has ended and every event is read. Breaking out of the loop stops
// it.
//
//	for event, err := range session.Events(ctx, 0) {
//		if err != nil {
//			return err
//		}
//		fmt.Println(event.Kind, event.Text())
//	}
func (s *AgentSession) Events(ctx context.Context, after int64) iter.Seq2[AgentEvent, error] {
	return func(yield func(AgentEvent, error) bool) {
		// Once a page says the session ended, the rest of the log is read
		// without waiting, until a page comes back empty.
		draining := false
		for {
			wait := agentEventsWait
			if draining {
				wait = 0
			}
			page, err := s.events(ctx, after, wait)
			if err != nil {
				yield(AgentEvent{}, err)
				return
			}
			for _, event := range page.Data {
				if !yield(event, nil) {
					return
				}
				after = event.Seq
			}
			if draining && len(page.Data) == 0 {
				return
			}
			if page.Ended {
				draining = true
			}
		}
	}
}

func tracePage(format string, after int64, limit int) url.Values {
	q := url.Values{"format": {format}, "after": {strconv.FormatInt(after, 10)}}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	return q
}

// Trace reads a page of the session's trace: every model turn and tool call
// its harness made, with timing, tokens and cost at the provider's list
// price. It holds up to limit spans after after (0: 200; 500 at most) and
// the whole session's totals; read on with after set to *NextAfter until
// NextAfter is nil.
//
//	for after := int64(0); ; {
//		page, err := session.Trace(ctx, after, 500)
//		if err != nil {
//			return err
//		}
//		for _, span := range page.Spans {
//			fmt.Println(span.Kind, span.DurationMS)
//		}
//		if page.NextAfter == nil {
//			break
//		}
//		after = *page.NextAfter
//	}
func (s *AgentSession) Trace(ctx context.Context, after int64, limit int) (*AgentTrace, error) {
	var trace AgentTrace
	if err := s.c.do(ctx, &call{method: http.MethodGet, path: s.path("/trace"), query: tracePage("json", after, limit)}, &trace); err != nil {
		return nil, err
	}
	return &trace, nil
}

// TraceOTLP reads the same page as OpenTelemetry traces: OTLP/JSON (an
// ExportTraceServiceRequest) in the GenAI semantic conventions.
func (s *AgentSession) TraceOTLP(ctx context.Context, after int64, limit int) (*AgentTraceOTLP, error) {
	var page struct {
		ResourceSpans json.RawMessage `json:"resourceSpans"`
		NextAfter     *int64          `json:"nextAfter"`
	}
	if err := s.c.do(ctx, &call{method: http.MethodGet, path: s.path("/trace"), query: tracePage("otlp", after, limit)}, &page); err != nil {
		return nil, err
	}
	request, err := json.Marshal(map[string]json.RawMessage{"resourceSpans": page.ResourceSpans})
	if err != nil {
		return nil, err
	}
	return &AgentTraceOTLP{Request: request, NextAfter: page.NextAfter}, nil
}

// Stop asks the session to stop and returns it as it is then. A running
// session ends once its sandbox is gone; Stop does not wait for that (Wait
// does).
func (s *AgentSession) Stop(ctx context.Context) (*AgentSessionInfo, error) {
	var info AgentSessionInfo
	if err := s.c.do(ctx, &call{method: http.MethodPost, path: s.path("/stop"), body: map[string]any{}}, &info); err != nil {
		return nil, err
	}
	s.set(info)
	return &info, nil
}

// Wait waits until the session has ended (done, failed or stopped) and
// returns it; a failed session is returned, not an error. It waits on the
// server, with no polling. timeout 0 waits as long as ctx allows; past a
// timeout it returns an *Error whose Code is timeout.
func (s *AgentSession) Wait(ctx context.Context, timeout time.Duration) (*AgentSessionInfo, error) {
	var deadline time.Time
	if timeout > 0 {
		deadline = time.Now().Add(timeout)
		var cancel context.CancelFunc
		ctx, cancel = context.WithDeadline(ctx, deadline)
		defer cancel()
	}
	timedOut := func(err error) error {
		if timeout > 0 && errors.Is(ctx.Err(), context.DeadlineExceeded) && !time.Now().Before(deadline) {
			return &Error{
				Code:    "timeout",
				Message: fmt.Sprintf("Session %s had not ended after %s.", s.ID(), timeout),
				Hint:    "Wait again, or end it with Stop.",
				Err:     err,
			}
		}
		return err
	}
	for {
		if err := s.Refresh(ctx); err != nil {
			return nil, timedOut(err)
		}
		info := s.Info()
		if info.Ended() {
			return &info, nil
		}
		wait := agentEventsWait
		if timeout > 0 {
			left := time.Until(deadline)
			if left <= 0 {
				return nil, timedOut(context.DeadlineExceeded)
			}
			wait = min(wait, max(1, int(math.Ceil(left.Seconds()))))
		}
		// Returns at a new event, at the end, or after wait seconds; then
		// the session is read again.
		if _, err := s.events(ctx, info.LastSeq, wait); err != nil {
			return nil, timedOut(err)
		}
	}
}

// AgentTriggerService is client.Agents.Triggers.
type AgentTriggerService struct{ c *Client }

// Create adds a trigger to an agent. kind is slack, github, schedule or
// webhook, and config its settings: a SlackTrigger, GitHubTrigger,
// ScheduleTrigger or WebhookTrigger, or a map.
//
//	trigger, err := client.Agents.Triggers.Create(ctx, "reviewer", "github",
//		withruntime.GitHubTrigger{Repository: "acme/app", Installation: 12345678})
func (s *AgentTriggerService) Create(ctx context.Context, agent, kind string, config any) (*AgentTrigger, error) {
	if config == nil {
		config = map[string]any{}
	}
	var out AgentTrigger
	return &out, s.c.do(ctx, &call{method: http.MethodPost, path: agentPath(agent) + "/triggers", body: map[string]any{"kind": kind, "config": config}}, &out)
}

// CreateWithRules adds a trigger with its rules.
//
//	trigger, err := client.Agents.Triggers.CreateWithRules(ctx, "alerts", "webhook",
//		withruntime.WebhookTrigger{}, withruntime.AgentTriggerRules{Key: "{cause}", OnEnded: "ask"})
func (s *AgentTriggerService) CreateWithRules(ctx context.Context, agent, kind string, config any, rules AgentTriggerRules) (*AgentTrigger, error) {
	if config == nil {
		config = map[string]any{}
	}
	var out AgentTrigger
	return &out, s.c.do(ctx, &call{method: http.MethodPost, path: agentPath(agent) + "/triggers", body: map[string]any{"kind": kind, "config": config, "rules": rules}}, &out)
}

// SetRules replaces a trigger's rules, whole, in place: its secret stays.
func (s *AgentTriggerService) SetRules(ctx context.Context, id string, rules AgentTriggerRules) (*AgentTrigger, error) {
	var out AgentTrigger
	return &out, s.c.do(ctx, &call{method: http.MethodPatch, path: triggerPath(id), body: map[string]any{"rules": rules}}, &out)
}

// Call calls a webhook trigger as its sender would, by its secret, never
// your key. A call with the key of an open session joins it.
func (s *AgentTriggerService) Call(ctx context.Context, id, secret string, in AgentTriggerCall) (*AgentTriggerCallOutcome, error) {
	var out AgentTriggerCallOutcome
	return &out, s.c.do(ctx, &call{method: http.MethodPost, path: triggerPath(id) + "/calls", body: in, bearer: secret, key: in.IdempotencyKey}, &out)
}

// Held lists the calls a trigger held for you, newest first (opts may be
// nil). Page.All walks every one.
func (s *AgentTriggerService) Held(ctx context.Context, id string, opts *HeldCallListOptions) (*Page[AgentHeldCall], error) {
	query := url.Values{}
	cursor := ""
	if opts != nil {
		setQuery(query, "state", opts.State, "limit", itoa(opts.Limit))
		cursor = opts.Cursor
	}
	return nextPage[AgentHeldCall](ctx, s.c, triggerPath(id)+"/held", query, cursor)
}

// StartedHeldCall is what starting a held call made.
type StartedHeldCall struct {
	Session AgentSessionInfo `json:"session"`
	Joined  bool             `json:"joined"`
	// Calls is how many held calls it took: this one and every one held
	// for its key since.
	Calls int `json:"calls"`
}

// StartHeld starts a held call: one session with it and every call held for
// its key since, oldest first.
func (s *AgentTriggerService) StartHeld(ctx context.Context, id, callID string) (*StartedHeldCall, error) {
	var out StartedHeldCall
	return &out, s.c.do(ctx, &call{method: http.MethodPost, path: triggerPath(id) + "/held/" + url.PathEscape(callID) + "/start", body: map[string]any{}}, &out)
}

// DismissHeld dismisses a held call: nothing runs.
func (s *AgentTriggerService) DismissHeld(ctx context.Context, id, callID string) (*AgentHeldCall, error) {
	var out AgentHeldCall
	return &out, s.c.do(ctx, &call{method: http.MethodPost, path: triggerPath(id) + "/held/" + url.PathEscape(callID) + "/dismiss", body: map[string]any{}}, &out)
}

// List returns an agent's triggers.
func (s *AgentTriggerService) List(ctx context.Context, agent string) ([]AgentTrigger, error) {
	return productList[AgentTrigger](ctx, s.c, agentPath(agent)+"/triggers", nil)
}

// Pause holds a trigger, saying why: a webhook's calls are held for you
// (Held), never dropped. The agent's other triggers and the API go on.
func (s *AgentTriggerService) Pause(ctx context.Context, id, why string) (*AgentTrigger, error) {
	var out AgentTrigger
	return &out, s.c.do(ctx, &call{method: http.MethodPost, path: triggerPath(id) + "/pause", body: map[string]any{"why": why}}, &out)
}

// Resume lets a paused trigger start sessions again.
func (s *AgentTriggerService) Resume(ctx context.Context, id string) (*AgentTrigger, error) {
	var out AgentTrigger
	return &out, s.c.do(ctx, &call{method: http.MethodPost, path: triggerPath(id) + "/resume", body: map[string]any{}}, &out)
}

// Delete deletes a trigger.
func (s *AgentTriggerService) Delete(ctx context.Context, id string) error {
	return s.c.do(ctx, &call{method: http.MethodDelete, path: triggerPath(id)}, nil)
}

func triggerPath(id string) string { return "/v1/agents/triggers/" + url.PathEscape(id) }

// AgentSlackService is client.Agents.Slack: Runtime's Slack app in your
// workspaces. Add it with Install's link; a slack trigger then names a
// workspace's Team and a channel the app is in.
type AgentSlackService struct{ c *Client }

// SlackInstallLink adds Runtime's Slack app to a workspace until ExpiresAt.
type SlackInstallLink struct {
	URL       string `json:"url"`
	ExpiresAt string `json:"expiresAt"`
}

// SlackTeam is a Slack workspace added to the account: Team is a slack
// trigger's team.
type SlackTeam struct {
	Team        string  `json:"team"`
	Name        *string `json:"name"`
	BotUser     string  `json:"botUser"`
	InstalledAt string  `json:"installedAt"`
}

// Install answers a link that adds Runtime's Slack app to a workspace, good
// for 15 minutes. Open it as a person who may add apps to the workspace;
// Slack sends them back to the console once it is added.
func (s *AgentSlackService) Install(ctx context.Context) (*SlackInstallLink, error) {
	var out SlackInstallLink
	return &out, s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/agents/slack/installs", body: map[string]any{}}, &out)
}

// Teams lists the workspaces added to the account.
func (s *AgentSlackService) Teams(ctx context.Context) ([]SlackTeam, error) {
	return productList[SlackTeam](ctx, s.c, "/v1/agents/slack/teams", nil)
}

// Remove removes a workspace: its token is revoked, and its triggers refuse
// events until it is added again.
func (s *AgentSlackService) Remove(ctx context.Context, team string) error {
	return s.c.do(ctx, &call{method: http.MethodDelete, path: "/v1/agents/slack/teams/" + url.PathEscape(team)}, nil)
}

// nextPage reads one {data, nextCursor} page of path, and wires Next to read the
// one after it with the same query.
func nextPage[T any](ctx context.Context, c *Client, path string, query url.Values, cursor string) (*Page[T], error) {
	q := url.Values{}
	for key, values := range query {
		q[key] = values
	}
	if cursor != "" {
		q.Set("cursor", cursor)
	}
	var body struct {
		Data []T     `json:"data"`
		Next *string `json:"nextCursor"`
	}
	if err := c.do(ctx, &call{method: http.MethodGet, path: path, query: q}, &body); err != nil {
		return nil, err
	}
	return &Page[T]{
		Data:       body.Data,
		NextCursor: body.Next,
		next: func(ctx context.Context, next string) (*Page[T], error) {
			return nextPage[T](ctx, c, path, query, next)
		},
	}, nil
}

/* Templates: data, the same in every Runtime SDK and the guide
   (packages/cloud-guide/agent-templates.json). */

// AgentTemplate is a harness Runtime knows how to run: its command and the
// egress secret its API key goes in. A subscription (a Claude Pro or Max
// token, a ChatGPT login) is for your own team's agents; an agent that
// serves your customers (api or webhook sessions for your end users) uses an
// API key, as the providers' terms say, and the API warns
// subscription_for_customers otherwise.
type AgentTemplate struct {
	Key     string `json:"key"`
	Title   string `json:"title"`
	Command string `json:"command"`
	// APIKeySecret is the egress secret to set (client.Secrets) for
	// APIKeyHost.
	APIKeySecret string `json:"apiKeySecret"`
	APIKeyHost   string `json:"apiKeyHost"`
	// Subscription says how to use a subscription login instead of an API
	// key, for your own team's agents only; nil when the harness takes only
	// an API key.
	Subscription *string `json:"subscription"`
	// Definition is the harness's part of an agent's definition.
	Definition AgentDefinition `json:"definition"`
}

// AgentUse is a preset for what an agent is for: "support" (your customers,
// driven by your own app, one session per end customer under your own key
// such as "customer:42", paused between their messages; use an API key)
// or "team" (your team's work from Slack and GitHub).
type AgentUse struct {
	Key   string `json:"key"`
	Title string `json:"title"`
	// SessionKey is the session key shape it uses, nil when each piece of
	// work is its own session.
	SessionKey *string  `json:"sessionKey"`
	Triggers   []string `json:"triggers"`
	// Definition is merged over a template's (AgentTemplateService.Definition).
	Definition AgentDefinition `json:"definition"`
}

// AgentTemplateService is client.Agents.Templates: data, no calls.
type AgentTemplateService struct{}

// List returns the harness templates, in order: claude-code, codex,
// gemini-cli, claude-agent-sdk, openai-agents-sdk, review (a CI/CD agent
// step's reviewer, on a Pool of Claude accounts) and judge (an agent step
// held to its instructions alone).
func (*AgentTemplateService) List() []AgentTemplate { return agentTemplates() }

// Get returns the harness template with this key.
func (t *AgentTemplateService) Get(key string) (AgentTemplate, bool) {
	for _, template := range t.List() {
		if template.Key == key {
			return template, true
		}
	}
	return AgentTemplate{}, false
}

// Uses returns the uses' presets, in order: support, team.
func (*AgentTemplateService) Uses() []AgentUse { return agentUses() }

// Use returns the use with this key.
func (t *AgentTemplateService) Use(key string) (AgentUse, bool) {
	for _, use := range t.Uses() {
		if use.Key == key {
			return use, true
		}
	}
	return AgentUse{}, false
}

// Definition returns a new definition: the template's, with the use's preset
// over it (use "" for the template's alone), ready for Agents.Create. An
// unknown key is an *Error whose Code is invalid_request, and nothing is
// sent.
//
//	def, err := client.Agents.Templates.Definition("claude-code", "support")
func (t *AgentTemplateService) Definition(template, use string) (AgentDefinition, error) {
	harness, ok := t.Get(template)
	if !ok {
		return AgentDefinition{}, unknownTemplate("template", template)
	}
	merged := map[string]any{}
	if err := mergeInto(merged, harness.Definition); err != nil {
		return AgentDefinition{}, err
	}
	if use != "" {
		preset, ok := t.Use(use)
		if !ok {
			return AgentDefinition{}, unknownTemplate("use", use)
		}
		if err := mergeInto(merged, preset.Definition); err != nil {
			return AgentDefinition{}, err
		}
	}
	encoded, err := json.Marshal(merged)
	if err != nil {
		return AgentDefinition{}, err
	}
	var out AgentDefinition
	return out, json.Unmarshal(encoded, &out)
}

// mergeInto puts the definition's fields in fields, over those there.
func mergeInto(fields map[string]any, definition AgentDefinition) error {
	encoded, err := json.Marshal(definition)
	if err != nil {
		return err
	}
	return json.Unmarshal(encoded, &fields)
}

func unknownTemplate(what, key string) *Error {
	return &Error{
		Code:    "invalid_request",
		Status:  400,
		Message: fmt.Sprintf("No agent %s is named %q.", what, key),
		Hint:    "Templates are claude-code, codex, gemini-cli, claude-agent-sdk, openai-agents-sdk, review, judge and browser; uses are support and team.",
	}
}

func agentTemplates() []AgentTemplate {
	text := func(s string) *string { return &s }
	claudeCode := `npx -y @anthropic-ai/claude-code --dangerously-skip-permissions --mcp-config ~/.runtime-agent/mcp.json -p "$(cat ~/.runtime-agent/start.md)"`
	codex := `npx -y @openai/codex exec --dangerously-bypass-approvals-and-sandbox "$(cat ~/.runtime-agent/start.md)"`
	gemini := `npx -y @google/gemini-cli --yolo -p "$(cat ~/.runtime-agent/start.md)"`
	python := "python3 ~/agent.py"
	review := "python3 ~/.runtime-agent/runtime-agent review"
	judge := "python3 ~/.runtime-agent/runtime-agent judge"
	browse := "python3 ~/.runtime-agent/runtime-agent browse"
	return []AgentTemplate{
		{
			Key: "claude-code", Title: "Claude Code", Command: claudeCode,
			APIKeySecret: "ANTHROPIC_API_KEY", APIKeyHost: "api.anthropic.com",
			Subscription: text("token: run `claude setup-token` on your own computer (Pro/Max), then `runtime secrets set CLAUDE_CODE_OAUTH_TOKEN` scoped to api.anthropic.com"),
			Definition:   AgentDefinition{Command: claudeCode, Secrets: []string{"ANTHROPIC_API_KEY"}},
		},
		{
			Key: "codex", Title: "Codex CLI", Command: codex,
			APIKeySecret: "OPENAI_API_KEY", APIKeyHost: "api.openai.com",
			Subscription: text("login once in the sandbox's terminal: `npx -y @openai/codex login --device-auth`, kept in the snapshot or a volume at `~/.codex`"),
			Definition:   AgentDefinition{Command: codex, Secrets: []string{"OPENAI_API_KEY"}},
		},
		{
			Key: "gemini-cli", Title: "Gemini CLI", Command: gemini,
			APIKeySecret: "GEMINI_API_KEY", APIKeyHost: "generativelanguage.googleapis.com",
			Subscription: text("login once in the sandbox's terminal (Sign in with Google), kept at `~/.gemini`"),
			Definition:   AgentDefinition{Command: gemini, Secrets: []string{"GEMINI_API_KEY"}},
		},
		{
			Key: "claude-agent-sdk", Title: "Claude Agent SDK", Command: python,
			APIKeySecret: "ANTHROPIC_API_KEY", APIKeyHost: "api.anthropic.com",
			Definition: AgentDefinition{Command: python, Secrets: []string{"ANTHROPIC_API_KEY"}},
		},
		{
			Key: "openai-agents-sdk", Title: "OpenAI Agents SDK", Command: python,
			APIKeySecret: "OPENAI_API_KEY", APIKeyHost: "api.openai.com",
			Definition: AgentDefinition{Command: python, Secrets: []string{"OPENAI_API_KEY"}},
		},
		{
			Key: "review", Title: "Code review", Command: review,
			APIKeySecret: "ANTHROPIC_API_KEY", APIKeyHost: "api.anthropic.com",
			Subscription: text("a token per account: run `claude setup-token` on your own computer (Pro/Max) for each, store each with `runtime secrets set CLAUDE_1` scoped to api.anthropic.com, then name them all in pool (--pool CLAUDE_1 --pool CLAUDE_2)"),
			Definition:   AgentDefinition{Command: review, Pool: []string{"ANTHROPIC_API_KEY"}, VCPU: 2, MemoryMiB: 2048, MaxSessionSeconds: 1800},
		},
		{
			Key: "judge", Title: "Your rules", Command: judge,
			APIKeySecret: "ANTHROPIC_API_KEY", APIKeyHost: "api.anthropic.com",
			Subscription: text("a token per account, as for review: `runtime secrets set CLAUDE_1` scoped to api.anthropic.com for each, then name them all in pool; its instructions are the rules that block"),
			Definition:   AgentDefinition{Command: judge, Pool: []string{"ANTHROPIC_API_KEY"}, VCPU: 2, MemoryMiB: 2048, MaxSessionSeconds: 1800},
		},
		{
			Key: "browser", Title: "Browser task", Command: browse,
			APIKeySecret: "ANTHROPIC_API_KEY", APIKeyHost: "api.anthropic.com",
			Definition: AgentDefinition{Command: browse, Secrets: []string{"ANTHROPIC_API_KEY"}, VCPU: 2, MemoryMiB: 4096, MaxSessionSeconds: 1800},
		},
	}
}

func agentUses() []AgentUse {
	perCustomer := "customer:<id>"
	return []AgentUse{
		{
			Key: "support", Title: "Your customers", SessionKey: &perCustomer, Triggers: []string{"api", "webhook"},
			Definition: AgentDefinition{Template: "support", VCPU: 1, MemoryMiB: 1024, IdlePauseSeconds: 10, MaxConcurrent: 1000},
		},
		{
			Key: "team", Title: "Your team", Triggers: []string{"slack", "github"},
			Definition: AgentDefinition{Template: "team", VCPU: 4, MemoryMiB: 8192},
		},
	}
}
