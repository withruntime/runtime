// sdks/release.sh surface: TypeScript. For every export of the published package (OLD), the built one (NEW) must
// stand in its place: a type-only file assigns each new export to its old type, and tsc checks it. Private brands
// (#fields) are dropped by Pub, so two builds of one class compare by what a caller sees.
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

// The TypeScript of the package checked (release.sh runs this in its folder, beside its own tsc), never one found
// beside this file: the release's work tree installs only the package (24 Nov 2026: `typescript` was not found from
// sdks/surface, so every npm release was refused as a break).
const ts = createRequire(join(process.cwd(), "package.json"))("typescript");

const [oldEntry, newEntry, out] = process.argv.slice(2);
const p = ts.createProgram([oldEntry], { strict: true, skipLibCheck: true, types: [] });
const c = p.getTypeChecker();
const lines = [
  `import type * as Old from ${JSON.stringify(oldEntry.replace(/\.d\.ts$/, ".js"))};`,
  `import type * as New from ${JSON.stringify(newEntry.replace(/\.d\.ts$/, ".js"))};`,
  "type Fn = (...a: any[]) => any;",
  "type Prim = string | number | boolean | bigint | symbol | null | undefined | Uint8Array | AbortSignal | Date;",
  "type ArgsOf<P extends any[]> = { [I in keyof P]: Arg<P[I]> };",
  "type Arg<T> = T extends Prim ? T : T extends object ? { [K in keyof T]: T[K] } : T;",
  "type Pub<T, D extends 0[] = []> = D['length'] extends 4 ? any : T extends Prim ? T : T extends Fn ? (...a: ArgsOf<Parameters<T>>) => Pub<ReturnType<T>, [...D, 0]> : T extends Promise<infer U> ? Promise<Pub<U, [...D, 0]>> : T extends readonly (infer E)[] ? Pub<E, [...D, 0]>[] : T extends object ? { [K in keyof T]: Pub<T[K], [...D, 0]> } : T;",
];
const np = ts.createProgram([newEntry], { strict: true, skipLibCheck: true, types: [] });
const nc = np.getTypeChecker();
const newNames = new Set(nc.getExportsOfModule(nc.getSymbolAtLocation(np.getSourceFile(newEntry))).map((s) => s.name));
for (const s0 of c.getExportsOfModule(c.getSymbolAtLocation(p.getSourceFile(oldEntry)))) {
  const s = s0.flags & ts.SymbolFlags.Alias ? c.getAliasedSymbol(s0) : s0;
  const n = s0.name;
  const arity = s.declarations?.[0]?.typeParameters?.length ?? 0;
  const args = arity ? `<${Array(arity).fill("any").join(", ")}>` : "";
  if (!newNames.has(n)) lines.push(`export type Removed_${n} = New.${n}; // removed`);
  else if (s.flags & ts.SymbolFlags.Class)
    lines.push(
      `export const c_${n}: Pub<Old.${n}${args}> = null as unknown as Pub<New.${n}${args}>;`,
      `export const s_${n}: Pub<Omit<typeof Old.${n}, "prototype">> = null as unknown as Pub<Omit<typeof New.${n}, "prototype">>;`,
    );
  else if (s.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias))
    lines.push(`export const t_${n}: Pub<Old.${n}${args}> = null as unknown as Pub<New.${n}${args}>;`);
  else lines.push(`export const v_${n}: Pub<typeof Old.${n}> = null as unknown as Pub<typeof New.${n}>;`);
}
writeFileSync(out, `${lines.join("\n")}\n`);
