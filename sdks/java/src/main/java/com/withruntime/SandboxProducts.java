package com.withruntime;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** The products that belong to one sandbox: {@code sbx.<product>().<verb>(...)}. */
public final class SandboxProducts {
  private SandboxProducts() {}

  /**
   * {@code sbx.network()}: turn the sandbox's internet off or on, narrow it to a list, refuse
   * destinations, or open host:port pairs. Changes apply at once, to open connections too.
   */
  public static final class Network {
    private final Sandbox sandbox;

    Network(Sandbox sandbox) {
      this.sandbox = sandbox;
    }

    public JsonObject get() {
      return new JsonObject(sandbox.t.object(new Transport.Call("GET", sandbox.path("/network"))));
    }

    /** Replaces the rules. */
    public JsonObject set(NetworkRules rules) {
      return new JsonObject(
          sandbox.t.object(
              new Transport.Call("PUT", sandbox.path("/network")).body(rules.toMap())));
    }

    /** No outbound connections at all. */
    public JsonObject off() {
      return set(new NetworkRules().internet(false));
    }

    /** The public web and nothing narrower. */
    public JsonObject on() {
      return set(new NetworkRules().internet(true));
    }
  }

  /** {@code sbx.interpreter()}: stateful Python and JavaScript cells, like a notebook. */
  public static final class Interpreter {
    private static final Pattern RESULT =
        Pattern.compile(
            "^/workspace/\\.runtime/interpreter/([a-z0-9][a-z0-9-]*)/out/([A-Za-z0-9][A-Za-z0-9_.-]*)$");
    private final Sandbox sandbox;

    Interpreter(Sandbox sandbox) {
      this.sandbox = sandbox;
    }

    private String path(String suffix) {
      return sandbox.path("/interpreter" + suffix);
    }

    /** Runs a Python cell in the default context. */
    public JsonObject run(String code) {
      return run(code, null, null, null, null);
    }

    /**
     * Runs a cell. language is "python" (the default) or "javascript"; context is a context id; any
     * may be null. With onStdout or onResult, output streams as it happens. Returns the execution:
     * status (ok, error, interrupted, timeout, lost), stdout, stderr, results, error.
     */
    public JsonObject run(
        String code,
        String language,
        String context,
        Consumer<String> onStdout,
        Consumer<JsonObject> onResult) {
      Map<String, Object> body = new LinkedHashMap<>();
      body.put("code", code);
      if (language != null) body.put("language", language);
      if (context != null) body.put("context", context);
      if (onStdout == null && onResult == null)
        return new JsonObject(
            sandbox.t.object(new Transport.Call("POST", path(":run")).body(body)));
      body.put("stream", true);
      try (EventStream<JsonObject> events =
          sandbox.t.events(new Transport.Call("POST", path(":run")).body(body), JsonObject::new)) {
        for (JsonObject event : events) {
          switch (String.valueOf(event.getString("k"))) {
            case "stdout" -> {
              if (onStdout != null) onStdout.accept(event.getString("text"));
            }
            case "result" -> {
              if (onResult != null) onResult.accept(event);
            }
            case "execution" -> {
              return event.getObject("execution");
            }
            case "failure" ->
                throw new RuntimeCloudException(
                    event.getString("message"), event.getString("code"), event.getString("hint"));
            default -> {}
          }
        }
      }
      throw new RuntimeCloudException(
          "The interpreter stream ended without a result.", "stream_failed", null);
    }

    /** The running contexts. */
    public List<JsonObject> contexts() {
      return new JsonObject(sandbox.t.object(new Transport.Call("GET", path("/contexts"))))
          .getObjects("data");
    }

    /** Starts a context; any argument may be null. */
    public JsonObject createContext(String id, String language, String cwd) {
      Map<String, Object> body = new LinkedHashMap<>();
      if (id != null) body.put("id", id);
      if (language != null) body.put("language", language);
      if (cwd != null) body.put("cwd", cwd);
      return new JsonObject(
          sandbox.t.object(new Transport.Call("POST", path("/contexts")).body(body)));
    }

