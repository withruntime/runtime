package withruntime

import (
	"context"
	"fmt"
	"iter"
	"net/http"
	"net/url"
	"slices"
)

// Containers is in private beta: an account outside the beta is refused
// with product_in_beta (403, errors.Is ErrPermissionDenied). A container
// runs one OCI image's process on its own microVM, billed at the sandbox
// rates, at /v1/containers.

// Container is one OCI image's process on its own microVM.
type Container struct {
	ID        string            `json:"id"`
	Name      *string           `json:"name"`
	Labels    map[string]string `json:"labels"`
	CreatedAt int64             `json:"createdAt"`
	UpdatedAt int64             `json:"updatedAt"`
	DeletedAt *int64            `json:"deletedAt"`
	Error     *ResourceError    `json:"error"`
	// State is waiting, running, sleeping, stopped, failed, deleting or
	// deleted.
	State string `json:"state"`
	// Image is the image it runs, pinned to its digest (name@sha256:...).
	Image      string   `json:"image"`
	Entrypoint []string `json:"entrypoint"`
	Command    []string `json:"command"`
	WorkingDir string   `json:"workingDir"`
	User       string   `json:"user"`
	// Port is the TCP port it serves on, or nil when it serves none.
	Port *int `json:"port"`
	// ExposedPorts are the image's, as N/tcp or N/udp.
	ExposedPorts []string `json:"exposedPorts"`
	// OnExit is restart or stop.
	OnExit    string `json:"onExit"`
	Sleep     bool   `json:"sleep"`
	VCPU      int    `json:"vcpu"`
	MemoryMiB int    `json:"memoryMiB"`
	// EnvNames are the environment's names. Values are never answered: they
	// may be secrets.
	EnvNames []string `json:"envNames"`
}

// CreateContainerOptions run one copy of an image. Image, VCPU and MemoryMiB
// are required; defaults belong to the API, so the SDK leaves unset fields
// out.
type CreateContainerOptions struct {
	// Image is an OCI image reference; the answer pins its digest.
	Image string `json:"image"`
	// VCPU is 1 to 16.
	VCPU int `json:"vcpu"`
	// MemoryMiB is 128 to 65536.
	MemoryMiB int               `json:"memoryMiB"`
	Name      string            `json:"name,omitempty"`
	Labels    map[string]string `json:"labels,omitempty"`
	// Entrypoint replaces the image's Entrypoint and drops its Cmd.
	Entrypoint []string `json:"entrypoint,omitempty"`
	// Command replaces the image's Cmd; the effective entrypoint stays.
	Command []string `json:"command,omitempty"`
	// Env is set over the image's own; only its names are read back.
	Env map[string]string `json:"env,omitempty"`
	// WorkingDir is an absolute path; the image's, else /.
	WorkingDir string `json:"workingDir,omitempty"`
	// User is the image's, else root.
	User string `json:"user,omitempty"`
	// Port is 1 to 65535, required when the image exposes several TCP ports.
	Port int `json:"port,omitempty"`
	// OnExit is restart or stop: restart when it serves a port, else stop,
	// unless set.
	OnExit string `json:"onExit,omitempty"`
	// Sleep lets it sleep when idle; it never does unless set.
	Sleep          bool   `json:"sleep,omitempty"`
	IdempotencyKey string `json:"-"`
}

// UpdateContainerOptions rename a container or replace its labels; nothing
// else changes. Nil fields stay as they are.
type UpdateContainerOptions struct {
	Name *string `json:"name,omitempty"`
	// ClearName removes the name.
	ClearName bool `json:"-"`
	// Labels replaces every label; an empty, non-nil map removes them all.
	Labels         map[string]string `json:"labels,omitempty"`
	IdempotencyKey string            `json:"-"`
}

// ContainerListOptions filter a list, every field optional. State defaults
// to every state but deleting and deleted; every label (key:value) must
// match.
type ContainerListOptions struct {
	Name  string
	Label []string
	State []string
	// Limit is 1 to 100; 50 unless set.
	Limit int
}

// ContainerGetOptions let the server hold the answer until the container
// reaches WaitFor, for up to TimeoutSeconds (1 to 60; 30 unless set). Check
// the returned state.
type ContainerGetOptions = AppGetOptions

// DeleteContainerOptions: with Wait, Delete returns once it is deleted.
type DeleteContainerOptions = DeleteAppOptions

// ContainerService is client.Containers (private beta).
type ContainerService struct{ c *Client }

