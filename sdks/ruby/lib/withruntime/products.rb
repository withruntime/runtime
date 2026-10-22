# frozen_string_literal: true

require "openssl"

module WithRuntime
  # The pieces every product shares.
  class Product
    SAFE_INTEGER = (2**53) - 1

    def initialize(transport)
      @t = transport
    end

    private

    def seg(value) = Transport.segment(value)

    # A followed log's refusal, with the cursor it resumes from in its details.
    def failure(code, hint, cursor) = Error.new(hint, code: code, hint: hint, details: { "cursor" => cursor })

    # A log cursor is opaque: a short string with no control characters.
    def valid_cursor?(value)
      value.is_a?(String) && !value.empty? && value.length <= 4096 && !value.match?(/[\x00-\x1f\x7f]/)
    end

    def safe_integer?(value) = value.is_a?(Integer) && value.abs <= SAFE_INTEGER

    # A change's body from keyword arguments: nil is left out, +:remove+ sends
    # null, which clears the field.
    def patch(changes)
      body = Fields.body(changes.reject { |_key, value| value == :remove })
      changes.each { |key, value| body[key.is_a?(Symbol) ? Fields.camel(key) : key.to_s] = nil if value == :remove }
      body
    end

    def page(path, query)
      body = @t.json("GET", path, query: query)
      Page.new(body["data"].map { |item| Record.new(item) }, body["nextCursor"]) do |cursor|
        page(path, query.merge("cursor" => cursor))
      end
    end
  end

  # +runtime.snapshots+. Take one with +sbx.snapshot+, start from one with
  # +runtime.sandboxes.create(snapshot: id)+, or do both with +sbx.fork+.
  class Snapshots < Product
    # Snapshots a sandbox by id, as it is: the API answers how the sandbox must be.
    def create(sandbox_id, name: nil, labels: nil, retention_days: nil, idempotency_key: nil)
      body = Fields.body(name: name, labels: labels, retention_days: retention_days)
      Record.new(@t.json("POST", "/v1/sandboxes/#{seg(sandbox_id)}:snapshot", body: body, wait: 10, key: idempotency_key))
    end

    def get(id) = Record.new(@t.json("GET", "/v1/snapshots/#{seg(id)}"))

    # state: capturing, ready, failed or deleting.
    def list(sandbox_id: nil, name: nil, state: nil, limit: nil)
      page("/v1/snapshots", { "sandboxId" => sandbox_id, "name" => name, "state" => state, "limit" => limit })
    end

    def delete(id)
      @t.json("POST", "/v1/snapshots/#{seg(id)}:delete", body: {})
      nil
    end

    # Keeps a snapshot for +retention_days+ from now.
    def extend_retention(id, retention_days)
      Record.new(@t.json("POST", "/v1/snapshots/#{seg(id)}:extend", body: { "retentionDays" => retention_days }))
    end
  end

  # +runtime.volumes+: persistent disks. Create one, then attach it when
  # creating a sandbox: +volumes: [{ volume_id: v.id, path: "/data" }]+. A
  # volume lives on one host; its backups can restore onto another host.
  class Volumes < Product
    # Creates a volume and waits (up to 10 seconds) until it is ready.
    def create(size_mib: nil, name: nil, labels: nil, region: nil, from_backup: nil, idempotency_key: nil)
      body = Fields.body(size_mib: size_mib, name: name, labels: labels, region: region, from_backup: from_backup)
      Record.new(@t.json("POST", "/v1/volumes", body: body, wait: 10, key: idempotency_key))
    end

    def backup(id, name: nil, labels: nil, retention_days: nil, wait: 60, idempotency_key: nil)
      Record.new(@t.json("POST", "/v1/volumes/#{seg(id)}:backup", body: Fields.body(name: name, labels: labels, retention_days: retention_days), wait: wait, key: idempotency_key))
    end
    def set_backup_policy(id, daily: nil, retention_days: nil) = Record.new(@t.json("POST", "/v1/volumes/#{seg(id)}:backup-policy", body: Fields.body(daily: daily, retention_days: retention_days)))
    def backups(volume_id: nil, state: nil, limit: nil) = page("/v1/volume-backups", { "volumeId" => volume_id, "state" => state, "limit" => limit })
    def get_backup(id) = Record.new(@t.json("GET", "/v1/volume-backups/#{seg(id)}"))
    def delete_backup(id) = Record.new(@t.json("POST", "/v1/volume-backups/#{seg(id)}:delete", body: {}))
    def restore(id, **options) = create(**options.merge(from_backup: id))

    def get(id) = Record.new(@t.json("GET", "/v1/volumes/#{seg(id)}"))

    def list(state: nil, name: nil, limit: nil) = page("/v1/volumes", { "state" => state, "name" => name, "limit" => limit })

    # Grows a volume no sandbox holds to +size_mib+, on its host, and waits
    # (up to +wait+ seconds) for it. The answer's +resize+ shows how far it got.
    def resize(id, size_mib:, wait: 10, idempotency_key: nil)
      Record.new(@t.json("POST", "/v1/volumes/#{seg(id)}:resize", body: Fields.body(size_mib: size_mib), wait: wait, key: idempotency_key))
    end

    # Deletes a volume and everything on it.
    def delete(id) = Record.new(@t.json("POST", "/v1/volumes/#{seg(id)}:delete", body: {}))
  end

  # +runtime.secrets+: a value your sandboxes use without seeing it. Every
  # sandbox of the organization has an environment variable of the secret's
  # name holding a placeholder; the egress proxy puts the value into HTTPS
  # requests to its hosts. The value is never returned.
  class Secrets < Product
    # Stores or replaces a secret for +hosts+ ("api.openai.com", "*.github.com").
    # With +header:+, that header is set on every request to them, +format:+'s
    # {value} replaced.
    #
    # +rules:+ limits the value to the requests a rule allows, such as
    # [{ "methods" => ["GET"], "paths" => ["/repos/acme/*"] }]. +only:+ gives it to
    # those sandboxes alone ({ "labels" => [{ "role" => "hub" }], "sandboxes" => [ids],
    # "apps" => [App ids] }; left out when replacing, the scope it has stays; {} is every
    # sandbox again). +github_app:+ ({ "id" =>, "installation" =>,
    # "repositories" =>, "permissions" =>, "api" => }) makes +value+ a GitHub App's
    # private key (PEM); the servers make its installation tokens themselves, and the
    # secret takes no +header:+ or +format:+. +git:+ ({ "push" => [branch patterns] };
    # an empty list is no push at all) limits what a git push may update. +api:+
    # ({ "callsPerHour" =>, "writesPerHour" =>, "keep" =>, "copies" =>, "fresh" =>,
    # "graphql" => { "path" =>, "mutations" => [] } }) sets each sandbox's hour with the
    # secret, the far end's reserve, GraphQL's mutations and shared copies. The answer
    # and +list+ return them as +githubApp+, +git+ and +api+. +env:+ is the environment
    # variable sandboxes see it in, when not the secret's name. Secrets scoped to different
    # sandboxes may share one, such as one GITHUB_TOKEN per repository; a write that would
    # put two in one sandbox is refused (409). Absent when replacing: the variable it has stays.
    def set(name, value:, hosts:, header: nil, format: nil, rules: nil, only: nil, github_app: nil, git: nil,
            api: nil, env: nil)
      body = { "value" => value, "hosts" => hosts, "header" => header, "format" => format, "rules" => rules,
               "only" => only, "githubApp" => github_app, "git" => git, "api" => api, "env" => env }.compact
      Record.new(@t.json("PUT", "/v1/egress-secrets/#{seg(name)}", body: body))
    end

    # Changes which sandboxes get a secret, without its value: +{}+ is every sandbox of the
    # organization again. Returns the secret, with +only+ and +enforced+.
    def scope(name, only)
      Record.new(@t.json("PUT", "/v1/egress-secrets/#{seg(name)}/sandboxes", body: only))
    end

    # Narrows +hosts:+ and/or +rules:+ without the value; only strictly narrower
    # ones are accepted. Widening needs the value: call +set+ again with it.
    def narrow(name, hosts: nil, rules: nil)
      body = { "hosts" => hosts, "rules" => rules }.compact
      Record.new(@t.json("PUT", "/v1/egress-secrets/#{seg(name)}/rules", body: body))
    end

    # Names, hosts and placeholders. Never values.
    def list = @t.json("GET", "/v1/egress-secrets")["secrets"].map { |secret| Record.new(secret) }

    # Erases a secret; its placeholder stops working.
    def delete(name)
      @t.json("DELETE", "/v1/egress-secrets/#{seg(name)}")
      nil
    end
  end

  # +runtime.limits+: whether this key is read-only, and what its agent may still spend today, plus +account+: the account's limits (limit, label, unit, max, used), or nil.
  class Limits < Product
    def get = Record.new(@t.json("GET", "/v1/limits"))
  end

  # +runtime.referrals+: the account's referral link and what it earned. Money is
  # integer microdollars in strings.
  class Referrals < Product
    def get = Record.new(@t.json("GET", "/v1/referrals"))
  end

  # +runtime.emails+: which of Runtime's optional emails this key's person gets
  # for this account: own-deletions (warnings for dates the account's own
  # retention set), billing, usage and tips. Sign-in, support replies, credit
  # expiry and deletions Runtime decides are always sent and are not listed.
  class Emails < Product
    def get = @t.json("GET", "/v1/account/emails")["settings"].map { |row| Record.new(row) }

    # Turns one on or off for this key's person only, and answers all of them.
    # Needs a key for every action.
    def set(category, enabled)
      body = { "category" => category, "enabled" => enabled }
      @t.json("POST", "/v1/account/emails:update", body: body)["settings"].map { |row| Record.new(row) }
    end
  end

  # +runtime.plans+: monthly plans whose fee is prepaid usage. The fee comes back as plan usage, spent first
  # each month at the same measured prices, plus a bonus for committing; plan usage left at the period's end
  # ends with it. Money is integer microdollars in strings.
  #
  # Every change answers +checkout_url+ (where a person starts a first plan or a trial in the browser, nil
  # once the change was made) and +current+ (the plan as it is now). Each takes an +idempotency_key+; one is
  # made per call when left out.
  class Plans < Product
    # +current+ (the plan you hold, or nil: plan_id, name, status, interval, period_start, period_end,
    # trial_ends_at, cancel_at_period_end, next_plan_id, started_at, add_ons, auto_upgrade, plan_usage) and
    # +plans+ (every plan you may choose: id, name, card, fee_micros, yearly_fee_micros, bonus_micros,
    # trial_days, first_period_double, support, collection, contract, position, included, limits, features,
    # add_ons).
    def list = Record.new(@t.json("GET", "/v1/plans"))

    # Start a plan, or move to another. With no plan, answers +checkout_url+. A dearer plan starts at once,
    # prorated; a cheaper one at +period_end+ (+next_plan_id+). +interval: "year"+ pays ten months for
    # twelve; monthly unless asked.
    def choose(plan, interval: nil, idempotency_key: nil)
      body = { "plan" => plan }
      body["interval"] = interval unless interval.nil?
      Record.new(@t.json("POST", "/v1/plans/choose", body: body, key: idempotency_key))
    end

    # End the plan at +period_end+.
    def cancel(idempotency_key: nil) = Record.new(@t.json("POST", "/v1/plans/cancel", body: {}, key: idempotency_key))

    # Keep a plan you cancelled, before +period_end+.
    def resume(idempotency_key: nil) = Record.new(@t.json("POST", "/v1/plans/resume", body: {}, key: idempotency_key))

    # Add an add-on by id: charged now for the rest of the period, prorated, then with the plan.
    def add_on(id, idempotency_key: nil)
      Record.new(@t.json("POST", "/v1/plans/add-ons", body: { "addOn" => id }, key: idempotency_key))
    end

    # Remove an add-on: its charge stops now, and it holds to +period_end+.
    def remove_add_on(id, idempotency_key: nil)
      Record.new(@t.json("DELETE", "/v1/plans/add-ons/#{seg(id)}", key: idempotency_key))
    end

    # Move up a plan by itself when a limit refuses (true), or not. Owners, and keys an owner made.
    def auto_upgrade(on, idempotency_key: nil)
      Record.new(@t.json("PUT", "/v1/plans/auto-upgrade", body: { "on" => on }, key: idempotency_key))
    end
  end

  # +runtime.switching+: compare usage with a rival's published rates, and record a switch.
  class Switching < Product
    # Your settled usage over the last +days+ (30 by default, at most 90) priced
    # on Runtime and at +provider+ (e2b, daytona, vercel, modal, cloudflare, fly, fly-machines).
    def compare(provider, days: nil) = Record.new(@t.json("GET", "/v1/usage/compare", query: { "provider" => provider, "days" => days }))

    def get = Record.new(@t.json("GET", "/v1/switching"))

    # Once per organization, before its first top-up.
    def record(provider) = Record.new(@t.json("POST", "/v1/switching", body: { "provider" => provider }))
  end

  # +runtime.events+: lifecycle events, newest first.
  class Events < Product
    def list(resource_id: nil, type: nil, limit: nil)
      page("/v1/events", { "resourceId" => resource_id, "type" => type, "limit" => limit })
    end
  end

  # +runtime.webhooks+: signed lifecycle events POSTed to your URL.
  class Webhooks < Product
    # Returns the webhook with its +secret+, shown this once. +events+ nil is every event.
    def create(url:, events: nil, description: nil)
      Record.new(@t.json("POST", "/v1/webhooks", body: { "url" => url, "events" => events, "description" => description }.compact))
    end

    def list = @t.json("GET", "/v1/webhooks")["data"].map { |hook| Record.new(hook) }

    def get(id) = Record.new(@t.json("GET", "/v1/webhooks/#{seg(id)}"))

    # Changes url, events, description or enabled; fields left out stay as they are.
    def update(id, **patch) = Record.new(@t.json("POST", "/v1/webhooks/#{seg(id)}:update", body: Fields.body(patch)))

    # A new secret, returned once. The old one keeps signing for
    # +keep_previous_seconds+ (a day by default, a week at most; 0 ends it now).
    def rotate_secret(id, keep_previous_seconds: nil)
      body = { "keepPreviousSeconds" => keep_previous_seconds }.compact
      Record.new(@t.json("POST", "/v1/webhooks/#{seg(id)}:rotate-secret", body: body))
    end

    def delete(id)
      @t.json("POST", "/v1/webhooks/#{seg(id)}:delete", body: {})
      nil
    end

    # Sends a signed webhook.test now and says how your endpoint answered.
    def test(id) = Record.new(@t.json("POST", "/v1/webhooks/#{seg(id)}:test", body: {}, wait: 10))

    # state: pending, succeeded, failed or cancelled.
    def deliveries(id, state: nil) = page("/v1/webhooks/#{seg(id)}/deliveries", { "state" => state })

    # Sends one delivery again, once, now.
    def retry(delivery_id) = Record.new(@t.json("POST", "/v1/webhook-deliveries/#{seg(delivery_id)}:retry", body: {}))

    # Checks a delivery's Runtime-Signature header against the raw body and
    # your secret (or secrets, during a rotation), and returns the event.
    # Raises WebhookVerificationError when the signature does not match or is
    # older than +tolerance+ seconds (300), which stops a captured delivery
    # being replayed. Pass the body exactly as received.
    def self.verify(body, header, secret, tolerance: 300, now: Time.now.to_i)
      raise WebhookVerificationError, "Missing Runtime-Signature header." if header.nil? || header.empty?

      parts = header.split(",").map { |part| part.strip.split("=", 2) }
      stamp = parts.find { |key, _| key == "t" }&.last
      given = parts.select { |key, value| key == "v1" && value && !value.empty? }.map(&:last)
      raise WebhookVerificationError, "Malformed Runtime-Signature header." unless stamp&.match?(/\A\d+\z/) && !given.empty?
      raise WebhookVerificationError, "The signature is too old; the delivery may be a replay." if (now - stamp.to_i).abs > tolerance

      Array(secret).each do |key|
        expected = OpenSSL::HMAC.hexdigest("SHA256", key, "#{stamp}.#{body}")
        next unless given.any? { |value| value.bytesize == expected.bytesize && OpenSSL.fixed_length_secure_compare(value, expected) }

        begin
          return Record.new(JSON.parse(body))
        rescue JSON::ParserError
          raise WebhookVerificationError, "The body is not JSON."
        end
      end
      raise WebhookVerificationError, "No signature matches the secret."
    end
  end

  # +runtime.otel+: events (as logs) and CPU and memory (as metrics) pushed to
  # an OpenTelemetry endpoint over OTLP/HTTP.
  class Otel < Product
    # +headers+ authenticate to the endpoint and are never shown back.
    def create(endpoint:, headers: nil, signals: nil)
      Record.new(@t.json("POST", "/v1/otel-exports", body: { "endpoint" => endpoint, "headers" => headers, "signals" => signals }.compact))
    end

    def list = @t.json("GET", "/v1/otel-exports")["data"].map { |export| Record.new(export) }
    def get(id) = Record.new(@t.json("GET", "/v1/otel-exports/#{seg(id)}"))
    def update(id, **patch) = Record.new(@t.json("POST", "/v1/otel-exports/#{seg(id)}:update", body: Fields.body(patch)))

    # Pushes now instead of at the next interval.
    def flush(id) = Record.new(@t.json("POST", "/v1/otel-exports/#{seg(id)}:flush", body: {}))

    def delete(id)
      @t.json("POST", "/v1/otel-exports/#{seg(id)}:delete", body: {})
      nil
    end
  end

  # +runtime.audit+: the account's audit log, newest first.
  class Audit < Product
    # +events+ and +next+ (pass it as +before:+). +action:+ is an action
    # (key.created) or a group ending in a dot (member.).
    def list(action: nil, limit: nil, before: nil)
      Record.new(@t.json("GET", "/v1/audit", query: { "action" => action, "limit" => limit, "before" => before }))
    end
  end

  # +runtime.feedback+: tell the Runtime team something.
  class Feedback < Product
    # +kind+ is bug, missing_feature, competitor_gap, migration_blocker, docs, pricing, praise or other.
    def submit(kind:, summary:, detail: nil, competitor: nil, resource_id: nil, request_id: nil, context: nil)
      body = Fields.body(kind: kind, summary: summary, detail: detail, competitor: competitor,
                         resource_id: resource_id, request_id: request_id, context: context)
      Record.new(@t.json("POST", "/v1/feedback", body: body))
    end

    # This account's reports and where each stands.
    def list(limit: nil) = @t.json("GET", "/v1/feedback", query: { "limit" => limit })["data"].map { |item| Record.new(item) }
  end

  # +runtime.support+: ask Runtime support.
  class Support < Product
    # When the status is "working", +read+ it again in a minute. Not retried:
    # support cannot deduplicate a message.
    def message(message = nil, conversation_id: nil, approve_action_id: nil, approve_input_hash: nil, deny_action_id: nil)
      body = Fields.body(message: message, conversation_id: conversation_id, approve_action_id: approve_action_id,
                         approve_input_hash: approve_input_hash, deny_action_id: deny_action_id)
      Record.new(@t.json("POST", "/v1/support/messages", body: body, no_retry: true, timeout: 120))
    end

    def read(conversation_id) = Record.new(@t.json("GET", "/v1/support/conversations/#{seg(conversation_id)}"))
  end

  # +sbx.network+: turn the sandbox's internet off or on, narrow it to a list,
  # refuse destinations, or open host:port pairs. Changes apply at once.
  class Network
    def initialize(sandbox)
      @sandbox = sandbox
    end

    def get = Record.new(@sandbox.transport.json("GET", @sandbox.path("/network")))

    # Replaces the rules: +internet:+, +allow:+ (example.com, *.example.com, an
    # address or a CIDR range), +deny:+, and +connect:+ (host:port pairs beyond
    # 80 and 443; paid accounts only).
    def set(internet:, allow: nil, deny: nil, connect: nil)
      body = { "internet" => internet, "allow" => allow, "deny" => deny, "connect" => connect }.compact
      Record.new(@sandbox.transport.json("PUT", @sandbox.path("/network"), body: body))
    end

    def off = set(internet: false)
    def on = set(internet: true)
  end

  # +sbx.interpreter+: stateful Python and JavaScript cells, like a notebook.
  class Interpreter
    RESULT = %r{\A/workspace/\.runtime/interpreter/([a-z0-9][a-z0-9-]*)/out/([A-Za-z0-9][A-Za-z0-9_.-]*)\z}

    def initialize(sandbox)
      @sandbox = sandbox
    end

    # Runs a cell. +language:+ is "python" (the default) or "javascript";
    # +context:+ is a context id. With +on_stdout+, +on_stderr+ or +on_result+,
    # output streams as it happens. Returns the execution: status (ok, error,
    # interrupted, timeout, lost), stdout, stderr, results and error.
    def run(code, language: nil, context: nil, timeout: nil, on_stdout: nil, on_stderr: nil, on_result: nil)
      body = { "code" => code, "language" => language, "context" => context,
               "timeoutMs" => timeout && (timeout * 1000).round }.compact
      return Record.new(t.json("POST", path(":run"), body: body)) unless on_stdout || on_stderr || on_result

      t.events("POST", path(":run"), body: body.merge("stream" => true)) do |event|
        case event["k"]
        when "stdout" then on_stdout&.call(event["text"])
        when "stderr" then on_stderr&.call(event["text"])
        when "result" then on_result&.call(Record.new(event))
        when "execution" then return Record.new(event["execution"])
        when "failure" then raise Error.new(event["message"], code: event["code"], hint: event["hint"])
        end
      end
      raise Error.new("The interpreter stream ended without a result.", code: "stream_failed")
    end

    def contexts = t.json("GET", path("/contexts"))["data"].map { |context| Record.new(context) }

    def create_context(id: nil, language: nil, cwd: nil, env: nil)
      Record.new(t.json("POST", path("/contexts"), body: Fields.body(id: id, language: language, cwd: cwd, env: env)))
    end

    def restart_context(id) = Record.new(t.json("POST", path("/contexts/#{Transport.segment(id)}:restart"), body: {}))
    def interrupt_context(id) = t.json("POST", path("/contexts/#{Transport.segment(id)}:interrupt"), body: {})["interrupted"] == true
    def remove_context(id) = t.json("DELETE", path("/contexts/#{Transport.segment(id)}"))["deleted"] == true

    # The bytes of a result too large to travel inline (a refs entry's path).
    def result(result_path)
      match = RESULT.match(result_path) or raise ArgumentError, "Not an interpreter result path."
      t.bytes("GET", path("/contexts/#{match[1]}/results/#{match[2]}"), accept: "application/octet-stream")
    end

    private

    def t = @sandbox.transport
    def path(suffix) = @sandbox.path("/interpreter#{suffix}")
  end

  # +sbx.desktop+: a Linux desktop in the sandbox, driven like a person would.
  # Coordinates are pixels from the top left of the screen.
  class Desktop
    def initialize(sandbox)
      @sandbox = sandbox
    end

    def recordings = Recordings.new(@sandbox)

    # Starts the desktop; +stream_url+ opens it live in a browser.
    def start(width: nil, height: nil)
      Record.new(t.json("POST", @sandbox.path("/desktop:start"), body: { "width" => width, "height" => height }.compact))
    end

    def stop = t.json("POST", @sandbox.path("/desktop:stop"), body: {}) && nil

    # PNG bytes, or JPEG with +format: "jpeg"+.
    def screenshot(format: nil, quality: nil)
      t.bytes("GET", @sandbox.path("/desktop/screenshot"), query: { "format" => format, "quality" => quality })
    end

    def move(x, y) = act("action" => "move", "x" => x, "y" => y)
    def click(x = nil, y = nil, button: nil, double: nil) = act({ "action" => "click", "x" => x, "y" => y, "button" => button, "double" => double }.compact)
    def double_click(x = nil, y = nil) = click(x, y, double: true)
    def right_click(x = nil, y = nil) = click(x, y, button: "right")
    def mouse_down(button = "left") = act("action" => "mouseDown", "button" => button)
    def mouse_up(button = "left") = act("action" => "mouseUp", "button" => button)
    def drag(from, to) = act("action" => "drag", "from" => from, "to" => to)

    # Wheel clicks: positive +dy+ scrolls down, positive +dx+ right.
    def scroll(dy, dx: nil, x: nil, y: nil) = act({ "action" => "scroll", "dy" => dy, "dx" => dx, "x" => x, "y" => y }.compact)

    def type(text, delay_ms: nil) = act({ "action" => "type", "text" => text, "delayMs" => delay_ms }.compact)

    # xdotool key names, space separated: "ctrl+l", "Return", "alt+Tab".
    def press(keys) = act("action" => "key", "keys" => keys)

    def cursor = act("action" => "cursor")
    def windows = act("action" => "windows")["windows"]
    def focus(window_id) = act("action" => "focus", "windowId" => window_id)

    # Opens +url+ in Firefox on the desktop.
    def open(url) = act("action" => "open", "url" => url)

    # Starts a program on the desktop, detached.
    def launch(*argv) = act("action" => "launch", "argv" => argv)

    private

    def t = @sandbox.transport
    def act(body) = Record.new(t.json("POST", @sandbox.path("/desktop:act"), body: body))
  end
end
