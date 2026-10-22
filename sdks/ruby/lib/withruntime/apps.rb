# frozen_string_literal: true

require "securerandom"

module WithRuntime
  # A product built on the five verbs every resource shares (create, get,
  # list, update, delete) and following one to a state: the same rules as the
  # JavaScript SDK's resources.ts. One deadline covers a write, its retries
  # and every read after it.
  class ResourceProduct < Product
    # A whole wait's deadline and its pause between reads.
    class Following
      attr_reader :key

      def initialize(timeout, poll, key)
        @poll = poll
        @key = key
        @deadline = timeout.positive? ? now + timeout : nil
      end

      # Seconds left for a call, or nil when the wait has no deadline (the
      # client's own timeout then bounds each call).
      def left = @deadline && [@deadline - now, 0.001].max

      def expired? = !@deadline.nil? && now >= @deadline

      def pause
        sleep(@deadline ? [@poll, [@deadline - now, 0].max].min : @poll)
        raise timed_out if expired?
      end

      def timed_out
        ConnectionError.new("Waiting was cancelled or reached its deadline; the resource may still change.",
                            code: "timeout", idempotency_key: key,
                            hint: "Read the resource to resume waiting. Retry a write with the same idempotency_key.")
      end

      private

      def now = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    end

    # +path+ is the product's path (/v1/apps); a wait ends at its target or at
    # any of +settled+, which raises the resource's own error.
    def initialize(transport, path, settled)
      super(transport)
      @base = path
      @settled = settled
    end

    # Creates one; defaults belong to the API, so the SDK sends none.
    def create(idempotency_key: nil, **fields)
      Record.new(@t.json("POST", @base, body: Fields.body(fields), key: idempotency_key))
    end

    # With +wait_for:+ the API holds the answer until that state or
    # +timeout_seconds+ (1 to 60; 30 by default) pass. Check the state it returns.
    def get(id, wait_for: nil, timeout_seconds: nil)
      read(id, { "waitFor" => wait_for, "timeoutSeconds" => timeout_seconds },
           wait_for && ((timeout_seconds || 30) + 60))
    end

    # +label:+ is key:value filters that all must match; +state:+ defaults to
    # the product's live states; +limit:+ 1 to 100 (50).
    def list(name: nil, label: nil, state: nil, limit: nil, cursor: nil)
      page(@base, { "name" => name, "label" => label, "state" => state, "limit" => limit, "cursor" => cursor })
    end

    # Fields left out stay as they are; +name: :remove+ clears the name.
    def update(id, idempotency_key: nil, **changes)
      Record.new(@t.json("POST", "#{@base}/#{seg(id)}:update", body: patch(changes), key: idempotency_key))
    end

    # Follows the resource's state to +target+, reading it every +poll+
    # seconds (0.25) for at most +timeout+ seconds in all (300; 0 waits as long
    # as it takes). Raises the resource's error when it settles elsewhere, and
    # ConnectionError with code timeout at the deadline.
    def wait(id, target, timeout: 300, poll: 0.25)
      following(timeout, poll, nil) { |wait| follow(id, target, wait) }
    end

    # Deletes it. With +wait: true+, follows it to deleted under one
    # idempotency key made before the first try, so a timed-out delete can be
    # retried after a restart with the key its error carries.
    def delete(id, wait: false, timeout: 300, poll: 0.25, idempotency_key: nil)
      return remove(id, idempotency_key, nil) unless wait

      key = idempotency_key || SecureRandom.uuid
      following(timeout, poll, key) { |follow| follow(id, "deleted", follow, remove(id, key, follow.left)) }
    end

    private

    def read(id, query = nil, timeout = nil)
      Record.new(@t.json("GET", "#{@base}/#{seg(id)}", query: query, timeout: timeout))
    end

    def remove(id, key, timeout) = Record.new(@t.json("DELETE", "#{@base}/#{seg(id)}", key: key, timeout: timeout))

    def follow(id, target, wait, initial = nil)
      record = initial || read(id, nil, wait.left)
      loop do
        return record if record.state == target
        if @settled.include?(record.state)
          error = record["error"].is_a?(Hash) ? record["error"] : {}
          raise Error.new(error["message"] || "Expected #{target}, but #{id} reached #{record.state}.",
                          code: error["code"] || "unexpected_state", idempotency_key: wait.key,
                          hint: "Read the resource and inspect its error before starting another change.",
                          details: { "id" => id, "state" => record.state, "target" => target, "resource" => record.to_h })
        end
        wait.pause
        record = read(id, nil, wait.left)
      end
    end

    # One deadline covers the write, retries and every read. A read's failure
    # still belongs to the write that started the wait, so it carries its key.
    def following(timeout, poll, key)
      check(timeout, "timeout")
      check(poll, "poll")
      wait = Following.new(timeout, poll, key)
      begin
        result = yield wait
        raise wait.timed_out if wait.expired?

        result
      rescue Error => e
        raise wait.timed_out if wait.expired?
        raise e if key.nil? || e.idempotency_key

        raise e.class.new(e.message, code: e.code, status: e.status, hint: e.hint, request_id: e.request_id,
                                     details: e.details, idempotency_key: key, retry_after: e.retry_after)
      end
    end

    def check(value, field)
      return if value.is_a?(Numeric) && value.finite? && !value.negative?

      raise Error.new("#{field} must be a finite, nonnegative number.", code: "invalid_request",
                                                                        hint: "Fix the option and call again; nothing was sent.",
                                                                        details: { "field" => field })
    end
  end

  # +runtime.apps+ and +runtime.functions+: your server, deployed from an
  # image or a build, kept running in copies (an App keeps +min_copies+ awake;
  # a Function sleeps to zero). In a private beta: an account outside it is
  # refused with product_in_beta (403, PermissionDeniedError).
  #
  #   app = runtime.apps.create(name: "web", max_copies: 3, vcpu: 1, memory_mib: 1024)
  #   deploy = runtime.apps.deploy(app.id, image: "web:latest", env: { "MODE" => "prod" }, wait: true)
  #   puts deploy.url
  #
  # An App or Function: id, name, url (its address for life, its name then
  # its account's: https://shop-3f9a1c2e7b04d915-acme1.runtimehost.com/; a rename leaves it,
  # and its id's address answers too), labels, state (waiting, live, failed,
  # deleting, deleted), min_copies, max_copies, concurrency, spares, vcpu,
  # memory_mib, port, health_path, cdn, live_version, previous_version, error
  # ({code, message} or nil), line (while a copy waits for room: lane,
  # place, ahead by lane and words; nil otherwise), created_at, updated_at,
  # deleted_at, and release_watch (alert, the default; rollback; or off). A Function
  # also has sleep_after_ms (250 to 5000).
  #
  # A deploy: id, version, url and state (building, warming, switching, live,
  # failed, superseded); a failed or superseded one has error with code
  # (deploy_build_failed, deploy_health_failed, deploy_stop_failed,
  # deploy_switch_failed, deploy_superseded), message, hint and last_output. A version: version,
  # live, previous, saved, deploy (its deploy's id) and build (nil for an
  # image). A copy: id, version,
  # region, state (starting, serving, draining, frozen, parked) and since.
  class Apps < ResourceProduct
    DEPLOY_ENDED = %w[live failed superseded].freeze
    # Reconnections in a row with no new line before a log follow gives up.
    LOG_RECONNECTS = 3
    LOG_SEEN = 10_000

    # +path+: /v1/apps or /v1/functions.
    def initialize(transport, path = "/v1/apps")
      super(transport, path, %w[failed deleted live])
    end

    # Creates one waiting for its first version: +max_copies:+ (1 to 1000),
    # +vcpu:+ (1 to 16) and +memory_mib:+ (128 to 65536) are required;
    # +concurrency:+, +spares:+, +port:+ (8080), +health_path:+, +cdn:+ (true: Cloudflare's CDN in
    # front of its addresses; false sends visitors straight to Runtime's routers,
    # nothing cached), +name:+, +labels:+, +release_watch:+ ("alert" by default: tell the
    # owners when a new version gets clearly worse in its first 15 minutes; "rollback" also
    # goes back to the previous version; "off" does neither), and for an App
    # +min_copies:+ (0). A Function leaves +min_copies+ out, zero included.
    # A Function also takes +sleep_after_ms:+ (250 to 5000, default 1000): at
    # most how long a copy stays awake after its last request ends; awake time
    # with no request in flight is not billed. An App is refused it.
    def create(idempotency_key: nil, **fields) = super

    # Follows resource state, not a deploy: an older live version can survive
    # a failed rollout of a newer one. +target+ is "live" or "deleted".
    def wait(id, target, timeout: 300, poll: 0.25) = super

    # Deploys a new version from +image:+ (an image of this account: id,
    # name, name:tag or name@version, ready) or +build:+ (a build's id), with
    # +env:+, +port:+ and +health_path:+. +keep_env: true+ carries the last
    # deploy's environment, still sealed, with +env:+'s names set over it.
    # With +wait: true+, follows the deploy, under one idempotency key, until
    # it is live, failed or superseded, and returns it (check its state).
    def deploy(id, image: nil, build: nil, env: nil, keep_env: nil, port: nil, health_path: nil, wait: false,
               timeout: 300, poll: 0.25, idempotency_key: nil)
      unless image.nil? ^ build.nil?
        raise ArgumentError, "Deploy exactly one of image: or build:; nothing was sent."
      end

      body = Fields.body(image: image, build: build, env: env, keep_env: keep_env, port: port, health_path: health_path)
      write_deploy(id, "deploys", body, wait, timeout, poll, idempotency_key)
    end

    # A deploy, by the App's id and its own. With +wait_for:+ the API holds
    # the answer until that state or +timeout_seconds+ pass.
    def get_deploy(id, deploy_id, wait_for: nil, timeout_seconds: nil)
      read_deploy(id, deploy_id, wait_for, timeout_seconds, wait_for && ((timeout_seconds || 30) + 60))
    end

    # Resumes following a deploy by id after a restart, without making another version.
    def wait_deploy(id, deploy_id, timeout: 300, poll: 0.25)
      following(timeout, poll, nil) do |wait|
        follow_deploy(id, read_deploy(id, deploy_id, nil, nil, wait.left), wait)
      end
    end

    # Goes back to the previous version, as a new deploy; +wait: true+ as for +deploy+.
    def rollback(id, wait: false, timeout: 300, poll: 0.25, idempotency_key: nil)
      write_deploy(id, "rollback", {}, wait, timeout, poll, idempotency_key)
    end

    def versions(id) = @t.json("GET", "#{@base}/#{seg(id)}/versions").map { |version| Record.new(version) }

    def copies(id) = @t.json("GET", "#{@base}/#{seg(id)}/copies").map { |copy| Record.new(copy) }

    # What its copies printed: lines (at, Unix milliseconds; stream, stdout
    # or stderr; copy, a copy's id or nil; version or nil; text), oldest
    # first, the newest +limit:+ (1 to 500; 100) in the window, with
    # next_cursor and has_more. +since:+ is an RFC 3339 time or a duration
    # back from now ("30s", "15m", "2h", "7d"; "1h" by default; 14 days at
    # most). +version:+, +copy:+ and +stream:+ narrow it. Pass next_cursor as
    # +cursor:+, with the same filters, for the page of older lines.
    def logs(id, since: nil, version: nil, copy: nil, stream: nil, limit: nil, cursor: nil)
      Record.new(@t.json("GET", "#{@base}/#{seg(id)}/logs", query: log_query(since, version, copy, stream, limit, cursor)))
    end

    # Each event to the block as its copies print (or an Enumerator without
    # one), until the caller breaks out: a line (type "line", cursor, and a
    # line's fields as for +logs+) or a gap where the store dropped lines
    # (type "gap"); the stream goes on after it. A first follow sends the
    # newest +limit:+ lines since +since:+, then new ones; +cursor:+ resumes
    # after that line. Each follow the API ends after about two minutes is
    # resumed from its cursor; a lost connection reconnects from the last
    # line, up to three times in a row, then app_log_interrupted, whose details
    # cursor resumes. An error event raises its own code and hint.
    def follow_logs(id, since: nil, version: nil, copy: nil, stream: nil, limit: nil, cursor: nil, &block)
      unless block
        return enum_for(:follow_logs, id, since: since, version: version, copy: copy, stream: stream, limit: limit,
                                          cursor: cursor)
      end

      follow_lines(id, log_query(since, version, copy, stream, limit, nil), cursor, &block)
      nil
    end

    private

    def log_query(since, version, copy, stream, limit, cursor)
      { "since" => since, "version" => version, "copy" => copy, "stream" => stream, "limit" => limit, "cursor" => cursor }
    end

    def log_invalid(cursor) = failure("app_log_invalid", "Retry the log from the last received cursor.", cursor)

    def valid_log_line?(event)
      event["text"].is_a?(String) && %w[stdout stderr].include?(event["stream"]) && valid_cursor?(event["cursor"]) &&
        safe_integer?(event["at"]) && !event["at"].negative? && (event["copy"].nil? || event["copy"].is_a?(String)) &&
        (event["version"].nil? || safe_integer?(event["version"]))
    end

    # Cursors are opaque positions: they cannot be ordered or counted on, so
    # lines already given are known by their cursor.
    def follow_lines(id, filters, cursor)
      if cursor && !valid_cursor?(cursor)
        raise failure("invalid_log_options", "Use the opaque cursor of a line or a continue event to resume.", cursor)
      end

      seen = cursor ? { cursor => true } : {}
      failures = 0
      loop do
        continued = false
        begin
          # The API ends each follow after about two minutes, with a continue event.
          @t.events("GET", "#{@base}/#{seg(id)}/logs", query: { "follow" => true }.merge(filters, { "cursor" => cursor }),
                                                       timeout: 180) do |event|
            raise log_invalid(cursor) unless event.is_a?(Hash)

            case event["type"]
            when "line"
              raise log_invalid(cursor) unless valid_log_line?(event)
              next if seen.key?(event["cursor"])

              seen[event["cursor"]] = true
              seen.delete(seen.first[0]) if seen.size > LOG_SEEN
              cursor = event["cursor"]
              failures = 0
              yield Record.new(event)
            when "gap"
              raise log_invalid(cursor) unless valid_cursor?(event["cursor"])

              cursor = event["cursor"]
              yield Record.new(event)
            when "continue"
              raise log_invalid(cursor) unless event["cursor"].nil? || valid_cursor?(event["cursor"])

              cursor = event["cursor"] || cursor
              continued = true
              break
            when "error"
              unless event["code"].is_a?(String) && !event["code"].empty? && event["hint"].is_a?(String) && !event["hint"].empty?
                raise log_invalid(cursor)
              end

              raise failure(event["code"], event["hint"], cursor)
            else
              raise log_invalid(cursor)
            end
          end
        rescue ConnectionError
          nil # A lost connection, not a refusal: the transport retries retryable answers. Reconnect from the last line.
        rescue Error => e
          raise e unless e.code == "unexpected_answer" && e.status.zero?

          raise failure("app_log_invalid", "The log contained invalid JSON; retry from details.cursor.", cursor)
        end
        failures += 1 unless continued
        if failures > LOG_RECONNECTS
          raise failure("app_log_interrupted", "Reconnect with follow_logs(id, cursor: details[\"cursor\"]).", cursor)
        end

        # A service that is down, or continuations one after another, never busy-loop.
        sleep(0.05 * [1, failures].max)
      end
    end

    def read_deploy(id, deploy_id, wait_for, timeout_seconds, timeout)
      Record.new(@t.json("GET", "#{@base}/#{seg(id)}/deploys/#{seg(deploy_id)}",
                         query: { "waitFor" => wait_for, "timeoutSeconds" => timeout_seconds }, timeout: timeout))
    end

    def follow_deploy(id, record, wait)
      until DEPLOY_ENDED.include?(record.state)
        record = read_deploy(id, record.id, "live", 60, wait.left)
        wait.pause unless DEPLOY_ENDED.include?(record.state)
      end
      record
    end

    def write_deploy(id, verb, body, wait, timeout, poll, idempotency_key)
      write = ->(key, left) { Record.new(@t.json("POST", "#{@base}/#{seg(id)}/#{verb}", body: body, key: key, timeout: left)) }
      return write.call(idempotency_key, nil) unless wait

      key = idempotency_key || SecureRandom.uuid
      following(timeout, poll, key) { |follow| follow_deploy(id, write.call(key, follow.left), follow) }
    end
  end
end
