package withruntime

import (
	"context"
	"net/http"
	"net/url"
	"time"
)

/* An agent's built-in memory: text files its sessions keep across sessions
   and search, from inside their sandboxes. A scope is whose: "" for what
   every session of the agent shares, or a session key such as
   "customer:42" for that key's alone. Up to 1 MiB a file, 1 GiB and 100,000
   files an agent, billed as storage; past them a write is refused 409
   memory_full. */

// AgentMemoryService is client.Agents.Memory: seed what an agent should
// know, and read what it kept.
type AgentMemoryService struct{ c *Client }

// AgentMemoryEntry is a file of an agent's memory, as a list shows it.
type AgentMemoryEntry struct {
	// Scope is "" for the shared memory, or the session key it belongs to.
	Scope string `json:"scope"`
	Path  string `json:"path"`
	// Bytes counts its text and its path, as billed.
	Bytes     int64     `json:"bytes"`
	UpdatedAt time.Time `json:"updatedAt"`
	// UpdatedBy is a key's principal id, or session:<id> when the agent wrote it.
	UpdatedBy string `json:"updatedBy"`
}

// AgentMemoryFile is a file with its text.
type AgentMemoryFile struct {
	AgentMemoryEntry
	Content string `json:"content"`
}

// AgentMemoryHit is a file a search found.
type AgentMemoryHit struct {
	Scope string `json:"scope"`
	Path  string `json:"path"`
	// Snippet is its words around the match, matches in **bold**.
	Snippet string `json:"snippet"`
	// Rank: higher is better.
	Rank      float64   `json:"rank"`
	Bytes     int64     `json:"bytes"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// AgentMemoryWritten is what a write did.
type AgentMemoryWritten struct {
	Scope string `json:"scope"`
	Path  string `json:"path"`
	Bytes int64  `json:"bytes"`
	// Created is true for a new file, false for one replaced.
	Created   bool      `json:"created"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// AgentMemoryUsage is the agent's whole memory, every scope: what storage is
// billed on, and its bounds.
type AgentMemoryUsage struct {
	Bytes      int64 `json:"bytes"`
	Files      int64 `json:"files"`
	LimitBytes int64 `json:"limitBytes"`
	LimitFiles int64 `json:"limitFiles"`
}

// AgentMemoryPage is a page of files, with the agent's usage.
type AgentMemoryPage struct {
	*Page[AgentMemoryEntry]
	Usage AgentMemoryUsage
}

// AgentMemoryListOptions: every field optional. Scope nil lists every scope;
// a pointer to "" lists the shared memory alone.
type AgentMemoryListOptions struct {
	Scope  *string
	Prefix string
	Cursor string
	// Limit caps a page (0: the API's default, 100; at most 1000).
	Limit int
}

// AgentMemorySearchOptions: Scope nil searches every scope; Limit 0 is the
// API's 10 (at most 50).
type AgentMemorySearchOptions struct {
	Scope *string
	Limit int
}

// AgentMemoryFileOptions name a file's scope; nil or "" is the shared memory.
type AgentMemoryFileOptions struct {
	Scope string
}

func memoryPath(agent string) string { return agentPath(agent) + "/memory" }

func memoryFileQuery(path string, opts *AgentMemoryFileOptions) url.Values {
	scope := ""
	if opts != nil {
		scope = opts.Scope
	}
	return url.Values{"scope": {scope}, "path": {path}}
}

// List returns the first page of an agent's files, by scope and path, with
// its usage (opts may be nil). Page.All walks every one.
func (s *AgentMemoryService) List(ctx context.Context, agent string, opts *AgentMemoryListOptions) (*AgentMemoryPage, error) {
	if opts == nil {
		opts = &AgentMemoryListOptions{}
	}
	query := setQuery(url.Values{}, "prefix", opts.Prefix, "limit", itoa(opts.Limit))
	if opts.Scope != nil {
		query.Set("scope", *opts.Scope)
	}
	return s.list(ctx, agent, query, opts.Cursor)
}

func (s *AgentMemoryService) list(ctx context.Context, agent string, query url.Values, cursor string) (*AgentMemoryPage, error) {
	q := url.Values{}
	for key, values := range query {
		q[key] = values
	}
	if cursor != "" {
		q.Set("cursor", cursor)
	}
	var body struct {
		Data  []AgentMemoryEntry `json:"data"`
		Next  *string            `json:"nextCursor"`
		Usage AgentMemoryUsage   `json:"usage"`
	}
	if err := s.c.do(ctx, &call{method: http.MethodGet, path: memoryPath(agent), query: q}, &body); err != nil {
		return nil, err
	}
	page := &Page[AgentMemoryEntry]{
		Data:       body.Data,
		NextCursor: body.Next,
		next: func(ctx context.Context, next string) (*Page[AgentMemoryEntry], error) {
			more, err := s.list(ctx, agent, query, next)
			if err != nil {
				return nil, err
			}
			return more.Page, nil
		},
	}
	return &AgentMemoryPage{Page: page, Usage: body.Usage}, nil
}

// Search finds the files whose words or path match q (words, "a phrase",
// or, -not), best first (opts may be nil).
func (s *AgentMemoryService) Search(ctx context.Context, agent, q string, opts *AgentMemorySearchOptions) ([]AgentMemoryHit, error) {
	if opts == nil {
		opts = &AgentMemorySearchOptions{}
	}
	query := setQuery(url.Values{"q": {q}}, "limit", itoa(opts.Limit))
	if opts.Scope != nil {
		query.Set("scope", *opts.Scope)
	}
	return productList[AgentMemoryHit](ctx, s.c, memoryPath(agent), query)
}

// Read reads one file; none there is 404 not_found (errors.Is ErrNotFound).
func (s *AgentMemoryService) Read(ctx context.Context, agent, path string, opts *AgentMemoryFileOptions) (*AgentMemoryFile, error) {
	var out AgentMemoryFile
	return &out, s.c.do(ctx, &call{method: http.MethodGet, path: memoryPath(agent) + "/content", query: memoryFileQuery(path, opts)}, &out)
}

// Write seeds or replaces a file.
func (s *AgentMemoryService) Write(ctx context.Context, agent, path, content string, opts *AgentMemoryFileOptions) (*AgentMemoryWritten, error) {
	var out AgentMemoryWritten
	return &out, s.c.do(ctx, &call{method: http.MethodPut, path: memoryPath(agent) + "/content", query: memoryFileQuery(path, opts), body: map[string]any{"content": content}}, &out)
}

// Delete deletes a file, and says whether there was one.
func (s *AgentMemoryService) Delete(ctx context.Context, agent, path string, opts *AgentMemoryFileOptions) (bool, error) {
	var out struct {
		Deleted bool `json:"deleted"`
	}
	err := s.c.do(ctx, &call{method: http.MethodDelete, path: memoryPath(agent) + "/content", query: memoryFileQuery(path, opts)}, &out)
	return out.Deleted, err
}
