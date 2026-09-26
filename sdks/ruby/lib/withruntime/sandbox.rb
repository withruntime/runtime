# frozen_string_literal: true

require "digest"
require "fileutils"
require "securerandom"
require "time"

module WithRuntime
  # +runtime.sandboxes+: create, find and list sandboxes.
  class Sandboxes
    def initialize(transport)
      @t = transport
    end

    # Creates a sandbox and, unless +wait: false+, waits until it is running.
    # Every field is optional: with none you get the free trial while it lasts,
    # the default region and a 2 vCPU / 4 GiB machine for up to 30 minutes.
    # When every trial slot or the account's quota is taken, it waits for one to
    # free, up to +wait_for_capacity+ seconds (the client's, two minutes by default).
    #
    #   runtime.sandboxes.create(funding: "trial", labels: { team: "search" }, timeout_seconds: 900)
    def create(wait: true, idempotency_key: nil, wait_for_capacity: nil, **fields)
      room = wait_for_capacity.nil? ? @t.wait_for_capacity : [0, wait_for_capacity].max
      info = @t.json("POST", "/v1/sandboxes", body: Fields.body(fields), wait: wait ? 60 : 0,
                                              key: idempotency_key, room: room)
      sandbox = Sandbox.new(@t, info)
      if wait && sandbox.state != "running"
        sandbox.wait_for("running", timeout: 60)
        unless sandbox.state == "running"
          raise Error.new("Sandbox #{sandbox.id} is #{sandbox.state}, not running.", code: "start_failed",
                                                                                       hint: "Read it with runtime.sandboxes.get(id); stop_reason says why.")
        end
      end
      sandbox
    end

    # The sandbox named +name+, ready to use: running as it is, woken if paused,
    # restarted if stopped and persistent, or created with the other fields when
    # no sandbox has the name. +sbx.info.reused+ says which.
    def get_or_create(name, **fields) = create(**fields, name: name, get_or_create: true)

    # Reconnects to a sandbox by id.
    def get(id) = Sandbox.new(@t, @t.json("GET", "/v1/sandboxes/#{Transport.segment(id)}"))

    # The first page of live sandboxes, oldest first; +each+ walks every page.
    def list(state: nil, include_stopped: false, labels: nil, name: nil, limit: nil)
      query = { "state" => state, "includeStopped" => (include_stopped ? "true" : nil),
                "label" => labels&.map { |key, value| "#{key}:#{value}" }, "name" => name, "limit" => limit }
      page(query, nil)
    end

    private

    def page(query, cursor)
      body = @t.json("GET", "/v1/sandboxes", query: query.merge("cursor" => cursor))
      Page.new(body["data"].map { |info| Sandbox.new(@t, info) }, body["nextCursor"]) { |after| page(query, after) }
    end
  end

  # A running (or stopped) sandbox. Its methods are safe to call from many threads.
  class Sandbox
    attr_reader :files, :previews, :network, :interpreter, :desktop, :info

    def initialize(transport, info)
      @t = transport
      @info = Record.new(info)
      @files = Files.new(self)
      @previews = Previews.new(self)
      @network = Network.new(self)
      @interpreter = Interpreter.new(self)
      @desktop = Desktop.new(self)
      @keep_alive = nil
    end

    # :nodoc:
    def transport = @t
    def mounts = Mounts.new(self)
    def mcp = SandboxMCP.new(self)
    def terminal(**options) = Terminal.new(self, **options)
    def open_tunnel = Tunnel.new(self)
    def port_forward(port, host: "127.0.0.1", local_port: 0) = PortForward.new(self, port, host: host, local_port: local_port)

    def id = @info["id"]
    def state = @info["state"]

    # :nodoc:
    def path(suffix = "") = "/v1/sandboxes/#{Transport.segment(id)}#{suffix}"

    # Reads the sandbox again.
    def refresh
      @info = Record.new(@t.json("GET", path))
      self
    end

    # Waits, on the server with no polling, until the sandbox reaches +state+
    # (running, paused or stopped) or +timeout+ seconds pass.
    def wait_for(state, timeout: 60)
      seconds = [1, timeout.to_i].max
      @info = Record.new(@t.json("GET", path, query: { "waitFor" => state, "timeoutSeconds" => seconds },
                                              timeout: seconds + 60))
      self
    end

    # Stops the sandbox and ends its charges. Also ends a keep-alive.
    def stop(wait: true, idempotency_key: nil)
      stop_keep_alive
      lifecycle("stop", {}, wait, idempotency_key)
    end

    # Saves the sandbox's memory and files; compute billing stops.
    def pause(wait: true, idempotency_key: nil) = lifecycle("pause", {}, wait, idempotency_key)

    # Carries on a paused sandbox, with its memory and processes; +timeout_seconds+ is its new lease.
    def wake(wait: true, timeout_seconds: nil, idempotency_key: nil)
      lifecycle("wake", timeout_seconds ? { "timeoutSeconds" => timeout_seconds } : {}, wait, idempotency_key)
    end

    # More time before the lease ends, at most an hour ahead of now.
    def extend_lease(seconds, idempotency_key: nil) = lifecycle("extend", { "seconds" => seconds }, false, idempotency_key)

    # Days (1 to 365) a paused sandbox is kept before it is deleted.
    def set_retention(days, idempotency_key: nil) = lifecycle("retention", { "days" => days }, false, idempotency_key)

    # Starts a stopped persistent sandbox again from its disk. Memory is not kept.
    def restart(wait: true, idempotency_key: nil) = lifecycle("restart", {}, wait, idempotency_key)

    # Changes name, labels, auto_wake, idle_pause_seconds, persistent or
    # max_total_cost_micros; fields left out stay as they are, and
    # +max_total_cost_micros: :remove+ removes the cap.
    def update(idempotency_key: nil, **settings)
      body = Fields.body(settings.reject { |_key, value| value == :remove })
      body["maxTotalCostMicros"] = nil if settings[:max_total_cost_micros] == :remove
      lifecycle("update", body, false, idempotency_key)
    end

    # Keeps a running sandbox's lease ahead of now on a background thread, until
    # +stop+ or +stop_keep_alive+: every +every+ seconds it extends the lease so
    # that +margin+ seconds remain, never more than the hour ahead the API
    # allows. Running time is billed as it is used. A paused sandbox is left
    # paused; a stopped one ends the loop.
    def keep_alive(every: 60, margin: 600, &on_error)
      stop_keep_alive
      every = [10, every].max
      margin = margin.clamp(60, 3600)
      @keep_alive = Thread.new do
        loop do
          begin
            refresh
            break if %w[stopped stopping].include?(state)

            expires = @info["expiresAt"]
            if state == "running" && expires
              need = (margin - (Time.parse(expires) - Time.now)).ceil
              extend_lease([3600, need].min) if need >= 1
            end
          rescue Error => e
            on_error&.call(e)
          end
          sleep(every)
        end
      end
      @keep_alive.report_on_exception = false
      self
    end

    # Ends a keep-alive, if one runs.
    def stop_keep_alive
      thread = @keep_alive
      @keep_alive = nil
      thread&.kill
    end

    # Starts copies of this sandbox as it is now (files, memory, running
    # processes), each its own sandbox, on the same server, answered once they
    # run. One copy without +count+; an array with it. If a copy fails, the
    # error's +details["startedSandboxIds"]+ names the copies that did start.
    def fork(count: nil, name: nil, labels: nil, keep_snapshot: nil, funding: nil, idempotency_key: nil)
      body = Fields.body(count: count, name: name, labels: labels, keep_snapshot: keep_snapshot, funding: funding)
      reply = @t.json("POST", path(":fork"), body: body, wait: 60, key: idempotency_key)
      copies = reply["sandboxes"].map { |info| Sandbox.new(@t, info) }
      count.nil? ? copies.first : copies
    end

    # Keeps this sandbox's whole machine as a snapshot to start new sandboxes
    # from. A running sandbox is paused for the moment it takes, then woken; a
    # paused one stays paused. A sandbox with volumes cannot be snapshotted.
    def snapshot(name: nil, labels: nil, retention_days: nil, idempotency_key: nil)
      refresh
      # Straight after a fork or a wake the sandbox is still resuming, and
      # after a pause still pausing: wait for where it is going, or a
      # snapshot of it is refused as not paused.
      if %w[resuming starting].include?(state) then wait_for("running")
      elsif state == "pausing" then wait_for("paused")
      end
      running = state == "running"
      pause if running
      begin
        Record.new(@t.json("POST", path(":snapshot"),
                           body: Fields.body(name: name, labels: labels, retention_days: retention_days),
                           wait: 10, key: idempotency_key))
      ensure
        wake if running
      end
    end

    # CPU and memory over a range: 15m, 1h, 6h, 24h, 7d or 30d.
    def metrics(range: nil) = Record.new(@t.json("GET", path("/metrics"), query: { "range" => range }))

    # Runs a command and returns its exit code and output. A String runs under
    # +bash -c+; an Array runs the program directly, with no shell.
    #
    # +cwd+ (default /workspace), +env+ (merged over the sandbox's; put secrets
    # here), +stdin+, +timeout+ (seconds, default 60, up to a day; a timeout is
    # a result, not an error), +on_stdout+ and +on_stderr+ (stream the command;
    # the result keeps everything), and +check+ (raise CommandError on a
    # non-zero exit or a timeout).
    def exec(command, cwd: nil, env: nil, stdin: nil, timeout: nil, on_stdout: nil, on_stderr: nil,
             check: false, idempotency_key: nil)
      streamed = on_stdout || on_stderr || (timeout && timeout > 60)
      result = if streamed
                 collect(exec_stream(command, cwd: cwd, env: env, stdin: stdin, timeout: timeout,
                                              idempotency_key: idempotency_key), on_stdout, on_stderr)
               else
                 body = command_body(command, cwd, env, stdin, timeout)
                 CommandResult.new(@t.json("POST", path(":exec"), body: body, key: idempotency_key,
                                                                  timeout: timeout && (timeout + 60)))
               end
      raise CommandError, result if check && !result.ok?

      result
    end

    # Runs a command and yields its events as they happen: start, stdout,
    # stderr, exit (each a Hash). Resumes by itself when the server ends a long
    # stream, so it never drops output. Without a block, an Enumerator.
    def exec_stream(command, cwd: nil, env: nil, stdin: nil, timeout: nil, idempotency_key: nil, &block)
      unless block
        return enum_for(:exec_stream, command, cwd: cwd, env: env, stdin: stdin, timeout: timeout,
                                               idempotency_key: idempotency_key)
      end

      body = command_body(command, cwd, env, stdin, timeout || 86_400).merge("stream" => true)
      handed_over = nil
      @t.events("POST", path(":exec"), body: body, key: idempotency_key,
                                       timeout: timeout ? timeout + 60 : 86_400) do |event|
        case event["type"]
        when "continue" then handed_over = event
        when "error" then raise stream_error(event)
        else yield event
        end
        break if handed_over
      end
      follow(handed_over["processId"], handed_over["cursor"], &block) if handed_over
    end

    # A process's output events from +cursor+ until it exits, across the server's stream slices.
    def follow(process_id, cursor = 0)
      return enum_for(:follow, process_id, cursor) unless block_given?

      loop do
        resume = nil
        exited = false
        @t.events("GET", path("/processes/#{Transport.segment(process_id)}/output"),
                  query: { "cursor" => cursor, "follow" => "true" }, timeout: 180) do |event|
          case event["type"]
          when "continue"
            resume = event["cursor"]
            break
          when "stdout", "stderr" then cursor = event["offset"] + event["data"].bytesize
          when "error" then raise stream_error(event)
          when "exit" then exited = true
          end
          yield event
          break if exited
        end
        break if exited || resume.nil?

        cursor = resume
      end
    end

    # Starts a background process (a server, a watcher, a REPL) and returns at
    # once. It outlives your connection; +process(id)+ gets it back.
    # +pipe_stdin: true+ keeps input open for +write+; +pty: { cols:, rows: }+
    # gives it a terminal.
    def spawn(command, cwd: nil, env: nil, timeout: nil, stdin: nil, pipe_stdin: false, pty: nil, idempotency_key: nil)
      body = command_body(command, cwd, env, pipe_stdin ? nil : stdin, timeout)
      body["stdinMode"] = "pipe" if pipe_stdin
      body["pty"] = Fields.body(pty) if pty
      SandboxProcess.new(self, @t.json("POST", path("/processes"), body: body, key: idempotency_key))
    end

    # The sandbox's background processes.
    def processes = @t.json("GET", path("/processes"))["data"].map { |info| Record.new(info) }

    # Gets a background process back by id.
    def process(id) = SandboxProcess.new(self, @t.json("GET", path("/processes/#{Transport.segment(id)}")))

    def inspect = "#<WithRuntime::Sandbox #{id} #{state}>"

    private

    def lifecycle(verb, body, wait, key)
      @info = Record.new(@t.json("POST", path(":#{verb}"), body: body, wait: wait ? 60 : 0, key: key))
      self
    end

    def command_body(command, cwd, env, stdin, timeout)
      body = command.is_a?(Array) ? { "argv" => command.map(&:to_s) } : { "command" => command.to_s }
      body["cwd"] = cwd if cwd
      body["env"] = env.to_h { |key, value| [key.to_s, value.to_s] } if env
      body["stdinBase64"] = [stdin.to_s.b].pack("m0") unless stdin.nil?
      body["timeoutMs"] = (timeout * 1000).round if timeout
      body
    end

    def collect(events, on_stdout, on_stderr)
      stdout = +""
      stderr = +""
      fields = {}
      dropped = false
      events.each do |event|
        case event["type"]
        when "start" then fields["processId"] = event["processId"]
        when "stdout"
          stdout << event["data"]
          on_stdout&.call(event["data"])
        when "stderr"
          stderr << event["data"]
          on_stderr&.call(event["data"])
        when "truncated" then dropped = true
        when "exit" then fields.merge!(event.slice("exitCode", "timedOut", "durationMs"))
        end
      end
      # A truncated event does not say which stream lost bytes, so both flags carry it.
      CommandResult.new(fields.merge("stdout" => stdout, "stderr" => stderr,
                                     "stdoutTruncated" => dropped, "stderrTruncated" => dropped))
    end

    def stream_error(event)
      error = event["error"].is_a?(Hash) ? event["error"] : {}
      Error.new(error["message"] || "The output stream failed.", code: error["code"] || "stream_failed",
                                                                 request_id: error["requestId"])
    end
  end

  # A background process in a sandbox: its output, its input, its end. Use one
  # from one thread at a time.
  class SandboxProcess
    attr_reader :info

    def initialize(sandbox, info)
      @sandbox = sandbox
      @info = Record.new(info)
      @input_offset = info["stdinOffset"].to_i
    end

    def id = @info["id"]

    # Every output event from +cursor+ (0 for the start) until the process exits.
    def output(cursor = 0, &block) = @sandbox.follow(id, cursor, &block)

    # Waits for the process to end and returns its result.
    def wait
      stdout = +""
      stderr = +""
      fields = { "processId" => id }
      dropped = false
      output(0) do |event|
        case event["type"]
        when "stdout" then stdout << event["data"]
        when "stderr" then stderr << event["data"]
        when "truncated" then dropped = true
        when "exit" then fields.merge!(event.slice("exitCode", "timedOut", "durationMs"))
        end
      end
      CommandResult.new(fields.merge("stdout" => stdout, "stderr" => stderr,
                                     "stdoutTruncated" => dropped, "stderrTruncated" => dropped))
    end

    # Sends input. Offsets are tracked for you, so a retried write is never
    # typed twice. +eof: true+ closes the input after it.
    def write(data, eof: false)
      data = data.to_s.b
      sent = 0
      loop do
        body = { "base64" => [data.byteslice(sent..)].pack("m0"), "offset" => @input_offset }
        body["eof"] = true if eof
        reply = @sandbox.transport.json("POST", path(":write"), body: body)
        progress = reply["offset"] - @input_offset
        sent += progress
        @input_offset = reply["offset"]
        return self if sent >= data.bytesize
        raise Error.new("The process took none of the input.", code: "write_stalled") if progress <= 0
      end
    end

    # Sends a signal: SIGTERM, SIGKILL, SIGINT, SIGHUP, SIGQUIT, SIGUSR1 or SIGUSR2.
    def kill(signal = "SIGTERM") = @sandbox.transport.json("POST", path(":signal"), body: { "signal" => signal })

    # Changes a PTY process's terminal size.
    def resize(cols, rows) = @sandbox.transport.json("POST", path(":resize"), body: { "cols" => cols, "rows" => rows })

    # Reads the process again.
    def refresh
      @info = Record.new(@sandbox.transport.json("GET", path))
      self
    end

    private

    def path(suffix = "") = @sandbox.path("/processes/#{Transport.segment(id)}#{suffix}")
  end

  # +sbx.files+: files in a sandbox. Paths are absolute; any path the sandbox user may use.
  class Files
    CHUNK = 1 << 20

    def initialize(sandbox)
      @sandbox = sandbox
    end

    # A file's bytes (a binary String), any size.
    def read(path) = t.bytes("GET", @sandbox.path("/files/content"), query: { "path" => path }, accept: "application/octet-stream")

    def read_text(path) = read(path).force_encoding(Encoding::UTF_8)

    # Writes a file of any size, atomically, making parent directories. A file
    # over 1 MiB goes in parallel 1 MiB chunks checked against its SHA-256.
    def write(path, data, mode: nil, idempotency_key: nil)
      data = data.to_s.b
      mode = mode_string(mode) unless mode.nil?
      if data.bytesize <= CHUNK
        t.bytes("PUT", @sandbox.path("/files/content"), query: { "path" => path, "mode" => mode }.compact, raw: data, key: idempotency_key)
        return nil
      end
      root = idempotency_key || SecureRandom.uuid
      phase = ->(name) { Digest::SHA256.hexdigest("files.write:#{root}:#{name}") }
      body = { "path" => path, "size" => data.bytesize, "sha256" => Digest::SHA256.hexdigest(data), "mode" => mode }.compact
      begin
        upload = t.json("POST", @sandbox.path("/uploads"), body: body, key: phase.call("begin"))
      rescue Error => error
        raise unless mode && error.code == "guest_upgrade_required"
        upload = t.json("POST", @sandbox.path("/uploads"), body: body.reject { |key, _| key == "mode" }, key: phase.call("legacy-begin"))
      end
      chunk = upload["chunkBytes"].to_i
      raise Error.new("The upload omitted its ID or chunk size.", code: "unexpected_answer") unless chunk.positive? && upload["uploadId"]
      base = @sandbox.path("/uploads/#{Transport.segment(upload["uploadId"])}")
      commit = -> { t.json("POST", "#{base}:commit", body: {}, key: phase.call("commit")) }
      committed = false
      if upload["replayed"]
        begin
          commit.call
          committed = true
        rescue Error => error
          raise unless error.code == "upload_incomplete"
        end
      end
      unless committed
        offsets = Queue.new
        (0...data.bytesize).step(chunk) { |offset| offsets << offset }
        offsets.close
        failure = nil
        lock = Mutex.new
        workers = Array.new(4) do
          Thread.new do
            while !lock.synchronize { failure } && (offset = offsets.pop)
              begin
                t.bytes("PUT", base, query: { "offset" => offset }, raw: data.byteslice(offset, chunk))
              rescue StandardError => error
                lock.synchronize { failure ||= error }
              end
            end
          end
        end
        begin
          workers.each(&:join)
          raise failure if failure
          commit.call
        rescue StandardError
          begin
            t.json("POST", "#{base}:abort", body: {}, key: phase.call("abort"), timeout: 10)
          rescue Error
            nil
          end
          raise
        end
      end
      t.json("POST", @sandbox.path("/files:chmod"), body: { "path" => path, "mode" => mode }, key: phase.call("chmod")) if mode && upload["mode"] != mode
      nil
    end

    def chmod(path, mode)
      t.json("POST", @sandbox.path("/files:chmod"), body: { "path" => path, "mode" => mode_string(mode) })
      nil
    end
    def watches = WatchService.new(@sandbox)
    def watch(path, **options) = watches.start(path, **options)
    def mode_string(mode)
      raise ArgumentError, "mode must be an integer from 000 to 777" unless mode.is_a?(Integer) && mode.between?(0, 0o777)
      format("%03o", mode)
    end
    private :mode_string

    # A directory's entries (default /workspace). +depth:+ goes deeper; +glob:+
    # filters, e.g. "**/*.py".
    def list(directory = "/workspace", depth: nil, glob: nil, hidden: nil, limit: nil)
      query = { "path" => directory, "depth" => depth, "glob" => glob, "hidden" => hidden, "limit" => limit }
      t.json("GET", @sandbox.path("/files/list"), query: query)["data"].map { |entry| Record.new(entry) }
    end

    def glob(pattern, root = "/workspace") = list(root, glob: pattern)

    # A file's entry, or nil when it does not exist.
    def stat(path)
      answer = t.json("GET", @sandbox.path("/files/stat"), query: { "path" => path })
      answer["exists"] ? Record.new(answer) : nil
    end

    def exist?(path) = !stat(path).nil?

    def mkdir(path, parents: true)
      t.json("POST", @sandbox.path("/files:mkdir"), body: { "path" => path, "parents" => (parents || nil) }.compact)
      nil
    end

    # Removes a file, or a directory with +recursive: true+. Says whether anything was there.
    def remove(path, recursive: false)
      body = { "path" => path, "recursive" => (recursive || nil) }.compact
      t.json("POST", @sandbox.path("/files:remove"), body: body)["removed"] == true
    end

    def rename(from, to, overwrite: false)
      body = { "from" => from, "to" => to, "overwrite" => (overwrite || nil) }.compact
      t.json("POST", @sandbox.path("/files:rename"), body: body)
      nil
    end

    # Copies a local file or directory in. A directory travels as one gzipped tar.
    def upload(local, remote)
      return write(remote, File.binread(local)) unless File.directory?(local)

      staging = "/tmp/.runtime-upload-#{SecureRandom.uuid}.tar.gz"
      write(staging, Tar.pack_directory(local))
      result = @sandbox.exec(["sh", "-c", 'mkdir -p "$1" && tar -xzf "$2" -C "$1"; code=$?; rm -f "$2"; exit $code',
                              "sh", remote, staging])
      raise CommandError, result unless result.ok?

      nil
    end

    # Copies a file or directory out.
    def download(remote, local)
      entry = stat(remote)
      raise NotFoundError.new("#{remote} does not exist.", code: "file_not_found", status: 404) unless entry

      if entry["type"] != "directory"
        FileUtils.mkdir_p(File.dirname(File.expand_path(local)))
        File.binwrite(local, read(remote))
        return nil
      end
      staging = "/tmp/.runtime-download-#{SecureRandom.uuid}.tar.gz"
      packed = @sandbox.exec(["tar", "-czf", staging, "-C", remote, "."])
      raise CommandError, packed unless packed.ok?

      begin
        Tar.unpack(read(staging), local)
      ensure
        begin
          remove(staging)
        rescue Error
          nil # /tmp is cleared with the sandbox.
        end
      end
      nil
    end

    private

    def t = @sandbox.transport
  end

  # +sbx.previews+: share ports of the sandbox at public HTTPS addresses under
  # runtimehost.com. WebSockets work; the server must listen on 0.0.0.0 or localhost.
  class Previews
    def initialize(sandbox)
      @sandbox = sandbox
    end

    # Shares +port+, or changes its visibility if it is shared already.
    # +visibility+ is "private" (the default: a token is needed) or "public";
    # +ttl_seconds+ is how long the returned token lasts (60 s to 7 days).
    def create(port, visibility: nil, ttl_seconds: nil)
      body = { "port" => port, "visibility" => visibility, "ttlSeconds" => ttl_seconds }.compact
      Record.new(t.json("POST", path, body: body))
    end

    # Every shared port, each private one with a fresh token.
    def list = t.json("GET", path)["data"].map { |preview| Record.new(preview) }

    # One preview, with a fresh token of +ttl_seconds+ if it is private.
    def get(port, ttl_seconds: nil) = Record.new(t.json("GET", path("/#{port.to_i}"), query: { "ttlSeconds" => ttl_seconds }))

    # Refuses every token issued for this port so far and returns a new one.
    def rotate(port) = Record.new(t.json("POST", path("/#{port.to_i}:rotate")))

    # Stops sharing +port+. Open connections close within seconds.
    def delete(port)
      t.json("DELETE", path("/#{port.to_i}"))
      nil
    end

    private

    def t = @sandbox.transport
    def path(suffix = "") = @sandbox.path("/previews#{suffix}")
  end
end
