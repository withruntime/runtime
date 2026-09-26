import { createHash } from "node:crypto";
import { NotSupportedError } from "./errors.js";

/** A file of the build context, as Runtime's image builds take it. */
export type ContextFile = { path: string; content: string; encoding: "base64"; mode?: number };

const PYTHON = ["3.9", "3.10", "3.11", "3.12", "3.13"] as const;

/** Daytona's declarative image, kept as the Dockerfile it stands for and
 * built as a Runtime image (`runtime.images.build`) when a sandbox or a
 * snapshot is created from it. Local files go with the build as its context. */
export class Image {
  #lines: string[];
  #files: Array<{ local: string; remote: string; dir: boolean }> = [];
  #dockerfilePath: string | undefined;

  private constructor(lines: string[]) {
    this.#lines = lines;
  }

  /** The Dockerfile so far. */
  get dockerfile(): string {
    return `${this.#lines.join("\n")}\n`;
  }

  static base(image: string): Image {
    return new Image([`FROM ${image}`]);
  }

  static debianSlim(pythonVersion: (typeof PYTHON)[number] = "3.12"): Image {
    if (!PYTHON.includes(pythonVersion))
      throw new NotSupportedError(
        `Python ${pythonVersion as string}`,
        `Use one of ${PYTHON.join(", ")}.`,
      );
    return new Image([
      `FROM python:${pythonVersion}-slim-bookworm`,
      "RUN apt-get update && apt-get install -y --no-install-recommends gcc gfortran build-essential && rm -rf /var/lib/apt/lists/*",
      "RUN pip install --upgrade pip",
    ]);
  }

  /** A local Dockerfile; files it copies come from its directory. */
  static fromDockerfile(path: string): Image {
    const image = new Image([]);
    image.#dockerfilePath = path;
    return image;
  }

  pipInstall(
    packages: string | string[],
    options: {
      indexUrl?: string;
      extraIndexUrls?: string[];
      findLinks?: string[];
      pre?: boolean;
      extraOptions?: string;
    } = {},
  ): Image {
    const list = [packages].flat();
    if (!list.length) return this;
    const flags = [
      ...(options.indexUrl ? [`--index-url ${options.indexUrl}`] : []),
      ...(options.extraIndexUrls ?? []).map((url) => `--extra-index-url ${url}`),
      ...(options.findLinks ?? []).map((url) => `--find-links ${url}`),
      ...(options.pre ? ["--pre"] : []),
      ...(options.extraOptions ? [options.extraOptions] : []),
    ];
    this.#lines.push(
      `RUN python -m pip install ${list.map((one) => JSON.stringify(one)).join(" ")} ${flags.join(" ")}`.trim(),
    );
    return this;
  }

  pipInstallFromRequirements(requirementsTxt: string): Image {
    const remote = `/.requirements/${createHash("sha256").update(requirementsTxt).digest("hex").slice(0, 12)}.txt`;
    this.#files.push({ local: requirementsTxt, remote, dir: false });
    this.#lines.push(`COPY ${remote.slice(1)} ${remote}`, `RUN python -m pip install -r ${remote}`);
    return this;
  }

  pipInstallFromPyproject(): Image {
    throw new NotSupportedError(
      "Installing from pyproject.toml (pipInstallFromPyproject)",
      "Export requirements (`uv export > requirements.txt`) and use pipInstallFromRequirements.",
    );
  }

  addLocalFile(localPath: string, remotePath: string): Image {
    const source = `ctx/${this.#files.length}`;
    this.#files.push({ local: localPath, remote: source, dir: false });
    this.#lines.push(`COPY ${source} ${remotePath}`);
    return this;
  }

  addLocalDir(localPath: string, remotePath: string): Image {
    const source = `ctx/${this.#files.length}`;
    this.#files.push({ local: localPath, remote: source, dir: true });
    this.#lines.push(`COPY ${source} ${remotePath}`);
    return this;
  }

  runCommands(...commands: (string | string[])[]): Image {
    for (const command of commands)
      this.#lines.push(`RUN ${Array.isArray(command) ? JSON.stringify(command) : command}`);
    return this;
  }

  env(envVars: Record<string, string>): Image {
    for (const [key, value] of Object.entries(envVars))
      this.#lines.push(`ENV ${key}=${JSON.stringify(value)}`);
    return this;
  }

  workdir(dirPath: string): Image {
    this.#lines.push(`WORKDIR ${dirPath}`);
    return this;
  }

  entrypoint(entrypointCommands: string[]): Image {
    this.#lines.push(`ENTRYPOINT ${JSON.stringify(entrypointCommands)}`);
    return this;
  }

  cmd(cmd: string[]): Image {
    this.#lines.push(`CMD ${JSON.stringify(cmd)}`);
    return this;
  }

  dockerfileCommands(dockerfileCommands: string[]): Image {
    this.#lines.push(...dockerfileCommands);
    return this;
  }

  /** The Dockerfile and its context files, read from the local disk. */
  async build(): Promise<{ dockerfile: string; files: ContextFile[]; name: string }> {
    const { readFile, readdir, stat } = await import("node:fs/promises");
    const paths = await import("node:path");
    const files: ContextFile[] = [];
    const add = async (local: string, remote: string) => {
      const info = await stat(local);
      if (info.isDirectory()) {
        for (const entry of await readdir(local, { recursive: true, withFileTypes: true })) {
          if (!entry.isFile()) continue;
          const full = paths.join(entry.parentPath, entry.name);
          files.push({
            path: `${remote}/${paths.relative(local, full)}`,
            content: (await readFile(full)).toString("base64"),
            encoding: "base64",
          });
        }
      } else
        files.push({
          path: remote,
          content: (await readFile(local)).toString("base64"),
          encoding: "base64",
          mode: info.mode & 0o777,
        });
    };
    let dockerfile = this.dockerfile;
    if (this.#dockerfilePath) {
      dockerfile = await readFile(this.#dockerfilePath, "utf8");
      const context = paths.dirname(this.#dockerfilePath);
      for (const match of dockerfile.matchAll(/^\s*(?:COPY|ADD)\s+(?:--\S+\s+)*(.+?)\s+\S+\s*$/gim))
        for (const source of match[1]!.split(/\s+/))
          if (!/^[a-z]+:\/\//.test(source))
            await add(paths.join(context, source), source.replace(/^\.\//, ""));
    }
    for (const file of this.#files) await add(file.local, file.remote);
    const digest = createHash("sha256").update(dockerfile);
    for (const file of files) digest.update(file.path).update(file.content);
    return { dockerfile, files, name: `daytona-image-${digest.digest("hex").slice(0, 16)}` };
  }
}
