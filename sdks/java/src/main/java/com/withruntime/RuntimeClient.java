package com.withruntime;

import java.net.http.HttpClient;
import java.time.Duration;
import java.util.Map;

/**
 * One client for every Runtime Cloud product. Make it once and share it: it is safe for concurrent
 * use and keeps its connections open.
 *
 * <pre>{@code
 * RuntimeClient runtime = RuntimeClient.create(); // RUNTIME_API_KEY, or this machine's saved connection
 * try (Sandbox sbx = runtime.sandboxes().create(new CreateSandbox())) {
 *   sbx.files().write("/workspace/invoice.py", "print(sum([125, 250, 375]))\n");
 *   CommandResult result = sbx.exec("python3 /workspace/invoice.py", new ExecOptions().check(true));
 *   System.out.print(result.stdout());
 * }
 * }</pre>
 *
 * <p>Every product is {@code runtime.<product>().<verb>(...)}. Money is integer microdollars
 * (1,000,000 is one US dollar).
 *
 * <p>Agents are set up from a runtime.yml in your repo by the CLI, which makes the account's agents
 * match the file: {@code npx withruntime agents deploy}. This package has no deploy of its own.
 */
public final class RuntimeClient {
  /** This SDK's version, sent as X-Runtime-Client. */
  public static final String VERSION = "0.21.0";

  /** Runtime's API. */
  public static final String DEFAULT_BASE_URL = "https://api.withruntime.com";

  final Transport transport;
  private final Sandboxes sandboxes;
  private final Snapshots snapshots;
  private final Images images;
  private final Volumes volumes;
  private final Agents agents;
  private final Apps apps;
  private final Apps functions;
  private final Builds builds;
  private final Ci ci;
  private final Containers containers;
  private final Products.Secrets secrets;
  private final Reservations reservations;
  private final Products.Limits limits;
  private final Products.Jobs jobs;
  private final Products.Emails emails;
  private final Products.Referrals referrals;
  private final Products.Plans plans;
  private final Products.Switching switching;
  private final Products.Events events;
  private final Products.Webhooks webhooks;
  private final Products.Otel otel;
  private final Products.Audit audit;
  private final Products.Feedback feedback;
  private final Products.Support support;

  private RuntimeClient(Builder builder) {
    Map<String, String> env = builder.env;
    String base = builder.baseUrl;
    if (base == null) base = env.get("RUNTIME_API_URL");
    if (base == null || base.isEmpty()) base = DEFAULT_BASE_URL;
    String origin = Credentials.origin(base);
    String key = builder.apiKey;
    if (key == null) {
      String fromEnv = env.get("RUNTIME_API_KEY");
      if (fromEnv != null && !fromEnv.isEmpty()) key = fromEnv;
      else key = Credentials.savedKey(env, origin);
    }
    if (key == null || key.isEmpty()) throw RuntimeCloudException.missingKey();
    if (key.chars().anyMatch(Character::isWhitespace))
      throw new IllegalArgumentException("The Runtime API key contains whitespace.");
    // The saved key is found by the origin as given; the calls go where that origin is reachable
    // from here.
    this.transport =
        new Transport(builder, key, Credentials.reachable(origin, Credentials::inRuntimeSandbox));
    this.sandboxes = new Sandboxes(transport);
    this.snapshots = new Snapshots(transport);
    this.images = new Images(transport);
    this.volumes = new Volumes(transport);
    this.agents = new Agents(transport);
    this.apps = new Apps(transport, "apps");
    this.functions = new Apps(transport, "functions");
    this.builds = new Builds(transport);
    this.ci = new Ci(transport);
    this.containers = new Containers(transport);
    this.secrets = new Products.Secrets(transport);
    this.reservations = new Reservations(transport);
    this.limits = new Products.Limits(transport);
    this.jobs = new Products.Jobs(transport);
    this.emails = new Products.Emails(transport);
    this.referrals = new Products.Referrals(transport);
    this.plans = new Products.Plans(transport);
    this.switching = new Products.Switching(transport);
    this.events = new Products.Events(transport);
    this.webhooks = new Products.Webhooks(transport);
    this.otel = new Products.Otel(transport);
    this.audit = new Products.Audit(transport);
    this.feedback = new Products.Feedback(transport);
    this.support = new Products.Support(transport);
  }

