import { Page } from "../page.js";
import type { RequestOptions, Transport } from "../transport.js";

/** A file for a small build context sent inline, or a recipe. */
export type ImageFile = {
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
  mode?: number;
};
export type ImageRecipe = {
  /** "runtime" (the default) or an image reference. */
  base?: string;
  apt?: string[];
  pip?: string[];
  npm?: string[];
  commands?: string[];
  env?: Record<string, string>;
  files?: ImageFile[];
  workdir?: string;
};
export type ImageBuildLimits = {
  vcpu?: number;
  memoryMiB?: number;
  diskMiB?: number;
  maxImageMiB?: number;
  timeoutSeconds?: number;
  /** The most this build's layer cache may keep. */
  cacheMiB?: number;
};
/** What a sandbox from the image runs as it starts, and when its create
 * answers: once `readyPort` is listened on, or `readyCommand` exits 0. */
export type ImageStart = {
  command?: string;
  argv?: string[];
  cwd?: string;
  env?: Record<string, string>;
  readyCommand?: string;
  readyPort?: number;
  readyTimeoutSeconds?: number;
};
/** An uploaded build context: its archive's chunks and the files it holds. */
export type ImageContext = {
  archive: { sha256: string; size: number; chunks: string[] };
  files: { path: string; sha256: string; size: number; mode?: number }[];
};
/** Exactly one of `image`, `dockerfile` or `recipe`. */
export type CreateImage = {
  /** Each build of a name is its next version. */
  name?: string;
  /** Tags the build takes when ready; a named image with none takes `latest`. */
  tags?: string[];
  labels?: Record<string, string>;
  region?: string;
  build?: ImageBuildLimits;
  env?: Record<string, string>;
  /** Overrides a Dockerfile's CMD and HEALTHCHECK; null runs nothing. */
  start?: ImageStart | null;
  /** false: build every step afresh and keep no cache. */
  cache?: boolean;
} & (
  | { image: string; dockerfile?: never; recipe?: never }
  | {
      dockerfile: string;
      /** A small context sent inline (1 MiB in all). */
      files?: ImageFile[];
      /** A folder to send as the context, with its .dockerignore; uploaded
       * as chunks, and only the ones the server does not have. */
      contextDir?: string;
      /** An already uploaded context (`uploadContext`). */
      context?: ImageContext;
      dockerignore?: string;
      buildArgs?: Record<string, string>;
      /** Build this stage instead of the last. */
      target?: string;
      image?: never;
      recipe?: never;
    }
  | { recipe: ImageRecipe; image?: never; dockerfile?: never }
);
export type ImageState = "queued" | "building" | "ready" | "failed" | "deleting" | "deleted";
export type Image = {
  id: string;
  kind: "image";
  status: string;
  state: ImageState;
  name: string | null;
  version: number | null;
  tags: string[];
  pendingTags?: string[];
  labels: Record<string, string>;
  region: string;
  source: {
    kind: "dockerfile" | "oci" | "recipe";
    digest: string;
    base: unknown;
    steps: number;
    planVersion?: number;
    stages?: number;
    contextBytes?: number | null;
  };
  build: ImageBuildLimits & {
    startedAt: string | null;
    endedAt: string | null;
    cachedSteps: number;
    builderVersion: string | null;
  };
  cache?: {
    enabled: boolean;
    maxMiB: number;
    from: string | null;
    checkpoints: number;
    bytes: number;
  };
  start?: ImageStart | null;
  sizeBytes: number | null;
  sizeMiB: number | null;
  storedBytes: number | null;
  rootfsSha256: string | null;
  env: Record<string, string>;
  workdir: string;
  error: string | null;
  logs: { bytes: number; lines: number; truncated: boolean };
  createdAt: string;
  readyAt: string | null;
  /** What the source asked for that an image does not carry (on create). */
  notes?: string[];
};
export type ImageLogLine = { seq: number; at: string; stream: "build" | "system"; text: string };
export type ImageLogs = {
  lines: ImageLogLine[];
  nextAfter: number;
  state: ImageState;
  truncated: boolean;
  done: boolean;
};
type LogEvent =
  | ({ type: "line" } & ImageLogLine)
  | { type: "truncated" }
  | { type: "done"; state: ImageState; image: Image }
  | { type: "continue"; after: number }
  | { type: "error"; error: { code: string; message: string } };
