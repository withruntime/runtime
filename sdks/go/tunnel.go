package withruntime

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
)

const tunnelWindow = 1 << 20
const tunnelChunk = 65536

func tunnelFrame(kind byte, id uint32, payload []byte) []byte {
	out := make([]byte, 5+len(payload))
	out[0] = kind
	binary.BigEndian.PutUint32(out[1:], id)
	copy(out[5:], payload)
	return out
}

type tunnelMessage struct {
	kind byte
	data []byte
}

// Tunnel multiplexes TCP connections over one authenticated sandbox WebSocket.
// It is unrelated to Client.Tunnel, which manages an account's WireGuard network.
type Tunnel struct {
	socket         *websocket
	ctx            context.Context
	cancel         context.CancelFunc
	mu             sync.Mutex
	sendMu         sync.Mutex
	streams        map[uint32]*TunnelStream
	next           uint32
	sent, credited uint64
	changed        chan struct{}
	err            error
	done           chan struct{}
	once           sync.Once
}

// OpenTunnel opens a session bounded by ctx. Close it when no longer needed.
func (s *Sandbox) OpenTunnel(ctx context.Context) (*Tunnel, error) {
	ctx, cancel := context.WithCancel(ctx)
	ws, err := s.c.websocket(ctx, s.path("/tunnel"), nil)
	if err != nil {
		cancel()
		return nil, err
	}
	for {
		op, payload, err := ws.read()
		if err != nil {
			cancel()
			ws.Close()
			return nil, err
		}
		if op != opText {
			continue
		}
		var reply struct {
			Type  string `json:"type"`
			Error *Error `json:"error"`
		}
		if err := json.Unmarshal(payload, &reply); err != nil {
			cancel()
			ws.Close()
			return nil, err
		}
		if reply.Type == "error" {
			cancel()
			ws.Close()
			if reply.Error != nil {
				return nil, reply.Error
			}
			return nil, &Error{Code: "tunnel_refused", Message: "The tunnel was refused."}
		}
		if reply.Type == "ready" {
			t := &Tunnel{socket: ws, ctx: ctx, cancel: cancel, streams: make(map[uint32]*TunnelStream), next: 1, changed: make(chan struct{}), done: make(chan struct{})}
			context.AfterFunc(ctx, func() { t.finish(ctx.Err()) })
			go t.read()
			return t, nil
		}
	}
}
func (t *Tunnel) finish(err error) {
	t.once.Do(func() {
		t.mu.Lock()
		t.err = err
		close(t.done)
		close(t.changed)
		t.mu.Unlock()
		t.cancel()
		_ = t.socket.Close()
	})
}
func (t *Tunnel) Close() error { t.finish(io.EOF); return nil }
func (t *Tunnel) read() {
	for {
		op, data, err := t.socket.read()
		if err != nil {
			t.finish(err)
			return
		}
		if op == opText {
			var reply struct {
				Type  string `json:"type"`
				Error *Error `json:"error"`
			}
			if json.Unmarshal(data, &reply) == nil && reply.Type == "error" {
				if reply.Error != nil {
					t.finish(reply.Error)
				} else {
					t.finish(errors.New("withruntime: tunnel failed"))
				}
				return
			}
			continue
		}
		if op != opBinary {
			continue
		}
		if len(data) < 5 || len(data) > tunnelWindow+5 {
			t.finish(errors.New("withruntime: invalid tunnel frame"))
			return
		}
		kind, id, payload := data[0], binary.BigEndian.Uint32(data[1:]), data[5:]
		t.mu.Lock()
		if t.err != nil {
			t.mu.Unlock()
			return
		}
		if kind == 'a' {
			if len(payload) != 8 {
				t.mu.Unlock()
				t.finish(errors.New("withruntime: invalid tunnel credit"))
				return
			}
			credit := binary.BigEndian.Uint64(payload)
			if credit > t.sent || credit < t.credited {
				t.mu.Unlock()
				t.finish(errors.New("withruntime: invalid tunnel credit"))
				return
			}
			t.credited = credit
			close(t.changed)
			t.changed = make(chan struct{})
			t.mu.Unlock()
			continue
		}
		stream := t.streams[id]
		t.mu.Unlock()
		if stream == nil {
			continue
		}
		stream.receive(tunnelMessage{kind: kind, data: payload})
	}
}
func (t *Tunnel) forget(id uint32) { t.mu.Lock(); delete(t.streams, id); t.mu.Unlock() }
func (t *Tunnel) control(kind byte, id uint32, payload []byte) error {
	select {
	case <-t.done:
		return t.failure()
	default:
	}
	return t.socket.write(opBinary, tunnelFrame(kind, id, payload))
}
func (t *Tunnel) failure() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.err != nil {
		return t.err
	}
	return io.ErrClosedPipe
}

