package com.withruntime;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/**
 * {@code sbx.files()}: files in a sandbox. Paths are absolute; any path the sandbox user may use.
 */
public final class Files {
  static final int CHUNK = 1 << 20;
  private final Sandbox sandbox;

  Files(Sandbox sandbox) {
    this.sandbox = sandbox;
  }

  private Transport t() {
    return sandbox.t;
  }

  /** A file's bytes, any size. */
  public byte[] read(String path) {
    return t().bytes(
            new Transport.Call("GET", sandbox.path("/files/content"))
                .query("path", path)
                .accept("application/octet-stream"));
  }

  public String readText(String path) {
    return new String(read(path), StandardCharsets.UTF_8);
  }

  public void write(String path, String text) {
    write(path, text.getBytes(StandardCharsets.UTF_8));
  }

  /**
   * Writes a file of any size, atomically, making parent directories. A file over 1 MiB goes in
   * parallel 1 MiB chunks checked against its SHA-256.
   */
  public void write(String path, byte[] data) {
    write(path, data, null);
  }

  /**
   * File permissions and a stable logical-write retry key. Integer modes use Java octal, e.g. 0755.
   */
  public static final class WriteOptions extends Params<WriteOptions> {
    public WriteOptions() {}

    public WriteOptions mode(int mode) {
      return set("mode", octal(mode));
    }
  }

  static String octal(int mode) {
    if (mode < 0 || mode > 0777) throw new IllegalArgumentException("mode must be 000 to 777");
    return String.format(java.util.Locale.ROOT, "%03o", mode);
  }

