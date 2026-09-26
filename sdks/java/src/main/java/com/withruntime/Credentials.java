package com.withruntime;

import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFileAttributes;
import java.nio.file.attribute.PosixFilePermission;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * The key `runtime login` saved for this machine. Its file is the CLI's
 * (packages/cloud-sdk/src/credentials.ts) and is read exactly as the CLI reads it: only from a
 * private file in a private directory, bound to both origins.
 */
final class Credentials {
  private Credentials() {}

  static final Pattern KEY = Pattern.compile("^rtcloud_[a-f0-9-]{36}_[A-Za-z0-9_-]{43}$");

  /** An HTTPS origin, or plain HTTP to localhost for tests, with nothing after the host. */
  static String origin(String value) {
    URI uri;
    try {
      uri = URI.create(value);
    } catch (IllegalArgumentException error) {
      throw new IllegalArgumentException("Use an HTTPS API origin (or http://localhost for tests).");
    }
    String host = uri.getHost();
    boolean local = "localhost".equals(host) || "127.0.0.1".equals(host) || "[::1]".equals(host);
    String path = uri.getRawPath();
    if (host == null
        || !("https".equals(uri.getScheme()) || (local && "http".equals(uri.getScheme())))
        || uri.getRawUserInfo() != null
        || uri.getRawQuery() != null
        || uri.getRawFragment() != null
        || !(path == null || path.isEmpty() || path.equals("/")))
      throw new IllegalArgumentException("Use an HTTPS API origin (or http://localhost for tests).");
    return uri.getScheme() + "://" + uri.getRawAuthority();
  }

  /** Where the CLI keeps this machine's connection for the two origins. */
  static Path file(Map<String, String> env, String apiOrigin, String authOrigin) {
    String root = env.get("XDG_CONFIG_HOME");
    Path base = root == null || root.isEmpty() ? Path.of(System.getProperty("user.home"), ".config") : Path.of(root);
    if (!base.isAbsolute()) throw new IllegalStateException("XDG_CONFIG_HOME must be an absolute path.");
    try {
      byte[] sum = MessageDigest.getInstance("SHA-256").digest((authOrigin + "\n" + apiOrigin).getBytes(StandardCharsets.UTF_8));
      return base.resolve("runtime-cloud").resolve(HexFormat.of().formatHex(sum) + ".json");
    } catch (NoSuchAlgorithmException impossible) {
      throw new IllegalStateException(impossible);
    }
  }

  /** The saved key, or null when there is none. */
  static String savedKey(Map<String, String> env, String apiOrigin) {
    String auth = env.get("RUNTIME_AUTH_URL");
    String authOrigin = origin(auth == null || auth.isEmpty() ? "https://withruntime.com" : auth);
    Path file = file(env, apiOrigin, authOrigin);
    Path directory = file.getParent();
    try {
      if (!Files.exists(directory, LinkOption.NOFOLLOW_LINKS)) return null;
      if (!Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS) || !isPrivate(directory))
        throw new IllegalStateException("Runtime's credential directory must be private to your user.");
      if (!Files.exists(file, LinkOption.NOFOLLOW_LINKS)) return null;
      if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) || Files.size(file) > 4096 || !isPrivate(file))
        throw new IllegalStateException("Runtime's saved connection must be private to your user.");
      Map<String, Object> saved = JsonObject.map(Json.parse(Files.readString(file, StandardCharsets.UTF_8)));
      JsonObject s = new JsonObject(saved);
      Long version = s.getLong("version");
      String key = s.getString("key");
      if (version == null
          || version != 1
          || !apiOrigin.equals(s.getString("apiOrigin"))
          || !authOrigin.equals(s.getString("authOrigin"))
          || key == null
          || !KEY.matcher(key).matches()
          || !(saved.get("connectionId") instanceof String)
          || !(saved.get("orgId") instanceof String)
          || !(saved.get("agentName") instanceof String))
        throw new IllegalStateException("Runtime's saved connection is invalid. Connect again with `npx withruntime login`.");
      return key;
    } catch (NoSuchFileException gone) {
      return null;
    } catch (IOException error) {
      throw new IllegalStateException("Could not safely open Runtime's saved connection.", error);
    } catch (IllegalArgumentException malformed) {
      throw new IllegalStateException("Runtime's saved connection is invalid. Connect again with `npx withruntime login`.");
    }
  }

  /** Readable by this user alone. Where POSIX permissions do not exist, the file system's own. */
  private static boolean isPrivate(Path path) throws IOException {
    PosixFileAttributes attributes;
    try {
      attributes = Files.readAttributes(path, PosixFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
    } catch (UnsupportedOperationException windows) {
      return true;
    }
    Set<PosixFilePermission> permissions = attributes.permissions();
    for (PosixFilePermission permission : permissions)
      if (permission.name().startsWith("GROUP") || permission.name().startsWith("OTHERS")) return false;
    return attributes.owner().getName().equals(System.getProperty("user.name"));
  }
}
