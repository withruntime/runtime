package com.withruntime;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.function.Consumer;
import java.util.function.Predicate;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * {@code runtime.images()}: custom images. Build one, then start sandboxes from it with {@link
 * CreateSandbox#image}.
 */
public final class Images {
  private static final Pattern UUID = Pattern.compile("(?i)^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$");
  static final long CONTEXT_BYTES = 100L << 20;
  static final int CONTEXT_FILES = 20_000;
  private final Transport t;

  Images(Transport transport) {
    this.t = transport;
  }

  private static String path(String id, String verb) {
    return "/v1/images/" + Transport.segment(id) + verb;
  }

  private Map<String, Object> prepare(CreateImage options) {
    Map<String, Object> body = options.toMap();
    if (options.contextDir != null) {
      Map<String, Object> uploaded = uploadContext(options.contextDir, (String) body.get("dockerignore"));
      body.put("context", uploaded.get("context"));
      if (uploaded.get("dockerignore") != null) body.put("dockerignore", uploaded.get("dockerignore"));
    }
    return body;
  }

  /** Queues a build and returns at once, in state "queued". */
  public Image create(CreateImage options) {
    return new Image(t.object(new Transport.Call("POST", "/v1/images").body(prepare(options)).key(options.idempotencyKey)));
  }

  /**
   * Builds an image and waits until it is ready, sending each log line to onLog (which may be
   * null). A failed build throws with code image_failed and the build's own error.
   */
  public Image build(CreateImage options, Consumer<JsonObject> onLog) {
    Image image = create(options);
    if (onLog != null) image = followLogs(image.id(), 0, onLog);
    while ("queued".equals(image.state()) || "building".equals(image.state())) {
      sleep(Duration.ofSeconds(1));
      image = get(image.id());
    }
    if (!"ready".equals(image.state()))
      throw new RuntimeCloudException(
          "Image " + image.id() + " " + image.state() + ": " + (image.error() == null ? "no error given" : image.error()),
          "image_failed",
          "Read the build log with runtime.images().logs(id, 0).");
    return image;
  }

  private static void sleep(Duration duration) {
    try {
      Thread.sleep(duration.toMillis());
    } catch (InterruptedException interrupted) {
      Thread.currentThread().interrupt();
      throw new RuntimeCloudException("Interrupted while waiting for the build.", "timeout", null);
    }
  }

  public Image get(String id) {
    return new Image(t.object(new Transport.Call("GET", path(id, ""))));
  }

  /** An image by id, name (its latest tag), name:tag or name@version. */
  public Image resolve(String ref) {
    if (UUID.matcher(ref).matches()) return get(ref);
    return new Image(t.object(new Transport.Call("GET", "/v1/images/resolve").query("ref", ref)));
  }

  private String idOf(String ref) {
    return UUID.matcher(ref).matches() ? ref : resolve(ref).id();
  }

  /** Build output after line after: lines, nextAfter, state, truncated and done. */
  public JsonObject logs(String id, int after) {
    return new JsonObject(t.object(new Transport.Call("GET", path(id, "/logs")).query("after", after)));
  }

  /**
   * Sends build output after line after to onLog as it is written, until the build ends, and
   * returns the image as it ended. It streams, and polls when a stream breaks.
   */
  public Image followLogs(String id, long after, Consumer<JsonObject> onLog) {
    try {
      boolean resume = true;
      while (resume) {
        resume = false;
        try (EventStream<JsonObject> events =
            t.events(new Transport.Call("GET", path(id, "/logs")).query("after", after).query("follow", "true").timeout(Duration.ofMinutes(3)), JsonObject::new)) {
          for (JsonObject event : events) {
            switch (String.valueOf(event.getString("type"))) {
              case "line" -> {
                onLog.accept(event);
                after = event.getLong("seq", after);
              }
              case "done" -> {
                JsonObject image = event.getObject("image");
                return image.has("id") ? new Image(image.raw()) : get(id);
              }
              case "continue" -> {
                after = event.getLong("after", after);
                resume = true;
              }
              case "error" -> throw EventStream.streamError(event);
              default -> {}
            }
          }
        }
      }
    } catch (RuntimeCloudException.Connection broken) {
      // Fall through to polling.
    }
    while (true) {
      JsonObject page = logs(id, (int) after);
      for (JsonObject line : page.getObjects("lines")) onLog.accept(line);
      after = page.getLong("nextAfter", after);
      Image image = get(id);
      if (page.getBoolean("done") || !("queued".equals(image.state()) || "building".equals(image.state()))) return image;
      sleep(Duration.ofSeconds(1));
    }
  }

  /** The first page of images; any filter may be null. */
  public Page<Image> list(String state, String name) {
    return Page.read(t, call(state, name, null, null), Image::new, cursor -> call(state, name, null, cursor));
  }

  private static Transport.Call call(String state, String name, Integer limit, String cursor) {
    return new Transport.Call("GET", "/v1/images").query("state", state).query("name", name).query("limit", limit).query("cursor", cursor);
  }

  /** Every version of a name, newest first. */
  public Page<Image> versions(String name) {
    return Page.read(t, call(null, name, 100, null), Image::new, cursor -> call(null, name, 100, cursor));
  }

  /** Points tag of the image's name at this version (ref is an id, name:tag or name@version). */
  public Image tag(String ref, String tag) {
    return new Image(t.object(new Transport.Call("POST", path(idOf(ref), ":tag")).body(Map.of("tag", tag))));
  }

  public Image untag(String ref, String tag) {
    return new Image(t.object(new Transport.Call("POST", path(idOf(ref), ":untag")).body(Map.of("tag", tag))));
  }

  /** Deletes one version and its tags. */
  public Image delete(String ref) {
    return new Image(t.object(new Transport.Call("POST", path(idOf(ref), ":delete")).body(Map.of())));
  }

  /** Saved credentials for private registries: never returned. */
  public List<JsonObject> registries() {
    return new JsonObject(t.object(new Transport.Call("GET", "/v1/images/registries"))).getObjects("data");
  }

  /** Saves a user name and token or password for a registry (Docker Hub, GitHub, Google...). */
  public JsonObject setRegistry(String registry, String username, String password) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("registry", registry);
    body.put("username", username);
    body.put("password", password);
    return new JsonObject(t.object(new Transport.Call("POST", "/v1/images/registries").body(body)));
  }

  public boolean deleteRegistry(String registry) {
    return new JsonObject(t.object(new Transport.Call("POST", "/v1/images/registries:delete").body(Map.of("registry", registry)))).getBoolean("deleted");
  }

  /**
   * Packs a folder as a build context, the way docker build does (its .dockerignore applied,
   * .git left out when there is none), and uploads the chunks the server does not have yet.
   * Returns {"context": ..., "dockerignore": ...} to build with.
   */
  public Map<String, Object> uploadContext(Path folder, String dockerignore) {
    Packed packed = pack(folder, dockerignore);
    List<byte[]> chunks = new ArrayList<>();
    List<String> digests = new ArrayList<>();
    for (int at = 0; at < packed.archive.length; at += Files.CHUNK) {
      byte[] chunk = Arrays.copyOfRange(packed.archive, at, Math.min(packed.archive.length, at + Files.CHUNK));
      chunks.add(chunk);
      digests.add(sha256(chunk));
    }
    Set<String> missing =
        new HashSet<>(new JsonObject(t.object(new Transport.Call("POST", "/v1/images/context/missing").body(Map.of("digests", digests)))).getStrings("missing"));
    ExecutorService pool = Executors.newFixedThreadPool(4, task -> {
      Thread thread = new Thread(task, "runtime-context-upload");
      thread.setDaemon(true);
      return thread;
    });
    try {
      List<Future<?>> uploads = new ArrayList<>();
      for (int i = 0; i < chunks.size(); i++) {
        if (!missing.contains(digests.get(i))) continue;
        byte[] chunk = chunks.get(i);
        String digest = digests.get(i);
        uploads.add(pool.submit(() -> t.json(new Transport.Call("PUT", "/v1/images/context/" + digest).raw(chunk))));
      }
      for (Future<?> upload : uploads) upload.get();
    } catch (InterruptedException interrupted) {
      Thread.currentThread().interrupt();
      throw new RuntimeCloudException("Interrupted while uploading the build context.", "timeout", null);
    } catch (ExecutionException failure) {
      if (failure.getCause() instanceof RuntimeException runtime) throw runtime;
      throw new RuntimeCloudException("The context upload failed: " + failure.getCause(), "upload_failed", null);
    } finally {
      pool.shutdownNow();
    }
    Map<String, Object> archive = new LinkedHashMap<>();
    archive.put("sha256", sha256(packed.archive));
    archive.put("size", packed.archive.length);
    archive.put("chunks", digests);
    Map<String, Object> context = new LinkedHashMap<>();
    context.put("archive", archive);
    context.put("files", packed.files);
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("context", context);
    out.put("dockerignore", packed.dockerignore);
    return out;
  }

  static String sha256(byte[] data) {
    try {
      return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(data));
    } catch (NoSuchAlgorithmException impossible) {
      throw new IllegalStateException(impossible);
    }
  }

  record Packed(byte[] archive, List<Map<String, Object>> files, String dockerignore) {}

  /** A deterministic gzipped tar of the folder: sorted, no times, no owners, no links. */
  static Packed pack(Path folder, String dockerignore) {
    try {
      Path root = folder.toAbsolutePath().normalize();
      if (dockerignore == null) {
        try {
          dockerignore = java.nio.file.Files.readString(root.resolve(".dockerignore"));
        } catch (NoSuchFileException none) {
          dockerignore = null;
        }
      }
      Predicate<String> ignored = dockerignoreFilter(dockerignore == null ? ".git\n" : dockerignore);
      boolean reincludes = dockerignore != null && Pattern.compile("(?m)^\\s*!").matcher(dockerignore).find();
      java.io.ByteArrayOutputStream tar = new java.io.ByteArrayOutputStream();
      List<Map<String, Object>> files = new ArrayList<>();
      walk(root, root, ignored, reincludes, tar, files);
      tar.write(new byte[1024], 0, 1024);
      byte[] archive = Tar.gzip(tar.toByteArray());
      if (archive.length > CONTEXT_BYTES)
        throw new RuntimeCloudException(
            "The build context is " + (archive.length / 1_048_576 + 1) + " MiB compressed; the most is 100 MiB.",
            "context_too_large",
            "Leave build outputs and dependencies out with a .dockerignore.");
      return new Packed(archive, files, dockerignore);
    } catch (IOException error) {
      throw new UncheckedIOException(error);
    }
  }

  private static void walk(Path root, Path directory, Predicate<String> ignored, boolean reincludes, java.io.ByteArrayOutputStream tar, List<Map<String, Object>> files) throws IOException {
    List<Path> entries;
    try (Stream<Path> list = java.nio.file.Files.list(directory)) {
      entries = list.sorted((a, b) -> a.getFileName().toString().compareTo(b.getFileName().toString())).toList();
    }
    for (Path path : entries) {
      String name = root.relativize(path).toString().replace('\\', '/');
      if (java.nio.file.Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)) {
        if (ignored.test(name) && !reincludes) continue;
        walk(root, path, ignored, reincludes, tar, files);
      } else if (java.nio.file.Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
        if (ignored.test(name)) continue;
        if (files.size() >= CONTEXT_FILES)
          throw new RuntimeCloudException("The build context has more than " + CONTEXT_FILES + " files.", "context_too_large", "Leave some out with a .dockerignore.");
        byte[] data = java.nio.file.Files.readAllBytes(path);
        int mode = Tar.mode(path) & 0777;
        Map<String, Object> file = new LinkedHashMap<>();
        file.put("path", name);
        file.put("sha256", sha256(data));
        file.put("size", data.length);
        file.put("mode", mode);
        files.add(file);
        tar.writeBytes(Tar.header(name, data.length, mode, '0', 0));
        tar.writeBytes(data);
        Tar.pad(tar, data.length);
      }
    }
  }

  /**
   * A .dockerignore as Docker reads it: # comments, ! re-includes, ** crosses directories, a
   * pattern naming a directory excludes what is in it, and the last matching pattern decides.
   */
  static Predicate<String> dockerignoreFilter(String text) {
    record Rule(boolean negate, Pattern regex) {}
    List<Rule> rules = new ArrayList<>();
    for (String raw : text.replace("\r\n", "\n").replace('\r', '\n').split("\n")) {
      String line = raw.strip();
      if (line.isEmpty() || line.startsWith("#")) continue;
      boolean negate = line.startsWith("!");
      if (negate) line = line.substring(1).strip();
      line = normalize(line.replaceAll("^/+", "")).replaceAll("/+$", "");
      if (line.isEmpty() || line.equals(".")) continue;
      StringBuilder source = new StringBuilder();
      for (int i = 0; i < line.length(); i++) {
        char c = line.charAt(i);
        if (c == '*' && i + 1 < line.length() && line.charAt(i + 1) == '*') {
          if (i + 2 < line.length() && line.charAt(i + 2) == '/') {
            source.append("(?:.*/)?");
            i += 2;
          } else {
            source.append(".*");
            i++;
          }
        } else if (c == '*') {
          source.append("[^/]*");
        } else if (c == '?') {
          source.append("[^/]");
        } else if (c == '[') {
          int end = line.indexOf(']', i + 1);
          if (end < 0) source.append("\\[");
          else {
            String set = line.substring(i + 1, end);
            if (set.startsWith("!")) set = "^" + set.substring(1);
            source.append('[').append(set.replace("\\", "\\\\")).append(']');
            i = end;
          }
        } else if (c == '\\' && i + 1 < line.length()) {
          source.append(Pattern.quote(String.valueOf(line.charAt(++i))));
        } else {
          source.append(Pattern.quote(String.valueOf(c)));
        }
      }
      rules.add(new Rule(negate, Pattern.compile("^" + source + "$")));
    }
    return path -> {
      String[] parts = path.split("/");
      boolean excluded = false;
      for (Rule rule : rules) {
        boolean hit = false;
        for (int n = parts.length; n >= 1 && !hit; n--) hit = rule.regex.matcher(String.join("/", Arrays.copyOf(parts, n))).matches();
        if (hit) excluded = !rule.negate;
      }
      return excluded;
    };
  }

  private static String normalize(String path) {
    List<String> out = new ArrayList<>();
    for (String part : path.split("/")) {
      if (part.isEmpty() || part.equals(".")) continue;
      if (part.equals("..")) {
        if (!out.isEmpty()) out.remove(out.size() - 1);
      } else out.add(part);
    }
    return out.isEmpty() ? "." : String.join("/", out);
  }

  static byte[] utf8(String text) {
    return text.getBytes(StandardCharsets.UTF_8);
  }
}
