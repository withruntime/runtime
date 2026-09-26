package withruntime

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"sync"
)

// TerminalOptions are a terminal's options, every one optional.
type TerminalOptions struct {
	// Cols and Rows are its size; 0 is 80 by 24.
	Cols int
	Rows int
	// Command runs instead of a login shell.
	Command string
	Cwd     string
	// ProcessID attaches to a process started with a PTY instead of starting
	// a new shell.
	ProcessID string
}

// Terminal is an interactive terminal over a WebSocket: Write types, Read
// reads what the terminal prints. Use one reader and one writer at a time.
type Terminal struct {
	socket    *websocket
	processID string
	mu        sync.Mutex
	exitCode  *int
	pending   []byte
}

// Terminal opens an interactive terminal in the sandbox, like SSH. ctx bounds
// the whole session, not only the opening.
func (s *Sandbox) Terminal(ctx context.Context, opts *TerminalOptions) (*Terminal, error) {
	if opts == nil {
		opts = &TerminalOptions{}
	}
	query := setQuery(url.Values{}, "cols", itoa(opts.Cols), "rows", itoa(opts.Rows), "command", opts.Command, "cwd", opts.Cwd, "processId", opts.ProcessID)
	socket, err := s.c.websocket(ctx, s.path("/terminal"), query)
	if err != nil {
		return nil, err
	}
	for {
		opcode, payload, err := socket.read()
		if err != nil {
			socket.Close()
			return nil, &Error{Code: "terminal_refused", Message: "The terminal could not be opened (check the key and that the sandbox is running).", Err: err}
		}
		if opcode != opText {
			continue
		}
		var message struct {
			Type      string `json:"type"`
			ProcessID string `json:"processId"`
			Error     *struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(payload, &message) != nil {
			continue
		}
		switch message.Type {
		case "ready":
			return &Terminal{socket: socket, processID: message.ProcessID}, nil
		case "error":
			socket.Close()
			failure := &Error{Code: "terminal_failed", Message: "Terminal failed."}
			if message.Error != nil {
				failure.Code, failure.Message = message.Error.Code, message.Error.Message
			}
			return nil, failure
		}
	}
}

// ProcessID is the terminal's process, to attach to again later.
func (t *Terminal) ProcessID() string { return t.processID }

// ExitCode is the shell's exit code once the terminal has ended, else nil.
func (t *Terminal) ExitCode() *int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.exitCode
}

// Write types data into the terminal.
func (t *Terminal) Write(data []byte) (int, error) {
	if err := t.socket.write(opBinary, data); err != nil {
		return 0, err
	}
	return len(data), nil
}

// Read reads what the terminal printed. It returns io.EOF once the terminal
// has ended.
func (t *Terminal) Read(buffer []byte) (int, error) {
	for len(t.pending) == 0 {
		opcode, payload, err := t.socket.read()
		if err != nil {
			return 0, io.EOF
		}
		switch opcode {
		case opBinary:
			t.pending = payload
		case opText:
			var message struct {
				Type     string `json:"type"`
				ExitCode *int   `json:"exitCode"`
			}
			if json.Unmarshal(payload, &message) == nil && message.Type == "exit" {
				t.mu.Lock()
				t.exitCode = message.ExitCode
				t.mu.Unlock()
			}
		}
	}
	n := copy(buffer, t.pending)
	t.pending = t.pending[n:]
	return n, nil
}

// Resize changes the terminal's size.
func (t *Terminal) Resize(cols, rows int) error {
	payload, _ := json.Marshal(map[string]any{"type": "resize", "cols": cols, "rows": rows})
	return t.socket.write(opText, payload)
}

// Close closes the terminal. A shell it started ends with it; a process it
// attached to lives on.
func (t *Terminal) Close() error { return t.socket.Close() }

const (
	opContinuation = 0x0
	opText         = 0x1
	opBinary       = 0x2
	opClose        = 0x8
	opPing         = 0x9
	opPong         = 0xA
)

// websocket is a minimal RFC 6455 client over the client's own HTTP
// transport (so its proxy settings apply): client frames masked, messages
// reassembled, pings answered.
type websocket struct {
	conn        io.ReadWriteCloser
	reader      *bufio.Reader
	mu          sync.Mutex
	closed      bool
	closeOnce   sync.Once
	stopContext func() bool
}

