import type { WatchOptions } from "./index.js";

/** Cloudflare's watch filters: include or exclude, never both; by default
 * .git, node_modules and .DS_Store are left out. */
export function watchFilters(options: WatchOptions): { include?: string[]; exclude?: string[] } {
  if (options.include?.length && options.exclude?.length)
    throw new Error("include and exclude cannot be used together");
  if (options.include?.length) return { include: options.include };
  return { exclude: options.exclude ?? [".git", "node_modules", ".DS_Store"] };
}
/** argv: path, recursive, include JSON, exclude JSON. Prints boot.digest. */
export const CHANGES = `import fnmatch,hashlib,json,os,sys
root,recursive,inc,exc=sys.argv[1],sys.argv[2]=="1",json.loads(sys.argv[3]),json.loads(sys.argv[4])
def hit(rel,pats): return any(fnmatch.fnmatch(rel,p) or fnmatch.fnmatch(os.path.basename(rel),p) or any(fnmatch.fnmatch(x,p) for x in rel.split("/")) for p in pats)
h=hashlib.sha256()
for d,dirs,files in os.walk(root):
  rel=os.path.relpath(d,root)
  dirs[:]=sorted(x for x in dirs if recursive and not hit(os.path.normpath(os.path.join(rel,x)),exc))
  for n in sorted(dirs+files):
    r=os.path.normpath(os.path.join(rel,n))
    if hit(r,exc) or (inc and n in files and not hit(r,inc)): continue
    try: st=os.lstat(os.path.join(d,n))
    except FileNotFoundError: continue
    h.update(f"{r}\\0{st.st_size}\\0{st.st_mtime_ns}\\0{st.st_mode}\\n".encode())
print(open("/proc/sys/kernel/random/boot_id").read().strip().replace("-","")+"."+h.hexdigest())`;
