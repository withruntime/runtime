package withruntime

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"iter"
	mathrand "math/rand/v2"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// call is one API request.
type call struct {
	method string
	path   string
	query  url.Values
	// body is sent as JSON; raw as application/octet-stream.
	body any
	raw  []byte
	// accept defaults to application/json.
	accept string
	// wait is how many seconds the server may hold the answer (Prefer: wait=N).
	wait int
	// key is the idempotency key for a write; one is made when empty.
	key string
	// noRetry: the server cannot deduplicate this write.
	noRetry bool
	// room is how long to wait out a full trial, quota or region.
	room time.Duration
	// timeout replaces the client's for this call.
	timeout time.Duration
}

// newKey makes an idempotency key: a random UUID.
func newKey() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

func backoff(attempt int) time.Duration {
	base := min(8000, 250*(1<<min(attempt, 10)))
	return time.Duration(float64(base)*(0.5+mathrand.Float64())) * time.Millisecond
}

// roomBackoff: 0.5 s, 1 s, 2 s, 4 s, then every 8 s, jittered, so a queue of
// CI jobs spreads out instead of knocking at once.
func roomBackoff(attempt int) time.Duration {
	base := min(8000, 500*(1<<min(attempt, 10)))
	return time.Duration(float64(base)*(0.75+mathrand.Float64()*0.5)) * time.Millisecond
}

func sleep(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// send makes the call and returns the response once it succeeded, with a
// cancel to call when its body has been read. It retries transport failures,
// 429, 502, 503 and 504 with backoff and jitter, with the same idempotency key
// every time, and waits out a full house for a call that sets room.
func (c *Client) send(ctx context.Context, cl *call) (*http.Response, context.CancelFunc, error) {
	write := cl.method != http.MethodGet
	key := ""
	if write {
		key = cl.key
		if key == "" {
			key = newKey()
		}
	}
	timeout := cl.timeout
	if timeout == 0 {
		timeout = c.timeout
	}
	// Time spent waiting for room is added to the deadline, not taken from
	// it: once admitted, a create still has its whole timeout.
	ctx, cancel := context.WithTimeout(ctx, timeout+cl.room)
	roomUntil := time.Now().Add(cl.room)
	roomAttempt := 0
	target := c.baseURL + cl.path
	if len(cl.query) > 0 {
		target += "?" + cl.query.Encode()
	}
	var payload []byte
	contentType := ""
	switch {
	case cl.raw != nil:
		payload, contentType = cl.raw, "application/octet-stream"
	case cl.body != nil:
		encoded, err := json.Marshal(cl.body)
		if err != nil {
			cancel()
			return nil, nil, err
		}
		payload, contentType = encoded, "application/json"
	}
	for attempt := 0; ; attempt++ {
		request, err := http.NewRequestWithContext(ctx, cl.method, target, bytes.NewReader(payload))
		if err != nil {
			cancel()
			return nil, nil, err
		}
		if payload == nil {
			request.Body = http.NoBody
		}
		request.Header.Set("Authorization", "Bearer "+c.apiKey)
		accept := cl.accept
		if accept == "" {
			accept = "application/json"
		}
		request.Header.Set("Accept", accept)
		request.Header.Set("X-Runtime-Client", c.userAgent)
		request.Header.Set("User-Agent", "withruntime-go/"+Version)
		if contentType != "" {
			request.Header.Set("Content-Type", contentType)
		}
		if key != "" {
			request.Header.Set("Idempotency-Key", key)
		}
		if cl.wait > 0 {
			request.Header.Set("Prefer", "wait="+strconv.Itoa(min(120, cl.wait)))
		}
		response, err := c.http.Do(request)
		if err == nil && response.StatusCode >= 300 && response.StatusCode < 400 {
			response.Body.Close()
			err = fmt.Errorf("runtime answered a redirect (%d)", response.StatusCode)
		}
		if err != nil {
			if ctx.Err() != nil || cl.noRetry || attempt >= c.maxRetries {
				cancel()
				return nil, nil, c.connectionError(ctx, write, key, err)
			}
			if sleep(ctx, backoff(attempt)) != nil {
				cancel()
				return nil, nil, c.connectionError(ctx, write, key, err)
			}
			continue
		}
		if response.StatusCode < 300 {
			return response, cancel, nil
		}
		body, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
		response.Body.Close()
		failure := errorFor(response.StatusCode, body, key)
		// A full house: wait for a slot or for room, then send the same call
		// again. A request that can never fit is not waited for.
		if !cl.noRetry && cl.room > 0 && waitsForRoom[failure.Code] && failure.Details["field"] != "count" {
			left := time.Until(roomUntil)
			if left <= 0 {
				cancel()
				return nil, nil, failure
			}
			wait := failure.RetryAfter
			if wait <= 0 {
				wait = roomBackoff(roomAttempt)
			}
			roomAttempt++
			if sleep(ctx, min(left, wait)) != nil {
				cancel()
				return nil, nil, failure
			}
			attempt--
			continue
		}
		retryable := (response.StatusCode == 429 || response.StatusCode == 502 ||
			response.StatusCode == 503 || response.StatusCode == 504) && !deliberate[failure.Code]
		if cl.noRetry || !retryable || attempt >= c.maxRetries {
			cancel()
			return nil, nil, failure
		}
		wait := failure.RetryAfter
		if wait <= 0 {
			if seconds, err := strconv.ParseFloat(response.Header.Get("Retry-After"), 64); err == nil && seconds > 0 {
				wait = time.Duration(seconds * float64(time.Second))
			} else {
				wait = backoff(attempt)
			}
		}
		wait = time.Duration(float64(min(30*time.Second, wait)) * (0.9 + mathrand.Float64()*0.2))
		if sleep(ctx, wait) != nil {
			cancel()
			return nil, nil, failure
		}
	}
}

func (c *Client) connectionError(ctx context.Context, write bool, key string, cause error) *Error {
	if ctx.Err() != nil {
		return &Error{
			Code:           "timeout",
			Message:        "The call was cancelled or ran past its deadline.",
			Hint:           "Allow a longer deadline for a long call, or retry with the same idempotency key.",
			IdempotencyKey: key,
			Err:            cause,
		}
	}
	message := "No answer from Runtime at " + c.baseURL + "."
	if write {
		message = "No answer from Runtime at " + c.baseURL + ". The change may have happened; retrying with the same idempotency key is safe."
	}
	return &Error{
		Code:           "connection_error",
		Message:        message,
		Hint:           "Check the network, HTTPS_PROXY, and RUNTIME_API_URL if you set it.",
		IdempotencyKey: key,
		Err:            cause,
	}
}

// do sends a call and decodes its JSON answer into out (when out is not nil).
// At most the client's max connections of these run at once.
func (c *Client) do(ctx context.Context, cl *call, out any) error {
	select {
	case c.slots <- struct{}{}:
	case <-ctx.Done():
		return c.connectionError(ctx, cl.method != http.MethodGet, cl.key, ctx.Err())
	}
	defer func() { <-c.slots }()
	response, cancel, err := c.send(ctx, cl)
	if err != nil {
		return err
	}
	defer cancel()
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return c.connectionError(ctx, cl.method != http.MethodGet, cl.key, err)
	}
	if out == nil || len(bytes.TrimSpace(body)) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("withruntime: unexpected answer from %s %s: %w", cl.method, cl.path, err)
	}
	return nil
}

