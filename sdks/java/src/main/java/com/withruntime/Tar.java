package com.withruntime;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermission;
import java.util.List;
import java.util.Set;
import java.util.stream.Stream;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;

/** A small ustar writer and reader for folder uploads, downloads and build contexts. */
final class Tar {
  private Tar() {}

  static byte[] header(String name, long size, int mode, char type, long mtime) {
    byte[] block = new byte[512];
    byte[] bytes = name.getBytes(StandardCharsets.UTF_8);
    byte[] prefix = new byte[0];
    byte[] shortName = bytes;
    if (bytes.length > 100) {
      int split = name.lastIndexOf('/', 155);
      if (split <= 0 || name.substring(split + 1).getBytes(StandardCharsets.UTF_8).length > 100)
        throw new IllegalArgumentException("Path too long for a tar archive: " + name);
      prefix = name.substring(0, split).getBytes(StandardCharsets.UTF_8);
      shortName = name.substring(split + 1).getBytes(StandardCharsets.UTF_8);
    }
    put(block, 0, shortName, 100);
    put(block, 100, octal(mode & 07777, 8), 8);
    put(block, 108, octal(0, 8), 8);
    put(block, 116, octal(0, 8), 8);
    put(block, 124, octal(size, 12), 12);
    put(block, 136, octal(mtime, 12), 12);
    put(block, 148, "        ".getBytes(StandardCharsets.US_ASCII), 8);
    block[156] = (byte) type;
    put(block, 257, "ustar\u000000".getBytes(StandardCharsets.US_ASCII), 8);
    put(block, 345, prefix, 155);
    long sum = 0;
    for (byte b : block) sum += b & 0xff;
    put(block, 148, (String.format("%06o", sum) + "\0 ").getBytes(StandardCharsets.US_ASCII), 8);
    return block;
  }

  private static byte[] octal(long value, int length) {
    String text = Long.toOctalString(value);
    StringBuilder padded = new StringBuilder();
    for (int i = text.length(); i < length - 1; i++) padded.append('0');
    return (padded + text + "\0").getBytes(StandardCharsets.US_ASCII);
  }

  private static void put(byte[] block, int offset, byte[] value, int length) {
    System.arraycopy(value, 0, block, offset, Math.min(length, value.length));
  }

  static void pad(ByteArrayOutputStream out, long size) {
    int pad = (int) ((512 - (size % 512)) % 512);
    out.write(new byte[pad], 0, pad);
  }

  static int mode(Path path) {
    try {
      Set<PosixFilePermission> permissions = Files.getPosixFilePermissions(path, LinkOption.NOFOLLOW_LINKS);
      int mode = 0;
      for (PosixFilePermission permission : permissions) mode |= 1 << (8 - permission.ordinal());
      return mode;
    } catch (UnsupportedOperationException | IOException windows) {
      return Files.isDirectory(path) ? 0755 : 0644;
    }
  }

  static byte[] gzip(byte[] data) {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    try (GZIPOutputStream zipped = new GZIPOutputStream(out)) {
      zipped.write(data);
    } catch (IOException impossible) {
      throw new UncheckedIOException(impossible);
    }
    return out.toByteArray();
  }

