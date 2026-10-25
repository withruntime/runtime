package com.withruntime;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

/**
 * A running (or stopped) sandbox. Its methods are safe for concurrent use. Closing it stops it, so
 * {@code try (Sandbox sbx = runtime.sandboxes().create(...))} never leaves one running.
 */
public final class Sandbox implements AutoCloseable {
  final Transport t;
  private volatile SandboxInfo info;
  private final Files files;
  private final Previews previews;
  private final SandboxProducts.Network network;
  private final SandboxProducts.Interpreter interpreter;
  private final SandboxProducts.Desktop desktop;
  private ScheduledExecutorService keepAlive;
  /** Set by a create that made it without {@link CreateSandbox#keep()}: {@link #close} deletes it. */
  boolean deleteOnClose;

  Sandbox(Transport transport, Map<String, Object> info) {
    this.t = transport;
    this.info = new SandboxInfo(info);
    this.files = new Files(this);
    this.previews = new Previews(this);
    this.network = new SandboxProducts.Network(this);
    this.interpreter = new SandboxProducts.Interpreter(this);
    this.desktop = new SandboxProducts.Desktop(this);
  }

  public String id() {
    return info.id();
  }

  /** What the API last said about the sandbox. {@link #refresh()} asks again. */
  public SandboxInfo info() {
    return info;
  }

  public String state() {
    return info.state();
  }

  /** Reads and writes files in the sandbox. */
  public Files files() {
    return files;
  }

  /** Shares the sandbox's ports at public HTTPS addresses. */
  public Previews previews() {
    return previews;
  }

  /** Turns the sandbox's internet on or off, or narrows it. */
  public SandboxProducts.Network network() {
    return network;
  }

  /** Python and JavaScript cells whose variables persist between runs. */
  public SandboxProducts.Interpreter interpreter() {
    return interpreter;
  }

  /** A Linux desktop in the sandbox, driven like a person would. */
  public SandboxProducts.Desktop desktop() {
    return desktop;
  }

  public Tunnel openTunnel() {
    return Tunnel.open(this);
  }

  public PortForward portForward(int port, java.net.InetSocketAddress address)
      throws java.io.IOException {
    return PortForward.open(this, port, address);
  }

  public Terminal terminal(Map<String, ?> options) {
    return Terminal.open(this, options);
  }

  public SandboxParity.Mounts mounts() {
    return new SandboxParity.Mounts(this);
  }

  public SandboxParity.MCP mcp() {
    return new SandboxParity.MCP(this);
  }

  String path(String suffix) {
    return "/v1/sandboxes/" + Transport.segment(id()) + suffix;
  }

  /** Reads the sandbox again. */
  public Sandbox refresh() {
    info = new SandboxInfo(t.object(new Transport.Call("GET", path(""))));
    return this;
  }

  /**
   * Waits, on the server with no polling, until the sandbox reaches {@code state} (running, paused
   * or stopped) or the timeout passes, and returns with the state it read.
   */
  public Sandbox waitFor(String state, Duration timeout) {
    long seconds = Math.max(1, timeout.toSeconds());
    info =
        new SandboxInfo(
            t.object(
                new Transport.Call("GET", path(""))
                    .query("waitFor", state)
                    .query("timeoutSeconds", seconds)
                    .timeout(timeout.plusMinutes(1))));
    return this;
  }

  private Sandbox lifecycle(String verb, Map<String, Object> body, boolean settle, String key) {
    return lifecycle(verb, body, settle, key, null);
  }

  // A wake or restart refused for room (no_capacity and the like) ran nothing and is sent again
  // with the same key until the client's waitForCapacity runs out. 16 October 2026 06:11 UTC the
  // product check's wake was refused no_capacity in 36 ms on its full server, where a create would
  // have waited; a wake or restart stays on its server, so it waits there for room. Stop, pause,
  // extend and fork never wait. {@code waitForCapacity} replaces the client's; ZERO fails at once.
  private Sandbox waitingLifecycle(String verb, Map<String, Object> body, Duration waitForCapacity) {
    Duration room = waitForCapacity != null ? waitForCapacity : t.waitForCapacity;
    return lifecycle(verb, body, true, null, room.isNegative() ? Duration.ZERO : room);
  }

