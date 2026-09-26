package withruntime

import (
	"context"
	"net/http"
	"time"
)

type MCPCatalogEntry struct {
	ID          string       `json:"id"`
	Title       string       `json:"title"`
	Description string       `json:"description"`
	License     string       `json:"license"`
	Source      string       `json:"source"`
	Version     string       `json:"version"`
	Env         []MCPSetting `json:"env"`
	Options     []MCPSetting `json:"options"`
	Egress      []string     `json:"egress"`
	Checked     string       `json:"checked"`
}
type MCPSetting struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Required    bool     `json:"required"`
	Secret      bool     `json:"secret"`
	Hosts       []string `json:"hosts,omitempty"`
}
type MCPServerRequest struct {
	ID      string            `json:"id,omitempty"`
	Name    string            `json:"name,omitempty"`
	Secrets map[string]string `json:"secrets,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
	Options map[string]string `json:"options,omitempty"`
	Command []string          `json:"command,omitempty"`
}
type MCPGateway struct {
	Running      bool              `json:"running"`
	Port         *int              `json:"port"`
	Token        *string           `json:"token"`
	Headers      map[string]string `json:"headers"`
	URLExpiresAt *time.Time        `json:"urlExpiresAt"`
	Servers      []MCPServer       `json:"servers"`
	Warnings     []string          `json:"warnings"`
}
type MCPServer struct {
	Name    string  `json:"name"`
	Status  string  `json:"status"`
	Message *string `json:"message"`
	URL     *string `json:"url"`
}
type MCPService struct{ c *Client }

func (s *MCPService) Catalog(ctx context.Context) ([]MCPCatalogEntry, error) {
	return productList[MCPCatalogEntry](ctx, s.c, "/v1/mcp/catalog", nil)
}

type SandboxMCP struct{ sandbox *Sandbox }
type MCPStartOptions struct {
	Servers        []MCPServerRequest `json:"servers"`
	Port           int                `json:"port,omitempty"`
	Replace        bool               `json:"replace,omitempty"`
	IdempotencyKey string             `json:"-"`
}

func (s *SandboxMCP) Start(ctx context.Context, input MCPStartOptions) (*MCPGateway, error) {
	var out MCPGateway
	return &out, s.sandbox.c.do(ctx, &call{method: http.MethodPost, path: s.sandbox.path("/mcp"), body: input, key: input.IdempotencyKey}, &out)
}
func (s *SandboxMCP) Get(ctx context.Context) (*MCPGateway, error) {
	var out MCPGateway
	return &out, s.sandbox.c.do(ctx, &call{method: http.MethodGet, path: s.sandbox.path("/mcp")}, &out)
}
func (s *SandboxMCP) Stop(ctx context.Context) error {
	return s.sandbox.c.do(ctx, &call{method: http.MethodDelete, path: s.sandbox.path("/mcp")}, nil)
}

// Ready waits until all servers finish installing. Inspect each server's Status for failures.
func (s *SandboxMCP) Ready(ctx context.Context, timeout time.Duration) (*MCPGateway, error) {
	if timeout <= 0 {
		timeout = 10 * time.Minute
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	for {
		out, err := s.Get(ctx)
		if err != nil {
			return nil, err
		}
		waiting := false
		for _, server := range out.Servers {
			waiting = waiting || server.Status == "installing"
		}
		if !out.Running || !waiting {
			return out, nil
		}
		if err := sleep(ctx, 2*time.Second); err != nil {
			return out, err
		}
	}
}