  /**
   * A client with the key from RUNTIME_API_KEY, or else the connection `npx withruntime login`
   * saved for this machine. Throws {@link RuntimeCloudException.Authentication} with code
   * missing_api_key when there is neither.
   */
  public static RuntimeClient create() {
    return builder().build();
  }

  public static Builder builder() {
    return new Builder();
  }

  /** How a client is made. Every setting is optional. */
  public static final class Builder {
    String apiKey;
    String baseUrl;
    Duration timeout = Duration.ofMinutes(5);
    int maxRetries = 4;
    int maxConnections = 32;
    Duration waitForCapacity = Duration.ofMinutes(2);
    HttpClient httpClient;
    Map<String, String> env = System.getenv();

    private Builder() {}

    /** The key. Default: RUNTIME_API_KEY, then this machine's saved connection. */
    public Builder apiKey(String key) {
      if (key == null || key.isEmpty() || key.chars().anyMatch(Character::isWhitespace))
        throw new IllegalArgumentException("The API key is empty or contains whitespace.");
      this.apiKey = key;
      return this;
    }

    /**
     * Another API origin. Default: RUNTIME_API_URL, then https://api.withruntime.com. Inside a
     * Runtime sandbox, calls for https://api.withruntime.com go to http://runtime.internal.
     */
    public Builder baseUrl(String url) {
      this.baseUrl = url;
      return this;
    }

    /** The deadline for each call, retries included. Default 5 minutes. */
    public Builder timeout(Duration timeout) {
      this.timeout = timeout;
      return this;
    }

    /** How often a transport failure, 429, 502, 503 or 504 is retried. Default 4. */
    public Builder maxRetries(int retries) {
      if (retries < 0) throw new IllegalArgumentException("maxRetries cannot be negative.");
      this.maxRetries = retries;
      return this;
    }

    /** Calls in flight at once; more wait their turn. Streams do not count. Default 32. */
    public Builder maxConnections(int connections) {
      this.maxConnections = Math.max(1, connections);
      return this;
    }

    /**
     * How long a sandbox create keeps retrying, with the same key and input, when every slot without credit,
     * the account's quota or the region is full. Default two minutes; zero fails at once.
     */
    public Builder waitForCapacity(Duration wait) {
      this.waitForCapacity = wait.isNegative() ? Duration.ZERO : wait;
      return this;
    }

    /**
     * Your own {@link HttpClient}. It must not follow redirects. The default honours HTTPS_PROXY
     * and NO_PROXY.
     */
    public Builder httpClient(HttpClient client) {
      this.httpClient = client;
      return this;
    }

    /** The environment to read RUNTIME_* and XDG_CONFIG_HOME from. For tests. */
    Builder env(Map<String, String> env) {
      this.env = env;
      return this;
    }

    public RuntimeClient build() {
      return new RuntimeClient(this);
    }
  }

  /** The API origin this client calls. */
  public String baseUrl() {
    return transport.baseUrl;
  }

  public Sandboxes sandboxes() {
    return sandboxes;
  }

  public Snapshots snapshots() {
    return snapshots;
  }

  public Images images() {
    return images;
  }

  public Volumes volumes() {
    return volumes;
  }

  /** Agents that run in sandboxes, one session per piece of work. A private beta. */
  public Agents agents() {
    return agents;
  }

  /**
   * Servers that wake on demand behind one URL, deployed from an image or a build, keeping copies
   * awake if asked. In private beta: outside it, PermissionDenied with code product_in_beta.
   */
  public Apps apps() {
    return apps;
  }

  /**
   * Apps that keep no copy awake, at /v1/functions. In private beta: outside it, PermissionDenied
   * with code product_in_beta.
   */
  public Apps functions() {
    return functions;
  }

  /**
   * Builds of connected repositories, and the repositories ({@code builds().repositories()}). In
   * private beta: outside it, PermissionDenied with code product_in_beta.
   */
  public Builds builds() {
    return builds;
  }

  /**
   * CI/CD: a connected GitHub repository's pushes and pull requests checked in sandboxes, and
   * their checks, jobs and test files. In a private beta.
   */
  public Ci ci() {
    return ci;
  }

  /**
   * One OCI image's process each on its own microVM, at the sandbox rates. In private beta:
   * outside it, PermissionDenied with code product_in_beta.
   */
  public Containers containers() {
    return containers;
  }

