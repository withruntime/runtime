/* What only end to end can prove (a real ssh and sshd, another language's
   SDK, a proxy process, a built package) runs on main's check, after merge
   (.runtime/e2e-files.sh), and never in a pull request's tests: Marc, 23
   October 2026, the whole suite near 30 s. Such a test stays in the file
   with its fixture, skipped unless `endToEnd`: its file's <name>.e2e.test.ts
   imports the file, and only there are they run. */
export const endToEnd = Bun.main.endsWith(".e2e.test.ts");
