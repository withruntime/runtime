package withruntime

import (
	"context"
	"errors"
	"iter"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"time"
)

type FileEvent struct {
	Type    string `json:"type"`
	Path    string `json:"path"`
	IsDir   bool   `json:"isDir"`
	OldPath string `json:"oldPath,omitempty"`
	Count   int    `json:"count,omitempty"`
}

// WatchEvent is an event batch, loss notice, pause, or end. Rescan after overflow or lost.
type WatchEvent struct {
	Kind    string      `json:"k"`
	Events  []FileEvent `json:"events"`
	Cursor  int64       `json:"cursor"`
	Dropped *int        `json:"dropped"`
	Reason  string      `json:"reason"`
	Watches int         `json:"watches"`
	Bytes   int64       `json:"bytes"`
	Code    string      `json:"code"`
	Message string      `json:"message"`
}
type WatchOptions struct {
	Recursive      bool     `json:"recursive,omitempty"`
	Events         []string `json:"events,omitempty"`
	Include        []string `json:"include,omitempty"`
	Exclude        []string `json:"exclude,omitempty"`
	BatchMs        int      `json:"batchMs,omitempty"`
	TimeoutMs      int64    `json:"timeoutMs,omitempty"`
	MaxWatches     int      `json:"maxWatches,omitempty"`
	IdempotencyKey string   `json:"-"`
}
type WatchInfo struct {
	ID        string `json:"id"`
	Path      string `json:"path"`
	ProcessID string `json:"processId"`
	State     string `json:"state"`
	StartedAt int64  `json:"startedAt"`
}
type WatchRead struct {
	Events     []FileEvent  `json:"events"`
	Notices    []WatchEvent `json:"notices"`
	NextCursor int64        `json:"nextCursor"`
	LostBytes  int64        `json:"lostBytes"`
	Ended      bool         `json:"ended"`
}
type WatchService struct{ sandbox *Sandbox }

func (s *WatchService) path(id string) string {
	p := s.sandbox.path("/files/watches")
	if id != "" {
		p += "/" + url.PathEscape(id)
	}
	return p
}
func (s *WatchService) List(ctx context.Context) ([]WatchInfo, error) {
	return productList[WatchInfo](ctx, s.sandbox.c, s.path(""), nil)
}
func (s *WatchService) Read(ctx context.Context, id string, cursor int64, wait time.Duration) (*WatchRead, error) {
	var out WatchRead
	return &out, s.sandbox.c.do(ctx, &call{method: http.MethodGet, path: s.path(id) + "/events", query: url.Values{"cursor": {strconv.FormatInt(cursor, 10)}, "waitMs": {strconv.FormatInt(wait.Milliseconds(), 10)}}}, &out)
}
func (s *WatchService) Stop(ctx context.Context, id string) error {
	return s.sandbox.c.do(ctx, &call{method: http.MethodDelete, path: s.path(id)}, nil)
}

// Start starts a watch. Events resumes from its cursor each time it is called.
func (s *WatchService) Start(ctx context.Context, path string, opts *WatchOptions) (*FileWatch, error) {
	if opts == nil {
		opts = &WatchOptions{}
	}
	body, err := withExtra(opts, map[string]any{"path": path})
	if err != nil {
		return nil, err
	}
	var out struct {
		ID     string `json:"id"`
		Path   string `json:"path"`
		Cursor int64  `json:"cursor"`
	}
	if err := s.sandbox.c.do(ctx, &call{method: http.MethodPost, path: s.path(""), body: body, key: opts.IdempotencyKey}, &out); err != nil {
		return nil, err
	}
	return &FileWatch{ID: out.ID, Path: out.Path, cursor: out.Cursor, service: s}, nil
}
func (f *Files) Watch(ctx context.Context, path string, opts *WatchOptions) (*FileWatch, error) {
	return f.Watches.Start(ctx, path, opts)
}

// FileWatch delivers at most one Events iterator at a time. Stop cancels its
// reader and stops the guest watch. Ending iteration alone leaves it running.
type FileWatch struct {
	stopMu  sync.Mutex
	ID      string
	Path    string
	service *WatchService
	mu      sync.Mutex
	reading bool
	stopped bool
	cursor  int64
	cancel  context.CancelFunc
}

func (w *FileWatch) Cursor() int64 { w.mu.Lock(); defer w.mu.Unlock(); return w.cursor }
func (w *FileWatch) Stop(ctx context.Context) error {
	w.stopMu.Lock()
	defer w.stopMu.Unlock()
	w.mu.Lock()
	if w.stopped {
		w.mu.Unlock()
		return nil
	}
	w.stopped = true
	if w.cancel != nil {
		w.cancel()
	}
	w.mu.Unlock()
	if err := w.service.Stop(ctx, w.ID); err != nil {
		w.mu.Lock()
		w.stopped = false
		w.mu.Unlock()
		return err
	}
	return nil
}
func (w *FileWatch) Events(ctx context.Context) iter.Seq2[WatchEvent, error] {
	return func(yield func(WatchEvent, error) bool) {
		w.mu.Lock()
		if w.reading || w.stopped {
			w.mu.Unlock()
			yield(WatchEvent{}, errors.New("withruntime: watch is stopped or already being read"))
			return
		}
		ctx, cancel := context.WithCancel(ctx)
		w.reading = true
		w.cancel = cancel
		w.mu.Unlock()
		defer func() { cancel(); w.mu.Lock(); w.reading = false; w.cancel = nil; w.mu.Unlock() }()
		for {
			again := false
			cl := &call{method: http.MethodGet, path: w.service.path(w.ID) + "/events", query: url.Values{"cursor": {strconv.FormatInt(w.Cursor(), 10)}, "follow": {"true"}}, timeout: 150 * time.Second}
			for event, err := range events[WatchEvent](ctx, w.service.sandbox.c, cl) {
				if err != nil {
					yield(WatchEvent{}, err)
					return
				}
				w.mu.Lock()
				w.cursor = event.Cursor
				w.mu.Unlock()
				if event.Kind == "continue" {
					again = true
					continue
				}
				if event.Kind == "failure" {
					yield(event, &Error{Code: event.Code, Message: event.Message})
					return
				}
				if !yield(event, nil) {
					return
				}
				if event.Kind == "end" || event.Kind == "paused" {
					return
				}
			}
			if !again || ctx.Err() != nil {
				return
			}
		}
	}
}
