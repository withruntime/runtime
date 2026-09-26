package withruntime

import (
	"context"
	"net/http"
	"time"
)

type SSOConnection struct {
	ID               string     `json:"id"`
	ProviderID       string     `json:"providerId"`
	Protocol         string     `json:"protocol"`
	Provider         string     `json:"provider"`
	Domain           string     `json:"domain"`
	DomainVerifiedAt *time.Time `json:"domainVerifiedAt"`
	Verification     DNSRecord  `json:"verification"`
	DefaultRole      string     `json:"defaultRole"`
	RequireSSO       bool       `json:"requireSso"`
	CreatedAt        time.Time  `json:"createdAt"`
}
type SSOStatus struct {
	Connections []SSOConnection `json:"connections"`
	SCIM        struct {
		Tokens      int         `json:"tokens"`
		Users       int         `json:"users"`
		ActiveUsers int         `json:"activeUsers"`
		Groups      []SCIMGroup `json:"groups"`
	} `json:"scim"`
	Manage string `json:"manage"`
}
type SCIMGroup struct {
	ID          string  `json:"id"`
	DisplayName string  `json:"displayName"`
	Role        *string `json:"role"`
}

// SSOService reads organization sign-on and directory status. Owners manage it on the website.
type SSOService struct{ c *Client }

func (s *SSOService) Get(ctx context.Context) (*SSOStatus, error) {
	var out SSOStatus
	return &out, s.c.do(ctx, &call{method: http.MethodGet, path: "/v1/sso"}, &out)
}
