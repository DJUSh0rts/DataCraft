// src/compiler/generator/index.ts
import type { Script, GeneratedFile, Diagnostic, Stmt } from "../types";

/**
 * Minimal generator that mirrors the behavior in your original App.tsx for:
 * - pack.mcmeta (one per project, using the first pack's title)
 * - mcfunction files under data/<ns>/functions/<FuncName>.mcfunction
 * - converting Say("...") -> `say "..."`
 *   and Run("...") -> raw command line (string literal contents)
 * - optional minecraft load/tick tags if functions named Load/Tick (case-insensitive)
 */
export function generate(ast: Script): {
  files: GeneratedFile[];
  diagnostics: Diagnostic[];
} {
  const files: GeneratedFile[] = [];
  const diagnostics: Diagnostic[] = [];

  const PACK_FORMAT = 48;

  if (!ast.packs.length) {
    return { files, diagnostics };
  }

  // Use first pack's title for pack.mcmeta description
  const firstPack = ast.packs[0];
  files.push({
    path: `pack.mcmeta`,
    contents:
      JSON.stringify(
        {
          pack: {
            pack_format: PACK_FORMAT,
            description: firstPack.packTitle || "Datapack",
          },
        },
        null,
        2
      ) + "\n",
  });

  // Collect load/tick for minecraft tags
  const loadFns: string[] = [];
  const tickFns: string[] = [];

  for (const pack of ast.packs) {
    const ns = pack.namespace.toLowerCase();

    for (const func of pack.functions) {
      const funcName = func.name; // keep original casing from parser
      const out: string[] = [];

      for (const st of func.body) {
        emitStmt(st, out, diagnostics);
      }

      files.push({
        path: `data/${ns}/functions/${funcName}.mcfunction`,
        contents: out.join("\n") + (out.length ? "\n" : ""),
      });

      // Register into load/tick if matches (case-insensitive)
      const lower = funcName.toLowerCase();
      if (lower === "load") loadFns.push(`${ns}:${funcName}`);
      if (lower === "tick") tickFns.push(`${ns}:${funcName}`);
    }
  }

  if (loadFns.length) {
    files.push({
      path: `data/minecraft/tags/functions/load.json`,
      contents: JSON.stringify({ values: loadFns }, null, 2) + "\n",
    });
  }
  if (tickFns.length) {
    files.push({
      path: `data/minecraft/tags/functions/tick.json`,
      contents: JSON.stringify({ values: tickFns }, null, 2) + "\n",
    });
  }

  return { files, diagnostics };
}

// --- helpers ---

function emitStmt(st: Stmt, out: string[], diags: Diagnostic[]) {
  switch (st.kind) {
    case "Say": {
      const text = stringifyStringExpr(st.expr);
      if (text == null) {
        diags.push({
          severity: "Error",
          message: `Say(...) expects a string literal`,
          line: (st as any).line ?? 0,
          col: (st as any).col ?? 0,
        });
        return;
      }
      out.push(`say ${JSON.stringify(text)}`);
      return;
    }
    case "Run": {
      const cmd = stringifyStringExpr(st.expr);
      if (cmd == null) {
        diags.push({
          severity: "Error",
          message: `Run(...) expects a string literal`,
          line: (st as any).line ?? 0,
          col: (st as any).col ?? 0,
        });
        return;
      }
      // Run content is the raw command line (no quoting)
      out.push(cmd);
      return;
    }
    // In this minimal generator, other kinds are ignored (no-ops)
    default:
      return;
  }
}

function stringifyStringExpr(e: any): string | null {
  if (!e) return null;
  if (e.kind === "String") return String(e.value ?? "");
  return null;
}