  /** Values sandboxes use on the way out without seeing them. */
  public Products.Secrets secrets() {
    return secrets;
  }

  /** Room booked for a burst of sandboxes for a window. */
  public Reservations reservations() {
    return reservations;
  }

  /** What this key may do and spend. */
  public Products.Limits limits() {
    return limits;
  }

  /** Other platforms' jobs read into Runtime jobs. */
  public Products.Jobs jobs() {
    return jobs;
  }

  /** Which of Runtime's optional emails this key's person gets. */
  public Products.Emails emails() {
    return emails;
  }

  public Products.Referrals referrals() {
    return referrals;
  }

  /** Monthly plans whose fee is prepaid usage. */
  public Products.Plans plans() {
    return plans;
  }

  /** Compare usage with a rival's published rates, and record a switch. */
  public Products.Switching switching() {
    return switching;
  }

  /** Lifecycle events. */
  public Products.Events events() {
    return events;
  }

  public Products.Webhooks webhooks() {
    return webhooks;
  }

  /** OpenTelemetry export. */
  public Products.Otel otel() {
    return otel;
  }

  public Products.Audit audit() {
    return audit;
  }

  /** Tell the Runtime team something. */
  public Products.Feedback feedback() {
    return feedback;
  }

  public Products.Support support() {
    return support;
  }

  public NetworkProducts.Domains domains() {
    return new NetworkProducts.Domains(transport);
  }

  public NetworkProducts.Ports ports() {
    return new NetworkProducts.Ports(transport);
  }

  /** Dedicated outbound addresses every sandbox of the account sends from. */
  public NetworkProducts.Addresses ips() {
    return new NetworkProducts.Addresses(transport);
  }

  /** The account's networks: {@code networks().wireguard()}. */
  public NetworkProducts.Networks networks() {
    return new NetworkProducts.Networks(transport);
  }

  /**
   * Renamed {@link #ips()} on 6 October 2026, one plural word per product.
   *
   * @deprecated use {@link #ips()}; removed by a release after the 30 days of overlap.
   */
  @Deprecated
  public NetworkProducts.Addresses addresses() {
    return ips();
  }

  /**
   * Renamed {@code networks().wireguard()} on 6 October 2026.
   *
   * @deprecated use {@code networks().wireguard()}; removed by a release after the 30 days of overlap.
   */
  @Deprecated
  public NetworkProducts.PrivateTunnel tunnel() {
    return networks().wireguard();
  }

  public IdentityProducts.SSO sso() {
    return new IdentityProducts.SSO(transport);
  }

  public IdentityProducts.MCP mcp() {
    return new IdentityProducts.MCP(transport);
  }

  /** Who this key is: organization, agent and credential. */
  public Me me() {
    return new Me(transport.object(new Transport.Call("GET", "/v1/me")));
  }

  /** The account's credit, holds, free time and per-resource charges. */
  public Usage usage() {
    return new Usage(transport.object(new Transport.Call("GET", "/v1/usage")));
  }

  /**
   * One page of settled usage for every product the key sees: settled at since or later and before
   * until (UTC, ending in Z). Follow nextCursor with the same range until it is null (cursor and
   * limit may be null). The page's finalThrough says how far the range can no longer change.
   */
  public UsageExportPage usageExport(String since, String until, String cursor, Integer limit) {
    return new UsageExportPage(
        transport.object(
            new Transport.Call("GET", "/v1/usage/export")
                .query("since", since)
                .query("until", until)
                .query("cursor", cursor)
                .query("limit", limit)));
  }

  /**
   * Calls any API path with this client's key, retries, idempotency keys and errors, and returns
   * the parsed JSON answer (a Map, a List or null). For an endpoint newer than this SDK.
   */
  public Object request(String method, String path, Map<String, ?> query, Object body) {
    if (!path.startsWith("/")) throw new IllegalArgumentException("The path must start with /.");
    Transport.Call call = new Transport.Call(method.toUpperCase(java.util.Locale.ROOT), path);
    if (query != null) query.forEach(call::query);
    if (body == null && !call.method.equals("GET") && !call.method.equals("DELETE"))
      body = Map.of();
    return transport.json(call.body(body));
  }
}
