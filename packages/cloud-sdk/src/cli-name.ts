/** How this CLI was started, so what it tells you to type works: through npx
 * the command is `npx withruntime`, installed it is `runtime`. Its own module
 * so a command that only names itself does not load the login flow. */
export const me = /[\\/]_npx[\\/]/.test(process.argv[1] ?? "") ? "npx withruntime" : "runtime";
/** Text that names a command, with the command spelled the way it was run. */
export function named(text: string, name: string = me): string {
  return name === "runtime" ? text : text.replace(/(^|[\s`(])runtime(?= [a-z<[])/g, `$1${name}`);
}
