package withruntime

import (
	"context"
	"encoding/json"
	"iter"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// Snapshot is a sandbox's whole machine (files, memory, running processes),
// kept on its host to start new sandboxes from.
type Snapshot struct {
	ID              string  `json:"id"`
	Kind            string  `json:"kind"`
	Status          string  `json:"status"`
	State           string  `json:"state"`
	Name            *string `json:"name"`
	SourceSandboxID string  `json:"sourceSandboxId"`
	Shape           struct {
		VCPU            int    `json:"vcpu"`
		MemoryMiB       int    `json:"memoryMiB"`
		DiskMiB         int    `json:"diskMiB"`
		MemoryGuarantee string `json:"memoryGuarantee"`
	} `json:"shape"`
	RetentionDays int `json:"retentionDays"`
	// StoredBytes is what it stores; MeteredBytes what storage is metered
	// for, the bytes it alone holds.
	StoredBytes  *int64          `json:"storedBytes"`
	MeteredBytes *int64          `json:"meteredBytes"`
	Error        *string         `json:"error"`
	CreatedAt    time.Time       `json:"createdAt"`
	ReadyAt      *time.Time      `json:"readyAt"`
	ExpiresAt    *time.Time      `json:"expiresAt"`
	Raw          json.RawMessage `json:"-"`
}

// UnmarshalJSON keeps the raw answer alongside the typed fields.
func (s *Snapshot) UnmarshalJSON(data []byte) error {
	type plain Snapshot
	var decoded plain
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	*s = Snapshot(decoded)
	s.Raw = append(json.RawMessage(nil), data...)
	return nil
}

// SnapshotService is client.Snapshots. Take one with Sandbox.Snapshot, start
// from one with CreateOptions.Snapshot, or do both with Sandbox.Fork.
type SnapshotService struct{ c *Client }

// Create snapshots a sandbox by id, as Sandbox.Snapshot does for one you
// hold, except that it does not pause a running sandbox first: the API
// answers how the sandbox must be.
func (s *SnapshotService) Create(ctx context.Context, sandboxID string, opts *SnapshotOptions) (*Snapshot, error) {
	if opts == nil {
		opts = &SnapshotOptions{}
	}
	var snapshot Snapshot
	return &snapshot, s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/sandboxes/" + url.PathEscape(sandboxID) + ":snapshot", body: opts, wait: 10, key: opts.IdempotencyKey}, &snapshot)
}

// Get reads a snapshot.
func (s *SnapshotService) Get(ctx context.Context, id string) (*Snapshot, error) {
	var snapshot Snapshot
	return &snapshot, s.c.do(ctx, &call{method: http.MethodGet, path: "/v1/snapshots/" + url.PathEscape(id)}, &snapshot)
}

// SnapshotListOptions filter a list, every field optional.
type SnapshotListOptions struct {
	SandboxID string
	Name      string
	// State is capturing, ready, failed or deleting.
	State string
	Limit int
}

// List returns the first page of snapshots.
func (s *SnapshotService) List(ctx context.Context, opts *SnapshotListOptions) (*Page[Snapshot], error) {
	query := url.Values{}
	if opts != nil {
		for key, value := range map[string]string{"sandboxId": opts.SandboxID, "name": opts.Name, "state": opts.State} {
			if value != "" {
				query.Set(key, value)
			}
		}
		if opts.Limit > 0 {
			query.Set("limit", strconv.Itoa(opts.Limit))
		}
	}
	return s.page(ctx, query, "")
}

// All walks every snapshot a list with these options finds.
func (s *SnapshotService) All(ctx context.Context, opts *SnapshotListOptions) iter.Seq2[Snapshot, error] {
	return func(yield func(Snapshot, error) bool) {
		page, err := s.List(ctx, opts)
		if err != nil {
			yield(Snapshot{}, err)
			return
		}
		for snapshot, err := range page.All(ctx) {
			if !yield(snapshot, err) {
				return
			}
		}
	}
}

func (s *SnapshotService) page(ctx context.Context, query url.Values, cursor string) (*Page[Snapshot], error) {
	q := url.Values{}
	for key, values := range query {
		q[key] = values
	}
	if cursor != "" {
		q.Set("cursor", cursor)
	}
	var body struct {
		Data       []Snapshot `json:"data"`
		NextCursor *string    `json:"nextCursor"`
	}
	if err := s.c.do(ctx, &call{method: http.MethodGet, path: "/v1/snapshots", query: q}, &body); err != nil {
		return nil, err
	}
	return &Page[Snapshot]{
		Data:       body.Data,
		NextCursor: body.NextCursor,
		next: func(ctx context.Context, next string) (*Page[Snapshot], error) {
			return s.page(ctx, query, next)
		},
	}, nil
}

// Delete deletes a snapshot.
func (s *SnapshotService) Delete(ctx context.Context, id string) error {
	return s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/snapshots/" + url.PathEscape(id) + ":delete", body: map[string]any{}}, nil)
}

// Extend keeps a snapshot for retentionDays from now.
func (s *SnapshotService) Extend(ctx context.Context, id string, retentionDays int) (*Snapshot, error) {
	var snapshot Snapshot
	return &snapshot, s.c.do(ctx, &call{
		method: http.MethodPost,
		path:   "/v1/snapshots/" + url.PathEscape(id) + ":extend",
		body:   map[string]any{"retentionDays": retentionDays},
	}, &snapshot)
}
