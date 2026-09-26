# frozen_string_literal: true

module WithRuntime
  DEFAULT_BASE_URL = "https://api.withruntime.com"

  # One client for every Runtime Cloud product. Make it once and share it: it
  # is safe for use from many threads and keeps its connections open.
  #
  #   runtime = WithRuntime::Client.new # RUNTIME_API_KEY, or this machine's saved connection
  #   sbx = runtime.sandboxes.create(funding: "trial")
  #   puts sbx.exec("python3 -c 'print(6 * 7)'", check: true).stdout
  #   sbx.stop
  #
  # Every product is +runtime.<product>.<verb>+. Money is integer microdollars
  # (1,000,000 is one US dollar).
  class Client
    attr_reader :transport, :sandboxes, :snapshots, :images, :volumes, :secrets, :limits, :referrals,
                :switching, :events, :webhooks, :otel, :audit, :feedback, :support, :domains, :ports, :addresses, :tunnel, :sso, :mcp

    # +api_key+: default RUNTIME_API_KEY, then this machine's saved connection.
    # +base_url+: default RUNTIME_API_URL, then https://api.withruntime.com.
    # +timeout+: seconds for each call, retries included (300).
    # +max_retries+: of transport failures, 429, 502, 503 and 504 (4).
    # +max_connections+: calls in flight at once; streams do not count (32).
    # +wait_for_capacity+: seconds a sandbox create keeps retrying, with the
    # same key and input, when the trial, quota or region is full (120; 0 fails at once).
    def initialize(api_key: nil, base_url: nil, timeout: 300, max_retries: 4, max_connections: 32,
                   wait_for_capacity: 120, env: ENV)
      origin = Credentials.origin(base_url || env["RUNTIME_API_URL"].then { |url| url.nil? || url.empty? ? DEFAULT_BASE_URL : url })
      key = api_key
      key ||= env["RUNTIME_API_KEY"] unless env["RUNTIME_API_KEY"].to_s.empty?
      key ||= Credentials.saved_key(env, origin)
      raise Error.missing_key if key.nil? || key.empty?
      raise ArgumentError, "The Runtime API key contains whitespace." if key.match?(/\s/)
      raise ArgumentError, "max_retries cannot be negative." if max_retries.negative?

      @transport = Transport.new(api_key: key, base_url: origin, timeout: timeout, max_retries: max_retries,
                                 max_connections: max_connections, wait_for_capacity: [0, wait_for_capacity].max)
      @sandboxes = Sandboxes.new(@transport)
      @snapshots = Snapshots.new(@transport)
      @images = Images.new(@transport)
      @volumes = Volumes.new(@transport)
      @secrets = Secrets.new(@transport)
      @limits = Limits.new(@transport)
      @referrals = Referrals.new(@transport)
      @switching = Switching.new(@transport)
      @events = Events.new(@transport)
      @webhooks = Webhooks.new(@transport)
      @otel = Otel.new(@transport)
      @audit = Audit.new(@transport)
      @feedback = Feedback.new(@transport)
      @support = Support.new(@transport)
      @domains = Domains.new(@transport)
      @ports = Ports.new(@transport)
      @addresses = Addresses.new(@transport)
      @tunnel = PrivateTunnel.new(@transport)
      @sso = SSO.new(@transport)
      @mcp = MCP.new(@transport)
    end

    def base_url = @transport.base_url

    # Who this key is: organization, agent and credential.
    def me = Record.new(@transport.json("GET", "/v1/me"))

    # The account's credit, holds, trial time and per-resource charges.
    def usage = Record.new(@transport.json("GET", "/v1/usage"))

    # Calls any API path with this client's key, retries, idempotency keys and
    # errors, and returns the parsed JSON answer. For an endpoint newer than this SDK.
    def request(method, path, query: nil, body: nil)
      raise ArgumentError, "The path must start with /." unless path.start_with?("/")

      method = method.to_s.upcase
      body = {} if body.nil? && !%w[GET DELETE].include?(method)
      @transport.json(method, path, query: query, body: body)
    end
  end
end
