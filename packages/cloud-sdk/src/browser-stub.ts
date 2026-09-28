/* What a browser bundle gets in place of the SDK's Node-only modules: the
 * "browser" field in package.json maps them here. Their calls (directory
 * uploads, image build contexts, the saved `runtime login` key, a proxy through
 * undici) run only on Node and Bun; a page using a sandbox session
 * (Sandbox.fromSession) never reaches them, and its bundler need not resolve
 * zlib, the file system or undici. */
export {};
