// src/compiler/compile.ts
import type { GeneratedFile, Diagnostic, Script } from "./types";
import { lex } from "./lexer";
import { parse } from "./parser";
import { generate } from "./generator";

export function compile(source: string): {
  files: GeneratedFile[];
  diagnostics: Diagnostic[];
  ast: Script;
} {
  let files: GeneratedFile[] = [];
  let diagnostics: Diagnostic[] = [];
  let ast: Script = { packs: [] };

  try {
    const tokens = lex(source);
    const { ast: parsed, diagnostics: parseDiags } = parse(tokens);
    ast = parsed;
    const { files: genFiles, diagnostics: genDiags } = generate(ast);
    files = genFiles;
    diagnostics = [...parseDiags, ...genDiags];
  } catch (e: any) {
    diagnostics.push({
      severity: "Error",
      message: e?.message ?? "Unknown error during compile",
      line: e?.line ?? 0,
      col: e?.col ?? 0,
    });
  }

  return { files, diagnostics, ast };
}
