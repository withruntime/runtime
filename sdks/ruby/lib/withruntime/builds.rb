# frozen_string_literal: true

module WithRuntime
  # +runtime.builds+: a connected repository's commit built into the server an
  # App or Function deploys. In a private beta: an account outside it is
  # refused with product_in_beta (403, PermissionDeniedError).
  #
  #   repo = runtime.builds.repositories.connect(provider: "github", repository: "acme/web", deploy: "app:#{app.id}")
  #   build = runtime.builds.create(repository_id: repo.id, ref: "main")
  #   runtime.builds.logs(build.id, follow: true) { |event| puts event.text if event.type == "line" }
  #
  # A build: id, name, labels, repository_id, ref, branch, commit, state
  # (queued, fetching, building, deploying, succeeded, failed, cancelled,
  # superseded), reason, timings (milliseconds per step once done, or nil),
  # output_snapshot_id, framework (detected for the commands the repository
  # leaves unset: nextjs, vite, fastapi, rails, go, docker, ...; or nil),
  # error, created_at, updated_at and deleted_at.
  class Builds < Product
    TERMINAL = %w[succeeded failed cancelled superseded].freeze
    # Reconnections in a row with no new line before a follow gives up.
    RECONNECTS = 3
    SEEN = 10_000

    attr_reader :repositories

    def initialize(transport)
      super
      @repositories = Repositories.new(transport)
    end

    # Builds +ref+ of a connected repository. The same +branch:+ and commit is
    # one build; a newer build of the branch supersedes older ones not ended.
    def create(repository_id:, ref:, branch: nil, name: nil, labels: nil, idempotency_key: nil)
      body = Fields.body(repository_id: repository_id, ref: ref, branch: branch, name: name, labels: labels)
      Record.new(@t.json("POST", "/v1/builds", body: body, key: idempotency_key))
    end

    def get(id) = Record.new(@t.json("GET", path(id)))

    def list(name: nil, label: nil, state: nil, limit: nil, cursor: nil)
      page("/v1/builds", { "name" => name, "label" => label, "state" => state, "limit" => limit, "cursor" => cursor })
    end

    # Cancels a build; one that already ended stays as it is.
    def cancel(id, idempotency_key: nil) = Record.new(@t.json("POST", "#{path(id)}:cancel", key: idempotency_key))

    # The last 200 lines and the failing step: lines (cursor, at, step, text,
    # stream), cursor, state, reason, failing_step (name, exit_code,
    # last_lines), has_more and next_cursor; +page_cursor:+ pages older lines.
    #
    # With +follow: true+, each event to the block as it is written (or an
    # Enumerator without one), until the build ends: a line (type "line"), a
    # gap where lines were lost (type "gap", earliest_cursor), then one
    # terminal event (state, reason, failing_step). +cursor:+ resumes after
    # that line. A lost connection reconnects from the last line, up to three
    # times in a row; then build_log_interrupted, whose details cursor resumes.
    # +timeout:+ bounds the whole follow, reconnections included (120 seconds;
    # 0 for none).
    def logs(id, follow: false, cursor: nil, page_cursor: nil, timeout: 120, &block)
      unless follow
        return Record.new(@t.json("GET", "#{path(id)}/logs", query: { "cursor" => cursor, "pageCursor" => page_cursor }))
      end
      return enum_for(:logs, id, follow: true, cursor: cursor, page_cursor: page_cursor, timeout: timeout) unless block

      follow_logs(id, cursor, page_cursor, timeout, &block)
      nil
    end

    private

    def path(id) = "/v1/builds/#{seg(id)}"

    def invalid(cursor) = failure("build_log_invalid", "Retry the log from the last received cursor.", cursor)

    def valid_failure?(value)
      return true if value.nil?
      return false unless value.is_a?(Hash)

      lines = value["lastLines"]
      value["name"].is_a?(String) && (value["exitCode"].nil? || safe_integer?(value["exitCode"])) &&
        lines.is_a?(Array) && lines.size <= 20 && lines.all?(String)
    end

    def now = Process.clock_gettime(Process::CLOCK_MONOTONIC)

    # Cursors are opaque physical positions: they cannot be ordered or
    # counted on, so lines already given are known by their cursor.
    def follow_logs(id, cursor, page_cursor, timeout)
      if (cursor && !valid_cursor?(cursor)) || page_cursor
        raise failure("invalid_log_options", "Use an opaque cursor for follow; page_cursor is only for search pages.", cursor)
      end

      seen = cursor ? { cursor => true } : {}
      failures = 0
      deadline = timeout.positive? ? now + timeout : nil
      timed_out = lambda do
        ConnectionError.new("The log follow reached its deadline.", code: "timeout", details: { "cursor" => cursor },
                                                                     hint: "Resume with logs(id, follow: true, cursor: details[\"cursor\"]).")
      end
      loop do
        raise timed_out.call if deadline && now >= deadline

        continued = false
        begin
          @t.events("GET", "#{path(id)}/logs", query: { "follow" => true, "cursor" => cursor },
                                               timeout: deadline && (deadline - now)) do |event|
            raise invalid(cursor) unless event.is_a?(Hash)
            raise invalid(cursor) unless event.key?("cursor") && (event["cursor"].nil? || valid_cursor?(event["cursor"]))

            case event["type"]
            when "line"
              unless event["text"].is_a?(String) && %w[stdout stderr].include?(event["stream"]) &&
                     safe_integer?(event["at"]) && !event["at"].negative? &&
                     (event["step"].nil? || event["step"].is_a?(String)) && valid_cursor?(event["cursor"])
                raise invalid(cursor)
              end
              next if seen.key?(event["cursor"])

              seen[event["cursor"]] = true
              seen.delete(seen.first[0]) if seen.size > SEEN
              cursor = event["cursor"]
              failures = 0
              yield Record.new(event)
            when "gap"
              raise invalid(cursor) if !valid_cursor?(event["earliestCursor"]) || (cursor && event["cursor"] != cursor)

              cursor = event["cursor"]
              yield Record.new(event)
            when "terminal"
              if (cursor && event["cursor"] != cursor) || !TERMINAL.include?(event["state"]) ||
                 !event["reason"].is_a?(String) || event["reason"].empty? || !valid_failure?(event["failingStep"]) ||
                 (event["state"] != "failed" && !event["failingStep"].nil?)
                raise invalid(cursor)
              end

              yield Record.new(event)
              return
            when "continue"
              if cursor && event["cursor"] != cursor
                raise failure("build_log_gap", "Resume from details.cursor; report a persistent missing log line.", cursor)
              end

              cursor = event["cursor"]
              continued = true
              break
            when "error"
              unless event["cursor"] == cursor && event["code"].is_a?(String) && !event["code"].empty? &&
                     event["hint"].is_a?(String) && !event["hint"].empty?
                raise invalid(cursor)
              end

              raise failure(event["code"], event["hint"], cursor)
            else
              raise invalid(cursor)
            end
          end
        rescue ConnectionError
          # A lost connection, not a refusal: the transport itself retries
          # retryable answers. Reconnect from the last line.
          raise timed_out.call if deadline && now >= deadline
        rescue Error => e
          raise e unless e.code == "unexpected_answer" && e.status.zero?

          raise failure("build_log_invalid", "The log contained invalid JSON; retry from details.cursor.", cursor)
        end
        failures += 1 unless continued
        if failures > RECONNECTS
          raise failure("build_log_interrupted", "Reconnect with logs(id, follow: true, cursor: details[\"cursor\"]).", cursor)
        end

        # A service that is down, or continuations one after another, never busy-loop.
        pause = 0.05 * [1, failures].max
        pause = [pause, [deadline - now, 0].max].min if deadline
        sleep(pause)
      end
    end
  end

  # +runtime.builds.repositories+: the repositories Runtime builds. Every push
  # to a repository's production branch builds it and deploys it to its
  # +deploy+ target. In the Builds private beta (product_in_beta, 403, outside it).
  #
  # A repository: id, name, labels, provider (github or git), repository,
  # deploy (app:<id>, function:<id> or container:<id>), production_branch,
  # previews, root_directory, install_command, build_command, start_command,
  # port, health_path, build_env, state (connected or disconnected), error,
  # created_at, updated_at and deleted_at.
  class Repositories < Product
    # Connects +repository+ from +provider+ ("github" or "git") to +deploy+.
    # Optional: production_branch, previews, root_directory, install_command
    # (chosen by the lockfile when left out), build_command, start_command
    # (the build then ends as that server, answering health_path with 200),
    # port, health_path, build_env (never a secret: anyone who reads the
    # repository sees it), name and labels.
    def connect(provider:, repository:, deploy:, idempotency_key: nil, **settings)
      body = Fields.body(settings.merge(provider: provider, repository: repository, deploy: deploy))
      Record.new(@t.json("POST", "/v1/repositories", body: body, key: idempotency_key))
    end

    def list(name: nil, label: nil, state: nil, limit: nil, cursor: nil)
      page("/v1/repositories", { "name" => name, "label" => label, "state" => state, "limit" => limit, "cursor" => cursor })
    end

    # Changes settings in place; its id and builds stay. Fields left out stay
    # as they are; +:remove+ clears name, install_command, build_command,
    # start_command or health_path.
    def update(id, idempotency_key: nil, **changes)
      Record.new(@t.json("POST", "/v1/repositories/#{seg(id)}:update", body: patch(changes), key: idempotency_key))
    end

    def disconnect(id, idempotency_key: nil) = Record.new(@t.json("DELETE", "/v1/repositories/#{seg(id)}", key: idempotency_key))

    # A link (url, expires_at) to install Runtime's GitHub App, so private
    # repositories build. Open it in a browser within 15 minutes, install the
    # App where Runtime may read, then connect the repository with provider github.
    def install_github = Record.new(@t.json("POST", "/v1/repositories/github:install"))
  end
end