func (c *Client) websocket(ctx context.Context, path string, query url.Values) (*websocket, error) {
	target := c.baseURL + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	var nonce [16]byte
	_, _ = rand.Read(nonce[:])
	key := base64.StdEncoding.EncodeToString(nonce[:])
	request.Header.Set("Connection", "Upgrade")
	request.Header.Set("Upgrade", "websocket")
	request.Header.Set("Sec-WebSocket-Version", "13")
	request.Header.Set("Sec-WebSocket-Key", key)
	request.Header.Set("Authorization", "Bearer "+c.apiKey)
	request.Header.Set("X-Runtime-Client", c.userAgent)
	request.Header.Set("User-Agent", "withruntime-go/"+Version)
	response, err := c.http.Do(request)
	if err != nil {
		return nil, c.connectionError(ctx, false, "", err)
	}
	if response.StatusCode != http.StatusSwitchingProtocols {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
		response.Body.Close()
		return nil, errorFor(response.StatusCode, body, "")
	}
	sum := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	if response.Header.Get("Sec-WebSocket-Accept") != base64.StdEncoding.EncodeToString(sum[:]) {
		response.Body.Close()
		return nil, errors.New("withruntime: the WebSocket handshake did not match")
	}
	conn, ok := response.Body.(io.ReadWriteCloser)
	if !ok {
		response.Body.Close()
		return nil, errors.New("withruntime: the HTTP transport cannot carry a WebSocket")
	}
	socket := &websocket{conn: conn, reader: bufio.NewReader(conn)}
	socket.stopContext = context.AfterFunc(ctx, func() { _ = conn.Close() })
	return socket, nil
}

func (w *websocket) write(opcode byte, payload []byte) error {
	var mask [4]byte
	_, _ = rand.Read(mask[:])
	frame := []byte{0x80 | opcode}
	switch n := len(payload); {
	case n < 126:
		frame = append(frame, 0x80|byte(n))
	case n < 1<<16:
		frame = append(frame, 0x80|126, byte(n>>8), byte(n))
	default:
		frame = append(frame, 0x80|127)
		frame = binary.BigEndian.AppendUint64(frame, uint64(n))
	}
	frame = append(frame, mask[:]...)
	for i, b := range payload {
		frame = append(frame, b^mask[i%4])
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return io.ErrClosedPipe
	}
	_, err := w.conn.Write(frame)
	return err
}

// read returns the next whole message.
func (w *websocket) read() (byte, []byte, error) {
	var message []byte
	var kind byte
	for {
		var head [2]byte
		if _, err := io.ReadFull(w.reader, head[:]); err != nil {
			return 0, nil, err
		}
		final, opcode := head[0]&0x80 != 0, head[0]&0x0f
		length := uint64(head[1] & 0x7f)
		switch length {
		case 126:
			var extended [2]byte
			if _, err := io.ReadFull(w.reader, extended[:]); err != nil {
				return 0, nil, err
			}
			length = uint64(binary.BigEndian.Uint16(extended[:]))
		case 127:
			var extended [8]byte
			if _, err := io.ReadFull(w.reader, extended[:]); err != nil {
				return 0, nil, err
			}
			length = binary.BigEndian.Uint64(extended[:])
		}
		if length > 64<<20 {
			return 0, nil, fmt.Errorf("withruntime: a WebSocket frame of %s bytes is too large", strconv.FormatUint(length, 10))
		}
		var mask []byte
		if head[1]&0x80 != 0 {
			mask = make([]byte, 4)
			if _, err := io.ReadFull(w.reader, mask); err != nil {
				return 0, nil, err
			}
		}
		payload := make([]byte, length)
		if _, err := io.ReadFull(w.reader, payload); err != nil {
			return 0, nil, err
		}
		if mask != nil {
			for i := range payload {
				payload[i] ^= mask[i%4]
			}
		}
		switch opcode {
		case opPing:
			_ = w.write(opPong, payload)
			continue
		case opPong:
			continue
		case opClose:
			_ = w.Close()
			return 0, nil, io.EOF
		case opContinuation:
			message = append(message, payload...)
		default:
			kind, message = opcode, payload
		}
		if final {
			return kind, message, nil
		}
	}
}

// Closing the underlying connection first also interrupts a blocked write;
// waiting for the writer lock before closing could deadlock cancellation.
func (w *websocket) Close() error {
	var err error
	w.closeOnce.Do(func() {
		if w.stopContext != nil {
			w.stopContext()
		}
		err = w.conn.Close()
		w.mu.Lock()
		w.closed = true
		w.mu.Unlock()
	})
	return err
}