  private Sandbox lifecycle(
      String verb, Map<String, Object> body, boolean settle, String key, Duration room) {
    Transport.Call call =
        new Transport.Call("POST", path(":" + verb))
            .body(body == null ? Map.of() : body)
            .waitSeconds(settle ? 60 : 0)
            .key(key);
    if (room != null) call.room(room);
    info = new SandboxInfo(t.object(call));
    return this;
  }

  /** Stops the sandbox and ends its charges. Also ends a keep-alive. */
  public Sandbox stop() {
    stopKeepAlive();
    return lifecycle("stop", null, true, null);
  }

  /** Saves the sandbox's memory and files; compute billing stops. {@link #wake} carries on. */
  public Sandbox pause() {
    return lifecycle("pause", null, true, null);
  }

  /**
   * Carries on a paused sandbox, with its memory and processes. When its server is full
   * (no_capacity) it waits for room as {@code create} does, up to the client's waitForCapacity.
   */
  public Sandbox wake() {
    return wake(null, null);
  }

  /**
   * Carries on a paused sandbox; {@code lease} is its new time limit, for a sandbox that has one.
   */
  public Sandbox wake(Duration lease) {
    return wake(lease, null);
  }

  /**
   * Carries on a paused sandbox; {@code lease} (null for none) is its new time limit, and {@code
   * waitForCapacity} replaces the client's wait for room on a full server (ZERO fails at once).
   */
  public Sandbox wake(Duration lease, Duration waitForCapacity) {
    return waitingLifecycle(
        "wake", lease == null ? null : Map.of("timeoutSeconds", lease.toSeconds()), waitForCapacity);
  }

  /**
   * Moves a sandbox's time limit on, at most an hour ahead of now. A sandbox with no time limit
   * answers at once and nothing changes.
   */
  public Sandbox extend(Duration by) {
    return lifecycle("extend", Map.of("seconds", by.toSeconds()), false, null);
  }

  /** Days (1 to 365) a paused sandbox is kept before it is deleted. */
  public Sandbox setRetention(int days) {
    return lifecycle("retention", Map.of("days", days), false, null);
  }

  /**
   * Starts a stopped persistent sandbox again from its disk. Memory is not kept. Waits for room on
   * a full server like {@link #wake()}.
   */
  public Sandbox restart() {
    return restart(null);
  }

  /** As {@link #restart()}, with {@code waitForCapacity} replacing the client's (ZERO fails at once). */
  public Sandbox restart(Duration waitForCapacity) {
    return waitingLifecycle("restart", null, waitForCapacity);
  }

  /**
   * Changes name, labels, autoWake, idlePauseSeconds, persistent or maxTotalCostMicros; fields left
   * out stay as they are, and a null maxTotalCostMicros removes the cap.
   */
  public Sandbox update(Map<String, Object> settings) {
    return lifecycle("update", new LinkedHashMap<>(settings), false, null);
  }

