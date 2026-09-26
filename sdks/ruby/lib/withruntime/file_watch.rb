# frozen_string_literal: true

module WithRuntime
  class WatchService < SandboxProduct
    def path(id = nil) = @s.path("/files/watches") + (id ? "/#{Transport.segment(id)}" : "")
    def start(path, idempotency_key: nil, **options)
      answer = @t.json("POST", self.path, body: Fields.body(options.merge(path: path)), key: idempotency_key)
      FileWatch.new(self, answer)
    end
    def list = @t.json("GET", path)["data"].map { |row| Record.new(row) }
    def read(id, cursor: 0, wait_ms: 0) = Record.new(@t.json("GET", "#{path(id)}/events", query: { "cursor" => cursor, "waitMs" => wait_ms }))
    def stop(id) = @t.json("DELETE", path(id)) && nil
    def events(id, cursor, cancel, &block)
      @t.events("GET", "#{path(id)}/events", query: { "cursor" => cursor, "follow" => true }, timeout: 150, cancel: cancel, &block)
    end
  end

  # Each events block retains its cursor. Close only its reader, or stop the guest watch too.
  class FileWatch
    attr_reader :id, :path
    def initialize(service, info)
      @service, @id, @path, @cursor = service, info["id"], info["path"], info["cursor"] || 0
      @lock, @stop_lock = Mutex.new, Mutex.new
      @reading = @stopped = false
    end
    def cursor = @lock.synchronize { @cursor }
    def close
      cancel = @lock.synchronize { @cancel }
      cancel&.cancel
    end
    def stop
      @stop_lock.synchronize do
        return if @lock.synchronize { @stopped }
        @lock.synchronize { @stopped = true }
        close
        begin
          @service.stop(@id)
        rescue StandardError
          @lock.synchronize { @stopped = false }
          raise
        end
      end
      nil
    end
    def events
      return enum_for(:events) unless block_given?
      cancel = @lock.synchronize do
        raise Error.new("The watch is stopped or already being read.", code: "watch_reader_active") if @reading || @stopped
        @reading = true
        @cancel = Transport::Cancellation.new
      end
      begin
        loop do
          again = false
          @service.events(@id, cursor, cancel) do |event|
            @lock.synchronize { @cursor = event["cursor"] if event.key?("cursor") }
            if event["k"] == "continue"
              again = true
              break
            end
            raise Error.new(event["message"], code: event["code"]) if event["k"] == "failure"
            yield Record.new(event)
            return if %w[end paused].include?(event["k"])
          end
          break unless again && !cancel.cancelled?
        end
      ensure
        cancel.cancel
        @lock.synchronize { @reading = false; @cancel = nil }
      end
    end
  end
end
