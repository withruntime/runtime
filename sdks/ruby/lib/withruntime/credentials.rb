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

    module_function

    # An HTTPS origin, or plain HTTP to localhost for tests, with nothing after the host.
    def origin(value)
      uri = URI(value)
      local = %w[localhost 127.0.0.1 [::1] ::1].include?(uri.host)
      unless uri.host && (uri.scheme == "https" || (local && uri.scheme == "http")) && uri.userinfo.nil? &&
             uri.query.nil? && uri.fragment.nil? && ["", "/"].include?(uri.path.to_s)
        raise ArgumentError, "Use an HTTPS API origin (or http://localhost for tests)."
      end

      default_port = uri.scheme == "https" ? 443 : 80
      host = uri.host.include?(":") && !uri.host.start_with?("[") ? "[#{uri.host}]" : uri.host
      "#{uri.scheme}://#{host}#{uri.port == default_port ? "" : ":#{uri.port}"}"
    rescue URI::InvalidURIError
      raise ArgumentError, "Use an HTTPS API origin (or http://localhost for tests)."
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
