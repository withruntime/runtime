package withruntime

import (
	"context"
	"net/http"
	"time"
)

// NetworkPolicy is a sandbox's network rules as its host enforces them.
type NetworkPolicy struct {
	SandboxID string   `json:"sandboxId"`
	Internet  bool     `json:"internet"`
	Allow     []string `json:"allow"`
	Deny      []string `json:"deny"`
	Connect   []string `json:"connect"`
	Version   int      `json:"version"`
	// Enforced: the sandbox's host confirmed it enforces this version.
	Enforced        bool       `json:"enforced"`
	EnforcedVersion int        `json:"enforcedVersion"`
	Ports           []int      `json:"ports"`
	ConnectAllowed  bool       `json:"connectAllowed"`
	ConnectReason   string     `json:"connectReason"`
	ForbiddenPorts  []int      `json:"forbiddenPorts"`
	UpdatedAt       *time.Time `json:"updatedAt"`
}

// SandboxNetwork is sbx.Network: turn the sandbox's internet off or on,
// narrow it to a list, refuse destinations, or open host:port pairs. Changes
// apply at once, to open connections too.
type SandboxNetwork struct{ sandbox *Sandbox }

// Get reads the rules.
func (n *SandboxNetwork) Get(ctx context.Context) (*NetworkPolicy, error) {
	var policy NetworkPolicy
	return &policy, n.sandbox.c.do(ctx, &call{method: http.MethodGet, path: n.sandbox.path("/network")}, &policy)
}

// Set replaces the rules. Allow narrows the web to a list (example.com,
// *.example.com, an address or a CIDR range), Deny refuses destinations, and
// Connect opens host:port pairs beyond 80 and 443 (paid accounts only).
func (n *SandboxNetwork) Set(ctx context.Context, rules Network) (*NetworkPolicy, error) {
	var policy NetworkPolicy
	return &policy, n.sandbox.c.do(ctx, &call{method: http.MethodPut, path: n.sandbox.path("/network"), body: rules}, &policy)
}

// Off refuses every outbound connection.
func (n *SandboxNetwork) Off(ctx context.Context) (*NetworkPolicy, error) {
	return n.Set(ctx, Network{Internet: false})
}

// On restores the public web and nothing narrower.
func (n *SandboxNetwork) On(ctx context.Context) (*NetworkPolicy, error) {
	return n.Set(ctx, Network{Internet: true})
}
