# frozen_string_literal: true

module WithRuntime
  # One authenticated WebSocket multiplexes connections to the sandbox's loopback.
  class Tunnel
    WINDOW = 1 << 20
    def initialize(sandbox)
      @lock, @credit, @send_lock = Mutex.new, ConditionVariable.new, Mutex.new
      @streams, @next, @sent, @credited, @closed = {}, 1, 0, 0, false
      @socket = WebSocket.new(sandbox.transport, sandbox.path("/tunnel"))
      deadline = @socket.now + @socket.timeout
      loop do
        frame = @socket.read(deadline)
        raise Error.new("Tunnel ended before ready.", code: "tunnel_refused") unless frame
        next unless frame[0] == 1
        reply = JSON.parse(frame[1])
        raise Error.from(0, reply, nil) if reply["type"] == "error"
        break if reply["type"] == "ready"
      end
      @reader = Thread.new do
        begin
          while (frame = @socket.read)
            receive(*frame)
          end
          close
        rescue StandardError => error
          finish(error)
        end
      end
    rescue StandardError
      @socket&.close
      raise
    end
    def connect(port)
      raise ArgumentError, "port must be 1 to 65535" unless port.is_a?(Integer) && port.between?(1, 65535)
      open_stream("tcp #{port}")
    end
    def ssh(public_key) = open_stream("ssh #{public_key}")
    def open_stream(target)
      stream = @lock.synchronize do
        raise closed_error if @closed
        raise Error.new("Tunnel stream IDs exhausted.", code: "tunnel_exhausted") if @next > 0xffffffff
        id = @next
        @next += 1
        @streams[id] = Stream.new(self, id)
      end
      begin
        control("o", stream.id, target)
        stream.wait_open(@socket.timeout)
        stream
      rescue StandardError
        stream.close
        raise
      end
    end
    def closed_error = @error || Error.new("The tunnel is closed.", code: "tunnel_closed")
    def control(kind, id, data = "")
      raise closed_error if @lock.synchronize { @closed }
      @socket.send_frame(2, kind.b + [id].pack("N") + data.b)
    end
    def write(stream, bytes)
      @send_lock.synchronize do
        (0...bytes.bytesize).step(65536) do |at|
          part = bytes.byteslice(at, 65536)
          @lock.synchronize do
            @credit.wait(@lock) while !@closed && !stream.closed? && @sent + part.bytesize - @credited > WINDOW
            raise closed_error if @closed
            raise IOError, "Stream closed" if stream.closed?
            @sent += part.bytesize
          end
          control("d", stream.id, part)
        end
      end
      bytes.bytesize
    end
    def forget(id)
      @lock.synchronize { @streams.delete(id); @credit.broadcast }
    end
    def async_close(id)
      Thread.new do
        control("c", id)
      rescue StandardError
        nil
      end
    end
    def receive(op, data)
      if op == 1
        reply = JSON.parse(data)
        raise Error.from(0, reply, nil) if reply["type"] == "error"
        return
      end
      raise Error.new("Malformed tunnel frame.", code: "tunnel_protocol") if data.bytesize < 5
      kind, id, bytes = data.byteslice(0, 1), data.byteslice(1, 4).unpack1("N"), data.byteslice(5..)
      if kind == "a"
        raise Error.new("Malformed tunnel credit.", code: "tunnel_protocol") unless bytes.bytesize == 8
        amount = bytes.unpack1("Q>")
        @lock.synchronize do
          return if @closed
          raise Error.new("Invalid tunnel credit.", code: "tunnel_protocol") unless amount.between?(@credited, @sent)
          @credited = amount
          @credit.broadcast
        end
        return
      end
      stream = @lock.synchronize { @streams[id] }
      return unless stream
      case kind
      when "o" then stream.opened
      when "d"
        unless stream.push(bytes)
          stream.finish(Error.new("Read responses while writing; this stream's unread buffer is full.", code: "tunnel_receive_overflow"))
          async_close(id)
        end
      when "e" then stream.eof
      when "c"
        code = { "closed" => "port_closed", "reserved" => "port_reserved", "no-sshd" => "sshd_missing" }.fetch(bytes, "tunnel_refused")
        stream.finish(bytes == "done" ? nil : Error.new("Sandbox connection ended: #{bytes}", code: code))
      end
    end
    def finish(error = nil)
      streams = @lock.synchronize do
        return if @closed
        @closed, @error = true, error
        @credit.broadcast
        values = @streams.values
        @streams = {}
        values
      end
      @socket.close
      streams.each { |stream| stream.finish(error) }
      nil
    end
    def close = finish

    class Stream
      attr_reader :id
      def initialize(tunnel, id)
        @tunnel, @id, @buffer = tunnel, id, StreamBuffer.new
        @lock, @opened, @write_lock = Mutex.new, ConditionVariable.new, Mutex.new
        @closed = @ready = @eof = false
      end
      def closed? = @closed
      def opened = @lock.synchronize { @ready = true; @opened.broadcast }
      def wait_open(timeout)
        deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
        @lock.synchronize do
          until @ready || @closed
            left = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
            raise Error.new("Opening the tunnel stream timed out.", code: "timeout") unless left.positive?
            @opened.wait(@lock, left)
          end
          raise(@error || Error.new("The stream closed before opening.", code: "tunnel_refused")) unless @ready
        end
      end
      def push(bytes) = @buffer.push(bytes)
      def eof = @buffer.finish
      def read(length = 65536) = @buffer.read(length)
      def write(bytes)
        @write_lock.synchronize do
          raise IOError, "Stream input is closed" if @closed || @eof
          @tunnel.write(self, bytes.to_s.b)
        end
      end
      def close_write
        @write_lock.synchronize do
          return if @eof || @closed
          @eof = true
          @tunnel.control("e", @id)
        end
        nil
      end
      def finish(error = nil)
        changed = @lock.synchronize do
          next false if @closed
          @closed, @error = true, error
          @opened.broadcast
          true
        end
        if changed
          @buffer.finish(error)
          @tunnel.forget(@id)
        end
        nil
      end
      def close
        return if @closed
        finish
        @tunnel.async_close(@id)
        nil
      end
    end
  end

  # Copies each accepted local TCP connection over a stream in one tunnel.
  class PortForward
    attr_reader :host, :port
    def initialize(sandbox, remote_port, host:, local_port:)
      raise ArgumentError, "port must be 1 to 65535" unless remote_port.is_a?(Integer) && remote_port.between?(1, 65535)
      @lock, @clients, @closed = Mutex.new, [], false
      @listener = TCPServer.new(host, local_port)
      @host, @port = @listener.addr[3], @listener.addr[1]
      @tunnel = sandbox.open_tunnel
      @accept = Thread.new do
        loop do
          local = @listener.accept
          @lock.synchronize { @clients << local }
          if @closed
            close_local(local)
            break
          end
          Thread.new(local) { |client| forward(client, remote_port) }
        end
      rescue IOError, SystemCallError
        close
      end
    rescue StandardError
      @listener&.close
      @tunnel&.close
      raise
    end
    def forward(local, remote_port)
      stream = @tunnel.connect(remote_port)
      directions, lock = 2, Mutex.new
      finish = lambda do
        last = lock.synchronize { directions -= 1; directions.zero? }
        if last
          stream.close
          close_local(local)
        end
      end
      Thread.new do
        begin
          loop { stream.write(local.readpartial(65536)) }
        rescue EOFError
          stream.close_write
        rescue StandardError
          stream.close
          close_local(local)
        ensure
          finish.call
        end
      end
      begin
        while (data = stream.read)
          local.write(data)
        end
        local.close_write
      rescue StandardError
        stream.close
        close_local(local)
      ensure
        finish.call
      end
    rescue StandardError
      close_local(local)
    end
    def close_local(local)
      @lock.synchronize { @clients.delete(local) }
      local.close unless local.closed?
    rescue IOError, SystemCallError
      nil
    end
    def close
      clients = @lock.synchronize do
        return if @closed
        @closed = true
        @clients.dup
      end
      @listener.close unless @listener.closed?
      clients.each { |client| close_local(client) }
      @tunnel.close
      nil
    end
  end
end
