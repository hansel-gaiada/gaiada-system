// WSK-15 — resolves a named export off a module namespace object that may have arrived in EITHER
// shape, depending on which loader is running the `.mts` file that imported it:
//
//   - `tsx` (real CLI execution, `node --import tsx ...`): a `.ts` file under `webdesk/api/src/**`
//     is CommonJS (that project's `package.json` has no `"type": "module"`). When such a file is
//     reached via a dynamic ESM import chain from an `.mts` file, `tsx`'s synthetic CJS->ESM
//     interop exposes the WHOLE `module.exports` object as the namespace's `default` property —
//     individual named bindings are NOT split out onto the namespace object itself.
//   - `vitest`/Vite (this repo's test runner, `test/codegen-*.spec.ts`): the SAME `.ts` file's
//     named exports ARE split out normally onto the namespace object — there is no `default`
//     wrapper at all (`import * as ns` gives `{ S3StorageAdapter: [class], ... }` directly).
//
// Verified empirically under both loaders (see this ticket's report for the transcript — this is
// exactly the footgun `test/codegen-generator-crossboundary-imports.spec.ts` exists to pin).
// Every cross-boundary import from an `.mts` generator file into a plain commonjs `.ts` file under
// `src/**` goes through this helper so the SAME source works, unmodified, under either loader.
export function namedExport<T>(mod: unknown, name: string): T {
  const direct = mod as Record<string, unknown>;
  if (name in direct && direct[name] !== undefined) return direct[name] as T;
  const wrapped = direct.default as Record<string, unknown> | undefined;
  if (wrapped && name in wrapped && wrapped[name] !== undefined) return wrapped[name] as T;
  throw new Error(`namedExport: could not resolve export "${name}" (checked both the direct namespace and its .default wrapper)`);
}
