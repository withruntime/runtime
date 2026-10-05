# frozen_string_literal: true

require "json"
require "net/http"
require "securerandom"
require "uri"

module WithRuntime
  # One connection pool, one retry policy and one error shape for every
  # product: the same rules as the JavaScript, Python, Go and Java SDKs. Writes
  # carry an idempotency key, made per call and kept across the client's own
  # retries; transport failures, 429, 502, 503 and 504 are retried with backoff
  # and jitter; a create waits out a full trial, quota or region.
  class Transport
    class OpeningCancelled < IOError; end
    class Cancellation
      def initialize
        @lock = Mutex.new
        @cancelled = false
        @action = nil
        @changed = ConditionVariable.new
      end
      def cancelled? = @lock.synchronize { @cancelled }
      def register(&action)
        run = @lock.synchronize { @action = action; @cancelled }
        action.call if run
      end
      def wait(seconds)
        deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + seconds
        @lock.synchronize do
          until @cancelled
            left = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
            return true if left <= 0
            @changed.wait(@lock, left)
          end
        end
        false
      end
      def cancel
        action = @lock.synchronize { @cancelled = true; @changed.broadcast; @action }
        action&.call
      end
    end
    # How long one attempt waits for its answer to start. The API starts every
    # answer within 120 s: Caddy answers 503 itself past that, and a longer call
    # gets its 200 at 90 s and then its JSON (runtime-late-answer). An attempt
    # with no answer by then is talking to a server that is gone, such as a
    # controller that died with the call in flight while its address moved to
    # the new leader: a client that only waits sends nothing the new leader
    # could refuse (the leader drill on vin-5, 4 October 2026). It is sent
    # again under the same key.
    ANSWER_START = 125.0
    class << self
      attr_writer :answer_start

      def answer_start = @answer_start || ANSWER_START
    end

    NETWORK_ERRORS = [IOError, SystemCallError, SocketError, Timeout::Error, OpenSSL::SSL::SSLError,
                      Net::HTTPBadResponse, Net::ProtocolError, EOFError].freeze

    attr_reader :base_url, :api_key, :timeout, :max_retries, :wait_for_capacity

    def initialize(api_key:, base_url:, timeout:, max_retries:, max_connections:, wait_for_capacity:)
      @api_key = api_key
      @base_url = base_url
      @uri = URI(base_url)
      @timeout = timeout
      @max_retries = max_retries
      @wait_for_capacity = wait_for_capacity
      @limit = [1, max_connections].max
      @idle = []
      @open = 0
      @lock = Mutex.new
      @freed = ConditionVariable.new
      @client = "sdk-ruby/#{VERSION}"
    end

    # Percent-encodes one path segment, as encodeURIComponent does.
    def self.segment(value)
      value.to_s.b.gsub(/[^A-Za-z0-9\-_.!~*'()]/) { |c| format("%%%02X", c.ord) }
    end

    # The value of a JSON call: a Hash, an Array or nil.
    def json(method, path, query: nil, body: nil, **options)
      with_connection(options, method) do |http, admitted|
        response = send_call(http, method, path, query: query, body: body, **admitted)
        text = response.body.to_s
        text.strip.empty? ? nil : JSON.parse(text)
      rescue JSON::ParserError => e
        raise Error.new("Unexpected answer from #{method} #{path}: #{e.message}", code: "unexpected_answer")
      end
    end

    # A GET's body to the block a chunk at a time as it arrives. A connection
    # lost part way is raised, never retried, so no chunk is given twice.
    def chunks(path, query: nil, accept: "application/octet-stream", &block)
      with_connection({}, "GET") do |http, admitted|
        send_call(http, "GET", path, query: query, accept: accept, no_retry: true, **admitted, &block)
      end
      nil
    end

    def bytes(method, path, query: nil, body: nil, **options)
      with_connection(options, method) do |http, admitted|
        send_call(http, method, path, query: query, body: body, **admitted).body.to_s.b
      end
    end

    # Newline-delimited JSON events as they arrive, one Hash per event, on a
    # connection of their own. A connection lost after the first event is
    # raised, never retried, so no event is given twice; the caller resumes
    # from its cursor.
    def events(method, path, query: nil, body: nil, cancel: nil, **options, &block)
      return enum_for(:events, method, path, query: query, body: body, cancel: cancel, **options) unless block

      cancellation = Cancellation.new
      cancel&.register { cancellation.cancel }
      http = connect
      begin
        buffer = +""
        send_call(http, method, path, query: query, body: body, accept: "application/x-ndjson", cancel: cancellation, **options) do |chunk|
          buffer << chunk
          while (newline = buffer.index("\n"))
            line = buffer.slice!(0, newline + 1).strip
            yield JSON.parse(line) unless line.empty?
          end
        end
        yield JSON.parse(buffer) unless buffer.strip.empty?
      rescue JSON::ParserError => e
        raise Error.new("Unexpected stream line: #{e.message}", code: "unexpected_answer")
      ensure
        cancellation.cancel
        begin
          http.finish if http.started?
        rescue IOError
          nil
        end
      end
    end

    def connection_error(timed_out, write, key, cause = nil)
      if timed_out
        ConnectionError.new("The call was cancelled or ran past its deadline.", code: "timeout",
                            hint: "Allow a longer timeout for a long call, or retry with the same idempotency key.",
                            idempotency_key: key)
      else
        message = "No answer from Runtime at #{base_url}."
        message += " The change may have happened; retrying with the same idempotency key is safe." if write
        message += " (#{cause.class}: #{cause.message})" if cause
        ConnectionError.new(message, code: "connection_error",
                                     hint: "Check the network, HTTPS_PROXY, and RUNTIME_API_URL if you set it.",
                                     idempotency_key: key)
      end
    end

    private

    # HTTPS_PROXY (or HTTP_PROXY for an http origin) and NO_PROXY, read the
    # way curl reads them. Net::HTTP's own :ENV reads http_proxy even for HTTPS.
    def self.proxy_for(uri, env = ENV)
      names = uri.scheme == "https" ? %w[HTTPS_PROXY https_proxy] : %w[HTTP_PROXY http_proxy]
      value = names.map { |name| env[name] }.find { |found| found && !found.strip.empty? }
      return nil unless value

      # URI's matcher knows neither curl's "*" (no proxy at all) nor "*.example.com".
      exempt = (env["NO_PROXY"] || env["no_proxy"]).to_s.split(",").map(&:strip).reject(&:empty?)
      return nil if exempt.include?("*")
      exempt = exempt.map { |entry| entry.delete_prefix("*") }.join(",")
      return nil if !exempt.empty? && !URI::Generic.use_proxy?(uri.host, uri.host, uri.port, exempt)

      value = "http://#{value}" unless value.include?("://")
      URI(value.strip)
    end

    def connect
      proxy = Transport.proxy_for(@uri)
      http = if proxy
               Net::HTTP.new(@uri.host, @uri.port, proxy.host, proxy.port,
                             proxy.user && URI.decode_www_form_component(proxy.user),
                             proxy.password && URI.decode_www_form_component(proxy.password))
             else
               Net::HTTP.new(@uri.host, @uri.port, nil)
             end
      http.use_ssl = @uri.scheme == "https"
      http.max_retries = 0
      http.open_timeout = 30
      http.keep_alive_timeout = 30
      http
    end

    # Net::HTTP keeps its socket local until TCP, proxy CONNECT and TLS finish.
    # Keep that opening alone in an owned worker: raising an IOError there runs
    # Net::HTTP's connect rescue and closes its local socket. Never interrupt the
    # caller's event block, and join before returning so cancellation leaks no
    # opening thread or socket.
    def open_connection(http, cancel)
      return if http.started?
      return http.start unless cancel

      opened = false
      gate = Queue.new
      worker = Thread.new do
        Thread.current.report_on_exception = false
        gate.pop
        http.start
      end
      worker.report_on_exception = false
      cancel.register { worker.raise(OpeningCancelled, "Stream connection cancelled.") if worker.alive? }
      gate.push(true)
      worker.value
      opened = true
    ensure
      if worker&.alive?
        worker.raise(OpeningCancelled, "Stream connection cancelled.")
        begin
          worker.join
        rescue *NETWORK_ERRORS
          nil
        end
      end
      # connect can assign @socket immediately before do_start marks the
      # session started. An interruption between those lines skips connect's
      # rescue, so finish/started? alone cannot clean up this failed opening.
      if worker && !opened
        begin
          http.instance_variable_get(:@socket)&.close
        rescue IOError, SystemCallError
          nil
        end
      end
    end

    # A connection from the pool, waited for within the call's own deadline;
    # the wait is taken off it, so a queued call expires as an unqueued one
    # would, without sending anything.
    def with_connection(options, method)
      limit = options[:timeout] || @timeout
      deadline = now + limit
      http = @lock.synchronize do
        loop do
          break @idle.pop unless @idle.empty?
          if @open < @limit
            @open += 1
            break connect
          end
          left = deadline - now
          raise connection_error(true, method != "GET", options[:key]) if left <= 0

          @freed.wait(@lock, left)
        end
      end
      healthy = false
      begin
        left = deadline - now
        raise connection_error(true, method != "GET", options[:key]) if left <= 0

        result = yield http, options.merge(timeout: left)
        healthy = true
        result
      ensure
        @lock.synchronize do
          if healthy
            @idle.push(http)
          else
            http.finish if http.started?
            @open -= 1
          end
          @freed.signal
        end
      end
    end

    def deadline_watchdog(http, seconds)
      Thread.new do
        Thread.current.report_on_exception = false
        sleep(seconds)
        begin
          http.instance_variable_get(:@socket)&.io&.close
        rescue IOError, SystemCallError
          nil
        end
      end
    end

    def backoff(attempt) = [8.0, 0.25 * (2**[attempt, 10].min)].min * (0.5 + rand)

    # 0.5 s, 1 s, 2 s, 4 s, then every 8 s, jittered, so a queue of CI jobs spreads out.
    def room_backoff(attempt) = [8.0, 0.5 * (2**[attempt, 10].min)].min * (0.75 + (rand * 0.5))

    def now = Process.clock_gettime(Process::CLOCK_MONOTONIC)

    def target(path, query)
      pairs = []
      (query || {}).each do |key, value|
        next if value.nil?

        Array(value).each { |item| pairs << [key.to_s, item.to_s] }
      end
      pairs.empty? ? path : "#{path}?#{URI.encode_www_form(pairs)}"
    end

    # Sends a call, retrying as the rules say, and returns the response once it
    # succeeded. With a block, the body is streamed to it.
    def send_call(http, method, path, query: nil, body: nil, raw: nil, accept: "application/json", wait: nil,
                  key: nil, no_retry: false, room: 0, timeout: nil, cancel: nil, &stream)
      write = method != "GET"
      key = write ? (key || SecureRandom.uuid) : nil
      deadline = now + (timeout || @timeout) + room
      room_until = now + room
      room_attempt = 0
      payload = raw || (body.nil? ? nil : JSON.generate(body))
      attempt = 0
      loop do
        raise connection_error(true, write, key) if cancel&.cancelled?
        left = deadline - now
        raise connection_error(true, write, key) if left <= 0

        request = Net::HTTPGenericRequest.new(method, !payload.nil?, true, target(path, query))
        request["Authorization"] = "Bearer #{api_key}"
        request["Accept"] = accept
        request["X-Runtime-Client"] = @client
        request["User-Agent"] = "withruntime-ruby/#{VERSION}"
        request["Idempotency-Key"] = key if key
        request["Prefer"] = "wait=#{[120, wait].min}" if wait&.positive?
        if payload
          request["Content-Type"] = raw ? "application/octet-stream" : "application/json"
          request.body = payload
        end
        # Until its answer starts, a read waits at most answer_start; then the
        # call's whole deadline again.
        bounded = Transport.answer_start < left
        answered = false
        http.read_timeout = bounded ? Transport.answer_start : left
        http.write_timeout = left if http.respond_to?(:write_timeout=)
        http.open_timeout = [left, 30].min
        # Per-read limits do not bound a body that keeps trickling in: at the
        # deadline the socket is closed, and the read fails as a timeout.
        watchdog = deadline_watchdog(http, left)
        response = nil
        # A stream that gave its consumer anything is never sent again: that
        # would give the same events twice. The consumer's own errors are its
        # own, never a reason to retry.
        streamed = false
        consumer_error = nil
        begin
          open_connection(http, cancel)
          cancel&.register do
            http.read_timeout = 0.001
            http.write_timeout = 0.001
            http.open_timeout = 0.001
            begin
              http.instance_variable_get(:@socket)&.io&.close
            rescue IOError, SystemCallError
              nil
            end
          end
          raise connection_error(true, write, key) if cancel&.cancelled?
          if stream
            http.request(request) do |answer|
              answered = true
              http.read_timeout = [deadline - now, 0.001].max
              response = answer
              if answer.code.to_i < 300
                answer.read_body do |chunk|
                  streamed = true
                  begin
                    stream.call(chunk)
                  rescue Exception => e
                    consumer_error = e
                    raise
                  end
                end
              end
            end
          else
            response = http.request(request) do
              answered = true
              http.read_timeout = [deadline - now, 0.001].max
            end
          end
          status = response.code.to_i
          if status >= 300 && status < 400
            raise Net::HTTPBadResponse, "Runtime answered a redirect (#{status})"
          end
        rescue *NETWORK_ERRORS => e
          http.finish if http.started?
          raise if e.equal?(consumer_error)

          unanswered = bounded && !answered && e.is_a?(Net::ReadTimeout) && now < deadline
          late = (e.is_a?(Timeout::Error) && !unanswered) || now >= deadline || cancel&.cancelled?
          raise connection_error(late, write, key, e) if late || no_retry || streamed || attempt >= max_retries

          pause(backoff(attempt), deadline, write, key, nil, cancel)
          attempt += 1
          next
        ensure
          watchdog.kill
        end
        return response if status < 300

        text = response.body.to_s
        parsed = begin
          JSON.parse(text)
        rescue JSON::ParserError
          { "error" => { "message" => text.strip.empty? ? nil : text.strip[0, 500] }.compact }
        end
        failure = Error.from(status, parsed, key)
        if !no_retry && room.positive? && Error::WAITS_FOR_ROOM.include?(failure.code) && failure.details["field"] != "count"
          room_left = room_until - now
          raise failure if room_left <= 0

          wait_for = failure.retry_after || room_backoff(room_attempt)
          room_attempt += 1
          pause([room_left, wait_for].min, deadline, write, key, failure, cancel)
          next
        end
        retryable = [429, 502, 503, 504].include?(status) && !Error::DELIBERATE.include?(failure.code)
        raise failure if no_retry || !retryable || attempt >= max_retries

        wait_for = failure.retry_after
        if wait_for.nil?
          header = Float(response["Retry-After"], exception: false)
          wait_for = header&.positive? ? header : backoff(attempt)
        end
        pause([30.0, wait_for].min * (0.9 + (rand * 0.2)), deadline, write, key, failure, cancel)
        attempt += 1
      end
    end

    def pause(seconds, deadline, write, key, failure = nil, cancel = nil)
      if now + seconds >= deadline
        raise failure if failure

        raise connection_error(true, write, key)
      end
      if cancel
        raise connection_error(true, write, key) unless cancel.wait(seconds)
      else
        sleep(seconds)
      end
    end
  end
end
