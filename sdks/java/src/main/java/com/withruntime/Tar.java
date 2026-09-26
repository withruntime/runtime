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
import java.nio.file.attribute.PosixFilePermission;
import java.util.List;
import java.util.Set;
import java.util.stream.Stream;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;

/** A small ustar writer and reader for directory uploads, downloads and build contexts. */
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

  /** Unpacks a gzipped tar into target, refusing any entry that would land outside it, and links. */
  static void unpack(byte[] archive, Path target) throws IOException {
    byte[] data;
    try (InputStream in = new GZIPInputStream(new ByteArrayInputStream(archive))) {
      data = in.readAllBytes();
    }
    Path root = target.toAbsolutePath().normalize();
    Files.createDirectories(root);
    String longName = null;
    for (int offset = 0; offset + 512 <= data.length; ) {
      boolean empty = true;
      for (int i = offset; i < offset + 512 && empty; i++) empty = data[i] == 0;
      if (empty) break;
      long size = Long.parseLong(field(data, offset + 124, 12).trim().isEmpty() ? "0" : field(data, offset + 124, 12).trim(), 8);
      char type = (char) data[offset + 156];
      String prefix = field(data, offset + 345, 155);
      String name = longName != null ? longName : prefix.isEmpty() ? field(data, offset, 100) : prefix + "/" + field(data, offset, 100);
      longName = null;
      String modeText = field(data, offset + 100, 8).trim();
      int mode = modeText.isEmpty() ? 0644 : Integer.parseInt(modeText, 8);
      int start = offset + 512;
      offset += 512 + (int) ((size + 511) / 512) * 512;
      if (type == 'L') {
        longName = new String(data, start, (int) size, StandardCharsets.UTF_8).replaceAll("\0.*$", "");
        continue;
      }
      if (name.startsWith("./")) name = name.substring(2);
      if (name.isEmpty() || name.equals(".") || name.equals("./")) continue;
      Path destination = root.resolve(name).normalize();
      if (!destination.startsWith(root) || destination.equals(root))
        throw new IOException("Refusing an archive entry outside the target: " + name);
      if (type == '5') {
        Files.createDirectories(destination);
      } else if (type == '0' || type == '\0' || type == '7') {
        Files.createDirectories(destination.getParent());
        Files.write(destination, java.util.Arrays.copyOfRange(data, start, start + (int) size));
        try {
          Files.setPosixFilePermissions(destination, permissions(mode & 0777));
        } catch (UnsupportedOperationException windows) {
          // The file system keeps its own permissions.
        }
      }
    }
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
