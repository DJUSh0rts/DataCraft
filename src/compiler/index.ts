// compiler/index.ts

// Re-export types
export * from "./types";

// Parser & generator (named exports)
export { parse } from "./parser";
export { generate } from "./generate";

// Lexer: tolerate either export name (`lex` or `tokenize`)
import * as L from "./lexer";

/**
 * Normalized lexer entry point.
 * Calls `lexer.lex(src)` if present, otherwise `lexer.tokenize(src)`.
 */
export const lex: (src: string) => ReturnType<any> = (src: string) => {
  const anyL = L as any;
  if (typeof anyL.lex === "function") return anyL.lex(src);
  if (typeof anyL.tokenize === "function") return anyL.tokenize(src);
  throw new Error("Lexer must export either `lex` or `tokenize`.");
};
