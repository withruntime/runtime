# frozen_string_literal: true

require "fileutils"
require "stringio"
require "tmpdir"
require "zlib"

module WithRuntime
  # A small ustar writer and reader for directory uploads, downloads and build contexts.
  module Tar
    module_function

    def header(name, size, mode, type, mtime = 0)
      bytes = name.b
      prefix = "".b
      if bytes.bytesize > 100
        split = name.rindex("/", 155)
        raise ArgumentError, "Path too long for a tar archive: #{name}" if split.nil? || split <= 0 || name[(split + 1)..].bytesize > 100

        prefix = name[0, split].b
        bytes = name[(split + 1)..].b
      end
      block = "\0".b * 512
      put = ->(offset, value, length) { block[offset, [length, value.bytesize].min] = value.b[0, length] }
      octal = ->(value, length) { "#{value.to_s(8).rjust(length - 1, "0")}\0" }
      put.call(0, bytes, 100)
      put.call(100, octal.call(mode & 0o7777, 8), 8)
      put.call(108, octal.call(0, 8), 8)
      put.call(116, octal.call(0, 8), 8)
      put.call(124, octal.call(size, 12), 12)
      put.call(136, octal.call(mtime, 12), 12)
      put.call(148, " " * 8, 8)
      put.call(156, type, 1)
      put.call(257, "ustar\u000000", 8)
      put.call(345, prefix, 155)
      put.call(148, "#{block.sum(64).to_s(8).rjust(6, "0")}\0 ", 8)
      block
    end

    def pad(size) = "\0".b * ((512 - (size % 512)) % 512)

    def gzip(data)
      out = StringIO.new("".b)
      writer = Zlib::GzipWriter.new(out, 6)
      writer.mtime = 0
      writer.write(data)
      writer.close
      out.string
    end

    # A directory as a gzipped tar: directories and regular files; links stay behind.
    def pack_directory(root)
      tar = "".b
      base = File.expand_path(root)
      Dir.glob("**/*", File::FNM_DOTMATCH, base: base).sort.each do |relative|
        next if relative.split("/").any? { |part| [".", ".."].include?(part) }

        full = File.join(base, relative)
        stat = File.lstat(full)
        if stat.directory?
          tar << header("#{relative}/", 0, stat.mode, "5", stat.mtime.to_i)
        elsif stat.file?
          data = File.binread(full)
          tar << header(relative, data.bytesize, stat.mode, "0", stat.mtime.to_i) << data << pad(data.bytesize)
        end
      end
      gzip(tar << ("\0".b * 1024))
    end

    # A folder that did not arrive whole: tar in the sandbox stopped part way
    # (a file it may not read, one that changed as it was read), which ends
    # the gzip stream short, or the connection was lost.
    def cut_short
      Error.new("The folder's archive arrived cut short: tar in the sandbox stopped part way, or the " \
                "connection was lost. Nothing was written.",
                code: "download_incomplete",
                hint: "Try again. If it fails the same way, a file in the folder cannot be read by the " \
                      "sandbox user or changes as it is read.")
    end

    # Unpacks a whole gzipped tar held in memory into target, by Unpacker's rules.
    def unpack(archive, target)
      unpacker = Unpacker.new(target)
      begin
        unpacker.feed(archive)
        unpacker.finish
      ensure
        unpacker.discard
      end
    end

    # Unpacks a gzipped tar fed to it a chunk at a time into a target folder,
    # holding no more than a chunk. Entries land only inside the target, and
    # symbolic links are not made; a hard link lands as the file it names. It unpacks into a folder beside the target and moves
    # it into place only once the whole archive arrived (+finish+), so an
    # archive cut short leaves nothing behind that could pass for the folder.
    # A target that exists is merged into, files of the same name replaced,
    # never through a link in it. +discard+ removes what was unpacked if
    # +finish+ was never reached.
    class Unpacker
      def initialize(target)
        @final = File.expand_path(target)
        FileUtils.mkdir_p(File.dirname(@final))
        @staging = Dir.mktmpdir("#{File.basename(@final)}.runtime-partial-", File.dirname(@final))
        @root = File.realpath(@staging)
        @inflate = Zlib::Inflate.new(Zlib::MAX_WBITS + 16)
        @held = "".b
        @entry = nil
        @left = 0
        @padding = 0
        @long = nil
        @long_link = nil
        @ended = false
      end

      def feed(data)
        begin
          @held << @inflate.inflate(data)
        rescue Zlib::Error
          raise Tar.cut_short
        end
        nil while step
      end

      # Checks the archive arrived whole, then puts it in place.
      def finish
        raise Tar.cut_short unless @inflate.finished? && @ended

        if File.exist?(@final) || File.symlink?(@final)
          final = File.realpath(@final)
          merge(@root, final, final)
        else
          File.rename(@staging, @final)
        end
      end

      def discard
        @entry[:file]&.close if @entry.is_a?(Hash)
        FileUtils.rm_rf(@staging)
      end

      private

      def step
        if @ended
          @held.clear
          return false
        end
        if @entry.nil?
          return false if @held.bytesize < 512

          header = @held.slice!(0, 512)
          if header.count("\0") == 512
            @ended = true
          else
            begin_entry(header)
          end
          return true
        end
        if @left.positive?
          return false if @held.empty?

          part = @held.slice!(0, @left)
          @left -= part.bytesize
          @entry[:file]&.write(part)
          @entry[:long]&.<<(part)
          return false if @left.positive?

          end_body
          return true
        end
        if @padding.positive?
          return false if @held.empty?

          @padding -= @held.slice!(0, @padding).bytesize
          return false if @padding.positive?
        end
        @entry = nil
        true
      end

      def field(header, start, length) = header[start, length].split("\0", 2).first.to_s.force_encoding("UTF-8")

      def begin_entry(header)
        size = if header.getbyte(124) & 0x80 != 0
                 header[125, 11].bytes.inject(0) { |sum, byte| (sum << 8) | byte }
               else
                 field(header, 124, 12).strip.then { |text| text.empty? ? 0 : text.to_i(8) }
               end
        type = header[156]
        prefix = field(header, 345, 155)
        name = @long || (prefix.empty? ? field(header, 0, 100) : "#{prefix}/#{field(header, 0, 100)}")
        link = @long_link || field(header, 157, 100)
        @long = nil
        @long_link = nil
        @long_link = nil
        mode = field(header, 100, 8).strip.then { |text| text.empty? ? 0o644 : text.to_i(8) }
        @left = size
        @padding = -size % 512
        @entry = {}
        if %w[L K x].include?(type)
          @entry = { long: "".b, type: type }
        else
          name = name.delete_prefix("./")
          unless name.empty? || name == "." || name == "./"
            destination = File.expand_path(name, @root)
            raise IOError, "Refusing an archive entry outside the target: #{name}" unless destination.start_with?("#{@root}/")

            case type
            when "5" then FileUtils.mkdir_p(destination)
            when "1" then hard_link(destination, link, name)
            when "0", "\0", "7"
              FileUtils.mkdir_p(File.dirname(destination))
              # A name already unpacked may share its file with a hard link;
              # writing through it would change the link's copy too.
              File.unlink(destination) if File.exist?(destination) || File.symlink?(destination)
              @entry = { file: File.open(destination, "wb"), path: destination, mode: mode }
            end
          end
        end
        end_body if @left.zero?
      end

      def end_body
        if @entry[:file]
          @entry[:file].close
          File.chmod(@entry[:mode] & 0o777, @entry[:path])
        elsif @entry[:long]
          body = @entry[:long]
          case @entry[:type]
          when "L" then @long = body.split("\0", 2).first.force_encoding("UTF-8")
          when "K" then @long_link = body.split("\0", 2).first.force_encoding("UTF-8")
          else @long = pax_path(body)
          end
        end
        @entry = {}
      end

      # A second name for a file the archive already carried: tar writes the
      # first name as a file and every other as a hard link to it. The link
      # names a plain file unpacked earlier in this archive, or the unpack
      # fails; it never reaches outside or ahead.
      def hard_link(destination, link, name)
        source = File.expand_path(link.delete_prefix("./"), @root)
        unless source.start_with?("#{@root}/") && !link.start_with?("/")
          raise IOError, "Refusing an archive hard link that leads outside the target: #{name} -> #{link}"
        end
        unless File.file?(source) && !File.symlink?(source)
          raise IOError, "Refusing an archive hard link to a file it does not carry: #{name} -> #{link}"
        end
        return if source == destination

        FileUtils.mkdir_p(File.dirname(destination))
        File.unlink(destination) if File.exist?(destination) || File.symlink?(destination)
        begin
          File.link(source, destination)
        rescue SystemCallError
          FileUtils.cp(source, destination, preserve: true)
        end
      end

      # A pax header's path record, if it has one.
      def pax_path(body)
        until body.empty?
          length = body[/\A\d+/].to_i
          key, value = body[0, length].split(" ", 2).last.chomp.split("=", 2)
          return value.force_encoding("UTF-8") if key == "path"

          body = body[length..]
        end
        nil
      end

      def merge(from, to, root)
        Dir.children(from).each do |name|
          source = File.join(from, name)
          destination = File.join(to, name)
          through = destination.delete_prefix("#{root}/").split("/").each_with_object([root]) { |part, way| way << File.join(way.last, part) }
          if through.drop(1).any? { |path| File.symlink?(path) }
            raise IOError, "Refusing an archive entry that passes through a link: #{destination.delete_prefix("#{root}/")}"
          end

          if File.directory?(source) && File.directory?(destination)
            merge(source, destination, root)
          else
            File.rename(source, destination)
          end
        end
      end
    end
  end
end