// Connect opens a TCP stream to a port on the sandbox's loopback.
func (t *Tunnel) Connect(ctx context.Context, port int) (*TunnelStream, error) {
	if port < 1 || port > 65535 {
		return nil, errors.New("withruntime: port must be 1 to 65535")
	}
	return t.open(ctx, fmt.Sprintf("tcp %d", port))
}

// SSH opens an SSH session authorized by this public key. Speak SSH over the returned stream.
func (t *Tunnel) SSH(ctx context.Context, publicKey string) (*TunnelStream, error) {
	return t.open(ctx, "ssh "+publicKey)
}
func (t *Tunnel) open(ctx context.Context, target string) (*TunnelStream, error) {
	t.mu.Lock()
	if t.err != nil {
		err := t.err
		t.mu.Unlock()
		return nil, err
	}
	id := t.next
	t.next++
	if id == 0 {
		t.mu.Unlock()
		return nil, errors.New("withruntime: tunnel stream IDs exhausted")
	}
	s := &TunnelStream{tunnel: t, id: id, in: make(chan tunnelMessage, 1024), done: make(chan struct{})}
	t.streams[id] = s
	t.mu.Unlock()
	if err := t.control('o', id, []byte(target)); err != nil {
		s.Close()
		return nil, err
	}
	select {
	case reply := <-s.in:
		s.consumed(len(reply.data))
		if reply.kind == 'o' {
			return s, nil
		}
		s.Close()
		return nil, streamFailure(string(reply.data))
	case <-ctx.Done():
		s.Close()
		return nil, ctx.Err()
	case <-t.done:
		s.Close()
		return nil, t.failure()
	}
}
func streamFailure(reason string) error {
	if reason == "done" {
		return io.EOF
	}
	code := "tunnel_refused"
	if reason == "closed" {
		code = "port_closed"
	}
	if reason == "reserved" {
		code = "port_reserved"
	}
	if reason == "no-sshd" {
		code = "sshd_missing"
	}
	return &Error{Code: code, Message: "Sandbox connection ended: " + reason}
}

// TunnelStream is an io.ReadWriteCloser. CloseWrite half-closes input while
// still allowing the response to be read. Use one reader and one writer.
type TunnelStream struct {
	tunnel       *Tunnel
	id           uint32
	in           chan tunnelMessage
	done         chan struct{}
	once         sync.Once
	writeMu      sync.Mutex
	ended        bool
	pending      []byte
	readErr      error
	receiveMu    sync.Mutex
	receiveBytes int
	receiveErr   error
}

// The v1 wire protocol has no per-stream receive window. Never let an
// abandoned reader block another stream's open, credit, or cancellation.
// Bound unread payload to one window and fail that stream explicitly if it
// exceeds the bound. A frame count bound also covers tiny/control frames.
func (s *TunnelStream) receive(message tunnelMessage) {
	s.receiveMu.Lock()
	select {
	case <-s.done:
		s.receiveMu.Unlock()
		return
	default:
	}
	if s.receiveBytes+len(message.data) <= tunnelWindow {
		select {
		case s.in <- message:
			s.receiveBytes += len(message.data)
			s.receiveMu.Unlock()
			return
		default:
		}
	}
	s.receiveErr = &Error{Code: "tunnel_receive_overflow", Message: "The stream's unread receive buffer is full. Read the response while writing requests."}
	s.receiveMu.Unlock()
	s.once.Do(func() {
		close(s.done)
		s.tunnel.forget(s.id)
		go func() { _ = s.tunnel.control('c', s.id, nil) }()
	})
}
func (s *TunnelStream) consumed(n int) {
	s.receiveMu.Lock()
	s.receiveBytes -= n
	s.receiveMu.Unlock()
}
func (s *TunnelStream) closedError() error {
	s.receiveMu.Lock()
	defer s.receiveMu.Unlock()
	if s.receiveErr != nil {
		return s.receiveErr
	}
	return io.ErrClosedPipe
}

