/**
 * Type stubs for pi-coding-agent.
 * Same pattern as packages/core/lib/declarations.d.ts — using `any` to keep
 * extension implementations decoupled from upstream's strict ExtensionContext
 * type. Tightening these stubs to the real types is a future refactor.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
declare module "@earendil-works/pi-coding-agent" {
  interface ExtensionAPI {
    registerTool(options: any): void;
    on(event: string, cb: (event: any) => void): void;
    injectContext?(ctx: string): void;
  }
  export { ExtensionAPI };
}
