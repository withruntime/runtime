# frozen_string_literal: true

require "socket"
require "digest"

module WithRuntime
  # One bounded RFC6455 connection, using the transport's origin, key and proxy rules.
  class WebSocket
    # The close code the server sent, once it closed.
    attr_reader :timeout, :close_code
    def initialize(transport, path, query = nil)
      @transport = transport
      @timeout = transport.timeout
      @write_lock, @close_lock = Mutex.new, Mutex.new
      @closed = false
      uri = URI(transport.base_url)
      proxy = Transport.send(:proxy_for, uri)
      if proxy && proxy.scheme != "http"
        raise Error.new("WebSocket proxy must use http CONNECT.", code: "proxy_unsupported")
      end
      @raw = Socket.tcp(proxy ? proxy.host : uri.host, proxy ? proxy.port : uri.port, connect_timeout: @timeout)
      @io = @raw
      deadline = now + @timeout
      if proxy
        authority = "#{uri.host}:#{uri.port}"
        auth = proxy.user ? "Proxy-Authorization: Basic #{["#{URI.decode_www_form_component(proxy.user)}:#{URI.decode_www_form_component(proxy.password.to_s)}"].pack("m0")}\r\n" : ""
        write_all("CONNECT #{authority} HTTP/1.1\r\nHost: #{authority}\r\n#{auth}\r\n", deadline)
        raise Error.new("The proxy refused the WebSocket connection.", code: "proxy_refused") unless headers(deadline).first.match?(/\AHTTP\/1\.[01] 200 /)
      end
      if uri.scheme == "https"
        context = OpenSSL::SSL::SSLContext.new
        context.set_params
        tls = OpenSSL::SSL::SSLSocket.new(@raw, context)
        tls.hostname = uri.host
        @io = tls
        loop do
          result = tls.connect_nonblock(exception: false)
          break unless %i[wait_readable wait_writable].include?(result)
          wait(result, deadline)
        end
        tls.post_connection_check(uri.host)
      end
      key = [SecureRandom.random_bytes(16)].pack("m0")
      target = path + (query && !query.empty? ? "?#{URI.encode_www_form(query.reject { |_, value| value.nil? })}" : "")
      host = uri.port == uri.default_port ? uri.host : "#{uri.host}:#{uri.port}"
      write_all("GET #{target} HTTP/1.1\r\nHost: #{host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: #{key}\r\nAuthorization: Bearer #{transport.api_key}\r\nX-Runtime-Client: sdk-ruby/#{VERSION}\r\n\r\n", deadline)
      status, fields = headers(deadline)
      accept = [Digest::SHA1.digest(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")].pack("m0")
      unless status.match?(/\AHTTP\/1\.[01] 101 /) && fields["sec-websocket-accept"] == accept && fields["upgrade"].to_s.downcase == "websocket"
        raise Error.new("The server refused the WebSocket upgrade.", code: "websocket_refused", status: status[/\AHTTP\/1\.[01] (\d{3})/, 1].to_i)
      end
    rescue *Transport::NETWORK_ERRORS => error
      close
      raise @transport.connection_error(error.is_a?(Timeout::Error), false, nil, error)
    rescue StandardError
      close
      raise
    end

    def now = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    def wait(direction, deadline)
      left = deadline && deadline - now
      raise Error.new("The stream deadline passed.", code: "timeout") if left && left <= 0
      selected = direction == :wait_writable ? IO.select(nil, [@io], nil, left) : IO.select([@io], nil, nil, left)
      raise Error.new("The stream deadline passed.", code: "timeout") unless selected
    end
    def exact(length, deadline = nil)
      out = +"".b
      while out.bytesize < length
        part = @io.read_nonblock(length - out.bytesize, exception: false)
        raise EOFError if part.nil?
        if part.is_a?(Symbol)
          wait(part, deadline)
        else
          out << part
        end
      end
      out
    end
    def write_all(bytes, deadline)
      at = 0
      while at < bytes.bytesize
        n = @io.write_nonblock(bytes.byteslice(at..), exception: false)
        n.is_a?(Symbol) ? wait(n, deadline) : at += n
      end
    end
    def headers(deadline)
      text = +""
      until text.end_with?("\r\n\r\n")
        raise Error.new("WebSocket response headers are too large.", code: "websocket_protocol") if text.bytesize >= 65536
        text << exact(1, deadline)
      end
      lines = text.split("\r\n")
      [lines.shift, lines.to_h { |line| name, value = line.split(":", 2); [name.downcase, value.to_s.strip] }]
    end
    def send_frame(op, bytes)
      bytes = bytes.b
      @write_lock.synchronize do
        raise IOError, "WebSocket closed" if @closed
        mask = SecureRandom.random_bytes(4)
        size = bytes.bytesize
        header = [0x80 | op].pack("C")
        header << if size < 126 then [0x80 | size].pack("C") elsif size <= 65535 then [0xfe, size].pack("Cn") else [0xff, size].pack("CQ>") end
        masked = bytes.bytes.each_with_index.map { |value, index| value ^ mask.getbyte(index % 4) }.pack("C*")
        write_all(header + mask + masked, now + @timeout)
      end
    rescue *Transport::NETWORK_ERRORS => error
      raise @transport.connection_error(error.is_a?(Timeout::Error), false, nil, error)
    end
    def read(deadline = nil)
      message = +"".b
      kind = nil
      loop do
        first, second = exact(2, deadline).unpack("CC")
        raise Error.new("Invalid WebSocket frame.", code: "websocket_protocol") unless (first & 0x70).zero? && (second & 0x80).zero?
        op, final, length = first & 15, (first & 0x80) != 0, second & 127
        length = exact(2, deadline).unpack1("n") if length == 126
        length = exact(8, deadline).unpack1("Q>") if length == 127
        if length > 1_048_581 || (op >= 8 && (!final || length > 125))
          raise Error.new("WebSocket frame exceeds its bound.", code: "stream_overflow")
        end
        data = exact(length, deadline)
        if op == 8
          @close_code = data.bytesize >= 2 ? data.unpack1("n") : 1005
          return nil
        end
        if op == 9
          send_frame(10, data)
          next
        end
        next if op == 10
        if op == 0
          raise Error.new("Unexpected continuation.", code: "websocket_protocol") unless kind
        else
          raise Error.new("Invalid data frame.", code: "websocket_protocol") unless [1, 2].include?(op) && kind.nil?
          kind = op
        end
        message << data
        raise Error.new("WebSocket message exceeds its bound.", code: "stream_overflow") if message.bytesize > 1_048_581
        return [kind, message] if final
      end
    rescue *Transport::NETWORK_ERRORS => error
      raise @transport.connection_error(error.is_a?(Timeout::Error), false, nil, error)
    end
    def close
      return unless @close_lock
      @close_lock.synchronize do
        return if @closed
        @closed = true
        @raw&.close unless @raw&.closed?
      end
    rescue IOError, SystemCallError
      nil
    end
  end

  # A terminal's or tunnel's WebSocket that outlives a restart of the API behind it
  # (packages/cloud/src/api/tunnels.ts, "Hand-off"): on {"type":"restart"} it holds what is
  # sent and answers; on {"type":"resume"} and close 1012 it opens the socket again with
  # ?resume=<token>, sends {"type":"replay"} first, then what it held. Output continues from
  # the byte it stopped at, and the reader sees no close.
  class ResumableSocket
    # RFC 6455 close code 1012, Service Restart.
    SERVICE_RESTART = 1012
    # How long reconnecting may take: within the token's 30 s, after which the API ends it.
    RESUME_SECONDS = 25
    attr_reader :timeout, :resumes, :replays
    def initialize(transport, path, query = nil)
      @transport, @path = transport, path
      @socket = WebSocket.new(transport, path, query)
      @timeout = @socket.timeout
      # Orders sends, the restart's answer and the switch to a new socket. close never takes
      # it, so it can close a socket under a send blocked holding it.
      @send_lock = Mutex.new
      @paused, @held, @closed, @resumes, @replays = false, [], false, 0, 0
    end
    def now = @socket.now
    def send_frame(op, bytes)
      @send_lock.synchronize do
        raise IOError, "WebSocket closed" if @closed
        next @held << [op, bytes.b] if @paused
        @socket.send_frame(op, bytes)
      end
    end
    # The next message the reader sees; the restart's own are not.
    def read(deadline = nil)
      loop do
        socket = @socket
        message = socket.read(deadline)
        unless message
          socket.close
          token = @token
          next if token && socket.close_code == SERVICE_RESTART && !@closed && resume(token)
          said, @said = @said, nil
          return said
        end
        if message[0] == 1 && message[1].bytesize <= 4096
          reply = begin
            JSON.parse(message[1])
          rescue JSON::ParserError
            nil
          end
          if reply.is_a?(Hash) && reply["type"] == "restart"
            @send_lock.synchronize do
              @paused = true
              socket.send_frame(1, JSON.generate(type: "restart"))
            end
            next
          end
          if reply.is_a?(Hash) && reply["type"] == "resume" && reply["token"]
            @token, @replay = reply["token"], reply["replay"]
            next
          end
        end
        return message
      end
    end
    def close
      @closed = true
      @attempt&.close
      # First unblocks a send in flight; then, under its lock, the socket a resume may have
      # swapped in meanwhile.
      @socket.close
      @send_lock.synchronize do
        @held.clear
        @socket.close
      end
    end

    private

    # Opens the socket again where it stopped; false when it cannot.
    def resume(token)
      replay = @replay
      @token = @replay = nil
      deadline = now + RESUME_SECONDS
      wait = 0.05
      while !@closed && now < deadline
        socket = nil
        begin
          socket = @attempt = WebSocket.new(@transport, @path, { "resume" => token })
          # A close that came while it opened.
          break socket.close if @closed
          # A server that never answers must not hold this past the deadline.
          message = socket.read(deadline)
          reply = message && message[0] == 1 ? JSON.parse(message[1]) : nil
          if reply.is_a?(Hash) && reply["type"] == "ready" && reply["resumed"]
            return @send_lock.synchronize do
              if @closed
                socket.close
                next false
              end
              @socket = socket
              @resumes += 1
              if replay && !replay.empty?
                @replays += 1
                socket.send_frame(1, JSON.generate(type: "replay", data: replay))
              end
              @held.each { |op, bytes| socket.send_frame(op, bytes) }
              @held.clear
              @paused = false
              true
            end
          end
          socket.close
          if reply.is_a?(Hash) && reply["type"] == "error"
            # Refused for good (the sandbox stopped, say): the reader reads the error.
            @said = message
            return false
          end
        rescue Error => error
          socket&.close
          # A 4xx other than 429: the token or the sandbox is not good, and asking again
          # changes nothing.
          return false if error.status.between?(400, 499) && error.status != 429
        rescue JSON::ParserError, IOError, SystemCallError
          socket&.close
        ensure
          @attempt = nil
        end
        sleep wait
        wait = [wait * 2, 1].min
      end
      false
    end
  end

  # Producer never waits for a reader. The stream owner decides how overflow is reported.
  class StreamBuffer
    def initialize
      @lock, @changed = Mutex.new, ConditionVariable.new
      @queue, @bytes, @ended = [], 0, false
    end
    def push(bytes)
      @lock.synchronize do
        return true if @ended
        return false if @bytes + bytes.bytesize > 1 << 20 || @queue.length >= 1024
        unless bytes.empty?
          @queue << bytes
          @bytes += bytes.bytesize
          @changed.broadcast
        end
        true
      end
    end
    def finish(error = nil)
      @lock.synchronize { unless @ended; @ended = true; @error = error; @changed.broadcast; end }
    end
    def read(length = 65536)
      raise ArgumentError, "length must be positive" unless length.positive?
      @lock.synchronize do
        @changed.wait(@lock) while @queue.empty? && !@ended
        if @queue.empty?
          raise @error if @error
          return nil
        end
        data = @queue.shift
        if data.bytesize > length
          @queue.unshift(data.byteslice(length..))
          data = data.byteslice(0, length)
        end
        @bytes -= data.bytesize
        data
      end
    end
  end

  class Terminal
    attr_reader :process_id, :exit_code
    def initialize(sandbox, **options)
      @socket = ResumableSocket.new(sandbox.transport, sandbox.path("/terminal"), Fields.body(options))
      @buffer = StreamBuffer.new
      deadline = @socket.now + @socket.timeout
      loop do
        message = @socket.read(deadline)
        raise Error.new("Terminal ended before ready.", code: "terminal_refused") unless message
        next unless message[0] == 1
        reply = JSON.parse(message[1])
        raise Error.from(0, reply, nil) if reply["type"] == "error"
        if reply["type"] == "ready"
          @process_id = reply["processId"]
          break
        end
      end
      @reader = Thread.new do
        begin
          while (message = @socket.read)
            if message[0] == 2
              raise Error.new("Read terminal output while writing input; its unread buffer is full.", code: "terminal_receive_overflow") unless @buffer.push(message[1])
            else
              reply = JSON.parse(message[1])
              if reply["type"] == "exit"
                @exit_code = reply["exitCode"]
                break
              end
              raise Error.from(0, reply, nil) if reply["type"] == "error"
            end
          end
          @buffer.finish
        rescue StandardError => error
          @buffer.finish(@closed ? nil : error)
        ensure
          @socket.close
        end
      end
    rescue StandardError
      @socket&.close
      raise
    end
    def read(length = 65536) = @buffer.read(length)
    def write(bytes)
      bytes = bytes.to_s.b
      (0...bytes.bytesize).step(65536) { |at| @socket.send_frame(2, bytes.byteslice(at, 65536)) }
      bytes.bytesize
    end
    def resize(cols:, rows:) = @socket.send_frame(1, JSON.generate(type: "resize", cols: cols, rows: rows))
    def close
      @closed = true
      @socket.close
      @buffer.finish
      nil
    end
  end
end
