package com.withruntime;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A build's fields: exactly one of {@link #image}, {@link #dockerfile} or {@link #recipe}. With a
 * Dockerfile the context is small inline files ({@link #file}), a local folder ({@link
 * #contextDir}, packed and uploaded for you) or an uploaded context.
 */
public final class CreateImage extends Params<CreateImage> {
  public CreateImage() {}

  Path contextDir;

  /** Each build of a name is its next version. */
  public CreateImage name(String name) {
    return set("name", name);
  }

  /** Tags the build takes when ready; a named image with none takes latest. */
  public CreateImage tags(String... tags) {
    return set("tags", List.of(tags));
  }

  /** An OCI image to use as it is, plus Runtime's guest agent. */
  public CreateImage image(String reference) {
    return set("image", reference);
  }

  /** A Dockerfile's text. */
  public CreateImage dockerfile(String text) {
    return set("dockerfile", text);
  }

  /** Packages, commands and files on top of a base ("runtime" unless the recipe says). */
  public CreateImage recipe(Map<String, Object> recipe) {
    return set("recipe", new LinkedHashMap<>(recipe));
  }

  /** A file of a small inline build context (1 MiB in all). */
  @SuppressWarnings("unchecked")
  public CreateImage file(String path, String content) {
    Map<String, Object> file = new LinkedHashMap<>();
    file.put("path", path);
    file.put("content", content);
    ((List<Object>) body.computeIfAbsent("files", k -> new ArrayList<>())).add(file);
    return this;
  }

  /** A local folder to send as the context, with its .dockerignore. */
  public CreateImage contextDir(Path folder) {
    this.contextDir = folder;
    return this;
  }

  /** Replaces the folder's own .dockerignore. */
  public CreateImage dockerignore(String text) {
    return set("dockerignore", text);
  }

  public CreateImage buildArg(String name, String value) {
    return putIn("buildArgs", name, value);
  }

  public CreateImage env(String name, String value) {
    return putIn("env", name, value);
  }

  /** Build this stage instead of the last. */
  public CreateImage target(String stage) {
    return set("target", stage);
  }

  /** What a sandbox from the image runs as it starts, and when it counts as ready. */
  public CreateImage start(Map<String, Object> start) {
    return set("start", new LinkedHashMap<>(start));
  }

  /** false builds every step afresh and keeps no cache. */
  public CreateImage cache(boolean cache) {
    return set("cache", cache);
  }

  @SuppressWarnings("unchecked")
  private CreateImage putIn(String field, String name, String value) {
    ((Map<String, String>) body.computeIfAbsent(field, k -> new LinkedHashMap<String, String>())).put(name, value);
    return this;
  }
}
