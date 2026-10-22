# frozen_string_literal: true

require "digest"
require "json"
require "net/http"
require "securerandom"
require "uri"

module WithRuntime
  # One connection pool, one retry policy and one error shape for every
  # product: the same rules as the JavaScript, Python, Go and Java SDKs. Writes
  # carry an idempotency key, made per call and kept across the client's own
  # retries; transport failures, 429, 502, 503 and 504 are retried with backoff
  # and jitter; a create waits out full slots without credit, a full quota or a full region.
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
    # The longest wait a server names that a call sleeps on (seconds). One
    # longer (a daily cap's hour) is raised at once, still retryable with its
    # retry_after, for the caller to schedule.
    LONGEST_WAIT = 60.0
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

    # A file's bytes, checked against the length (x-content-length) and
    # SHA-256 (x-content-sha256) the API sent with them: a stream that broke
    # can arrive as one that ended, short. A short or different body is read
    # again twice, then download_incomplete.
    def file_bytes(path, query: nil, accept: "application/octet-stream", **options)
      attempt = 0
      loop do
        response = with_connection(options, "GET") do |http, admitted|
          send_call(http, "GET", path, query: query, accept: accept, **admitted)
        end
        body = response.body.to_s.b
        problem = Transport.check_body(response, body)
        return body unless problem
        raise problem if attempt >= 2

        sleep(backoff(attempt))
        attempt += 1
      end
    end

    # Why a whole file body cannot be trusted, or nil when it can.
    def self.check_body(response, body)
      expected = response["x-content-length"]
      if expected&.match?(/\A\d+\z/) && body.bytesize != expected.to_i
        return Error.new("The download ended at #{body.bytesize} of #{expected} bytes.",
                         code: "download_incomplete",
                         hint: "Read the file again; nothing was written for this read.",
                         details: { "received" => body.bytesize, "expected" => expected.to_i })
      end
      sha256 = response["x-content-sha256"]
      return nil if sha256.nil? || sha256.empty? || Digest::SHA256.hexdigest(body).casecmp?(sha256)

      Error.new("The file's bytes did not match the SHA-256 the API sent with them.",
                code: "download_incomplete", hint: "Read the file again.")
    end

    # The status a late answer's body failed with, or 200 when it is an
    # answer. An API error is a body of `error` alone, with a code; an answer
    # may carry an `error` of its own (a code cell's exception) beside other
    # fields. A body that is not JSON was cut or garbled: 502.
    def self.late_failure(text)
      body = begin
        JSON.parse(text)
      rescue JSON::ParserError
        return 502
      end
      return 200 unless body.is_a?(Hash) && body.size == 1
      error = body["error"]
      return 200 unless error.is_a?(Hash) && error["code"].is_a?(String)

      status = error["status"]
      status.is_a?(Numeric) && status >= 400 ? status.to_i : 500
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

    # A connection that never opened: no byte of the request left this machine.
    NEVER_OPENED = [Errno::ECONNREFUSED, Errno::ENOENT, Errno::EHOSTUNREACH, Errno::ENETUNREACH,
                    Errno::EADDRNOTAVAIL].freeze

    # Whether a failure, or one of its causes, is a connection that never
    # opened. A timeout or a reset never counts.
    def self.never_sent?(error)
      at = error
      5.times do
        return false if at.nil?
        return true if NEVER_OPENED.any? { |kind| at.is_a?(kind) }

        at = at.cause
      end
      false
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
                  key: nil, no_retry: false, room: nil, timeout: nil, cancel: nil, &stream)
      write = method != "GET"
      key = write ? (key || SecureRandom.uuid) : nil
      # room: nil for a call with no room wait; 0 for a create, wake, restart
      # or fork told at once.
      deadline = now + (timeout || @timeout) + (room || 0)
      room_until = now + (room || 0)
      room_attempt = 0
      payload = raw || (body.nil? ? nil : JSON.generate(body))
      attempt = 0
      # An answer that ran nothing is sent again until the call's deadline
      # (a Ruby call always has one: its timeout, plus any wait for room).
      idle_attempt = 0
      # The last try never left, and was sent again at once.
      resent_at_once = false
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
              # A late answer is read whole first: it may be a failure.
              if answer.code.to_i < 300 && answer["runtime-late-answer"] != "true"
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

          # A connection that never opened sent no byte of the request, so the
          # next try, which may reach another server, goes at once; once in a
          # row, so an API that is down is not hammered. A reset or a timeout
          # may have reached a server and keeps the backoff and its key's rules.
          at_once = Transport.never_sent?(e) && !resent_at_once
          resent_at_once = at_once
          pause(at_once ? rand * 0.05 : backoff(attempt), deadline, write, key, nil, cancel)
          attempt += 1
          next
        ensure
          watchdog.kill
        end
        # An answer that took longer than the API holds its headers (90 s)
        # comes as a 200 sent early, and then its JSON: the answer, or
        # {"error": ...} when the work failed after the status went
        # (runtime-late-answer). A failure is raised as the error it is,
        # never returned as a success.
        late = status < 300 && response["runtime-late-answer"] == "true"
        status = Transport.late_failure(response.body.to_s) if late
        if status < 300
          stream&.call(response.body.to_s) if late
          return response
        end

        text = response.body.to_s
        parsed = begin
          JSON.parse(text)
        rescue JSON::ParserError
          { "error" => { "message" => text.strip.empty? ? nil : text.strip[0, 500] }.compact }
        end
        failure = Error.from(status, parsed, key)
        # A quota on what is kept says it never clears by waiting.
        if !no_retry && room&.positive? && Error::WAITS_FOR_ROOM.include?(failure.code) && failure.details["field"] != "count" &&
           failure.sent_retryable != false
          room_left = room_until - now
          raise failure if room_left <= 0

          wait_for = failure.retry_after || room_backoff(room_attempt)
          room_attempt += 1
          pause([room_left, wait_for].min, deadline, write, key, failure, cancel)
          next
        end
        header = Float(response["Retry-After"], exception: false)
        header = nil unless header&.positive?
        # The wait the server names, when it names one.
        named = failure.retry_after || header
        # Nothing ran: safe to send again for any call, past max_retries,
        # with growing waits, until the deadline; then this refusal stands.
        # A late answer's failure came after the work began, so only a
        # guest's own refusal (guest_busy, before anything is journaled)
        # still says nothing ran.
        if [429, 503].include?(status) && Error::NOTHING_RAN.include?(failure.code) &&
           failure.sent_retryable != false && (!late || failure.code == "guest_busy")
          raise failure if named && named > LONGEST_WAIT

          pause_for = [30.0, (named || 0.25) * (2**[idle_attempt, 3].min)].min * (0.9 + (rand * 0.2))
          idle_attempt += 1
          raise failure if pause_for >= deadline - now

          pause(pause_for, deadline, write, key, failure, cancel)
          next
        end
        # The answer says whether the same call may work again; an older
        # server that does not say is retried on 429, 502, 503 and 504. A
        # refusal for room or the account's own limit is the room wait's on a
        # create, wake, restart or fork; any other call retries what it says.
        again = if failure.sent_retryable.nil?
                  [429, 502, 503, 504].include?(status) && !Error::DELIBERATE.include?(failure.code)
                else
                  failure.sent_retryable
                end
        raise failure if no_retry || !again || (room && Error::WAITS_FOR_ROOM.include?(failure.code)) ||
                         attempt >= max_retries
        # A wait longer than a minute (a daily cap) is the caller's to
        # schedule: the error says when, in retry_after.
        raise failure if named && named > LONGEST_WAIT

        pause([30.0, named || backoff(attempt)].min * (0.9 + (rand * 0.2)), deadline, write, key, failure, cancel)
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
