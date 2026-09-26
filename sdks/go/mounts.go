package withruntime

import (
	"context"
	"net/http"
)

// BucketMountOptions references a Runtime secret; the bucket key stays outside the sandbox.
type BucketMountOptions struct {
	Provider       string `json:"provider"`
	Bucket         string `json:"bucket"`
	Path           string `json:"path"`
	Prefix         string `json:"prefix,omitempty"`
	Region         string `json:"region,omitempty"`
	Endpoint       string `json:"endpoint,omitempty"`
	AccountID      string `json:"accountId,omitempty"`
	Secret         string `json:"secret,omitempty"`
	ReadOnly       bool   `json:"readOnly,omitempty"`
	IdempotencyKey string `json:"-"`
}
type BucketMount struct {
	Path      string  `json:"path"`
	Provider  string  `json:"provider"`
	Bucket    string  `json:"bucket"`
	Prefix    *string `json:"prefix"`
	Endpoint  string  `json:"endpoint"`
	Secret    *string `json:"secret"`
	ReadOnly  bool    `json:"readOnly"`
	Mounted   bool    `json:"mounted"`
	MountedAt string  `json:"mountedAt"`
}
type MountService struct{ sandbox *Sandbox }

func (s *MountService) Add(ctx context.Context, input BucketMountOptions) (*BucketMount, error) {
	var out BucketMount
	return &out, s.sandbox.c.do(ctx, &call{method: http.MethodPost, path: s.sandbox.path("/mounts"), body: input, key: input.IdempotencyKey}, &out)
}
func (s *MountService) List(ctx context.Context) ([]BucketMount, error) {
	return productList[BucketMount](ctx, s.sandbox.c, s.sandbox.path("/mounts"), nil)
}
func (s *MountService) Remove(ctx context.Context, path string) error {
	return s.sandbox.c.do(ctx, &call{method: http.MethodPost, path: s.sandbox.path("/mounts:unmount"), body: map[string]any{"path": path}}, nil)
}
