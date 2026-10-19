/** A file's MIME type as Cloudflare's container reports it: from the
 * extension first, then from the content (`file --mime-type` there; the
 * common signatures and text here), else application/octet-stream. */
const BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
  avif: "image/avif",
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  tgz: "application/gzip",
  tar: "application/x-tar",
  wasm: "application/wasm",
  json: "application/json",
  xml: "application/xml",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  css: "text/css",
  html: "text/html",
  htm: "text/html",
  md: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  yaml: "text/yaml",
  yml: "text/yaml",
  py: "text/x-python",
  sh: "application/x-sh",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
};
const SIGNATURES: [number[], string][] = [
  [[0x89, 0x50, 0x4e, 0x47], "image/png"],
  [[0xff, 0xd8, 0xff], "image/jpeg"],
  [[0x47, 0x49, 0x46, 0x38], "image/gif"],
  [[0x25, 0x50, 0x44, 0x46], "application/pdf"],
  [[0x50, 0x4b, 0x03, 0x04], "application/zip"],
  [[0x1f, 0x8b], "application/gzip"],
  [[0x00, 0x61, 0x73, 0x6d], "application/wasm"],
  [[0x7f, 0x45, 0x4c, 0x46], "application/x-executable"],
];

export function mimeType(path: string, bytes: Uint8Array): string {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  const known = dot > 0 ? BY_EXTENSION[name.slice(dot + 1).toLowerCase()] : undefined;
  if (known) return known;
  for (const [signature, type] of SIGNATURES)
    if (signature.every((byte, i) => bytes[i] === byte)) return type;
  if (bytes.length === 0) return "inode/x-empty";
  const text = new TextDecoder().decode(bytes.subarray(0, 8192));
  return text.includes("\0") || text.includes("�") ? "application/octet-stream" : "text/plain";
}