  /**
   * Keeps a sandbox with a time limit running past it on a background thread, until {@link
   * #stop()}, {@link #stopKeepAlive()} or {@link #close()}: every {@code every} it extends the
   * limit so that {@code margin} remains, never more than the hour ahead the API allows. A sandbox
   * with no time limit needs none and is only watched. Running time is billed as it is used. A
   * paused sandbox is left paused; a stopped or deleted one ends the loop.
   */
  public synchronized void keepAlive(Duration every, Duration margin, Consumer<Exception> onError) {
    stopKeepAlive();
    long period = Math.max(10, every.toSeconds());
    long keep = Math.min(3600, Math.max(60, margin.toSeconds()));
    ScheduledExecutorService timer =
        Executors.newSingleThreadScheduledExecutor(
            task -> {
              Thread thread = new Thread(task, "runtime-keep-alive-" + id());
              thread.setDaemon(true);
              return thread;
            });
    keepAlive = timer;
    timer.scheduleWithFixedDelay(
        () -> {
          try {
            refresh();
            String state = state();
            if ("stopped".equals(state) || "stopping".equals(state)) {
              timer.shutdown();
              return;
            }
            Instant expires = limitEnd(info);
            if ("running".equals(state) && expires != null) {
              long left = Duration.between(Instant.now(), expires).toSeconds();
              long need = keep - left;
              if (need >= 1) extend(Duration.ofSeconds(Math.min(3600, need)));
            }
          } catch (RuntimeException error) {
            // Gone (deleted elsewhere, or by its own time limit): nothing to keep alive, and asking
            // again would only be refused.
            if (error instanceof RuntimeCloudException refused && refused.status() == 404) {
              timer.shutdown();
              return;
            }
            if (onError != null) onError.accept(error);
          }
        },
        0,
        period,
        TimeUnit.SECONDS);
  }

  /**
   * Where a sandbox's time limit ends, or null when it has none: it renews itself (timeoutSeconds
   * 0, or persistent) unless endsAt says its renewal stopped. An older server sends no endsAt and a
   * timeout of at least a minute.
   */
  static Instant limitEnd(SandboxInfo info) {
    if (info.endsAt() != null) return info.endsAt();
    if (info.timeoutSeconds() == 0 || info.persistent()) return null;
    return info.expiresAt();
  }

  /** Ends a keep-alive, if one runs. */
  public synchronized void stopKeepAlive() {
    if (keepAlive != null) {
      keepAlive.shutdownNow();
      keepAlive = null;
    }
  }

  /**
   * Starts copies of this sandbox as it is now (files, memory, running processes), each its own
   * sandbox, on its server while it has room and on another when it is full, and answers once
   * they run. If a copy fails, the exception's
   * details name the copies that did start ("startedSandboxIds").
   */
  public List<Sandbox> fork(ForkOptions options) {
    JsonObject reply =
        new JsonObject(
            t.object(
                new Transport.Call("POST", path(":fork"))
                    .body(options.toMap())
                    .waitSeconds(60)
                    .key(options.idempotencyKey)
                    // Its key replays a refusal for room or a limit, so it is told at once.
                    .room(Duration.ZERO)));
    List<Sandbox> copies = new ArrayList<>();
    for (JsonObject copy : reply.getObjects("sandboxes")) copies.add(new Sandbox(t, copy.raw()));
    return copies;
  }

  /**
   * Keeps this sandbox's whole machine as a snapshot to start new sandboxes from. A running sandbox
   * is paused by the server for the moment it takes and woken once the capture is over (one still
   * capturing when the call answers stays paused until it is ready); a paused one stays paused. A
   * sandbox with volumes cannot be snapshotted.
   */
  public Snapshot snapshot(SnapshotOptions options) {
    refresh();
    // Straight after a fork or a wake the sandbox is still resuming, and after a pause still
    // pausing: wait for where it is going, or a snapshot of it is refused as not paused.
    Duration settle = Duration.ofSeconds(ApiDefaults.WAIT_FOR_TIMEOUT_SECONDS);
    if ("resuming".equals(state()) || "starting".equals(state())) waitFor("running", settle);
    else if ("pausing".equals(state())) waitFor("paused", settle);
    // The server pauses a running sandbox itself: a client pause and wake would be two more
    // round trips.
    return new Snapshot(
        t.object(
            new Transport.Call("POST", path(":snapshot"))
                .body(options.toMap())
                .waitSeconds(10)
                .key(options.idempotencyKey)));
  }

