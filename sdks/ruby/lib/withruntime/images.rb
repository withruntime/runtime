# frozen_string_literal: true

require "digest"

module WithRuntime
  # +runtime.images+: custom images. Build one, then start sandboxes from it
  # with +runtime.sandboxes.create(image: "app")+.
  #
  #   runtime.images.build(name: "app", recipe: { pip: ["pandas"] })
  #   runtime.images.build(name: "app", dockerfile: File.read("Dockerfile"), context_dir: ".")
  class Images < Product
    UUID = /\A[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\z/i
    CONTEXT_BYTES = 100 * 1_048_576
    CONTEXT_FILES = 20_000
    CHUNK = 1_048_576

    # Queues a build and returns at once, in state "queued". Exactly one of
    # +image:+, +dockerfile:+ or +recipe:+. With +context_dir:+ the folder is
    # packed and its missing chunks uploaded first.
    def create(context_dir: nil, idempotency_key: nil, **fields)
      Record.new(@t.json("POST", "/v1/images", body: prepare(context_dir, fields), key: idempotency_key))
    end

    # Builds and waits until the image is ready, sending each log line to the
    # block. Raises with code image_failed, and the build's own error, when it fails.
    def build(context_dir: nil, idempotency_key: nil, **fields, &on_log)
      image = create(context_dir: context_dir, idempotency_key: idempotency_key, **fields)
      image = follow_logs(image.id, &on_log) if on_log
      while %w[queued building].include?(image.state)
        sleep 1
        image = get(image.id)
      end
      unless image.state == "ready"
        raise Error.new("Image #{image.id} #{image.state}: #{image.error || "no error given"}", code: "image_failed",
                                                                                                 hint: "Read the build log with runtime.images.logs(id).")
      end

      image
    end

    def get(id) = Record.new(@t.json("GET", "/v1/images/#{seg(id)}"))

    # An image by id, name (its latest tag), name:tag or name@version.
    def resolve(ref) = UUID.match?(ref) ? get(ref) : Record.new(@t.json("GET", "/v1/images/resolve", query: { "ref" => ref }))

    # Build output after line +after+: lines, next_after, state, truncated and done.
    def logs(id, after: 0) = Record.new(@t.json("GET", "/v1/images/#{seg(id)}/logs", query: { "after" => after }))

    # Sends build output after line +after+ to the block as it is written,
    # until the build ends, and returns the image as it ended. It streams, and
    # polls when a stream breaks.
    def follow_logs(id, after: 0)
      begin
        loop do
          resume = false
          @t.events("GET", "/v1/images/#{seg(id)}/logs", query: { "after" => after, "follow" => "true" }, timeout: 180) do |event|
            case event["type"]
            when "line"
              yield Record.new(event)
              after = event["seq"]
            when "done" then return event["image"].is_a?(Hash) && event["image"]["id"] ? Record.new(event["image"]) : get(id)
            when "continue"
              after = event["after"]
              resume = true
            when "error" then raise Error.new(event.dig("error", "message") || "The log stream failed.", code: event.dig("error", "code") || "stream_failed")
            end
          end
          break unless resume
        end
      rescue ConnectionError
        nil # Fall through to polling.
      end
      loop do
        page = logs(id, after: after)
        Array(page["lines"]).each { |line| yield Record.new(line) }
        after = page["nextAfter"]
        image = get(id)
        return image if page["done"] || !%w[queued building].include?(image.state)

        sleep 1
      end
    end

    def list(state: nil, name: nil, limit: nil) = page("/v1/images", { "state" => state, "name" => name, "limit" => limit })

    # Every version of a name, newest first.
    def versions(name) = list(name: name, limit: 100)

    # Points +tag+ of the image's name at this version (+ref+ is an id, name:tag or name@version).
    def tag(ref, tag) = Record.new(@t.json("POST", "/v1/images/#{seg(id_of(ref))}:tag", body: { "tag" => tag }))
    def untag(ref, tag) = Record.new(@t.json("POST", "/v1/images/#{seg(id_of(ref))}:untag", body: { "tag" => tag }))

    # Deletes one version and its tags.
    def delete(ref) = Record.new(@t.json("POST", "/v1/images/#{seg(id_of(ref))}:delete", body: {}))

    # Saved credentials for private registries. The secret is never returned.
    def registries = @t.json("GET", "/v1/images/registries")["data"].map { |registry| Record.new(registry) }

    # A user name and token or password (Docker Hub, GitHub, Google with
    # username _json_key), or +access_key_id:+ and +secret_access_key:+ for Amazon ECR.
    def set_registry(registry, username: nil, password: nil, access_key_id: nil, secret_access_key: nil)
      body = Fields.body(registry: registry, username: username, password: password, access_key_id: access_key_id,
                         secret_access_key: secret_access_key)
      Record.new(@t.json("POST", "/v1/images/registries", body: body))
    end

    def delete_registry(registry) = @t.json("POST", "/v1/images/registries:delete", body: { "registry" => registry })["deleted"] == true

    # Packs a folder as a build context, the way docker build does (its
    # .dockerignore applied, .git left out when there is none), and uploads the
    # chunks the server does not have yet. Returns the context and the
    # .dockerignore to build with.
    def upload_context(folder, dockerignore: nil)
      archive, files, applied = self.class.pack(folder, dockerignore)
      chunks = (0...archive.bytesize).step(CHUNK).map { |at| archive.byteslice(at, CHUNK) }
      digests = chunks.map { |chunk| Digest::SHA256.hexdigest(chunk) }
      missing = @t.json("POST", "/v1/images/context/missing", body: { "digests" => digests })["missing"]
      queue = Queue.new
      digests.each_with_index { |digest, index| queue << index if missing.include?(digest) }
      queue.close
      failure = nil
      Array.new(4) do
        Thread.new do
          while !failure && (index = queue.pop)
            begin
              @t.json("PUT", "/v1/images/context/#{digests[index]}", raw: chunks[index])
            rescue StandardError => e
              failure ||= e
            end
          end
        end
      end.each(&:join)
      raise failure if failure

      { "context" => { "archive" => { "sha256" => Digest::SHA256.hexdigest(archive), "size" => archive.bytesize, "chunks" => digests },
                       "files" => files },
        "dockerignore" => applied }
    end

    # A deterministic gzipped tar of the folder (sorted, no times, no owners,
    # no links) and its files with their SHA-256.
    def self.pack(folder, dockerignore = nil)
      root = File.expand_path(folder)
      ignore_file = File.join(root, ".dockerignore")
      dockerignore ||= File.read(ignore_file) if File.file?(ignore_file)
      ignored = dockerignore_filter(dockerignore || ".git\n")
      reincludes = dockerignore.to_s.match?(/^\s*!/)
      tar = "".b
      files = []
      walk = lambda do |directory|
        Dir.children(directory).sort.each do |name|
          full = File.join(directory, name)
          relative = full.delete_prefix("#{root}/")
          stat = File.lstat(full)
          if stat.directory?
            walk.call(full) unless ignored.call(relative) && !reincludes
          elsif stat.file? && !ignored.call(relative)
            raise Error.new("The build context has more than #{CONTEXT_FILES} files.", code: "context_too_large", hint: "Leave some out with a .dockerignore.") if files.size >= CONTEXT_FILES

            data = File.binread(full)
            mode = stat.mode & 0o777
            files << { "path" => relative, "sha256" => Digest::SHA256.hexdigest(data), "size" => data.bytesize, "mode" => mode }
            tar << Tar.header(relative, data.bytesize, mode, "0") << data << Tar.pad(data.bytesize)
          end
        end
      end
      walk.call(root)
      archive = Tar.gzip(tar << ("\0".b * 1024))
      if archive.bytesize > CONTEXT_BYTES
        raise Error.new("The build context is #{(archive.bytesize / 1_048_576) + 1} MiB compressed; the most is 100 MiB.",
                        code: "context_too_large", hint: "Leave build outputs and dependencies out with a .dockerignore.")
      end

      [archive, files, dockerignore]
    end

    # A .dockerignore as Docker reads it: # comments, ! re-includes, **
    # crosses directories, a pattern naming a directory excludes what is in it,
    # and the last matching pattern decides.
    def self.dockerignore_filter(text)
      rules = text.gsub(/\r\n?/, "\n").split("\n").filter_map do |raw|
        line = raw.strip
        next if line.empty? || line.start_with?("#")

        negate = line.start_with?("!")
        line = line[1..].strip if negate
        line = normalize(line.sub(%r{\A/+}, "")).sub(%r{/+\z}, "")
        next if line.empty? || line == "."

        [negate, Regexp.new("\\A#{translate(line)}\\z")]
      end
      lambda do |path|
        parts = path.split("/")
        rules.reduce(false) do |excluded, (negate, regex)|
          parts.length.downto(1).any? { |n| regex.match?(parts[0, n].join("/")) } ? !negate : excluded
        end
      end
    end

    def self.translate(line)
      source = +""
      i = 0
      while i < line.length
        char = line[i]
        if char == "*" && line[i + 1] == "*"
          if line[i + 2] == "/"
            source << "(?:.*/)?"
            i += 2
          else
            source << ".*"
            i += 1
          end
        elsif char == "*" then source << "[^/]*"
        elsif char == "?" then source << "[^/]"
        elsif char == "["
          close = line.index("]", i + 1)
          if close.nil?
            source << "\\["
          else
            set = line[(i + 1)...close]
            set = "^#{set[1..]}" if set.start_with?("!")
            source << "[#{set.gsub("\\", "\\\\\\\\")}]"
            i = close
          end
        elsif char == "\\" && i + 1 < line.length
          i += 1
          source << Regexp.escape(line[i])
        else
          source << Regexp.escape(char)
        end
        i += 1
      end
      source
    end

    def self.normalize(path)
      out = []
      path.split("/").each do |part|
        next if part.empty? || part == "."

        part == ".." ? out.pop : out.push(part)
      end
      out.empty? ? "." : out.join("/")
    end

    private

    def id_of(ref) = UUID.match?(ref) ? ref : resolve(ref).id

    def prepare(context_dir, fields)
      body = Fields.body(fields)
      return body unless context_dir

      uploaded = upload_context(context_dir, dockerignore: body["dockerignore"])
      body.merge("context" => uploaded["context"], "dockerignore" => uploaded["dockerignore"]).compact
    end
  end
end
