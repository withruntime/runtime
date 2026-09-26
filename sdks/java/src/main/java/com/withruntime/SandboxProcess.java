package com.withruntime;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * A background process in a sandbox: its output, its input, its end. Use one from one thread at
 * a time.
 */
public final class SandboxProcess {
  private final Sandbox sandbox;
  private volatile ProcessInfo info;
  private long inputOffset;

  SandboxProcess(Sandbox sandbox, Map<String, Object> info) {
    this.sandbox = sandbox;
    this.info = new ProcessInfo(info);
    this.inputOffset = this.info.stdinOffset();
  }

  public String id() {
    return info.id();
  }

  public ProcessInfo info() {
    return info;
  }

  private String path(String suffix) {
    return sandbox.path("/processes/" + Transport.segment(id()) + suffix);
  }

  /** Every output event from cursor (0 for the start) until the process exits. */
  public EventStream<OutputEvent> output(long cursor) {
    return sandbox.follow(id(), cursor);
  }

  /** Waits for the process to end and returns its result. */
  public CommandResult waitFor() {
    StringBuilder stdout = new StringBuilder();
    StringBuilder stderr = new StringBuilder();
    Map<String, Object> fields = new LinkedHashMap<>();
    fields.put("processId", id());
    boolean dropped = false;
    try (EventStream<OutputEvent> events = output(0)) {
      for (OutputEvent event : events) {
        switch (event.type()) {
          case "stdout" -> stdout.append(event.data());
          case "stderr" -> stderr.append(event.data());
          case "truncated" -> dropped = true;
          case "exit" -> {
            fields.put("exitCode", event.get("exitCode"));
            fields.put("timedOut", event.timedOut());
            fields.put("durationMs", event.get("durationMs"));
          }
          default -> {}
        }
      }
    }
    fields.put("stdout", stdout.toString());
    fields.put("stderr", stderr.toString());
    fields.put("stdoutTruncated", dropped);
    fields.put("stderrTruncated", dropped);
    return new CommandResult(fields);
  }

  /**
   * Sends input. Offsets are tracked for you, so a retried write is never typed twice. With eof
   * the input is closed after it.
   */
  public void write(byte[] data, boolean eof) {
    int sent = 0;
    while (true) {
      Map<String, Object> body = new LinkedHashMap<>();
      body.put("base64", Base64.getEncoder().encodeToString(Arrays.copyOfRange(data, sent, data.length)));
      body.put("offset", inputOffset);
      if (eof) body.put("eof", true);
      JsonObject reply = new JsonObject(sandbox.t.object(new Transport.Call("POST", path(":write")).body(body)));
      long offset = reply.getLong("offset", inputOffset);
      long progress = offset - inputOffset;
      sent += (int) progress;
      inputOffset = offset;
      if (sent >= data.length) return;
      if (progress <= 0)
        throw new RuntimeCloudException(
            "The process took none of the input.", "write_stalled", "Check that its input is still open (info().stdinOpen()).");
    }
  }

  public void write(String text, boolean eof) {
    write(text.getBytes(StandardCharsets.UTF_8), eof);
  }

  /** Sends a signal: SIGTERM, SIGKILL, SIGINT, SIGHUP, SIGQUIT, SIGUSR1 or SIGUSR2. */
  public void kill(String signal) {
    sandbox.t.json(new Transport.Call("POST", path(":signal")).body(Map.of("signal", signal == null ? "SIGTERM" : signal)));
  }

  /** Changes a PTY process's terminal size. */
  public void resize(int cols, int rows) {
    sandbox.t.json(new Transport.Call("POST", path(":resize")).body(Map.of("cols", cols, "rows", rows)));
  }

  /** Reads the process again. */
  public ProcessInfo refresh() {
    info = new ProcessInfo(sandbox.t.object(new Transport.Call("GET", path(""))));
    return info;
  }
}