  /** CPU and memory over a range: 15m, 1h, 6h, 24h, 7d or 30d (null is the default). */
  public JsonObject metrics(String range) {
    return new JsonObject(
        t.object(new Transport.Call("GET", path("/metrics")).query("range", range)));
  }

  // ------------------------------------------------------------------ commands

  private Map<String, Object> commandBody(Object command, ExecOptions options, Duration fallback) {
    Map<String, Object> body = new LinkedHashMap<>();
    if (command instanceof String shell) body.put("command", shell);
    else body.put("argv", command);
    if (options.cwd != null) body.put("cwd", options.cwd);
    if (options.user != null) body.put("user", options.user);
    if (options.env != null) body.put("env", options.env);
    if (options.stdin != null)
      body.put("stdinBase64", Base64.getEncoder().encodeToString(options.stdin));
    Duration timeout = options.timeout != null ? options.timeout : fallback;
    if (timeout != null) body.put("timeoutMs", timeout.toMillis());
    if (options.traceFiles) body.put("traceFiles", true);
    return body;
  }

  /** Runs a command under {@code bash -c} and returns its exit code and output. */
  public CommandResult exec(String command) {
    return exec(command, new ExecOptions());
  }

  public CommandResult exec(String command, ExecOptions options) {
    return run(command, options);
  }

  /** Runs a program directly, with no shell: what you want for untrusted arguments. */
  public CommandResult execArgv(List<String> argv, ExecOptions options) {
    return run(List.copyOf(argv), options);
  }

  private CommandResult run(Object command, ExecOptions options) {
    CommandResult result;
    boolean streamed =
        options.onStdout != null
            || options.onStderr != null
            || (options.timeout != null && options.timeout.compareTo(Duration.ofMinutes(1)) > 0);
    if (!streamed) {
      Transport.Call call =
          new Transport.Call("POST", path(":exec"))
              .body(commandBody(command, options, null))
              .key(options.idempotencyKey);
      if (options.timeout != null) call.timeout(options.timeout.plusMinutes(1));
      result = new CommandResult(t.object(call));
    } else {
      StringBuilder stdout = new StringBuilder();
      StringBuilder stderr = new StringBuilder();
      Map<String, Object> fields = new LinkedHashMap<>();
      boolean dropped = false;
      try (EventStream<OutputEvent> events = stream(command, options)) {
        for (OutputEvent event : events) {
          switch (event.type()) {
            case "start" -> fields.put("processId", event.processId());
            case "stdout" -> {
              stdout.append(event.data());
              if (options.onStdout != null) options.onStdout.accept(event.data());
            }
            case "stderr" -> {
              stderr.append(event.data());
              if (options.onStderr != null) options.onStderr.accept(event.data());
            }
            case "truncated" -> dropped = true;
            case "exit" -> {
              fields.put("exitCode", event.get("exitCode"));
              fields.put("timedOut", event.timedOut());
              fields.put("durationMs", event.get("durationMs"));
              if (event.has("files")) fields.put("files", event.get("files"));
            }
            default -> {}
          }
        }
      }
      fields.put("stdout", stdout.toString());
      fields.put("stderr", stderr.toString());
      // A truncated event does not say which stream lost bytes, so both flags carry it.
      fields.put("stdoutTruncated", dropped);
      fields.put("stderrTruncated", dropped);
      result = new CommandResult(fields);
    }
    if (options.check && !result.ok()) throw new RuntimeCloudException.Command(result);
    return result;
  }

  /**
   * Runs a command and yields its events as they happen: start, stdout, stderr, exit. It resumes by
   * itself when the server ends a long stream, so it never drops output. Close the stream to stop
   * reading early.
   */
  public EventStream<OutputEvent> execStream(String command, ExecOptions options) {
    return stream(command, options);
  }