func (s *TunnelStream) Read(buffer []byte) (int, error) {
	if len(buffer) == 0 {
		return 0, nil
	}
	for len(s.pending) == 0 {
		if s.readErr != nil {
			return 0, s.readErr
		}
		var message tunnelMessage
		// Drain frames already received before surfacing a socket close.
		select {
		case message = <-s.in:
		default:
			select {
			case message = <-s.in:
			case <-s.done:
				return 0, s.closedError()
			case <-s.tunnel.done:
				select {
				case message = <-s.in:
				default:
					return 0, s.tunnel.failure()
				}
			}
		}
		if message.kind != 'd' {
			s.consumed(len(message.data))
		}
		switch message.kind {
		case 'd':
			s.pending = message.data
		case 'e':
			s.readErr = io.EOF
		case 'c':
			s.readErr = streamFailure(string(message.data))
			s.tunnel.forget(s.id)
		}
	}
	n := copy(buffer, s.pending)
	s.pending = s.pending[n:]
	s.consumed(n)
	return n, nil
}
func (s *TunnelStream) Write(data []byte) (int, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if s.ended {
		return 0, io.ErrClosedPipe
	}
	t := s.tunnel
	t.sendMu.Lock()
	defer t.sendMu.Unlock()
	written := 0
	for written < len(data) {
		select {
		case <-s.done:
			return written, io.ErrClosedPipe
		default:
		}
		piece := data[written:min(len(data), written+tunnelChunk)]
		for {
			t.mu.Lock()
			if t.err != nil {
				err := t.err
				t.mu.Unlock()
				return written, err
			}
			if t.sent+uint64(len(piece))-t.credited <= tunnelWindow {
				t.sent += uint64(len(piece))
				t.mu.Unlock()
				break
			}
			changed := t.changed
			t.mu.Unlock()
			select {
			case <-changed:
			case <-s.done:
				return written, io.ErrClosedPipe
			case <-t.done:
				return written, t.failure()
			}
		}
		if err := t.control('d', s.id, piece); err != nil {
			t.finish(err)
			return written, err
		}
		written += len(piece)
	}
	return written, nil
}
func (s *TunnelStream) CloseWrite() error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if s.ended {
		return nil
	}
	s.ended = true
	return s.tunnel.control('e', s.id, nil)
}
func (s *TunnelStream) Close() error {
	s.once.Do(func() { close(s.done); s.tunnel.forget(s.id); _ = s.tunnel.control('c', s.id, nil) })
	return nil
}

// PortForward listens locally and carries every accepted TCP connection over one tunnel.
type PortForward struct {
	listener    net.Listener
	tunnel      *Tunnel
	cancel      context.CancelFunc
	mu          sync.Mutex
	connections map[net.Conn]struct{}
	closed      bool
	wg          sync.WaitGroup
	once        sync.Once
}

func (p *PortForward) Addr() net.Addr { return p.listener.Addr() }

// PortForward binds localAddress (default 127.0.0.1:0). The returned listener
// and active connections end on Close or context cancellation.
func (s *Sandbox) PortForward(ctx context.Context, port int, localAddress string) (*PortForward, error) {
	if port < 1 || port > 65535 {
		return nil, errors.New("withruntime: port must be 1 to 65535")
	}
	if localAddress == "" {
		localAddress = "127.0.0.1:0"
	}
	ctx, cancel := context.WithCancel(ctx)
	listener, err := (&net.ListenConfig{}).Listen(ctx, "tcp", localAddress)
	if err != nil {
		cancel()
		return nil, err
	}
	tunnel, err := s.OpenTunnel(ctx)
	if err != nil {
		cancel()
		listener.Close()
		return nil, err
	}
	p := &PortForward{listener: listener, tunnel: tunnel, cancel: cancel, connections: make(map[net.Conn]struct{})}
	p.wg.Add(1)
	go func() {
		defer p.wg.Done()
		for {
			local, err := listener.Accept()
			if err != nil {
				return
			}
			p.mu.Lock()
			if p.closed {
				p.mu.Unlock()
				local.Close()
				return
			}
			p.connections[local] = struct{}{}
			p.wg.Add(1)
			p.mu.Unlock()
			go func() {
				defer p.wg.Done()
				defer func() { local.Close(); p.mu.Lock(); delete(p.connections, local); p.mu.Unlock() }()
				remote, err := tunnel.Connect(ctx, port)
				if err != nil {
					return
				}
				defer remote.Close()
				copyDone := make(chan struct{})
				go func() { _, _ = io.Copy(remote, local); _ = remote.CloseWrite(); close(copyDone) }()
				_, _ = io.Copy(local, remote)
				if tcp, ok := local.(*net.TCPConn); ok {
					_ = tcp.CloseWrite()
				}
				_ = local.Close()
				_ = remote.Close()
				<-copyDone
			}()
		}
	}()
	go func() {
		select {
		case <-ctx.Done():
		case <-tunnel.done:
		}
		p.Close()
	}()
	return p, nil
}
func (p *PortForward) Close() error {
	p.once.Do(func() {
		p.cancel()
		p.listener.Close()
		p.mu.Lock()
		p.closed = true
		for conn := range p.connections {
			conn.Close()
		}
		p.mu.Unlock()
		p.tunnel.Close()
	})
	p.wg.Wait()
	return nil
}
