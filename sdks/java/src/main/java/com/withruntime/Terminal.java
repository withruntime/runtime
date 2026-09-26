package com.withruntime;

import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/** Interactive terminal. One input reader and one output writer; close cancels both. */
public final class Terminal implements AutoCloseable {
  private final WebSocketSession socket;
  private final WebSocketSession.Buffer buffer = new WebSocketSession.Buffer();
  private final CompletableFuture<String> ready = new CompletableFuture<>();
  private volatile Integer exitCode;

  private Terminal(Sandbox s, Map<String, ?> options) {
    socket =
        new WebSocketSession(
            s.t,
            new WebSocketSession.Handler() {
              public void frame(boolean text, byte[] bytes) {
                if (!text) {
                  if (!buffer.add(bytes))
                    socket.fail(
                        new RuntimeCloudException(
                            "Read terminal output while writing input; the receive buffer is full.",
                            "terminal_receive_overflow",
                            null));
                  return;
                }
                JsonObject message =
                    new JsonObject(
                        JsonObject.map(Json.parse(new String(bytes, StandardCharsets.UTF_8))));
                switch (String.valueOf(message.getString("type"))) {
                  case "ready" -> ready.complete(message.getString("processId"));
                  case "exit" -> {
                    Long code = message.getLong("exitCode");
                    exitCode = code == null ? null : code.intValue();
                    buffer.end(null);
                  }
                  case "error" -> socket.fail(WebSocketSession.error(message));
                  default -> {}
                }
              }

              public void ended(Throwable failure) {
                ready.completeExceptionally(
                    failure == null
                        ? new RuntimeCloudException(
                            "Terminal closed before it was ready.", "terminal_refused", null)
                        : failure);
                buffer.end(failure);
              }
            });
    Transport.Call call = new Transport.Call("GET", s.path("/terminal"));
    if (options != null) options.forEach(call::query);
    socket.open(call);
    try {
      ready.get(s.t.timeout.toMillis(), TimeUnit.MILLISECONDS);
    } catch (InterruptedException failure) {
      Thread.currentThread().interrupt();
      close();
      throw s.t.connectionError(true, false, null, failure);
    } catch (ExecutionException failure) {
      close();
      if (failure.getCause() instanceof RuntimeCloudException runtime) throw runtime;
      throw s.t.connectionError(false, false, null, failure.getCause());
    } catch (TimeoutException failure) {
      close();
      throw s.t.connectionError(true, false, null, failure);
    }
  }

  static Terminal open(Sandbox s, Map<String, ?> options) {
    return new Terminal(s, options);
  }

  public String processId() {
    return ready.join();
  }

  public Integer exitCode() {
    return exitCode;
  }

  public void resize(int cols, int rows) {
    if (cols < 1 || rows < 1)
      throw new IllegalArgumentException("Terminal dimensions must be positive.");
    socket.json(Map.of("type", "resize", "cols", cols, "rows", rows));
  }

  public InputStream input() {
    return new InputStream() {
      @Override
      public int read() throws IOException {
        byte[] one = new byte[1];
        return read(one, 0, 1) < 0 ? -1 : one[0] & 255;
      }

      @Override
      public int read(byte[] bytes, int offset, int length) throws IOException {
        java.util.Objects.checkFromIndexSize(offset, length, bytes.length);
        try {
          return buffer.read(bytes, offset, length);
        } catch (InterruptedIOException failure) {
          Terminal.this.close();
          throw failure;
        }
      }

      @Override
      public void close() {
        Terminal.this.close();
      }
    };
  }

  public OutputStream output() {
    return new OutputStream() {
      @Override
      public void write(int value) {
        write(new byte[] {(byte) value}, 0, 1);
      }

      @Override
      public void write(byte[] bytes, int offset, int length) {
        java.util.Objects.checkFromIndexSize(offset, length, bytes.length);
        for (int at = offset; at < offset + length; at += 65536)
          socket.send(false, Arrays.copyOfRange(bytes, at, Math.min(offset + length, at + 65536)));
      }

      @Override
      public void close() {
        Terminal.this.close();
      }
    };
  }

  @Override
  public void close() {
    socket.close();
  }
}