  private EventStream<OutputEvent> stream(Object command, ExecOptions options) {
    Duration longest = Duration.ofMillis(ApiDefaults.STREAMED_EXEC_TIMEOUT_MS);
    Map<String, Object> body = commandBody(command, options, longest);
    body.put("stream", true);
    Duration timeout = options.timeout != null ? options.timeout.plusMinutes(1) : longest;
    EventStream<OutputEvent> first =
        t.events(
            new Transport.Call("POST", path(":exec"))
                .body(body)
                .key(options.idempotencyKey)
                .timeout(timeout),
            OutputEvent::new);
    return EventStream.following(first, this::follow);
  }

  /** A process's output events from cursor until it exits, across the server's stream slices. */
  EventStream<OutputEvent> follow(String processId, long cursor) {
    return EventStream.resuming(
        cursor,
        at ->
            t.events(
                new Transport.Call(
                        "GET", path("/processes/" + Transport.segment(processId) + "/output"))
                    .query("cursor", at)
                    .query("follow", "true")
                    .timeout(Duration.ofMinutes(3)),
                OutputEvent::new));
  }

  /**
   * Starts a background process (a server, a watcher, a REPL) under {@code bash -c} and returns at
   * once. It outlives your connection; {@link #process(String)} gets it back.
   */
  public SandboxProcess spawn(String command, SpawnOptions options) {
    return spawnCommand(command, options);
  }

  public SandboxProcess spawnArgv(List<String> argv, SpawnOptions options) {
    return spawnCommand(List.copyOf(argv), options);
  }

  private SandboxProcess spawnCommand(Object command, SpawnOptions options) {
    ExecOptions exec = new ExecOptions().cwd(options.cwd).user(options.user);
    exec.env = options.env;
    exec.timeout = options.timeout;
    exec.traceFiles = options.traceFiles;
    Map<String, Object> body = commandBody(command, exec, null);
    if (options.pipeStdin) body.put("stdinMode", "pipe");
    else if (options.stdin != null)
      body.put("stdinBase64", Base64.getEncoder().encodeToString(options.stdin));
    if (options.cols != null) body.put("pty", Map.of("cols", options.cols, "rows", options.rows));
    return new SandboxProcess(
        this,
        t.object(
            new Transport.Call("POST", path("/processes")).body(body).key(options.idempotencyKey)));
  }

  /** The sandbox's background processes. */
  public List<ProcessInfo> processes() {
    return new JsonObject(t.object(new Transport.Call("GET", path("/processes"))))
        .getObjects("data", ProcessInfo::new);
  }

  /** Gets a background process back by id. */
  public SandboxProcess process(String id) {
    return new SandboxProcess(
        this, t.object(new Transport.Call("GET", path("/processes/" + Transport.segment(id)))));
  }

  /**
   * Deletes it for good: stops it if it runs or is paused, deletes its disk and paused memory,
   * revokes its previews and ports, and removes it from lists. Its snapshots, usage and audit
   * entries stay. Deleting it again answers the same.
   */
  public JsonObject delete() {
    stopKeepAlive();
    return new JsonObject(t.object(new Transport.Call("DELETE", path(""))));
  }

  /**
   * The end of a try-with-resources block. A sandbox that {@code create} made there is deleted,
   * unless it was created with {@link CreateSandbox#keep()}; one from {@code get}, or one {@code
   * getOrCreate} found already there, is stopped and keeps its disk. Never throws for a sandbox
   * already gone.
   */
  @Override
  public void close() {
    stopKeepAlive();
    if (deleteOnClose) {
      try {
        delete();
      } catch (RuntimeCloudException.NotFound gone) {
        // Nothing to delete.
      }
      return;
    }
    if ("stopped".equals(state())) return;
    try {
      lifecycle("stop", null, false, null);
    } catch (RuntimeCloudException.NotFound gone) {
      // Nothing to stop.
    }
  }

  @Override
  public String toString() {
    return "Sandbox(" + id() + ", " + state() + ")";
  }
}
