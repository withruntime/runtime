# frozen_string_literal: true

require "stringio"
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

    # Unpacks a gzipped tar into target, refusing any entry that would land outside it, and links.
    def unpack(archive, target)
      data = Zlib::GzipReader.new(StringIO.new(archive)).read.b
      root = File.expand_path(target)
      FileUtils.mkdir_p(root)
      field = ->(start, length) { data[start, length].split("\0", 2).first.to_s.force_encoding("UTF-8") }
      offset = 0
      long_name = nil
      while offset + 512 <= data.bytesize
        break if data[offset, 512].count("\0") == 512

        size = field.call(offset + 124, 12).strip.then { |text| text.empty? ? 0 : text.to_i(8) }
        type = data[offset + 156]
        prefix = field.call(offset + 345, 155)
        name = long_name || (prefix.empty? ? field.call(offset, 100) : "#{prefix}/#{field.call(offset, 100)}")
        long_name = nil
        mode = field.call(offset + 100, 8).strip.then { |text| text.empty? ? 0o644 : text.to_i(8) }
        body = data[offset + 512, size]
        offset += 512 + (((size + 511) / 512) * 512)
        if type == "L"
          long_name = body.split("\0", 2).first.force_encoding("UTF-8")
          next
        end
        name = name.delete_prefix("./")
        next if name.empty? || name == "." || name == "./"

        destination = File.expand_path(name, root)
        raise IOError, "Refusing an archive entry outside the target: #{name}" unless destination.start_with?("#{root}/")

        case type
        when "5" then FileUtils.mkdir_p(destination)
        when "0", "\0", "7"
          FileUtils.mkdir_p(File.dirname(destination))
          File.binwrite(destination, body)
          File.chmod(mode & 0o777, destination)
        end
      end
    end
  end
end
