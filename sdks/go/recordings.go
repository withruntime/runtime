package withruntime

import (
	"context"
	"net/http"
	"net/url"
)

type DesktopRecording struct {
	ID        string   `json:"id"`
	State     string   `json:"state"`
	Path      string   `json:"path"`
	Bytes     int64    `json:"bytes"`
	Seconds   *float64 `json:"seconds"`
	Reason    *string  `json:"reason"`
	StartedAt *int64   `json:"startedAt"`
}
type RecordOptions struct {
	FPS            int    `json:"fps,omitempty"`
	MaxSeconds     int    `json:"maxSeconds,omitempty"`
	MaxMiB         int    `json:"maxMiB,omitempty"`
	CRF            int    `json:"crf,omitempty"`
	IdempotencyKey string `json:"-"`
}
type RecordingService struct{ sandbox *Sandbox }

func (s *RecordingService) path(id string) string {
	p := s.sandbox.path("/desktop/recordings")
	if id != "" {
		p += "/" + url.PathEscape(id)
	}
	return p
}
func (s *RecordingService) Start(ctx context.Context, opts *RecordOptions) (*DesktopRecording, error) {
	if opts == nil {
		opts = &RecordOptions{}
	}
	var out DesktopRecording
	return &out, s.sandbox.c.do(ctx, &call{method: http.MethodPost, path: s.path(""), body: opts, key: opts.IdempotencyKey}, &out)
}
func (s *RecordingService) Stop(ctx context.Context, id string) (*DesktopRecording, error) {
	var out DesktopRecording
	return &out, s.sandbox.c.do(ctx, &call{method: http.MethodPost, path: s.path(id) + ":stop", body: map[string]any{}}, &out)
}
func (s *RecordingService) Get(ctx context.Context, id string) (*DesktopRecording, error) {
	var out DesktopRecording
	return &out, s.sandbox.c.do(ctx, &call{method: http.MethodGet, path: s.path(id)}, &out)
}
func (s *RecordingService) List(ctx context.Context) ([]DesktopRecording, error) {
	return productList[DesktopRecording](ctx, s.sandbox.c, s.path(""), nil)
}
func (s *RecordingService) Download(ctx context.Context, id string) ([]byte, error) {
	return s.sandbox.c.bytes(ctx, &call{method: http.MethodGet, path: s.path(id) + "/video", accept: "video/mp4"})
}
func (s *RecordingService) Delete(ctx context.Context, id string) error {
	return s.sandbox.c.do(ctx, &call{method: http.MethodDelete, path: s.path(id)}, nil)
}
