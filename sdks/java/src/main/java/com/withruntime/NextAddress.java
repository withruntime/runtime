package com.withruntime;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.ProxySelector;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketAddress;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.nio.channels.SelectionKey;
import java.nio.channels.Selector;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

/**
 * A connection to a name with more than one address.
 *
 * <p>The API's name has one record for each server that serves it, and a server that has just
 * gone down does not refuse a connection: its address goes quiet until its record is removed (a
 * minute or so). {@code java.net.http.HttpClient} dials only a name's first address, and the JVM
 * keeps that answer for 30 s, so a client would wait out its connect timeout on the lost server,
 * try after try. Here the next address is dialled whenever the ones before have not connected
 * within {@link #ATTEMPT_DELAY} (or failed), the earlier ones still trying, as RFC 8305 does; the
 * first to connect is kept and the rest are closed.
 *
 * <p>The client has no hook for how it dials, only for its proxy, so the SDK's own client reaches
 * the API through a relay in this process ({@link Relay}): a CONNECT relay on loopback that dials
 * as above and then copies bytes. TLS stays end to end and the client still checks the API's name;
 * the relay sees only ciphertext. It tunnels only to the origins the SDK's clients named, so it is
 * no more than a way to the public API for anything else on the machine. A client given its own
 * {@code HttpClient}, or a proxy from the environment, dials as that says.
 */
final class NextAddress {
  /** How long an attempt has before the name's next address is tried beside it. */
  static final Duration ATTEMPT_DELAY = Duration.ofMillis(250);

  /** A name's addresses, as {@link InetAddress#getAllByName} gives them. */
  interface Resolver {
    InetAddress[] all(String host) throws IOException;
  }

  private NextAddress() {}

  /** The addresses with their families alternating, the first one's first. */
  static List<InetAddress> interleave(InetAddress[] all) {
    List<InetAddress> first = new ArrayList<>();
    List<InetAddress> other = new ArrayList<>();
    for (InetAddress a : all) {
      if (a.getClass() == all[0].getClass()) first.add(a);
      else other.add(a);
    }
    List<InetAddress> out = new ArrayList<>();
    for (int i = 0; i < Math.max(first.size(), other.size()); i++) {
      if (i < first.size()) out.add(first.get(i));
      if (i < other.size()) out.add(other.get(i));
    }
    return out;
  }

  /**
   * A connected, blocking channel to host:port, its addresses raced {@link #ATTEMPT_DELAY} apart,
   * within {@code timeout}.
   *
   * @throws ConnectException every address refused or could not be reached
   * @throws SocketTimeoutException none connected within the timeout
   */
  static SocketChannel connect(Resolver resolver, String host, int port, Duration timeout)
      throws IOException {
    InetAddress[] found = resolver.all(host);
    if (found.length == 0) throw new java.net.UnknownHostException(host);
    List<InetAddress> addrs = interleave(found);
    long delay = ATTEMPT_DELAY.toNanos();
    long deadline = System.nanoTime() + timeout.toNanos();
    List<IOException> errors = new ArrayList<>();
    Map<SocketChannel, InetAddress> pending = new LinkedHashMap<>();
    SocketChannel winner = null;
    try (Selector selector = Selector.open()) {
      int next = 0;
      long nextAt = System.nanoTime();
      while (winner == null) {
        long now = System.nanoTime();
        if (now >= deadline) {
          throw new SocketTimeoutException(
              "no address of " + host + " connected within " + timeout.toMillis() + " ms");
        }
        if (next < addrs.size() && (now >= nextAt || pending.isEmpty())) {
          InetAddress at = addrs.get(next++);
          SocketChannel channel = SocketChannel.open();
          try {
            channel.configureBlocking(false);
            if (channel.connect(new InetSocketAddress(at, port))) {
              winner = channel;
              break;
            }
            channel.register(selector, SelectionKey.OP_CONNECT);
            pending.put(channel, at);
            nextAt = now + delay;
          } catch (IOException failure) {
            channel.close();
            errors.add(failure);
            continue;
          }
        }
        if (pending.isEmpty()) {
          if (next >= addrs.size()) break;
          continue;
        }
        long wait = deadline - now;
        if (next < addrs.size()) wait = Math.min(wait, nextAt - now);
        selector.select(Math.max(1, TimeUnit.NANOSECONDS.toMillis(wait)));
        Iterator<SelectionKey> ready = selector.selectedKeys().iterator();
        while (ready.hasNext()) {
          SelectionKey key = ready.next();
          ready.remove();
          SocketChannel channel = (SocketChannel) key.channel();
          InetAddress at = pending.remove(channel);
          key.cancel();
          try {
            channel.finishConnect();
            if (winner == null) winner = channel;
            else channel.close();
          } catch (IOException failure) {
            channel.close();
            errors.add(new ConnectException(at.getHostAddress() + ": " + failure.getMessage()));
          }
        }
      }
    } finally {
      for (SocketChannel channel : pending.keySet()) {
        try {
          channel.close();
        } catch (IOException ignored) {
          // Closing an attempt nobody waits for.
        }
      }
    }
    if (winner == null) {
      ConnectException none = new ConnectException("no address of " + host + " connected");
      for (IOException e : errors) none.addSuppressed(e);
      throw none;
    }
    // The selector is closed, so the winner is registered nowhere and may block again.
    winner.configureBlocking(true);
    return winner;
  }

