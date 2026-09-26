# frozen_string_literal: true

module WithRuntime
  class SandboxProduct
    def initialize(sandbox)
      @s = sandbox
      @t = sandbox.transport
    end
  end

  class Mounts < SandboxProduct
    def add(idempotency_key: nil, **options) = Record.new(@t.json("POST", @s.path("/mounts"), body: Fields.body(options), key: idempotency_key))
    def list = @t.json("GET", @s.path("/mounts"))["data"].map { |row| Record.new(row) }
    def remove(path) = @t.json("POST", @s.path("/mounts:unmount"), body: { "path" => path }) && nil
  end

  class SandboxMCP < SandboxProduct
    def start(servers:, port: nil, replace: nil, idempotency_key: nil)
      # Secrets/env/options are customer dictionary keys, not SDK field names.
      servers = servers.map do |entry|
        entry.to_h.each_with_object({}) do |(key, value), out|
          name = Fields.camel(key)
          out[name] = %w[secrets env options].include?(name) ? Fields.stringify(value) : Fields.convert(value)
        end
      end
      Record.new(@t.json("POST", @s.path("/mcp"), body: { "servers" => servers, "port" => port, "replace" => replace }.compact, key: idempotency_key))
    end
    def get = Record.new(@t.json("GET", @s.path("/mcp")))
    def stop = @t.json("DELETE", @s.path("/mcp")) && nil
    def ready(timeout: 600)
      deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
      loop do
        left = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
        raise @t.connection_error(true, false, nil) unless left.positive?
        state = Record.new(@t.json("GET", @s.path("/mcp"), timeout: left))
        return state unless state.running && Array(state.servers).any? { |server| server.status == "installing" }
        sleep([2, left].min)
      end
    end
  end

  class Recordings < SandboxProduct
    def path(id = nil) = @s.path("/desktop/recordings") + (id ? "/#{Transport.segment(id)}" : "")
    def start(idempotency_key: nil, **options) = Record.new(@t.json("POST", path, body: Fields.body(options), key: idempotency_key))
    def get(id) = Record.new(@t.json("GET", path(id)))
    def list = @t.json("GET", path)["data"].map { |row| Record.new(row) }
    def stop(id) = Record.new(@t.json("POST", "#{path(id)}:stop", body: {}))
    def download(id) = @t.bytes("GET", "#{path(id)}/video", accept: "video/mp4")
    def delete(id) = @t.json("DELETE", path(id)) && nil
  end
end
