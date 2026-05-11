/**
 * Type stubs for packages that may not be installed at the host machine
 * during local typechecks (they exist as peer/optional dependencies of pi-mind).
 *
 * LIMITATION: All stubs use `any` — this catches:
 *   ✓ syntax errors (missing declarations, typos)
 *   ✓ undefined variables
 *   ✗ API misuse (wrong event names, argument counts, return types)
 *
 * Once pi-coding-agent is installed locally for development, real types take over.
 * Until then, this is a syntax-only guard, not a type guard.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
declare module "@sinclair/typebox" {
  const Type: any;
  export type Static<T> = any;
  export { Type };
}

declare module "@earendil-works/pi-coding-agent" {
  interface ExtensionAPI {
    registerTool(options: any): void;
    on(event: string, cb: (event: any) => void): void;
    injectContext?(ctx: string): void;
  }
  export { ExtensionAPI };
}

declare module "@volcengine/openapi" {
  const Signer: any;
  export { Signer };
}
