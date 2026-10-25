package withruntime

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
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
	"strings"
	"sync"
	"syscall"
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
	// room is how long to wait out full slots without credit, a full quota or a full region.
	room time.Duration
	// roomed: the call is a create, wake, restart or fork, whose refusals for
	// room or a limit are the room wait's (room 0 tells them at once), not
	// the general retry's.
	roomed bool
	// timeout replaces the client's for this call.
	timeout time.Duration
	// bearer is sent instead of the client's API key: a webhook trigger's
	// secret, which is all its calls carry.
	bearer string
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

// answerStart is how long one attempt waits for its answer to start. The API
// starts every answer within 120 s: Caddy answers 503 itself past that, and a
// longer call gets its 200 at 90 s and then its JSON (runtime-late-answer). An
// attempt with no answer by then is talking to a server that is gone, such as
// a controller that died with the call in flight while its address moved to
// the new leader: a client that only waits sends nothing the new leader could
// refuse (a controller failover drill, 4 October 2026). It is sent again under
// the same key.
var answerStart = 125 * time.Second

// errNoAnswerStarted ends an attempt whose answer did not start in time.
var errNoAnswerStarted = errors.New("no answer started")

// neverSent reports whether a failed attempt's connection never opened, so
// no byte of the request left this machine. A timeout or a reset never counts.
func neverSent(err error) bool {
	for _, code := range []syscall.Errno{syscall.ECONNREFUSED, syscall.ENOENT, syscall.EHOSTUNREACH,
		syscall.ENETUNREACH, syscall.EADDRNOTAVAIL} {
		if errors.Is(err, code) {
			return true
		}
	}
	return false
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

// wait waits out one of a call's retry pauses on the client's clock.
func (c *Client) wait(ctx context.Context, d time.Duration) error {
	if c.pause != nil {
		return c.pause(ctx, d)
	}
	return sleep(ctx, d)
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
// every time, and waits out a full house for a call that sets room. With
// whole, it reads the successful body itself and a body lost part way is a
// transport failure like any other: retried with the same key, and an error
// that carries the key once the retries are spent, so a write the server made
// is never made twice by a caller retrying with a new one.
func (c *Client) send(ctx context.Context, cl *call, whole bool) (*http.Response, context.CancelFunc, error) {
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
	// An answer that ran nothing is sent again until the call's deadline.
	idleUntil := time.Now().Add(nothingRanFor)
	if deadline, ok := ctx.Deadline(); ok {
		idleUntil = deadline
	}
	idleAttempt := 0
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
	// The last try never left, and was sent again at once.
	resentAtOnce := false
	for attempt := 0; ; attempt++ {
		request, err := http.NewRequestWithContext(ctx, cl.method, target, bytes.NewReader(payload))
		if err != nil {
			cancel()
			return nil, nil, err
		}
		if payload == nil {
			request.Body = http.NoBody
		}
		bearer := c.apiKey
		if cl.bearer != "" {
			bearer = cl.bearer
		}
		request.Header.Set("Authorization", "Bearer "+bearer)
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
		// The attempt's own context: ended only if no answer starts in time,
		// so a body read after the headers keeps the call's deadline alone.
		attemptCtx, endAttempt := context.WithCancelCause(ctx)
		unanswered := time.AfterFunc(answerStart, func() { endAttempt(errNoAnswerStarted) })
		response, err := c.http.Do(request.WithContext(attemptCtx))
		unanswered.Stop()
		if err == nil && response.StatusCode >= 300 && response.StatusCode < 400 {
			response.Body.Close()
			err = fmt.Errorf("runtime answered a redirect (%d)", response.StatusCode)
		}
		// An answer that took longer than the API holds its headers (90 s)
		// comes as a 200 sent early, and then its JSON: the answer, or
		// {"error": ...} when the work failed after the status went
		// (runtime-late-answer). It is read whole here, so a failure is
		// returned as the error it is, never as a success.
		late := err == nil && response.StatusCode < 300 && response.Header.Get("Runtime-Late-Answer") == "true"
		var body []byte
		if err == nil && (whole || late) && response.StatusCode < 300 {
			body, err = io.ReadAll(response.Body)
			response.Body.Close()
			response.Body = io.NopCloser(bytes.NewReader(body))
		}
		if err != nil {
			// The error is read before cancel, which would make every
			// failure read as a timeout.
			// A connection that never opened sent no byte of the request,
			// so the next try, which may reach another server, goes at
			// once; once in a row, so an API that is down is not
			// hammered. A reset or a timeout may have reached a server
			// and keeps the backoff and its key's rules.
			atOnce := response == nil && neverSent(err) && !resentAtOnce
			resentAtOnce = atOnce
			pause := backoff(attempt)
			if atOnce {
				pause = time.Duration(mathrand.Float64() * float64(50*time.Millisecond))
			}
			if ctx.Err() != nil || cl.noRetry || attempt >= c.maxRetries || c.wait(ctx, pause) != nil {
				failure := c.connectionError(ctx, write, key, err)
				cancel()
				return nil, nil, failure
			}
			continue
		}
		status := response.StatusCode
		if late {
			status = lateFailure(body)
		}
		if status < 300 {
			return response, cancel, nil
		}
		if !late {
			body, _ = io.ReadAll(io.LimitReader(response.Body, 1<<20))
			response.Body.Close()
		}
		failure := errorFor(status, body, key)
		// A full house: wait for a slot or for room, then send the same call
		// again. A request that can never fit is not waited for.
		// A quota on what is kept says it never clears by waiting.
		keptLimit := failure.ServerRetryable != nil && !*failure.ServerRetryable
		if !cl.noRetry && cl.room > 0 && waitsForRoom[failure.Code] && failure.Details["field"] != "count" && !keptLimit {
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
			if c.wait(ctx, min(left, wait)) != nil {
				cancel()
				return nil, nil, failure
			}
			attempt--
			continue
		}
		named := failure.RetryAfter
		if named <= 0 {
			named = retryAfterHeader(response)
		}
		// A wait the server names past maxNamedWait (a daily cap) is not
		// slept on: the refusal is returned at once, still retryable and
		// carrying its RetryAfter, for the caller to schedule.
		if named > maxNamedWait {
			failure.RetryAfter = named
			cancel()
			return nil, nil, failure
		}
		// Nothing ran: safe to send again for any call, past maxRetries,
		// with growing waits, until the call's deadline; then this refusal
		// stands. A late answer's failure came after the work began, so only
		// a guest's own refusal (guest_busy, before anything is journaled)
		// still says nothing ran.
		if (status == 429 || status == 503) && nothingRan[failure.Code] && !saysNotRetryable(failure) && (!late || failure.Code == "guest_busy") {
			base := named
			if base <= 0 {
				base = 250 * time.Millisecond
			}
			pause := time.Duration(float64(min(30*time.Second, base*time.Duration(1<<min(idleAttempt, 3)))) * (0.9 + mathrand.Float64()*0.2))
			idleAttempt++
			if pause >= time.Until(idleUntil) || c.wait(ctx, pause) != nil {
				cancel()
				return nil, nil, failure
			}
			attempt--
			continue
		}
		if cl.noRetry || !retriesAgain(failure, cl.roomed) || attempt >= c.maxRetries {
			cancel()
			return nil, nil, failure
		}
		wait := named
		if wait <= 0 {
			wait = backoff(attempt)
		}
		wait = time.Duration(float64(min(30*time.Second, wait)) * (0.9 + mathrand.Float64()*0.2))
		if c.wait(ctx, wait) != nil {
			cancel()
			return nil, nil, failure
		}
	}
}

// maxNamedWait is the longest wait a server names (Retry-After or
// retryAfterMs) that the client sleeps on before sending again; a longer one
// is returned at once for the caller to schedule.
const maxNamedWait = 60 * time.Second

// nothingRanFor is how long an answer that ran nothing is sent again for a
// call without a deadline of its own.
const nothingRanFor = 300 * time.Second

// nothingRan are refusals given before anything ran: sent again for any call,
// with growing waits, until the call's deadline, past maxRetries.
var nothingRan = map[string]bool{"guest_busy": true, "busy": true, "rate_limited": true}

// retriesAgain: the general retry. The server's own `retryable` when the
// answer carried one; else, for an older server, a 429, 502, 503 or 504 that
// is not a product switched off.
func retriesAgain(failure *Error, roomed bool) bool {
	// A refusal for room or the account's own limit is the room wait's on a
	// create, wake, restart or fork; any other call retries what the answer
	// says.
	if roomed && waitsForRoom[failure.Code] {
		return false
	}
	if failure.ServerRetryable != nil {
		return *failure.ServerRetryable
	}
	switch failure.Status {
	case 429, 502, 503, 504:
		return !deliberate[failure.Code]
	}
	return false
}

// saysNotRetryable: the answer said retryable false, which no path resends.
func saysNotRetryable(failure *Error) bool {
	return failure.ServerRetryable != nil && !*failure.ServerRetryable
}

// retryAfterHeader is the answer's Retry-After in seconds, or 0.
func retryAfterHeader(response *http.Response) time.Duration {
	if seconds, err := strconv.ParseFloat(response.Header.Get("Retry-After"), 64); err == nil && seconds > 0 {
		return time.Duration(seconds * float64(time.Second))
	}
	return 0
}

// lateFailure is the status a late answer's body failed with, or 200 when it
// is an answer. An API error is a body of `error` alone, with a code; an answer
// may carry an `error` of its own (a code cell's exception) beside other
// fields. A body that is not JSON was cut or garbled: 502.
func lateFailure(body []byte) int {
	var fields map[string]json.RawMessage
	if json.Unmarshal(body, &fields) != nil {
		var value any
		if json.Unmarshal(body, &value) != nil {
			return http.StatusBadGateway
		}
		return http.StatusOK
	}
	if len(fields) != 1 || fields["error"] == nil {
		return http.StatusOK
	}
	var failed struct {
		Code   *string  `json:"code"`
		Status *float64 `json:"status"`
	}
	if json.Unmarshal(fields["error"], &failed) != nil || failed.Code == nil {
		return http.StatusOK
	}
	if failed.Status != nil && *failed.Status >= 400 {
		return int(*failed.Status)
	}
	return http.StatusInternalServerError
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

// acquire waits for a connection slot within the call's own deadline and
// takes the wait off it, so a queued call expires as an unqueued one would,
// without sending anything. The caller frees the slot it returns with.
func (c *Client) acquire(ctx context.Context, cl *call) (*call, error) {
	timeout := cl.timeout
	if timeout == 0 {
		timeout = c.timeout
	}
	started := time.Now()
	waiting, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	select {
	case c.slots <- struct{}{}:
	case <-waiting.Done():
		return nil, c.connectionError(waiting, cl.method != http.MethodGet, cl.key, waiting.Err())
	}
	left := timeout - time.Since(started)
	if left <= 0 {
		<-c.slots
		<-waiting.Done()
		return nil, c.connectionError(waiting, cl.method != http.MethodGet, cl.key, waiting.Err())
	}
	admitted := *cl
	admitted.timeout = left
	return &admitted, nil
}

// do sends a call and decodes its JSON answer into out (when out is not nil).
// At most the client's max connections of these run at once.
func (c *Client) do(ctx context.Context, cl *call, out any) error {
	cl, err := c.acquire(ctx, cl)
	if err != nil {
		return err
	}
	defer func() { <-c.slots }()
	response, cancel, err := c.send(ctx, cl, true)
	if err != nil {
		return err
	}
	defer cancel()
	body, _ := io.ReadAll(response.Body)
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
	cl, err := c.acquire(ctx, cl)
	if err != nil {
		return nil, err
	}
	defer func() { <-c.slots }()
	response, cancel, err := c.send(ctx, cl, true)
	if err != nil {
		return nil, err
	}
	defer cancel()
	return io.ReadAll(response.Body)
}

// fileBytes sends a call for a file's bytes and checks them against the
// length (x-content-length) and SHA-256 (x-content-sha256) the API sent with
// them: a stream that broke can arrive as one that ended, short. A short or
// different body is read again twice, then download_incomplete.
func (c *Client) fileBytes(ctx context.Context, cl *call) ([]byte, error) {
	for attempt := 0; ; attempt++ {
		var problem *Error
		body, err := func() ([]byte, error) {
			admitted, err := c.acquire(ctx, cl)
			if err != nil {
				return nil, err
			}
			defer func() { <-c.slots }()
			response, cancel, err := c.send(ctx, admitted, true)
			if err != nil {
				return nil, err
			}
			defer cancel()
			body, err := io.ReadAll(response.Body)
			if err == nil {
				problem = checkBody(response.Header, body)
			}
			return body, err
		}()
		if err != nil {
			return nil, err
		}
		if problem == nil {
			return body, nil
		}
		if attempt >= 2 {
			return nil, problem
		}
		if c.wait(ctx, backoff(attempt)) != nil {
			return nil, problem
		}
	}
}

// checkBody says why a whole file body cannot be trusted, or nil when it can.
func checkBody(header http.Header, body []byte) *Error {
	if value := header.Get("X-Content-Length"); value != "" {
		if expected, err := strconv.ParseInt(value, 10, 64); err == nil && expected >= 0 && int64(len(body)) != expected {
			return &Error{
				Code: "download_incomplete", Message: fmt.Sprintf("The download ended at %d of %d bytes.", len(body), expected),
				Hint:    "Read the file again; nothing was written for this read.",
				Details: map[string]any{"received": len(body), "expected": expected},
			}
		}
	}
	if want := header.Get("X-Content-Sha256"); want != "" {
		sum := sha256.Sum256(body)
		if !strings.EqualFold(hex.EncodeToString(sum[:]), want) {
			return &Error{
				Code: "download_incomplete", Message: "The file's bytes did not match the SHA-256 the API sent with them.",
				Hint: "Read the file again.",
			}
		}
	}
	return nil
}

// stream sends a call and returns its body to read as it arrives. It holds a
// connection slot until the body is closed.
func (c *Client) stream(ctx context.Context, cl *call) (io.ReadCloser, error) {
	cl, err := c.acquire(ctx, cl)
	if err != nil {
		return nil, err
	}
	response, cancel, err := c.send(ctx, cl, false)
	if err != nil {
		<-c.slots
		return nil, err
	}
	return &streamBody{ReadCloser: response.Body, done: func() { cancel(); <-c.slots }}, nil
}

type streamBody struct {
	io.ReadCloser
	once sync.Once
	done func()
}

func (s *streamBody) Close() error {
	err := s.ReadCloser.Close()
	s.once.Do(s.done)
	return err
}

// events streams newline-delimited JSON as it arrives. Streams do not hold a
// connection slot: they are long-lived.
func events[T any](ctx context.Context, c *Client, cl *call) iter.Seq2[T, error] {
	return func(yield func(T, error) bool) {
		var zero T
		cl.accept = "application/x-ndjson"
		response, cancel, err := c.send(ctx, cl, false)
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
