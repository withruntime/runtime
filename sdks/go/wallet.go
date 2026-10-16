// An account opened with a wallet alone: no key, no sign-in, no browser.
//
//	opened, err := withruntime.OpenWalletAccount(ctx, 20, true)
//	// send exactly opened.Amount to one of opened.Networks, then, once paid:
//	claim, err := withruntime.ClaimWalletAccount(ctx, opened.ClaimCode)
//	client, err := withruntime.New(withruntime.WithAPIKey(claim.APIKey))
//
// Opening one means agreeing to https://withruntime.com/legal/terms, so ask the
// person you work for first. The claim code is shown once and is the only way
// to the account's key: keep it secret. These two calls go to the website;
// every call after the key goes to the API as usual.

package withruntime

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// WalletToken is a token accepted on a network.
type WalletToken struct {
	Currency string `json:"currency"`
	Contract string `json:"contract"`
}

// WalletNetwork is a network to pay on and the address to pay.
type WalletNetwork struct {
	Network string        `json:"network"`
	Address string        `json:"address"`
	Tokens  []WalletToken `json:"tokens"`
}

// WalletTopup is a stablecoin top-up.
type WalletTopup struct {
	PurchaseID string `json:"purchaseId"`
	Status     string `json:"status"`
	AmountUSD  string `json:"amountUsd"`
	// Amount is the exact token amount to send, to six decimals.
	Amount string `json:"amount"`
	// PayBy is when the payment is due, nil when it has no deadline yet.
	PayBy    *string         `json:"payBy"`
	Networks []WalletNetwork `json:"networks"`
	Next     string          `json:"next,omitempty"`
}

// OpenedWalletAccount is a new account and its top-up.
type OpenedWalletAccount struct {
	WalletTopup
	OrgID string `json:"orgId"`
	// ClaimCode is the only way to this account's key, shown once. Keep it secret.
	ClaimCode string `json:"claimCode"`
}

// WalletClaim is the answer to a claim. Once paid, Status is "paid" and
// APIKey is the account's key, shown once. Before that, Status is the
// top-up's and Topup and Next say what to do now, such as sending the top-up
// again when it has no address.
type WalletClaim struct {
	Status string       `json:"status"`
	OrgID  string       `json:"orgId"`
	APIKey string       `json:"apiKey,omitempty"`
	Note   string       `json:"note,omitempty"`
	Topup  *WalletTopup `json:"topup,omitempty"`
	Next   string       `json:"next,omitempty"`
}

type walletConfig struct {
	authURL string
	http    *http.Client
	timeout time.Duration
}

// WalletOption configures OpenWalletAccount and ClaimWalletAccount.
type WalletOption func(*walletConfig)

// WithWalletAuthURL points the call at another website origin. The default is
// RUNTIME_AUTH_URL, then https://withruntime.com.
func WithWalletAuthURL(value string) WalletOption {
	return func(c *walletConfig) { c.authURL = value }
}

// WithWalletHTTPClient replaces the HTTP client. Its redirect policy is
// replaced: a redirect is refused.
func WithWalletHTTPClient(client *http.Client) WalletOption {
	return func(c *walletConfig) { c.http = client }
}

// WithWalletTimeout is the deadline for the call, unless the context's is
// sooner. Default 30 seconds.
func WithWalletTimeout(d time.Duration) WalletOption {
	return func(c *walletConfig) { c.timeout = d }
}

// OpenWalletAccount opens an account and a stablecoin top-up of usd dollars
// ($10 to $500: it is a new account's first week). acceptTerms must be true.
func OpenWalletAccount(ctx context.Context, usd float64, acceptTerms bool, options ...WalletOption) (*OpenedWalletAccount, error) {
	var opened OpenedWalletAccount
	body := map[string]any{"usd": usd, "acceptTerms": acceptTerms}
	if err := walletPost(ctx, "/api/wallet/topups", body, &opened, options); err != nil {
		return nil, err
	}
	return &opened, nil
}

// ClaimWalletAccount exchanges a paid account's claim code for its API key,
// once. Until the payment arrives it answers the top-up's status instead;
// call it again.
func ClaimWalletAccount(ctx context.Context, claimCode string, options ...WalletOption) (*WalletClaim, error) {
	var claim WalletClaim
	if err := walletPost(ctx, "/api/wallet/claim", map[string]string{"claimCode": claimCode}, &claim, options); err != nil {
		return nil, err
	}
	return &claim, nil
}

func walletPost(ctx context.Context, path string, body, into any, options []WalletOption) error {
	config := walletConfig{timeout: 30 * time.Second}
	for _, option := range options {
		option(&config)
	}
	if config.authURL == "" {
		config.authURL = os.Getenv("RUNTIME_AUTH_URL")
	}
	if config.authURL == "" {
		config.authURL = "https://withruntime.com"
	}
	base, err := origin(strings.TrimRight(config.authURL, "/"))
	if err != nil {
		return err
	}
	client := &http.Client{Transport: http.DefaultTransport}
	if config.http != nil {
		copied := *config.http
		client = &copied
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	ctx, cancel := context.WithTimeout(ctx, config.timeout)
	defer cancel()
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, base+path, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	var answer []byte
	if err == nil {
		defer response.Body.Close()
		answer, err = io.ReadAll(response.Body)
	}
	if err != nil {
		return &Error{Code: "network", Message: "No answer from " + base + ".", Hint: "Retry in a minute.", Err: err}
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		said := struct {
			Error string `json:"error"`
			Code  string `json:"code"`
		}{}
		_ = json.Unmarshal(answer, &said)
		failure := &Error{Code: said.Code, Message: said.Error, Status: response.StatusCode}
		if failure.Message == "" {
			failure.Message = fmt.Sprintf("The request failed (HTTP %d).", response.StatusCode)
		}
		if failure.Code == "" {
			failure.Code = "request_failed"
			if response.StatusCode == http.StatusTooManyRequests {
				failure.Code = "rate_limited"
			}
		}
		return failure
	}
	if err := json.Unmarshal(answer, into); err != nil {
		return &Error{Code: "request_failed", Message: "The website's answer was not JSON.", Status: response.StatusCode, Err: err}
	}
	return nil
}