  static String sha256(byte[] data) {
    try {
      return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(data));
    } catch (NoSuchAlgorithmException impossible) {
      throw new IllegalStateException(impossible);
    }
  }

  private static String phase(String key, String phase) {
    return sha256(("files.write:" + key + ":" + phase).getBytes(StandardCharsets.UTF_8));
  }

  public void write(String path, String text, WriteOptions options) {
    write(path, text.getBytes(StandardCharsets.UTF_8), options);
  }

  public void write(String path, byte[] data, WriteOptions options) {
    WriteOptions opts = options == null ? new WriteOptions() : options;
    String mode = (String) opts.body.get("mode");
    if (data.length <= CHUNK) {
      t().bytes(
              new Transport.Call("PUT", sandbox.path("/files/content"))
                  .query("path", path)
                  .query("mode", mode)
                  .raw(data)
                  .key(opts.idempotencyKey));
      return;
    }
    String key = opts.idempotencyKey == null ? UUID.randomUUID().toString() : opts.idempotencyKey;
    Map<String, Object> begin = new LinkedHashMap<>();
    begin.put("path", path);
    begin.put("size", data.length);
    begin.put("sha256", sha256(data));
    if (mode != null) begin.put("mode", mode);
    JsonObject upload;
    try {
      upload =
          new JsonObject(
              t().object(
                      new Transport.Call("POST", sandbox.path("/uploads"))
                          .body(begin)
                          .key(phase(key, "begin"))));
    } catch (RuntimeCloudException failure) {
      if (mode == null || !"guest_upgrade_required".equals(failure.code())) throw failure;
      begin.remove("mode");
      upload =
          new JsonObject(
              t().object(
                      new Transport.Call("POST", sandbox.path("/uploads"))
                          .body(begin)
                          .key(phase(key, "legacy-begin"))));
    }
    long chunk = upload.getLong("chunkBytes", 0);
    if (chunk <= 0 || upload.getString("uploadId") == null)
      throw new RuntimeCloudException(
          "The upload omitted its ID or chunk size.", "unexpected_answer", null);
    String base = sandbox.path("/uploads/" + Transport.segment(upload.getString("uploadId")));
    boolean committed = false;
    if (upload.getBoolean("replayed")) {
      try {
        commit(base, key);
        committed = true;
      } catch (RuntimeCloudException failure) {
        if (!"upload_incomplete".equals(failure.code())) throw failure;
      }
    }
    if (!committed) {
      ExecutorService pool =
          Executors.newFixedThreadPool(
              4,
              task -> {
                Thread thread = new Thread(task, "runtime-upload");
                thread.setDaemon(true);
                return thread;
              });
      List<Future<?>> parts = new ArrayList<>();
      try {
        for (long offset = 0; offset < data.length; offset += chunk) {
          final long at = offset;
          final byte[] part =
              Arrays.copyOfRange(data, (int) at, (int) Math.min(data.length, at + chunk));
          parts.add(
              pool.submit(
                  () -> t().bytes(new Transport.Call("PUT", base).query("offset", at).raw(part))));
        }
        for (Future<?> part : parts) part.get();
        commit(base, key);
      } catch (InterruptedException | ExecutionException | RuntimeException failure) {
        for (Future<?> part : parts) part.cancel(true);
        pool.shutdownNow();
        // Preserve the first failure; cleanup is bounded and never changes its code.
        try {
          t().json(
                  new Transport.Call("POST", base + ":abort")
                      .body(Map.of())
                      .key(phase(key, "abort"))
                      .timeout(java.time.Duration.ofSeconds(10)));
        } catch (RuntimeException ignored) {
        }
        if (failure instanceof InterruptedException) Thread.currentThread().interrupt();
        Throwable cause = failure instanceof ExecutionException ? failure.getCause() : failure;
        if (cause instanceof RuntimeException runtime) throw runtime;
        throw new RuntimeCloudException("The upload failed: " + cause, "upload_failed", null);
      } finally {
        pool.shutdownNow();
      }
    }
    if (mode != null && !mode.equals(upload.getString("mode")))
      t().json(
              new Transport.Call("POST", sandbox.path("/files:chmod"))
                  .body(Map.of("path", path, "mode", mode))
                  .key(phase(key, "chmod")));
  }

  private void commit(String base, String key) {
    t().json(new Transport.Call("POST", base + ":commit").body(Map.of()).key(phase(key, "commit")));
  }

  /** Change permissions. Requires exec on older guest images. */
  public void chmod(String path, int mode) {
    t().json(
            new Transport.Call("POST", sandbox.path("/files:chmod"))
                .body(Map.of("path", path, "mode", octal(mode))));
  }

  public FileWatch.Service watches() {
    return new FileWatch.Service(sandbox);
  }

  public FileWatch watch(String path, Map<String, ?> options) {
    return watches().start(path, options);
  }

  /**
   * A directory's entries (default /workspace). depth goes deeper; glob filters, e.g.
   * "**&#47;*.py".
   */
  public List<FileEntry> list(String directory, Integer depth, String glob) {
    Transport.Call call =
        new Transport.Call("GET", sandbox.path("/files/list"))
            .query("path", directory == null ? "/workspace" : directory)
            .query("depth", depth)
            .query("glob", glob);
    return new JsonObject(t().object(call)).getObjects("data", FileEntry::new);
  }

  public List<FileEntry> list(String directory) {
    return list(directory, null, null);
  }

  /** The files under root (default /workspace) matching pattern. */
  public List<FileEntry> glob(String pattern, String root) {
    return list(root, null, pattern);
  }

  /** A file's entry, or null when it does not exist. */
  public FileEntry stat(String path) {
    JsonObject answer =
        new JsonObject(
            t().object(new Transport.Call("GET", sandbox.path("/files/stat")).query("path", path)));
    return answer.getBoolean("exists") ? new FileEntry(answer.raw()) : null;
  }

  public boolean exists(String path) {
    return stat(path) != null;
  }

  /** Makes a directory; parents makes the ones above it too. */
  public void mkdir(String path, boolean parents) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("path", path);
    if (parents) body.put("parents", true);
    t().json(new Transport.Call("POST", sandbox.path("/files:mkdir")).body(body));
  }

  /** Removes a file, or a directory with recursive. Says whether anything was there. */
  public boolean remove(String path, boolean recursive) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("path", path);
    if (recursive) body.put("recursive", true);
    return new JsonObject(
            t().object(new Transport.Call("POST", sandbox.path("/files:remove")).body(body)))
        .getBoolean("removed");
  }

  /** Moves a file or directory; overwrite replaces what is at to. */
  public void rename(String from, String to, boolean overwrite) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("from", from);
    body.put("to", to);
    if (overwrite) body.put("overwrite", true);
    t().json(new Transport.Call("POST", sandbox.path("/files:rename")).body(body));
  }

  /**
   * Copies a local file or directory in. A directory travels as one gzipped tar to the API's folder
   * routes, and the sandbox's own tar unpacks it as it arrives, making the folder and its parents.
   */
  public void upload(Path local, String remote) {
    byte[] archive;
    try {
      if (!java.nio.file.Files.isDirectory(local)) {
        write(remote, java.nio.file.Files.readAllBytes(local));
        return;
      }
      archive = Tar.packDirectory(local);
    } catch (IOException error) {
      throw new UncheckedIOException(error);
    }
    if (archive.length <= CHUNK) {
      t().bytes(
              new Transport.Call("PUT", sandbox.path("/files/archive"))
                  .query("path", remote)
                  .raw(archive));
      return;
    }
    // Larger: parts in order, each unpacked as it arrives; a part resent after a lost answer is not
    // written twice.
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("path", remote);
    body.put("gzip", true);
    JsonObject upload =
        new JsonObject(
            t().object(
                    new Transport.Call("POST", sandbox.path("/files/archive/uploads")).body(body)));
    long chunk = upload.getLong("chunkBytes", 0);
    if (chunk <= 0 || upload.getString("uploadId") == null)
      throw new RuntimeCloudException(
          "The folder upload omitted its ID or chunk size.", "unexpected_answer", null);
    String base =
        sandbox.path("/files/archive/uploads/" + Transport.segment(upload.getString("uploadId")));
    try {
      for (long offset = 0; offset < archive.length; offset += chunk)
        t().bytes(
                new Transport.Call("PUT", base)
                    .query("offset", offset)
                    .raw(
                        Arrays.copyOfRange(
                            archive, (int) offset, (int) Math.min(archive.length, offset + chunk))));
      t().json(new Transport.Call("POST", base + ":commit").body(Map.of()));
    } catch (RuntimeException failure) {
      try {
        t().json(
                new Transport.Call("POST", base + ":abort")
                    .body(Map.of())
                    .noRetry()
                    .timeout(java.time.Duration.ofSeconds(10)));
      } catch (RuntimeException ignored) {
        // The first failure is the one to report; an unfinished upload ends on its own.
      }
      throw failure;
    }
  }

  /**
   * Copies a file or directory out. A directory comes as one gzipped tar from the API's folder
   * route, packed by the sandbox's own tar as it streams and unpacked here as it arrives; one cut
   * short is {@code download_incomplete} and nothing is put in place.
   */
  public void download(String remote, Path local) {
    FileEntry entry = stat(remote);
    if (entry == null)
      throw new RuntimeCloudException(
          remote + " does not exist.", "file_not_found", 404, null, null, null, null, null, null);
    try {
      if (!"directory".equals(entry.type())) {
        Path parent = local.toAbsolutePath().getParent();
        if (parent != null) java.nio.file.Files.createDirectories(parent);
        java.nio.file.Files.write(local, read(remote));
        return;
      }
      t().stream(
              new Transport.Call("GET", sandbox.path("/files/archive"))
                  .query("path", remote)
                  .query("gzip", true)
                  .accept("application/gzip"),
              body -> Tar.unpack(body, local));
    } catch (IOException error) {
      throw new UncheckedIOException(error);
    }
  }
}