  /** The SDK's client's proxy for {@code origin}: the relay for HTTPS to that origin's name. */
  static ProxySelector selector(URI origin) {
    Relay relay = Relay.shared();
    String target = Relay.authority(origin.getHost(), port(origin));
    relay.allow(target);
    return new ProxySelector() {
      @Override
      public List<Proxy> select(URI uri) {
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        boolean secure = scheme.equals("https") || scheme.equals("wss");
        if (secure && uri.getHost() != null && Relay.authority(uri.getHost(), port(uri)).equals(target))
          return List.of(new Proxy(Proxy.Type.HTTP, relay.address()));
        return List.of(Proxy.NO_PROXY);
      }

      @Override
      public void connectFailed(URI uri, SocketAddress at, IOException failure) {}
    };
  }

  /** Whether the SDK's client reaches {@code origin} through the relay: HTTPS to a name. */
  static boolean relayed(URI origin) {
    String host = origin.getHost();
    return "https".equalsIgnoreCase(origin.getScheme())
        && host != null
        && !host.contains(":")
        && !host.matches("[0-9.]+");
  }

  private static int port(URI uri) {
    return uri.getPort() == -1 ? 443 : uri.getPort();
  }

  /**
   * Whether {@code failure} is the relay saying that no address connected (its {@code 502}): no
   * byte of the request left this machine.
   */
  static boolean relayRefused(Throwable failure) {
    String message = failure.getMessage();
    return message != null
        && message.toLowerCase(Locale.ROOT).contains("tunnel")
        && message.contains(String.valueOf(Relay.NONE_CONNECTED));
  }

  /** The CONNECT relay on loopback ({@link NextAddress}). */
  static final class Relay {
    /** The answer when every address refused or could not be reached. */
    static final int NONE_CONNECTED = 502;

    private static Relay shared;
    private final ServerSocket socket;
    private final Resolver resolver;
    private final Duration within;
    private final Set<String> allowed = ConcurrentHashMap.newKeySet();

    Relay(Resolver resolver, Duration within) throws IOException {
      this.resolver = resolver;
      this.within = within;
      socket = new ServerSocket(0, 256, InetAddress.getLoopbackAddress());
      Thread accepting = new Thread(this::accept, "withruntime-next-address");
      accepting.setDaemon(true);
      accepting.start();
    }