  /** A directory as a gzipped tar: directories and regular files; links stay behind. */
  static byte[] packDirectory(Path root) throws IOException {
    ByteArrayOutputStream tar = new ByteArrayOutputStream();
    List<Path> paths;
    try (Stream<Path> walk = Files.walk(root)) {
      paths = walk.sorted().toList();
    }
    for (Path path : paths) {
      if (path.equals(root)) continue;
      String name = root.relativize(path).toString().replace('\\', '/');
      long mtime = Files.getLastModifiedTime(path, LinkOption.NOFOLLOW_LINKS).toMillis() / 1000;
      if (Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)) {
        tar.writeBytes(header(name + "/", 0, mode(path), '5', mtime));
      } else if (Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
        byte[] data = Files.readAllBytes(path);
        tar.writeBytes(header(name, data.length, mode(path), '0', mtime));
        tar.writeBytes(data);
        pad(tar, data.length);
      }
    }
    tar.write(new byte[1024], 0, 1024);
    return gzip(tar.toByteArray());
  }

  /**
   * A folder that did not arrive whole: tar in the sandbox stopped part way (a file it may not
   * read, one that changed as it was read), which ends the gzip stream short, or the connection was
   * lost (ARCHITECTURE.md section 10, "Folders over HTTP").
   */
  static RuntimeCloudException cutShort(Throwable cause) {
    return new RuntimeCloudException(
        "The folder's archive arrived cut short: tar in the sandbox stopped part way, or the"
            + " connection was lost. Nothing was written.",
        "download_incomplete",
        0,
        "Try again. If it fails the same way, a file in the folder cannot be read by the sandbox"
            + " user or changes as it is read.",
        null,
        null,
        null,
        null,
        cause);
  }

  /** Unpacks a whole gzipped tar held in memory, by the rules of the streamed one. */
  static void unpack(byte[] archive, Path target) throws IOException {
    unpack(new ByteArrayInputStream(archive), target);
  }

  /**
   * Unpacks a gzipped tar that arrives as a stream into target, holding no more than a read at a
   * time. Entries land only inside target, and links are not made. It unpacks into a folder beside
   * target and moves it into place only once the whole archive arrived, its end blocks and gzip's
   * checksum included, so an archive cut short leaves nothing behind that could pass for the
   * folder: it is {@code download_incomplete}. A target that exists is merged into, files of the
   * same name replaced, never through a link in it.
   */
  static void unpack(InputStream source, Path target) throws IOException {
    Path destination = target.toAbsolutePath().normalize();
    Path parent = destination.getParent();
    Files.createDirectories(parent);
    Path staging =
        Files.createTempDirectory(parent, destination.getFileName() + ".runtime-partial-");
    try {
      InputStream in;
      try {
        in = new GZIPInputStream(source, 1 << 16);
      } catch (IOException cut) {
        throw cutShort(cut);
      }
      unpackEntries(in, staging.toRealPath());
      if (!Files.exists(destination, LinkOption.NOFOLLOW_LINKS)) {
        try {
          Files.setPosixFilePermissions(staging, permissions(0755));
        } catch (UnsupportedOperationException windows) {
          // The file system keeps its own permissions.
        }
        Files.move(staging, destination);
      } else {
        Path real = destination.toRealPath();
        merge(staging, real, real);
      }
    } finally {
      deleteTree(staging);
    }
  }

  /** Exactly n bytes, or fewer at the stream's end; a failed read is the archive cut short. */
  private static byte[] take(InputStream in, int n) {
    try {
      return in.readNBytes(n);
    } catch (IOException cut) {
      throw cutShort(cut);
    }
  }

  private static void unpackEntries(InputStream in, Path root) throws IOException {
    String longName = null;
    for (; ; ) {
      byte[] header = take(in, 512);
      if (header.length < 512) throw cutShort(null);
      boolean empty = true;
      for (int i = 0; i < 512 && empty; i++) empty = header[i] == 0;
      if (empty) {
        // Read to gzip's end, so its checksum is checked.
        try {
          in.transferTo(java.io.OutputStream.nullOutputStream());
        } catch (IOException cut) {
          throw cutShort(cut);
        }
        return;
      }
      String sizeText = field(header, 124, 12).trim();
      long size = sizeText.isEmpty() ? 0 : Long.parseLong(sizeText, 8);
      long padding = (512 - size % 512) % 512;
      char type = (char) header[156];
      String prefix = field(header, 345, 155);
      String name =
          longName != null
              ? longName
              : prefix.isEmpty() ? field(header, 0, 100) : prefix + "/" + field(header, 0, 100);
      longName = null;
      String modeText = field(header, 100, 8).trim();
      int mode = modeText.isEmpty() ? 0644 : Integer.parseInt(modeText, 8);
      if (type == 'L') {
        byte[] value = take(in, (int) size);
        if (value.length < size) throw cutShort(null);
        longName = new String(value, StandardCharsets.UTF_8).replaceAll("\0.*$", "");
        skip(in, padding);
        continue;
      }
      if (name.startsWith("./")) name = name.substring(2);
      Path destination = root.resolve(name).normalize();
      if (name.isEmpty() || name.equals(".") || name.equals("./")) {
        skip(in, size + padding);
        continue;
      }
      if (!destination.startsWith(root) || destination.equals(root))
        throw new IOException("Refusing an archive entry outside the target: " + name);
      if (type == '5') {
        Files.createDirectories(destination);
        skip(in, size + padding);
      } else if (type == '0' || type == '\0' || type == '7') {
        Files.createDirectories(destination.getParent());
        try (java.io.OutputStream out = Files.newOutputStream(destination)) {
          for (long left = size; left > 0; ) {
            byte[] part = take(in, (int) Math.min(left, 1 << 16));
            if (part.length == 0) throw cutShort(null);
            out.write(part);
            left -= part.length;
          }
        }
        try {
          Files.setPosixFilePermissions(destination, permissions(mode & 0777));
        } catch (UnsupportedOperationException windows) {
          // The file system keeps its own permissions.
        }
        skip(in, padding);
      } else {
        skip(in, size + padding);
      }
    }
  }

  private static void skip(InputStream in, long n) {
    for (long left = n; left > 0; ) {
      byte[] part = take(in, (int) Math.min(left, 1 << 16));
      if (part.length == 0) throw cutShort(null);
      left -= part.length;
    }
  }

  /**
   * Moves what was unpacked in from into to, merging with what is there and replacing files of the
   * same name, never through a link in to.
   */
  private static void merge(Path from, Path to, Path root) throws IOException {
    List<Path> entries;
    try (Stream<Path> listed = Files.list(from)) {
      entries = listed.toList();
    }
    for (Path source : entries) {
      Path destination = to.resolve(source.getFileName().toString());
      if (Files.isSymbolicLink(destination))
        throw new IOException(
            "Refusing an archive entry that passes through a link: " + root.relativize(destination));
      if (Files.isDirectory(source, LinkOption.NOFOLLOW_LINKS)
          && Files.isDirectory(destination, LinkOption.NOFOLLOW_LINKS)) merge(source, destination, root);
      else Files.move(source, destination, StandardCopyOption.REPLACE_EXISTING);
    }
  }

  private static void deleteTree(Path root) throws IOException {
    if (!Files.exists(root, LinkOption.NOFOLLOW_LINKS)) return;
    List<Path> paths;
    try (Stream<Path> walk = Files.walk(root)) {
      paths = walk.sorted(java.util.Comparator.reverseOrder()).toList();
    }
    for (Path path : paths) Files.deleteIfExists(path);
  }

  private static Set<PosixFilePermission> permissions(int mode) {
    Set<PosixFilePermission> out = java.util.EnumSet.noneOf(PosixFilePermission.class);
    for (PosixFilePermission permission : PosixFilePermission.values())
      if ((mode & (1 << (8 - permission.ordinal()))) != 0) out.add(permission);
    return out;
  }

  private static String field(byte[] data, int start, int length) {
    int end = start;
    while (end < start + length && data[end] != 0) end++;
    return new String(data, start, end - start, StandardCharsets.UTF_8);
  }
}
