# frozen_string_literal: true

module WithRuntime
  class Domains < Product
    def add(hostname:, sandbox_id:, port:, idempotency_key: nil)
      Record.new(@t.json("POST", "/v1/domains", body: Fields.body(hostname: hostname, sandbox_id: sandbox_id, port: port), key: idempotency_key))
    end
    def get(hostname) = Record.new(@t.json("GET", "/v1/domains/#{seg(hostname)}"))
    def verify(hostname) = Record.new(@t.json("POST", "/v1/domains/#{seg(hostname)}:verify", body: {}))
    def list = @t.json("GET", "/v1/domains")["data"].map { |row| Record.new(row) }
    def remove(hostname) = @t.json("DELETE", "/v1/domains/#{seg(hostname)}") && nil
  end

  class Ports < Product
    def open(sandbox_id:, port:, idempotency_key: nil)
      Record.new(@t.json("POST", "/v1/ports", body: Fields.body(sandbox_id: sandbox_id, port: port), key: idempotency_key))
    end
    def list(sandbox_id: nil) = @t.json("GET", "/v1/ports", query: { "sandboxId" => sandbox_id })["data"].map { |row| Record.new(row) }
    def close(id) = @t.json("DELETE", "/v1/ports/#{seg(id)}") && nil
  end

  class Addresses < Product
    def reserve(family: 4) = Record.new(@t.json("POST", "/v1/addresses", body: { "family" => family }))
    def list = @t.json("GET", "/v1/addresses")["data"].map { |row| Record.new(row) }
    def release(id) = @t.json("DELETE", "/v1/addresses/#{seg(id)}") && nil
  end

  # Account WireGuard networking, distinct from Sandbox#open_tunnel.
  class PrivateTunnel < Product
    def get = Record.new(@t.json("GET", "/v1/tunnel"))
    def create(subnet: nil) = Record.new(@t.json("POST", "/v1/tunnel", body: { "subnet" => subnet }.compact))
    def delete = @t.json("DELETE", "/v1/tunnel") && nil
    # Save config even when config_ready is false: its private key is shown once.
    def add_peer(name:, public_key: nil, routes: nil, idempotency_key: nil)
      Record.new(@t.json("POST", "/v1/tunnel/peers", body: Fields.body(name: name, public_key: public_key, routes: routes), key: idempotency_key, no_retry: public_key.to_s.empty?))
    end
    def rotate_peer(id, public_key: nil)
      Record.new(@t.json("POST", "/v1/tunnel/peers/#{seg(id)}:rotate", body: { "publicKey" => public_key }.compact, no_retry: public_key.to_s.empty?))
    end
    def remove_peer(id) = Record.new(@t.json("DELETE", "/v1/tunnel/peers/#{seg(id)}"))
  end

  class SSO < Product
    def get = Record.new(@t.json("GET", "/v1/sso"))
  end
  class MCP < Product
    def catalog = @t.json("GET", "/v1/mcp/catalog")["data"].map { |row| Record.new(row) }
  end
end
