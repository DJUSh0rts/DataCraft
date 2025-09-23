import { lex } from "./lexer";
import { parse } from "./parser";
import { generate } from "./generate";
import type { Diagnostic, GeneratedFile, SymbolIndex } from "./types";

/**
 * Top-level compile driver: src -> tokens -> AST -> files
 */
export function compile(src: string): {
  files: GeneratedFile[];
  diagnostics: Diagnostic[];
  symbols: SymbolIndex;
} {
  let diagnostics: Diagnostic[] = [];
  let files: GeneratedFile[] = [];
  let symbols: SymbolIndex = { packs: {} };

  try {
    const tokens = lex(src);
    const { ast, diagnostics: pDiags } = parse(tokens);
    diagnostics = diagnostics.concat(pDiags);
    if (ast) {
      const gen = generate(ast);
      files = gen.files;
      diagnostics = diagnostics.concat(gen.diagnostics);
      symbols = gen.symbolIndex;
    }
  } catch (e: any) {
    diagnostics.push({
      severity: "Error",
      message: e?.message ?? "Unknown error",
      line: e?.line ?? 0,
      col: e?.col ?? 0,
    });
  }

  return { files, diagnostics, symbols };
}
