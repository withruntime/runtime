# frozen_string_literal: true

module WithRuntime
  # Every failure the SDK raises. +code+ is stable and machine-readable, +hint+
  # says what to do next, and +request_id+ is what to quote in a report. The
  # subclasses name the class of failure, as in the JavaScript, Python, Go and
  # Java SDKs.
  class Error < StandardError
    # 503s that are a deliberate state, not a passing one: retrying cannot change them.
    DELIBERATE = %w[
      unavailable unsupported fork_unavailable previews_unavailable
      network_unavailable network_rules_unavailable secrets_unavailable identity_unavailable env_unavailable
    ].freeze
    # Refusals that pass on their own: a host frees room, a trial slot frees.
    PASSING = %w[no_capacity trial_busy].freeze
    # Refusals of a create that clear when a sandbox stops or a host frees room.
    WAITS_FOR_ROOM = %w[trial_busy trial_domain_limit trial_capacity quota_exceeded no_capacity volume_releasing].freeze

    attr_reader :code, :status, :hint, :request_id, :details, :idempotency_key, :retry_after

    def initialize(message, code:, status: 0, hint: nil, request_id: nil, details: nil, idempotency_key: nil, retry_after: nil)
      super(message)
      @code = code
      @status = status
      @hint = hint
      @request_id = request_id
      @details = details || {}
      @idempotency_key = idempotency_key
      @retry_after = retry_after
    end

    # Whether retrying this exact call, with the same idempotency key, is safe and may work.
    def retryable?
      return false if DELIBERATE.include?(code)
      return details["field"] != "count" if PASSING.include?(code)

      [0, 429, 502, 503, 504].include?(status)
    end

    def to_s
      text = +"#{super}"
      text << " Hint: #{hint}" if hint
      text << " Request: #{request_id}" if request_id
      text
    end

    # The API's one error shape, as the right subclass.
    def self.from(status, body, idempotency_key)
      error = body.is_a?(Hash) && body["error"].is_a?(Hash) ? body["error"] : {}
      retry_ms = error["retryAfterMs"]
      klass = case status
              when 401 then AuthenticationError
              when 403 then PermissionDeniedError
              when 404 then NotFoundError
              when 409 then ConflictError
              when 400, 413, 422 then InvalidRequestError
              when 429 then RateLimitError
              else status >= 500 ? ServiceUnavailableError : Error
              end
      klass.new(
        error["message"].is_a?(String) ? error["message"] : "Runtime request failed (#{status}).",
        code: error["code"].is_a?(String) ? error["code"] : "request_failed",
        status: status,
        hint: error["hint"],
        request_id: error["requestId"],
        details: error["details"].is_a?(Hash) ? error["details"] : nil,
        idempotency_key: idempotency_key,
        retry_after: retry_ms.is_a?(Numeric) ? retry_ms / 1000.0 : nil
      )
    end

    def self.missing_key
      AuthenticationError.new(
        "No Runtime key found: RUNTIME_API_KEY is not set and this machine is not connected.",
        code: "missing_api_key",
        hint: "Run `npx -y withruntime login` (a browser approval; nothing to copy), set RUNTIME_API_KEY to a key " \
              "from https://withruntime.com/account/keys, or pass api_key:."
      )
    end
  end

  class AuthenticationError < Error; end
  class PermissionDeniedError < Error; end
  class NotFoundError < Error; end
  class ConflictError < Error; end
  class InvalidRequestError < Error; end
  class RateLimitError < Error; end
  class ServiceUnavailableError < Error; end

  # No answer arrived (+connection_error+) or the call ran past its deadline
  # (+timeout+). A write may or may not have happened; retrying with the same
  # idempotency key settles it safely.
  class ConnectionError < Error; end

  # Raised by exec with +check: true+ when a command exits non-zero or times out.
  class CommandError < Error
    attr_reader :result

    def initialize(result)
      @result = result
      if result.timed_out
        super("Command timed out.", code: "command_timeout")
      else
        tail = result.stderr.strip
        tail = tail[-500..] if tail.length > 500
        super("Command exited with #{result.exit_code.inspect}.#{tail.empty? ? "" : " #{tail}"}", code: "command_failed")
      end
    end

    def exit_code = result.exit_code
    def stdout = result.stdout
    def stderr = result.stderr
  end

  # A webhook delivery that is not authentic or is too old.
  class WebhookVerificationError < StandardError; end
end
