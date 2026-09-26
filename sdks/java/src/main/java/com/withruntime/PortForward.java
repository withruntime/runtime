package com.withruntime;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/** A local TCP listener backed by one authenticated sandbox tunnel. Close releases all sockets. */
public final class PortForward implements AutoCloseable {
  private final ServerSocket listener;
  private final Tunnel tunnel;
  private final AtomicBoolean closed = new AtomicBoolean();
  private final Set<Socket> clients = ConcurrentHashMap.newKeySet();

  private PortForward(Sandbox sandbox, int port, InetSocketAddress address) throws IOException {
    if (port < 1 || port > 65535) throw new IllegalArgumentException("port must be 1 to 65535");
    listener = new ServerSocket();
    try {
      listener.bind(address == null ? new InetSocketAddress("127.0.0.1", 0) : address);
    } catch (IOException failure) {
      listener.close();
      throw failure;
    }
    try {
      tunnel = Tunnel.open(sandbox);
    } catch (RuntimeException failure) {
      listener.close();
      throw failure;
    }
    worker(
        "runtime-forward-accept",
        () -> {
          while (!closed.get())
            try {
              Socket local = listener.accept();
              clients.add(local);
              if (closed.get()) {
                closeSocket(local);
                break;
              }
              worker(
                  "runtime-forward-open",
                  () -> {
                    Tunnel.Stream remote;
                    try {
                      remote = tunnel.connect(port);
                    } catch (RuntimeException failure) {
                      closeSocket(local);
                      return;
                    }
                    AtomicInteger directions = new AtomicInteger(2);
                    Runnable finish =
                        () -> {
                          if (directions.decrementAndGet() == 0) {
                            remote.close();
                            closeSocket(local);
                          }
                        };
                    worker(
                        "runtime-forward-in",
                        () -> {
                          try {
                            copy(local.getInputStream(), remote.output());
                            remote.closeWrite();
                          } catch (IOException | RuntimeException failure) {
                            remote.close();
                            closeSocket(local);
                          } finally {
                            finish.run();
                          }
                        });
                    worker(
                        "runtime-forward-out",
                        () -> {
                          try {
                            copy(remote.input(), local.getOutputStream());
                            local.shutdownOutput();
                          } catch (IOException | RuntimeException failure) {
                            remote.close();
                            closeSocket(local);
                          } finally {
                            finish.run();
                          }
                        });
                  });
            } catch (IOException failure) {
              if (!closed.get()) close();
              break;
            }
        });
  }

  private static void worker(String name, Runnable action) {
    Thread thread = new Thread(action, name);
    thread.setDaemon(true);
    thread.start();
  }

  private static void copy(InputStream in, OutputStream out) throws IOException {
    byte[] bytes = new byte[65536];
    for (int n; (n = in.read(bytes)) >= 0; ) if (n > 0) out.write(bytes, 0, n);
  }

  private void closeSocket(Socket socket) {
    clients.remove(socket);
    try {
      socket.close();
    } catch (IOException ignored) {
    }
  }

  static PortForward open(Sandbox sandbox, int port, InetSocketAddress address) throws IOException {
    return new PortForward(sandbox, port, address);
  }

  public InetSocketAddress address() {
    return (InetSocketAddress) listener.getLocalSocketAddress();
  }

  @Override
  public void close() {
    if (closed.compareAndSet(false, true)) {
      try {
        listener.close();
      } catch (IOException ignored) {
      }
      for (Socket socket : clients) closeSocket(socket);
      tunnel.close();
    }
  }
}