    /** The one relay of this process, started at its first use. */
    static synchronized Relay shared() {
      if (shared == null) {
        try {
          shared = new Relay(InetAddress::getAllByName, Duration.ofSeconds(30));
        } catch (IOException failure) {
          throw new java.io.UncheckedIOException("withruntime: a loopback port", failure);
        }
      }
      return shared;
    }

    static String authority(String host, int port) {
      return host.toLowerCase(Locale.ROOT) + ":" + port;
    }

    void allow(String target) {
      allowed.add(target.toLowerCase(Locale.ROOT));
    }

    InetSocketAddress address() {
      return new InetSocketAddress(socket.getInetAddress(), socket.getLocalPort());
    }

    void close() throws IOException {
      socket.close();
    }

    private void accept() {
      while (!socket.isClosed()) {
        Socket client;
        try {
          client = socket.accept();
        } catch (IOException failure) {
          continue;
        }
        Thread serving = new Thread(() -> serve(client), "withruntime-next-address-tunnel");
        serving.setDaemon(true);
        serving.start();
      }
    }

    private static void answer(OutputStream out, int status, String reason) throws IOException {
      out.write(
          ("HTTP/1.1 " + status + " " + reason + "\r\ncontent-length: 0\r\n\r\n")
              .getBytes(StandardCharsets.ISO_8859_1));
      out.flush();
    }

    private void serve(Socket client) {
      try (Socket c = client) {
        c.setSoTimeout(10_000);
        c.setTcpNoDelay(true);
        InputStream in = c.getInputStream();
        OutputStream out = c.getOutputStream();
        // The CONNECT request's head, byte by byte: nothing past it is read here.
        ByteArrayOutputStream head = new ByteArrayOutputStream();
        int b;
        while ((b = in.read()) != -1) {
          head.write(b);
          byte[] h = head.toByteArray();
          int n = h.length;
          if (n >= 4 && h[n - 4] == '\r' && h[n - 3] == '\n' && h[n - 2] == '\r' && h[n - 1] == '\n')
            break;
          if (n > 8192) return;
        }
        String[] line = head.toString(StandardCharsets.ISO_8859_1).split("\r\n", 2)[0].split(" ");
        String target = line.length == 3 ? line[1].toLowerCase(Locale.ROOT) : "";
        int colon = target.lastIndexOf(':');
        if (!line[0].equals("CONNECT") || colon < 1 || !allowed.contains(target)) {
          answer(out, 403, "Forbidden");
          return;
        }
        SocketChannel up;
        try {
          up = connect(resolver, target.substring(0, colon), Integer.parseInt(target.substring(colon + 1)), within);
        } catch (SocketTimeoutException failure) {
          answer(out, 504, "Gateway Timeout");
          return;
        } catch (IOException failure) {
          answer(out, NONE_CONNECTED, "Bad Gateway");
          return;
        }
        try (SocketChannel u = up) {
          Socket upstream = u.socket();
          upstream.setTcpNoDelay(true);
          answer(out, 200, "Connection Established");
          c.setSoTimeout(0);
          Thread back =
              new Thread(() -> copy(upstream, c), "withruntime-next-address-back");
          back.setDaemon(true);
          back.start();
          copy(c, upstream);
          back.join();
        }
      } catch (IOException | InterruptedException failure) {
        // The tunnel ends with either side; the client sees its own error.
        if (failure instanceof InterruptedException) Thread.currentThread().interrupt();
      }
    }

    /** Copies {@code from} to {@code to} until {@code from} ends, then half-closes {@code to}. */
    private static void copy(Socket from, Socket to) {
      byte[] buffer = new byte[16 * 1024];
      try {
        InputStream in = from.getInputStream();
        OutputStream out = to.getOutputStream();
        for (int n; (n = in.read(buffer)) != -1; ) {
          out.write(buffer, 0, n);
          out.flush();
        }
        to.shutdownOutput();
      } catch (IOException failure) {
        try {
          from.close();
          to.close();
        } catch (IOException ignored) {
          // Both are being torn down.
        }
      }
    }
  }
}