// bytes sends a call and returns its body.
func (c *Client) bytes(ctx context.Context, cl *call) ([]byte, error) {
	select {
	case c.slots <- struct{}{}:
	case <-ctx.Done():
		return nil, c.connectionError(ctx, cl.method != http.MethodGet, cl.key, ctx.Err())
	}
	defer func() { <-c.slots }()
	response, cancel, err := c.send(ctx, cl)
	if err != nil {
		return nil, err
	}
	defer cancel()
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, c.connectionError(ctx, cl.method != http.MethodGet, cl.key, err)
	}
	return body, nil
}

// events streams newline-delimited JSON as it arrives. Streams do not hold a
// connection slot: they are long-lived.
func events[T any](ctx context.Context, c *Client, cl *call) iter.Seq2[T, error] {
	return func(yield func(T, error) bool) {
		var zero T
		cl.accept = "application/x-ndjson"
		response, cancel, err := c.send(ctx, cl)
		if err != nil {
			yield(zero, err)
			return
		}
		defer cancel()
		defer response.Body.Close()
		scanner := bufio.NewScanner(response.Body)
		scanner.Buffer(make([]byte, 64*1024), 16<<20)
		for scanner.Scan() {
			line := bytes.TrimSpace(scanner.Bytes())
			if len(line) == 0 {
				continue
			}
			var event T
			if err := json.Unmarshal(line, &event); err != nil {
				yield(zero, fmt.Errorf("withruntime: unexpected stream line: %w", err))
				return
			}
			if !yield(event, nil) {
				return
			}
		}
		if err := scanner.Err(); err != nil && !errors.Is(err, context.Canceled) {
			yield(zero, c.connectionError(ctx, false, "", err))
		}
	}
}
