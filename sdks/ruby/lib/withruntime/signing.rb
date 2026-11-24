# frozen_string_literal: true

require "digest"
require "openssl"
require "securerandom"
require_relative "errors"

module WithRuntime
  # API keys as key pairs (ARCHITECTURE.md section 11): the SDK holds the
  # private half and signs each request; the server stores only the public
  # half, so no bearer secret crosses the network.
  #
  #   Authorization: Runtime-Ed25519 Credential=<32 hex>,Timestamp=<ns>,Nonce=<32 hex>,Signature=<128 hex>
  #   Runtime-Project: <32 hex>
  #
  # The signature is Ed25519 over
  #
  #   "rtr\x01" | credential (16, LE) | project (16, LE) | timestamp ns (8, LE)
  #   | nonce (16) | SHA-256(body) (32) | method | "\n" | path and query | "\n"
  #   | Idempotency-Key (empty when none)
  #
  # so it is good for one request, on one project, within 60 seconds of the
  # server's clock. A signed write must carry an Idempotency-Key: a copy
  # replayed within the minute is then answered from the first one's commit,
  # not run again. The front's side is engines/front/crates/front/src/signed.rs;
  # every SDK signs the same test vector to the same header. OpenSSL signs.
  module Signing
    SCHEME = "Runtime-Ed25519"
    # A key pair's secret, as RUNTIME_API_KEY or +api_key+ holds it.
    PREFIX = "rtsk_"
    DOMAIN = "rtr\x01".b.freeze
    # PKCS #8 for an Ed25519 private key, before its 32-byte seed (RFC 8410).
    PKCS8_PREFIX = ["302e020100300506032b657004220420"].pack("H*").freeze
    ID = /\A[0-9a-f]{32}\z/
    SEED = /\A[0-9a-f]{64}\z/

    # A key pair as an API key: +credential+, the ID its public half was
    # registered as (32 hex characters), and its private key (seed), 64 hex
    # characters.
    class Key
      attr_reader :credential

      def initialize(credential, private_key)
        unless ID.match?(credential) && SEED.match?(private_key)
          raise ArgumentError, "A signing key is a 32-character credential ID and a 64-character private key, in lowercase hex."
        end

        @credential = credential
        @credential_bytes = Signing.id_bytes(credential)
        @key = OpenSSL::PKey.read(PKCS8_PREFIX + [private_key].pack("H*"))
      end

      # Never the private key: an inspect reaches logs.
      def inspect = "#<WithRuntime::Signing::Key credential=#{@credential}>"

      # The public key, 64 hex characters: what is registered.
      def public_key = @key.public_to_der.byteslice(-32, 32).unpack1("H*")

      # The headers that sign one request: Authorization and Runtime-Project.
      # +target+ is the path and query exactly as sent; +body+ the bytes as
      # sent; +idempotency_key+ the Idempotency-Key header sent, which a write
      # must have. Sign each attempt anew: the server takes a nonce once.
      def sign_request(project, method, target, body = nil, idempotency_key: nil, timestamp_ns: nil, nonce: nil)
        raise ArgumentError, "The project is its 32-character ID, in lowercase hex." unless ID.match?(project)

        nonce ||= SecureRandom.random_bytes(16)
        raise ArgumentError, "A nonce is 16 bytes." unless nonce.bytesize == 16

        at = timestamp_ns || Process.clock_gettime(Process::CLOCK_REALTIME, :nanosecond)
        message = String.new(capacity: 94 + method.bytesize + target.bytesize + idempotency_key.to_s.bytesize,
                             encoding: Encoding::BINARY)
        message << DOMAIN << @credential_bytes << Signing.id_bytes(project) << [at].pack("Q<") << nonce.b
        message << Digest::SHA256.digest(body.to_s) << method.b << "\n" << target.b << "\n" << idempotency_key.to_s.b
        signature = @key.sign(nil, message)
        { "Authorization" => "#{SCHEME} Credential=#{@credential},Timestamp=#{at},Nonce=#{nonce.unpack1('H*')},Signature=#{signature.unpack1('H*')}",
          "Runtime-Project" => project }
      end
    end

    module_function

    # A 128-bit ID's 16 bytes, little-endian, as the server reads it.
    def id_bytes(id) = [id].pack("H*").reverse

    # A new key pair, made on this machine: [private_key, public_key], each 64
    # hex characters. Register the public key as an API key; keep the private
    # key secret. The server never sees it.
    def generate_key_pair
      seed = SecureRandom.random_bytes(32).unpack1("H*")
      [seed, public_key_of(seed)]
    end

    # The public key (64 hex characters) of a private key.
    def public_key_of(private_key) = Key.new("0" * 32, private_key).public_key

    # A key pair's secret, rtsk_<credential>_<private_key>: what
    # RUNTIME_API_KEY or +api_key+ holds to sign requests instead of sending a
    # bearer key.
    def secret(credential, private_key)
      Key.new(credential, private_key)
      "#{PREFIX}#{credential}_#{private_key}"
    end

    # The key pair in an rtsk_ secret, or nil for any other key.
    def parse(secret)
      return nil unless secret.start_with?(PREFIX)

      parts = secret.delete_prefix(PREFIX).split("_", -1)
      return nil unless parts.size == 2 && ID.match?(parts[0]) && SEED.match?(parts[1])

      Key.new(parts[0], parts[1])
    end

    # An rtsk_ secret is a private key: every call that authorizes with the
    # API key goes through +authorize+ (signs) or +bearer_key+ (refuses it),
    # so it is never sent, whatever the call.

    # Whether +key+ is a key pair's secret (rtsk_): a private key, which signs
    # requests and is never sent.
    def signing_key?(key) = key.to_s.start_with?(PREFIX)

    # +key+, for a call that can only send a bearer key (another platform's
    # SDK pointed at Runtime). A key pair's secret is never sent: raises for
    # one, before anything leaves this machine.
    def bearer_key(key, what)
      return key unless signing_key?(key)

      raise Error.new("#{what} sends the API key as a bearer token, and this key is a key pair's private key (rtsk_), " \
                      "which is never sent. Nothing was sent.",
                      code: "invalid_request", hint: "Use a bearer API key (rtkey_) here; the SDK's own calls sign with the rtsk_ key.")
    end

    # The key pair in +key+, or nil for a bearer key. Raises for a malformed
    # rtsk_ secret, or one with no +project+ to sign for: callers check before
    # sending anything.
    def key_for(key, project)
      return nil unless signing_key?(key)

      signing = (@parsed ||= {})[key] ||= parse(key)
      unless signing
        raise Error.new("The API key starts with rtsk_ but is not a key pair's secret (rtsk_<32 hex>_<64 hex>). Nothing was sent.",
                        code: "invalid_request", hint: "Use the whole secret, as WithRuntime::Signing.secret wrote it.")
      end
      unless ID.match?(project.to_s)
        raise Error.new("A signing key (rtsk_) signs each request for one project, and none was given. Nothing was sent.",
                        code: "invalid_request", hint: "Set RUNTIME_PROJECT to the project's 32-character ID, or pass project:.")
      end
      signing
    end

    # The headers that authorize one attempt with +key+: a key pair's
    # signature, else Authorization: Bearer. Raises, sending nothing, for a
    # malformed rtsk_ secret or one with no project. Call it for each attempt:
    # the server takes a nonce once.
    def authorize(key, project, method, target, body = nil, idempotency_key: nil)
      signing = key_for(key, project)
      # The project goes with every call, a bearer key's too: a key that
      # reaches the whole org would otherwise list, change and delete in
      # every project.
      return { "Authorization" => "Bearer #{key}" }.merge(project ? { "Runtime-Project" => project } : {}) unless signing

      signing.sign_request(project, method, target, body, idempotency_key: idempotency_key)
    end
  end
end
