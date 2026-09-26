package withruntime

import (
	"context"
	"net/http"
	"net/url"
	"time"
)

// DNSRecord is a record to publish at your DNS provider.
type DNSRecord struct {
	Type    string `json:"type"`
	Name    string `json:"name"`
	Value   string `json:"value"`
	Purpose string `json:"purpose"`
}
type Domain struct {
	ID         string      `json:"id"`
	Hostname   string      `json:"hostname"`
	SandboxID  string      `json:"sandboxId"`
	Port       int         `json:"port"`
	State      string      `json:"state"`
	URL        string      `json:"url"`
	Disabled   bool        `json:"disabled"`
	Records    []DNSRecord `json:"records"`
	VerifiedAt *time.Time  `json:"verifiedAt"`
	CheckedAt  *time.Time  `json:"checkedAt"`
	CheckError *string     `json:"checkError"`
	CreatedAt  time.Time   `json:"createdAt"`
	Pointed    *bool       `json:"pointed"`
	Hint       string      `json:"hint"`
}
type AddDomainOptions struct {
	Hostname       string `json:"hostname"`
	SandboxID      string `json:"sandboxId"`
	Port           int    `json:"port"`
	IdempotencyKey string `json:"-"`
}

// DomainService serves a sandbox's port at a customer-owned HTTPS hostname.
type DomainService struct{ c *Client }

func (s *DomainService) Add(ctx context.Context, input AddDomainOptions) (*Domain, error) {
	var out Domain
	return &out, s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/domains", body: input, key: input.IdempotencyKey}, &out)
}
func (s *DomainService) Get(ctx context.Context, hostname string) (*Domain, error) {
	var out Domain
	return &out, s.c.do(ctx, &call{method: http.MethodGet, path: "/v1/domains/" + url.PathEscape(hostname)}, &out)
}
func (s *DomainService) Verify(ctx context.Context, hostname string) (*Domain, error) {
	var out Domain
	return &out, s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/domains/" + url.PathEscape(hostname) + ":verify", body: map[string]any{}}, &out)
}
func (s *DomainService) List(ctx context.Context) ([]Domain, error) {
	return productList[Domain](ctx, s.c, "/v1/domains", nil)
}
func (s *DomainService) Remove(ctx context.Context, hostname string) error {
	return s.c.do(ctx, &call{method: http.MethodDelete, path: "/v1/domains/" + url.PathEscape(hostname)}, nil)
}

type TCPPort struct {
	ID         string    `json:"id"`
	SandboxID  string    `json:"sandboxId"`
	Port       int       `json:"port"`
	Address    string    `json:"address"`
	PublicPort int       `json:"publicPort"`
	Connect    string    `json:"connect"`
	Protocol   string    `json:"protocol"`
	Disabled   bool      `json:"disabled"`
	CreatedAt  time.Time `json:"createdAt"`
	Hint       string    `json:"hint"`
}
type OpenPortOptions struct {
	SandboxID      string `json:"sandboxId"`
	Port           int    `json:"port"`
	IdempotencyKey string `json:"-"`
}
type PortService struct{ c *Client }

func (s *PortService) Open(ctx context.Context, input OpenPortOptions) (*TCPPort, error) {
	var out TCPPort
	return &out, s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/ports", body: input, key: input.IdempotencyKey}, &out)
}
func (s *PortService) List(ctx context.Context, sandboxID string) ([]TCPPort, error) {
	return productList[TCPPort](ctx, s.c, "/v1/ports", setQuery(url.Values{}, "sandboxId", sandboxID))
}
func (s *PortService) Close(ctx context.Context, id string) error {
	return s.c.do(ctx, &call{method: http.MethodDelete, path: "/v1/ports/" + url.PathEscape(id)}, nil)
}

// NetworkFunding reports the immutable quoted rate and current traffic funding.
// A reservation survives exhausted credit until the customer releases it.
type NetworkFunding struct {
	Funded      bool       `json:"funded"`
	FundedUntil *time.Time `json:"fundedUntil"`
	RateMicros  int64      `json:"rateMicros"`
	RateUnit    string     `json:"rateUnit"`
}
type EgressAddress struct {
	NetworkFunding
	ID        string    `json:"id"`
	Address   string    `json:"address"`
	Family    int       `json:"family"`
	CreatedAt time.Time `json:"createdAt"`
}
type AddressService struct{ c *Client }

