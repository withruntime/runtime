# frozen_string_literal: true

require "digest"
require "json"
require "uri"

module WithRuntime
  # The key `runtime login` saved for this machine. Its file is the CLI's
  # (packages/cloud-sdk/src/credentials.ts) and is read exactly as the CLI
  # reads it: only from a private file in a private directory, bound to both
  # origins.
  module Credentials
    KEY = /\Artcloud_[a-f0-9-]{36}_[A-Za-z0-9_-]{43}\z/

    BAD_ORIGIN = "Use an HTTPS API origin (or http://runtime.internal inside a sandbox, http://localhost for tests)."
    # Runtime's API as code inside a Runtime sandbox reaches it: the sandbox's
    # own host sends each request on to the public API over HTTPS. The API runs
    # on that host, whose addresses a sandbox cannot reach directly. Plain HTTP
    # because the hop never leaves the machine: from the program to the guest's
    # own proxy, then over the sandbox's private channel to its host.
    SANDBOX_BASE_URL = "http://runtime.internal"
    # A file every Runtime sandbox has; the guest keeps it current.
    SANDBOX_MARKER = "/run/runtime/environment.json"

    module_function

    def in_runtime_sandbox?(marker = SANDBOX_MARKER)
      File.exist?(marker)
    end

    # The origin calls for +api_origin+ are sent to from here. In a sandbox the
    # public API is its own host, which it cannot reach directly, so calls for
    # it go to runtime.internal; every other origin is left as it is.
    def reachable(api_origin, in_sandbox: -> { in_runtime_sandbox? })
      api_origin == DEFAULT_BASE_URL && in_sandbox.call ? SANDBOX_BASE_URL : api_origin
    end

    # An HTTPS origin, plain HTTP to runtime.internal inside a sandbox, or plain
    # HTTP to localhost for tests, with nothing after the host. runtime.internal
    # is reserved and never resolves outside a sandbox, so a key sent there in
    # plain HTTP never leaves the sandbox's host.
    def origin(value)
      uri = URI(value)
      internal = uri.host == "runtime.internal"
      local = %w[localhost 127.0.0.1 [::1] ::1].include?(uri.host) || internal
      unless uri.host && (uri.scheme == "https" || (local && uri.scheme == "http")) && uri.userinfo.nil? &&
             uri.query.nil? && uri.fragment.nil? && ["", "/"].include?(uri.path.to_s) &&
             !(internal && (uri.scheme != "http" || uri.port != 80))
        raise ArgumentError, BAD_ORIGIN
      end

      default_port = uri.scheme == "https" ? 443 : 80
      host = uri.host.include?(":") && !uri.host.start_with?("[") ? "[#{uri.host}]" : uri.host
      "#{uri.scheme}://#{host}#{uri.port == default_port ? "" : ":#{uri.port}"}"
    rescue URI::InvalidURIError
      raise ArgumentError, BAD_ORIGIN
    end

    # Where the CLI keeps this machine's connection for the two origins.
    def file(env, api_origin, auth_origin)
      root = env["XDG_CONFIG_HOME"]
      root = File.join(Dir.home, ".config") if root.nil? || root.empty?
      raise ArgumentError, "XDG_CONFIG_HOME must be an absolute path." unless root.start_with?("/")

      File.join(root, "runtime-cloud", "#{Digest::SHA256.hexdigest("#{auth_origin}\n#{api_origin}")}.json")
    end

    # The saved key, or nil when there is none.
    def saved_key(env, api_origin)
      auth = env["RUNTIME_AUTH_URL"]
      auth_origin = origin(auth.nil? || auth.empty? ? "https://withruntime.com" : auth)
      path = file(env, api_origin, auth_origin)
      directory = File.dirname(path)
      begin
        info = File.lstat(directory)
      rescue Errno::ENOENT
        return nil
      end
      raise SecurityError, "Runtime's credential directory must be private to your user." unless info.directory? && private?(info)

      text = begin
        File.open(path, File::RDONLY | File::NOFOLLOW) do |handle|
          stat = handle.stat
          raise SecurityError, "Runtime's saved connection must be private to your user." unless stat.file? && stat.size <= 4096 && private?(stat)

          handle.read(4097)
        end
      rescue Errno::ENOENT
        return nil
      rescue Errno::ELOOP
        raise SecurityError, "Could not safely open Runtime's saved connection."
      end
      saved = JSON.parse(text)
      unless saved.is_a?(Hash) && saved["version"] == 1 && saved["apiOrigin"] == api_origin &&
             saved["authOrigin"] == auth_origin && saved["key"].is_a?(String) && KEY.match?(saved["key"]) &&
             %w[connectionId orgId agentName].all? { |name| saved[name].is_a?(String) }
        raise ArgumentError, "Runtime's saved connection is invalid. Connect again with `npx withruntime login`."
      end

      saved["key"]
    rescue JSON::ParserError
      raise ArgumentError, "Runtime's saved connection is invalid. Connect again with `npx withruntime login`."
    end

    def private?(stat)
      return true if Gem.win_platform?

      (stat.mode & 0o077).zero? && stat.uid == Process.uid
    end
  end
end