    public JsonObject restartContext(String id) {
      return new JsonObject(
          sandbox.t.object(
              new Transport.Call("POST", path("/contexts/" + Transport.segment(id) + ":restart"))
                  .body(Map.of())));
    }

    public boolean interruptContext(String id) {
      return new JsonObject(
              sandbox.t.object(
                  new Transport.Call(
                          "POST", path("/contexts/" + Transport.segment(id) + ":interrupt"))
                      .body(Map.of())))
          .getBoolean("interrupted");
    }

    public boolean removeContext(String id) {
      return new JsonObject(
              sandbox.t.object(
                  new Transport.Call("DELETE", path("/contexts/" + Transport.segment(id)))))
          .getBoolean("deleted");
    }

    /** The bytes of a result too large to travel inline (a refs entry's path). */
    public byte[] result(String resultPath) {
      Matcher match = RESULT.matcher(resultPath);
      if (!match.matches()) throw new IllegalArgumentException("Not an interpreter result path.");
      return sandbox.t.bytes(
          new Transport.Call(
                  "GET", path("/contexts/" + match.group(1) + "/results/" + match.group(2)))
              .accept("application/octet-stream"));
    }
  }

  /**
   * {@code sbx.desktop()}: a Linux desktop in the sandbox. Coordinates are pixels from the top left
   * of the screen.
   */
  public static final class Desktop {
    private final Sandbox sandbox;

    Desktop(Sandbox sandbox) {
      this.sandbox = sandbox;
    }

    public SandboxParity.Recordings recordings() {
      return new SandboxParity.Recordings(sandbox);
    }

    private JsonObject act(Map<String, Object> body) {
      return new JsonObject(
          sandbox.t.object(new Transport.Call("POST", sandbox.path("/desktop:act")).body(body)));
    }

    /** Starts the desktop; streamUrl opens it live in a browser. Width and height may be null. */
    public JsonObject start(Integer width, Integer height) {
      Map<String, Object> body = new LinkedHashMap<>();
      if (width != null) body.put("width", width);
      if (height != null) body.put("height", height);
      return new JsonObject(
          sandbox.t.object(new Transport.Call("POST", sandbox.path("/desktop:start")).body(body)));
    }

    public void stop() {
      sandbox.t.json(new Transport.Call("POST", sandbox.path("/desktop:stop")).body(Map.of()));
    }

    /** The screen as PNG. */
    public byte[] screenshot() {
      return sandbox.t.bytes(new Transport.Call("GET", sandbox.path("/desktop/screenshot")));
    }

    public void move(int x, int y) {
      act(Map.of("action", "move", "x", x, "y", y));
    }

    public void click(int x, int y) {
      act(Map.of("action", "click", "x", x, "y", y));
    }

    public void doubleClick(int x, int y) {
      act(Map.of("action", "click", "double", true, "x", x, "y", y));
    }

    public void rightClick(int x, int y) {
      act(Map.of("action", "click", "button", "right", "x", x, "y", y));
    }

    /** Positive dy scrolls down. */
    public void scroll(int dy) {
      act(Map.of("action", "scroll", "dy", dy));
    }

    public void type(String text) {
      act(Map.of("action", "type", "text", text));
    }

    /** xdotool key names, space separated: "ctrl+l", "Return". */
    public void press(String keys) {
      act(Map.of("action", "key", "keys", keys));
    }

    /** Opens url in Firefox on the desktop. */
    public void open(String url) {
      act(Map.of("action", "open", "url", url));
    }

    /** The desktop's windows. */
    public List<JsonObject> windows() {
      return act(Map.of("action", "windows")).getObjects("windows");
    }
  }

  static Duration seconds(long value) {
    return Duration.ofSeconds(value);
  }
}
