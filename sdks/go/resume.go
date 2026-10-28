package withruntime

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"sync"
	"time"
)

/* A terminal's or tunnel's WebSocket that outlives a restart of the API
   behind it (packages/cloud/src/api/tunnels.ts, "Hand-off"):

   1. the API sends {"type":"restart"}; this side stops sending, holds what
      the caller writes and answers {"type":"restart"};
   2. the API sends {"type":"resume","token":...,"replay":...} and closes
      with 1012 (Service Restart);
   3. this side opens the socket again with ?resume=<token>, sends
      {"type":"replay"} first when there was input the API had not yet
      written, then what it held.

   Output and streams continue from the exact byte they stopped at, and the
   caller sees no close. */

// serviceRestart is RFC 6455 close code 1012, Service Restart.
const serviceRestart = 1012

// resumeFor is how long reconnecting may take: within the token's 30 s,
// after which the API ends the process.
const resumeFor = 25 * time.Second

type outgoing struct {
	op      byte
	payload []byte
}

// resumable has the read, write and Close of websocket, across restarts.
// One reader; any number of writers.
type resumable struct {
	open func(resume string) (*websocket, error)
	// ctx bounds every socket; Close cancels it, which also ends a resume.
	ctx    context.Context
	cancel context.CancelFunc
	// send orders writes, the restart's answer and the switch to a new
	// socket; mu guards the fields. Close takes mu alone, so it can close a
	// socket under a write blocked holding send.
	send    sync.Mutex
	mu      sync.Mutex
	cur     *websocket
	attempt *websocket // the reconnect in flight
	paused  bool
	held    []outgoing
	closed  bool
	token   string
	replay  string
	said    []byte
	resumes int
	replays int
}

func (c *Client) resumable(ctx context.Context, path string, query url.Values) (*resumable, error) {
	ctx, cancel := context.WithCancel(ctx)
	r := &resumable{ctx: ctx, cancel: cancel, open: func(resume string) (*websocket, error) {
		if resume != "" {
			return c.websocket(ctx, path, url.Values{"resume": {resume}})
		}
		return c.websocket(ctx, path, query)
	}}
	ws, err := r.open("")
	if err != nil {
		cancel()
		return nil, err
	}
	r.cur = ws
	return r, nil
}

func (r *resumable) write(op byte, payload []byte) error {
	r.send.Lock()
	defer r.send.Unlock()
	r.mu.Lock()
	closed, paused, cur := r.closed, r.paused, r.cur
	if paused && !closed {
		r.held = append(r.held, outgoing{op, append([]byte(nil), payload...)})
	}
	r.mu.Unlock()
	if closed {
		return io.ErrClosedPipe
	}
	if paused {
		return nil
	}
	return cur.write(op, payload)
}

// read returns the next message the caller sees; the restart's own are not.
func (r *resumable) read() (byte, []byte, error) {
	for {
		r.mu.Lock()
		cur, said := r.cur, r.said
		r.said = nil
		r.mu.Unlock()
		if said != nil {
			return opText, said, nil
		}
		op, payload, err := cur.read()
		if err != nil {
			if cur.closeCode() == serviceRestart && r.token != "" && r.resume() {
				continue
			}
			// Ended for good: later writes fail rather than wait for a resume.
			r.mu.Lock()
			said, r.said = r.said, nil
			r.closed, r.held = true, nil
			r.mu.Unlock()
			if said != nil {
				return opText, said, nil
			}
			return 0, nil, err
		}
		if op == opText {
			var message struct {
				Type   string `json:"type"`
				Token  string `json:"token"`
				Replay string `json:"replay"`
			}
			if json.Unmarshal(payload, &message) == nil {
				switch {
				case message.Type == "restart":
					r.send.Lock()
					r.mu.Lock()
					r.paused = true
					r.mu.Unlock()
					_ = cur.write(opText, []byte(`{"type":"restart"}`))
					r.send.Unlock()
					continue
				case message.Type == "resume" && message.Token != "":
					r.token, r.replay = message.Token, message.Replay
					continue
				}
			}
		}
		return op, payload, nil
	}
}

// resume opens the socket again where it stopped; false when it cannot.
func (r *resumable) resume() bool {
	token, replay := r.token, r.replay
	r.token, r.replay = "", ""
	deadline := time.Now().Add(resumeFor)
	for wait := 50 * time.Millisecond; time.Now().Before(deadline); wait = min(wait*2, time.Second) {
		ws, err := r.open(token)
		if r.ctx.Err() != nil {
			if ws != nil {
				_ = ws.Close()
			}
			return false
		}
		if err != nil {
			var refused *Error
			// A 4xx other than 429: the token or the sandbox is not good, and
			// asking again changes nothing.
			if errors.As(err, &refused) && refused.Status >= 400 && refused.Status < 500 && refused.Status != 429 {
				return false
			}
			if !r.sleep(wait) {
				return false
			}
			continue
		}
		r.mu.Lock()
		if r.closed {
			r.mu.Unlock()
			_ = ws.Close()
			return false
		}
		r.attempt = ws
		r.mu.Unlock()
		// A server that never answers must not hold this past the deadline.
		timer := time.AfterFunc(time.Until(deadline), func() { _ = ws.Close() })
		op, payload, err := ws.read()
		timer.Stop()
		r.mu.Lock()
		r.attempt = nil
		r.mu.Unlock()
		if err == nil && op == opText {
			var message struct {
				Type    string `json:"type"`
				Resumed bool   `json:"resumed"`
			}
			if json.Unmarshal(payload, &message) == nil {
				if message.Type == "ready" && message.Resumed {
					r.send.Lock()
					defer r.send.Unlock()
					r.mu.Lock()
					if r.closed {
						r.mu.Unlock()
						_ = ws.Close()
						return false
					}
					r.cur = ws
					r.resumes++
					if replay != "" {
						r.replays++
					}
					held := r.held
					r.held, r.paused = nil, false
					r.mu.Unlock()
					if replay != "" {
						body, _ := json.Marshal(map[string]string{"type": "replay", "data": replay})
						_ = ws.write(opText, body)
					}
					for _, out := range held {
						_ = ws.write(out.op, out.payload)
					}
					return true
				}
				if message.Type == "error" {
					// Refused for good (the sandbox stopped, say): the caller
					// reads the error, as on any socket.
					_ = ws.Close()
					r.mu.Lock()
					r.said = payload
					r.mu.Unlock()
					return false
				}
			}
		}
		_ = ws.Close()
		if !r.sleep(wait) {
			return false
		}
	}
	return false
}

// sleep waits between reconnects; false once Close was called.
func (r *resumable) sleep(wait time.Duration) bool {
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-r.ctx.Done():
		return false
	}
}

func (r *resumable) Close() error {
	r.mu.Lock()
	r.closed = true
	r.held = nil
	cur, attempt := r.cur, r.attempt
	r.mu.Unlock()
	r.cancel()
	if attempt != nil {
		_ = attempt.Close()
	}
	return cur.Close()
}
