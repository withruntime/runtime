package withruntime

import (
	"context"
	"errors"
	"iter"
	"net/http"
	"net/url"
	"sort"
	"time"
)

/* The account's inbox: the questions its agents' sessions need answered to
   go on. Each has why it matters, options (a label and what it costs), a
   recommended pick and maybe an expiry. Asks of one agent's sessions
   sharing a memory, with the same step, are one row while it is open, and
   one answer reaches every session asking. An ask closes by itself when every session asking it
   ends, when they withdraw it, or when it expires, its pick taken as the
   answer when it has one. */

// AgentAskService is client.Agents.Asks.
type AgentAskService struct{ c *Client }

// AgentAskOption is one answer an ask offers.
type AgentAskOption struct {
	Label string `json:"label"`
	// Detail says what it costs and what happens after it.
	Detail string `json:"detail,omitempty"`
}

// AgentAskAnswer is how an ask was answered.
type AgentAskAnswer struct {
	// Option is the label picked, if one was.
	Option string `json:"option,omitempty"`
	// Text is the words given, if any.
	Text string `json:"text,omitempty"`
	// Expired: the pick was taken because no one answered in time.
	Expired bool `json:"expired,omitempty"`
}

// AgentAskSession is one session asking an ask.
type AgentAskSession struct {
	SessionID string `json:"sessionId"`
	// State is asking, answered, expired, withdrawn or ended.
	State string `json:"state"`
	// Seq is its ask event in the session's log.
	Seq int64 `json:"seq"`
	// AnswerSeq is the answer event that woke it.
	AnswerSeq *int64 `json:"answerSeq"`
}

// AgentAsk is one row of the inbox.
type AgentAsk struct {
	ID string `json:"id"`
	// AgentID is the agent of the session that asked first.
	AgentID string `json:"agentId"`
	// Step is what it waits on, in the asker's words; nil for none.
	Step     *string          `json:"step"`
	Question string           `json:"question"`
	Why      *string          `json:"why"`
	Options  []AgentAskOption `json:"options"`
	// Pick is the recommended option's label, taken when it expires.
	Pick *string `json:"pick"`
	// Labels say who sees it: its agent's, with the ask's own over them.
	Labels map[string]string `json:"labels"`
	// State is open, answered, withdrawn, expired or closed.
	State  string          `json:"state"`
	Answer *AgentAskAnswer `json:"answer"`
	// AnsweredBy is a key's principal id, or runtime for a pick at expiry.
	AnsweredBy *string           `json:"answeredBy"`
	Sessions   []AgentAskSession `json:"sessions"`
	ExpiresAt  *time.Time        `json:"expiresAt"`
	CreatedAt  time.Time         `json:"createdAt"`
	UpdatedAt  time.Time         `json:"updatedAt"`
	ClosedAt   *time.Time        `json:"closedAt"`
	// ToolCall is the tool call it holds, answered Allow or Deny; nil for
	// any other ask.
	ToolCall *AgentAskToolCall `json:"toolCall"`
}

// AgentAskToolCall is a call the agent's permissions hold for a person.
type AgentAskToolCall struct {
	// Tool is the harness's name for it: Bash, apply_patch, mcp__github__create_issue.
	Tool      string         `json:"tool"`
	Input     map[string]any `json:"input"`
	ToolUseID string         `json:"toolUseId,omitempty"`
	// Seq is its tool_call event in the session's log.
	Seq int64 `json:"seq,omitempty"`
	// Policy is always_ask or auto; ReasonCode says why auto held it.
	Policy     string `json:"policy"`
	ReasonCode string `json:"reasonCode,omitempty"`
}

// AgentAskListOptions filter the inbox, every field optional.
type AgentAskListOptions struct {
	// States are open (the default), answered, expired, withdrawn, closed.
	States []string
	// Agent is an agent's id or name.
	Agent string
	// Labels: only asks carrying every one (who sees an ask).
	Labels map[string]string
	Cursor string
	// Limit caps a page (0: the API's default).
	Limit int
}

// AgentAnswerOptions are Answer's optional fields.
type AgentAnswerOptions struct {
	// Text is words, with the option or instead of it.
	Text string
	// IdempotencyKey: made for you when empty, and kept across retries.
	IdempotencyKey string
}

// List returns the first page of the inbox, newest first (opts may be nil).
func (s *AgentAskService) List(ctx context.Context, opts *AgentAskListOptions) (*Page[AgentAsk], error) {
	query := url.Values{}
	cursor := ""
	if opts != nil {
		for _, state := range opts.States {
			query.Add("state", state)
		}
		keys := make([]string, 0, len(opts.Labels))
		for k := range opts.Labels {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			query.Add("label", k+":"+opts.Labels[k])
		}
		setQuery(query, "agent", opts.Agent, "limit", itoa(opts.Limit))
		cursor = opts.Cursor
	}
	return nextPage[AgentAsk](ctx, s.c, "/v1/agents/asks", query, cursor)
}

// All walks every ask a list with these options finds, across pages.
func (s *AgentAskService) All(ctx context.Context, opts *AgentAskListOptions) iter.Seq2[AgentAsk, error] {
	return walk(ctx, func() (*Page[AgentAsk], error) { return s.List(ctx, opts) })
}

// Get reads one ask, with the sessions asking it.
func (s *AgentAskService) Get(ctx context.Context, id string) (*AgentAsk, error) {
	var out AgentAsk
	return &out, s.c.do(ctx, &call{method: http.MethodGet, path: askPath(id)}, &out)
}

// Answer answers an open ask with an option's label (or "" for none) and/or
// opts.Text: every session asking reads it next and wakes. One no longer
// open is refused 409 ask_closed (errors.Is ErrConflict).
func (s *AgentAskService) Answer(ctx context.Context, id, option string, opts *AgentAnswerOptions) (*AgentAsk, error) {
	if opts == nil {
		opts = &AgentAnswerOptions{}
	}
	if option == "" && opts.Text == "" {
		return nil, errors.New("withruntime: an answer is an option's label, text, or both")
	}
	body := map[string]any{}
	if option != "" {
		body["option"] = option
	}
	if opts.Text != "" {
		body["text"] = opts.Text
	}
	var out AgentAsk
	return &out, s.c.do(ctx, &call{method: http.MethodPost, path: askPath(id) + "/answer", body: body, key: opts.IdempotencyKey}, &out)
}

// Approve lets a tool call the agent's permissions held run (its ask's Allow).
func (s *AgentAskService) Approve(ctx context.Context, id string) (*AgentAsk, error) {
	return s.Answer(ctx, id, "Allow", nil)
}

// Deny keeps a held tool call from running (its ask's Deny); message, when
// not empty, is told to the agent as the reason.
func (s *AgentAskService) Deny(ctx context.Context, id, message string) (*AgentAsk, error) {
	return s.Answer(ctx, id, "Deny", &AgentAnswerOptions{Text: message})
}

func askPath(id string) string { return "/v1/agents/asks/" + url.PathEscape(id) }