// Reserve reserves IPv4 (family 4 or 0) or IPv6 (6). Repeated reservation returns the existing address.
func (s *AddressService) Reserve(ctx context.Context, family int) (*EgressAddress, error) {
	body := map[string]any{}
	if family != 0 {
		body["family"] = family
	}
	var out EgressAddress
	return &out, s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/addresses", body: body}, &out)
}
func (s *AddressService) List(ctx context.Context) ([]EgressAddress, error) {
	return productList[EgressAddress](ctx, s.c, "/v1/addresses", nil)
}
func (s *AddressService) Release(ctx context.Context, id string) error {
	return s.c.do(ctx, &call{method: http.MethodDelete, path: "/v1/addresses/" + url.PathEscape(id)}, nil)
}

type TunnelPeer struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	PublicKey string     `json:"publicKey"`
	Address   string     `json:"address"`
	Routes    []string   `json:"routes"`
	CreatedAt time.Time  `json:"createdAt"`
	RotatedAt *time.Time `json:"rotatedAt"`
}

// PrivateTunnel is the account's WireGuard tunnel, distinct from a sandbox TCP forward.
type PrivateTunnel struct {
	NetworkFunding
	ID               string          `json:"id"`
	Subnet           string          `json:"subnet"`
	GatewayAddress   string          `json:"gatewayAddress"`
	Endpoint         string          `json:"endpoint"`
	GatewayPublicKey *string         `json:"gatewayPublicKey"`
	Disabled         bool            `json:"disabled"`
	Peers            []TunnelPeer    `json:"peers"`
	Sandboxes        []TunnelSandbox `json:"sandboxes"`
	CreatedAt        time.Time       `json:"createdAt"`
}
type TunnelSandbox struct {
	SandboxID string  `json:"sandboxId"`
	Name      *string `json:"name"`
	Address   string  `json:"address"`
	State     string  `json:"state"`
}
type TunnelPeerCreated struct {
	Tunnel      PrivateTunnel `json:"tunnel"`
	Peer        TunnelPeer    `json:"peer"`
	Config      *string       `json:"config"`
	ConfigReady bool          `json:"configReady"`
	Hint        string        `json:"hint"`
}
type AddTunnelPeerOptions struct {
	Name           string   `json:"name"`
	PublicKey      string   `json:"publicKey,omitempty"`
	Routes         []string `json:"routes,omitempty"`
	IdempotencyKey string   `json:"-"`
}
type PrivateTunnelService struct{ c *Client }

func (s *PrivateTunnelService) Get(ctx context.Context) (*PrivateTunnel, error) {
	var out PrivateTunnel
	return &out, s.c.do(ctx, &call{method: http.MethodGet, path: "/v1/tunnel"}, &out)
}
func (s *PrivateTunnelService) Create(ctx context.Context, subnet string) (*PrivateTunnel, error) {
	body := map[string]any{}
	if subnet != "" {
		body["subnet"] = subnet
	}
	var out PrivateTunnel
	return &out, s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/tunnel", body: body}, &out)
}
func (s *PrivateTunnelService) Delete(ctx context.Context) error {
	return s.c.do(ctx, &call{method: http.MethodDelete, path: "/v1/tunnel"}, nil)
}

// AddPeer shows the generated private key once, in Config. Keep even a draft config when ConfigReady is false.
func (s *PrivateTunnelService) AddPeer(ctx context.Context, input AddTunnelPeerOptions) (*TunnelPeerCreated, error) {
	var out TunnelPeerCreated
	return &out, s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/tunnel/peers", body: input, key: input.IdempotencyKey, noRetry: input.PublicKey == ""}, &out)
}

// RotatePeer rotates a peer. Supplying a public key keeps its private half on your machine.
func (s *PrivateTunnelService) RotatePeer(ctx context.Context, id, publicKey string) (*TunnelPeerCreated, error) {
	body := map[string]any{}
	if publicKey != "" {
		body["publicKey"] = publicKey
	}
	var out TunnelPeerCreated
	return &out, s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/tunnel/peers/" + url.PathEscape(id) + ":rotate", body: body, noRetry: publicKey == ""}, &out)
}
func (s *PrivateTunnelService) RemovePeer(ctx context.Context, id string) (*PrivateTunnel, error) {
	var out PrivateTunnel
	return &out, s.c.do(ctx, &call{method: http.MethodDelete, path: "/v1/tunnel/peers/" + url.PathEscape(id)}, &out)
}

func productList[T any](ctx context.Context, c *Client, path string, query url.Values) ([]T, error) {
	var out struct {
		Data []T `json:"data"`
	}
	err := c.do(ctx, &call{method: http.MethodGet, path: path, query: query}, &out)
	return out.Data, err
}