export type ImageRegistry = {
  id: string;
  registry: string;
  kind: "basic" | "ecr";
  username: string;
  region: string | null;
  createdAt: string;
};
/** Credentials for pulling private images: a user name and token or password
 * (Docker Hub, GitHub, Google with username `_json_key`), or an AWS access
 * key for Amazon ECR. Sealed for Runtime's hosts; never returned. */
export type SetImageRegistry =
  | { registry: string; username: string; password: string }
  | { registry: string; accessKeyId: string; secretAccessKey: string };

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PARALLEL_UPLOADS = 4;

/** Custom images: `runtime.images.build({ recipe: { pip: ["pandas"] } })`, or
 * `runtime.images.build({ name: "app", dockerfile, contextDir: "." })`, then
 * `runtime.sandboxes.create({ image: "app" })`. */
export function images(t: Transport) {
  const enc = encodeURIComponent;
  const get = (id: string, options?: RequestOptions) =>
    t.json<Image>({ method: "GET", path: `/v1/images/${enc(id)}`, ...options });
  /** An image by id, name (its latest tag), name:tag or name@version. */
  const resolve = (ref: string, options?: RequestOptions) =>
    UUID.test(ref)
      ? get(ref, options)
      : t.json<Image>({ method: "GET", path: "/v1/images/resolve", query: { ref }, ...options });
  const idOf = async (ref: string, options?: RequestOptions) =>
    UUID.test(ref) ? ref : (await resolve(ref, options)).id;
  const logs = (id: string, after = 0, options?: RequestOptions) =>
    t.json<ImageLogs>({
      method: "GET",
      path: `/v1/images/${enc(id)}/logs`,
      query: { after },
      ...options,
    });
  const list = async (
    query: { state?: ImageState; name?: string; limit?: number; cursor?: string } = {},
    options?: RequestOptions,
  ): Promise<Page<Image>> => {
    const page = await t.json<{ data: Image[]; nextCursor: string | null }>({
      method: "GET",
      path: "/v1/images",
      query,
      ...options,
    });
    return new Page(page.data, page.nextCursor, (cursor) => list({ ...query, cursor }, options));
  };

  /** Pack a folder as a build context and upload the chunks the server does
   * not have yet. Node and Bun. */
  async function uploadContext(
    folder: string,
    options: RequestOptions & { dockerignore?: string; dockerfile?: string } = {},
  ): Promise<ImageContext & { dockerignore?: string }> {
    const { dockerignore, dockerfile, ...request } = options;
    const { packContext, chunkArchive } = await import("../image-context.js");
    const packed = await packContext(folder, {
      ...(dockerignore === undefined ? {} : { dockerignore }),
      ...(dockerfile === undefined ? {} : { dockerfile }),
    });
    const archive = await chunkArchive(packed.archive);
    const { missing } = await t.json<{ missing: string[] }>({
      method: "POST",
      path: "/v1/images/context/missing",
      body: { digests: archive.chunks.map((c) => c.sha256) },
      ...request,
    });
    const wanted = new Set(missing);
    const queue = archive.chunks.filter((chunk) => wanted.has(chunk.sha256));
    const upload = async () => {
      for (let chunk = queue.shift(); chunk; chunk = queue.shift())
        await t.json({
          method: "PUT",
          path: `/v1/images/context/${chunk.sha256}`,
          bytes: chunk.bytes,
          ...request,
        });
    };
    await Promise.all(Array.from({ length: PARALLEL_UPLOADS }, upload));
    return {
      archive: {
        sha256: archive.sha256,
        size: archive.size,
        chunks: archive.chunks.map((c) => c.sha256),
      },
      files: packed.files,
      ...(packed.dockerignore === undefined ? {} : { dockerignore: packed.dockerignore }),
    };
  }

  /** The request, with a context folder uploaded and named instead. */
  async function prepare(input: CreateImage, options?: RequestOptions): Promise<CreateImage> {
    if (!("contextDir" in input) || input.contextDir === undefined) return input;
    const { contextDir, ...rest } = input;
    const uploaded = await uploadContext(contextDir, {
      ...(rest.dockerignore === undefined ? {} : { dockerignore: rest.dockerignore }),
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    const { dockerignore, ...context } = uploaded;
    return {
      ...rest,
      context,
      ...(dockerignore === undefined ? {} : { dockerignore }),
    };
  }

  /** Build log lines as they are written, until the build ends. Streams when
   * the server can, and polls when it cannot. */
  async function followLogs(
    id: string,
    onLog: (line: ImageLogLine) => void,
    options: RequestOptions & { after?: number; pollMs?: number } = {},
  ): Promise<Image> {
    const { after: from = 0, pollMs = 1000, ...request } = options;
    let after = from;
    try {
      for (;;) {
        let resume = false;
        for await (const event of t.events<LogEvent>({
          method: "GET",
          path: `/v1/images/${enc(id)}/logs`,
          query: { after, follow: true },
          ...request,
        })) {
          if (event.type === "line") {
            onLog(event);
            after = event.seq;
          } else if (event.type === "done") return event.image;
          else if (event.type === "continue") {
            after = event.after;
            resume = true;
          } else if (event.type === "error") throw new Error(event.error.message);
        }
        if (!resume) break;
      }
    } catch (error) {
      if (request.signal?.aborted) throw error;
    }
    // A server without streamed logs, or a stream that broke: poll.
    for (;;) {
      const page = await logs(id, after, request);
      for (const line of page.lines) onLog(line);
      after = page.nextAfter;
      if (page.done) return get(id, request);
      const image = await get(id, request);
      if (image.state !== "queued" && image.state !== "building") {
        for (const line of (await logs(id, after, request)).lines) onLog(line);
        return image;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  return {
    /** Queue a build and return at once, state "queued". With `contextDir`,
     * the folder is packed and its missing chunks uploaded first. */
    async create(input: CreateImage, options?: RequestOptions) {
      return t.json<Image>({
        method: "POST",
        path: "/v1/images",
        body: await prepare(input, options),
        ...options,
      });
    },
    /** Build and wait until the image is ready or failed, streaming log lines
     * to `onLog`. Throws when the build fails, with the build's own error. */
    async build(
      input: CreateImage,
      options: RequestOptions & { onLog?: (line: ImageLogLine) => void; pollMs?: number } = {},
    ): Promise<Image> {
      const { onLog, pollMs = 1000, ...request } = options;
      let image = await t.json<Image>({
        method: "POST",
        path: "/v1/images",
        body: await prepare(input, request),
        ...request,
      });
      if (onLog) image = await followLogs(image.id, onLog, { ...request, pollMs });
      while (image.state === "queued" || image.state === "building") {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        image = await get(image.id, { ...(request.signal ? { signal: request.signal } : {}) });
      }
      if (image.state !== "ready")
        throw new Error(`Image ${image.id} ${image.state}: ${image.error ?? "no error given"}`);
      return image;
    },
    uploadContext,
    get,
    resolve,
    logs,
    followLogs,
    list,
    /** Every version of a name, newest first. */
    versions: (name: string, options?: RequestOptions) => list({ name, limit: 100 }, options),
    /** Point `tag` of the image's name at this version. */
    async tag(ref: string, tag: string, options?: RequestOptions) {
      return t.json<Image>({
        method: "POST",
        path: `/v1/images/${enc(await idOf(ref, options))}:tag`,
        body: { tag },
        ...options,
      });
    },
    async untag(ref: string, tag: string, options?: RequestOptions) {
      return t.json<Image>({
        method: "POST",
        path: `/v1/images/${enc(await idOf(ref, options))}:untag`,
        body: { tag },
        ...options,
      });
    },
    /** Delete one version (by id, name:tag or name@version) and its tags. */
    async delete(ref: string, options?: RequestOptions) {
      return t.json<Image>({
        method: "POST",
        path: `/v1/images/${enc(await idOf(ref, options))}:delete`,
        body: {},
        ...options,
      });
    },
    /** Credentials for private registries. The secret is sealed on arrival
     * and never returned. */
    registries: {
      list: async (options?: RequestOptions) =>
        (
          await t.json<{ data: ImageRegistry[] }>({
            method: "GET",
            path: "/v1/images/registries",
            ...options,
          })
        ).data,
      set: (input: SetImageRegistry, options?: RequestOptions) =>
        t.json<ImageRegistry>({
          method: "POST",
          path: "/v1/images/registries",
          body: input,
          ...options,
        }),
      delete: (registry: string, options?: RequestOptions) =>
        t.json<{ registry: string; deleted: boolean }>({
          method: "POST",
          path: "/v1/images/registries:delete",
          body: { registry },
          ...options,
        }),
    },
  };
}