func containerPath(id, verb string) string {
	return "/v1/containers/" + url.PathEscape(id) + verb
}

// Create runs one copy of an image.
func (s *ContainerService) Create(ctx context.Context, opts CreateContainerOptions) (*Container, error) {
	var container Container
	return &container, s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/containers", body: opts, key: opts.IdempotencyKey}, &container)
}

// Get reads one. opts may be nil.
func (s *ContainerService) Get(ctx context.Context, id string, opts *ContainerGetOptions) (*Container, error) {
	var container Container
	return &container, s.c.do(ctx, &call{method: http.MethodGet, path: containerPath(id, ""), query: serverWait(opts)}, &container)
}

// List returns the first page.
func (s *ContainerService) List(ctx context.Context, opts *ContainerListOptions) (*Page[Container], error) {
	query := url.Values{}
	if opts != nil {
		query = listQuery(opts.Name, opts.Label, opts.State, opts.Limit)
	}
	return listPage[Container](ctx, s.c, "/v1/containers", query, "")
}

// All walks every container a list with these options finds.
func (s *ContainerService) All(ctx context.Context, opts *ContainerListOptions) iter.Seq2[Container, error] {
	return walk(ctx, func() (*Page[Container], error) { return s.List(ctx, opts) })
}

// Update renames it or replaces its labels.
func (s *ContainerService) Update(ctx context.Context, id string, opts UpdateContainerOptions) (*Container, error) {
	body, err := fields(opts)
	if err != nil {
		return nil, err
	}
	// omitempty drops an empty map, and an empty map is how every label is
	// removed.
	if opts.Labels != nil {
		body["labels"] = opts.Labels
	}
	if opts.ClearName {
		body["name"] = nil
	}
	var container Container
	return &container, s.c.do(ctx, &call{method: http.MethodPost, path: containerPath(id, ":update"), body: body, key: opts.IdempotencyKey}, &container)
}

// Wait follows the container to target (running, say). Reaching failed or
// deleted first is an error carrying the container's own.
func (s *ContainerService) Wait(ctx context.Context, id, target string, opts *WaitOptions) (*Container, error) {
	if opts == nil {
		opts = &WaitOptions{}
	}
	return following(ctx, *opts, func(ctx context.Context, pause func() error) (*Container, error) {
		return s.follow(ctx, id, target, opts.IdempotencyKey, pause, nil)
	})
}

// follow reads the container until it reaches target or settles elsewhere.
func (s *ContainerService) follow(ctx context.Context, id, target, key string, pause func() error, record *Container) (*Container, error) {
	for {
		if record == nil {
			read, err := s.Get(ctx, id, nil)
			if err != nil {
				return nil, err
			}
			record = read
		}
		if record.State == target {
			return record, nil
		}
		if slices.Contains([]string{"failed", "deleted"}, record.State) {
			failure := &Error{
				Code:           "unexpected_state",
				Message:        fmt.Sprintf("Expected %s, but %s reached %s.", target, id, record.State),
				Hint:           "Read the resource and inspect its error before starting another change.",
				Details:        map[string]any{"id": id, "state": record.State, "target": target, "resource": record},
				IdempotencyKey: key,
			}
			if record.Error != nil {
				failure.Code, failure.Message = record.Error.Code, record.Error.Message
			}
			return nil, failure
		}
		if err := pause(); err != nil {
			return nil, err
		}
		record = nil
	}
}

// Delete deletes it and stops its process. With opts.Wait it returns once
// deleted, under one idempotency key made before the first try. opts may be
// nil.
func (s *ContainerService) Delete(ctx context.Context, id string, opts *DeleteContainerOptions) (*Container, error) {
	if opts == nil {
		opts = &DeleteContainerOptions{}
	}
	remove := func(ctx context.Context, key string) (*Container, error) {
		var container Container
		return &container, s.c.do(ctx, &call{method: http.MethodDelete, path: containerPath(id, ""), key: key}, &container)
	}
	if !opts.Wait {
		return remove(ctx, opts.IdempotencyKey)
	}
	wait := withKey(opts.WaitOptions)
	return following(ctx, wait, func(ctx context.Context, pause func() error) (*Container, error) {
		container, err := remove(ctx, wait.IdempotencyKey)
		if err != nil {
			return nil, err
		}
		return s.follow(ctx, id, "deleted", wait.IdempotencyKey, pause, container)
	})
}
