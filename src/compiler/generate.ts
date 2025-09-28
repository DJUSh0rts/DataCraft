// src/compiler/generate.ts
import type {
  Diagnostic, Expr, StringExpr, BinaryExpr,
  VarDeclStmt, Stmt, IfBlock, ElseBlock, Condition, CmpCond, CmpOp,
  TypeName, Script, GeneratedFile, SymbolIndex
} from "./types";

/**
 * Changes in this version:
 * - Floats/doubles usable anywhere ints are (loop init/cond/incr, math & comparisons).
 *   We read float/double from storage via `data get ...` into temporary scores (integer math).
 * - Macro efficiency: when expanding $"..." we write only the needed keys, then call a small macro fn.
 * - Say/Run now accept variables directly:
 *     Say(myStringVar)  -> reads from storage with tellraw NBT
 *     Run(myStringVar)  -> copies var to __cmd; calls a macro fn with `$$(__cmd)`
 * - String interpolation in $"Hello {x}" remains, and works inside Say/Run.
 */

const PACK_FORMAT_CONST = 48;
type VarKind = TypeName;

function scoreName(ns: string, varName: string) { return `_${ns}.${varName}`; }
function localScoreName(_ns: string, fn: string, idx: number, name: string) { return `__${fn}_for${idx}_${name}`; }
function tmpScoreName(idx: number) { return `__tmp${idx}`; }

function isArrayKind(k: VarKind) { return /\[\]$/.test(k); }
function baseOf(k: VarKind): Exclude<VarKind, `${string}[]`> {
  return (isArrayKind(k) ? (k.replace(/\[\]$/, "") as any) : (k as any)) as any;
}
function isNumericKind(k: VarKind) { const b = baseOf(k) as any; return b === "int" || b === "bool"; }
function isStoredNumericKind(k: VarKind) { const b = baseOf(k) as any; return b === "int" || b === "bool" || b === "float" || b === "double"; }

function storageTypeFor(k: VarKind): "int" | "float" | "double" | "byte" | "string" | "raw" {
  const b = baseOf(k);
  if (b === "int") return "int";
  if (b === "float") return "float";
  if (b === "double") return "double";
  if (b === "bool") return "byte";
  if (b === "string" || b === "Ent") return "string";
  return "raw";
}

// Normalize different parse shapes of: Ent.Get("selector...")
function getEntGetSelectorArg(e: Expr): string | undefined {
  if (e.kind !== "CallExpr") return undefined;

  const name = e.name.toLowerCase();

  // Shape A: { kind:"CallExpr", target:"Ent", name:"Get", args:[ StringExpr ] }
  if (e.target && e.target.toLowerCase() === "ent" && name === "get") {
    const a0 = e.args[0];
    if (a0 && a0.kind === "String") return a0.value;
  }

  // Shape B: older parse style — { kind:"CallExpr", target:undefined, name:"Get", args:[ Var("Ent"), StringExpr ] }
  if (!e.target && name === "get") {
    const a0 = e.args[0];
    const a1 = e.args[1];
    if (a0 && a0.kind === "Var" && a0.name.toLowerCase() === "ent" && a1 && a1.kind === "String") {
      return a1.value;
    }
  }

  return undefined;
}


function extractSelectorStringFromExpr(e: Expr): string | null {
  // Ent.Get("type=player") or test.Get("type=player")
  if (e.kind === "CallExpr" && e.name.toLowerCase() === "get") {
    // Find the first string literal among args (works for both static & instance forms)
    for (const a of e.args) {
      if (a && a.kind === "String") return (a as StringExpr).value;
    }
  }
  // Direct string (either full selector "@e[...]" or just "type=...,limit=1")
  if (e.kind === "String") return e.value;
  return null;
}


// ---- Items component helper ----
function componentTokensToMap(ts?: any[]): Record<string, any> | undefined {
  if (!ts || !ts.length) return undefined;
  const out: Record<string, any> = {};
  let i = 0;
  while (i < ts.length) {
    const k = ts[i];
    if (k.type !== "Identifier") { i++; continue; }
    i++;
    if (i < ts.length && ts[i].type === "Equals") i++;
    if (i < ts.length) {
      const v = ts[i];
      if (v.type === "String" || v.type === "Identifier" || v.type === "Number") {
        out[k.value!] = v.value;
        i++;
      }
    }
    if (i < ts.length && ts[i].type === "Comma") i++;
  }
  return out;
}

// ---- Macro helpers ----
function renderMacroTemplate(src: string): { line: string; refs: string[] } {
  const refs: string[] = [];
  const line = src.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, g1) => { refs.push(g1); return `$(${g1})`; });
  return { line, refs: Array.from(new Set(refs)) };
}
function exprIsMacroString(e: Expr): e is StringExpr { return e.kind === "String" && e.value.startsWith("$"); }
function isStaticString(e: Expr): boolean {
  switch (e.kind) {
    case "String": return !e.value.startsWith("$");
    case "Number": return true;
    case "Binary": return e.op === "+" && isStaticString(e.left) && isStaticString(e.right);
    default: return false;
  }
}
function evalStaticString(e: Expr): string | undefined {
  switch (e.kind) {
    case "String": return e.value.startsWith("$") ? e.value.slice(1) : e.value;
    case "Number": return String(e.value);
    case "Binary":
      if (e.op !== "+") return undefined;
      const L = evalStaticString(e.left), R = evalStaticString(e.right);
      if (L === undefined || R === undefined) return undefined;
      return L + R;
    default: return undefined;
  }
}
function snbtFromLiteral(kind: VarKind, num: number | boolean | string): string {
  const b = baseOf(kind);
  if (b === "string" || b === "Ent") return JSON.stringify(String(num));
  if (b === "bool") return (num ? "1b" : "0b");
  if (b === "int") return `${Math.trunc(Number(num))}`;
  if (b === "float") { const n = Number(num); return Number.isInteger(n) ? `${n.toFixed(1)}f` : `${n}f`; }
  if (b === "double") { const n = Number(num); return Number.isInteger(n) ? `${n.toFixed(1)}d` : `${n}d`; }
  return JSON.stringify(num);
}

function arrayInitCommands(ns: string, name: string, kind: VarKind, items: Expr[], pushDiag: (d: Diagnostic)=>void): string[] {
  const b = baseOf(kind); const cmds: string[] = [];
  cmds.push(`data remove storage ${ns}:variables ${name}`);
  cmds.push(`data modify storage ${ns}:variables ${name} set value []`);
  const toLit = (e: Expr): string | undefined => {
    if (b === "string" || b === "Ent") {
      if (e.kind === "String" && !e.value.startsWith("$")) return JSON.stringify(e.value);
      if (e.kind === "Number") return JSON.stringify(String(e.value));
      return undefined;
    }
    if (b === "bool") {
      if (e.kind === "Number") return e.value ? "1b" : "0b";
      if (e.kind === "String") return (e.value.toLowerCase() === "true" ? "1b" : "0b");
      return undefined;
    }
    if (b === "int") {
      if (e.kind === "Number") return `${Math.trunc(e.value)}`;
      return undefined;
    }
    if (b === "float" || b === "double") {
      if (e.kind === "Number") return snbtFromLiteral(kind, e.value);
      return undefined;
    }
    return undefined;
  };
  items.forEach((it, idx) => {
    const lit = toLit(it);
    if (lit === undefined) {
      pushDiag({ severity: "Error", message: `Array element ${idx} for ${name} must be literal of type ${b}`, line: (it as any).line ?? 0, col: (it as any).col ?? 0 });
      return;
    }
    cmds.push(`data modify storage ${ns}:variables ${name}[${idx}] set value ${lit}`);
  });
  return cmds;
}

// ---------- Numeric expression compiler ----------
export function compileNumericExpr(
  expr: Expr,
  ns: string,
  emit: (cmd: string) => void,
  tmpCounter: { n: number },
  resolveScoreForVar: (name: string) => string,
  resolveKindForVar: (name: string) => VarKind | undefined,
  diagnostics: Diagnostic[]
): string {
  const res = tmpScoreName(tmpCounter.n++);
  const to = (target: string, e: Expr): void => {
    switch (e.kind) {
      case "Number": {
        emit(`scoreboard players set ${target} vars ${Math.trunc(e.value)}`);
        return;
      }
      case "Var": {
        const vk = resolveKindForVar(e.name);
        if (!vk || !isStoredNumericKind(vk)) {
          diagnostics.push({ severity: "Error", message: `Variable '${e.name}' is not numeric`, line: (e as any).line, col: (e as any).col });
          emit(`scoreboard players set ${target} vars 0`);
          return;
        }
        if (isNumericKind(vk)) {
          emit(`scoreboard players operation ${target} vars = ${resolveScoreForVar(e.name)} vars`);
        } else {
          // float/double -> read from storage (rounded to integer per Minecraft rules)
          emit(`execute store result score ${target} vars run data get storage ${ns}:variables ${e.name} 1`);
        }
        return;
      }
      case "Binary": {
        const L = tmpScoreName(tmpCounter.n++), R = tmpScoreName(tmpCounter.n++);
        to(L, e.left); to(R, e.right);
        const map: Record<BinaryExpr["op"], string> = { "+": "+=", "-": "-=", "*": "*=", "/": "/=", "%": "%=" };
        emit(`scoreboard players operation ${L} vars ${map[e.op]} ${R} vars`);
        emit(`scoreboard players operation ${target} vars = ${L} vars`);
        return;
      }
      case "CallExpr": {
        const tgt = (e.target || "").toLowerCase(); const name = e.name.toLowerCase();

        // Random.value(min,max)
        if (tgt === "random" && name === "value") {
          let minLit: number | undefined = e.args[0]?.kind === "Number" ? Math.trunc((e.args[0] as any).value) : undefined;
          let maxLit: number | undefined = e.args[1]?.kind === "Number" ? Math.trunc((e.args[1] as any).value) : undefined;
          if (minLit === undefined || maxLit === undefined) {
            diagnostics.push({ severity: "Warning", message: `Random.value(...) expects literal numeric bounds. Using 0..100 as fallback.`, line: (e as any).line, col: (e as any).col });
            minLit = 0; maxLit = 100;
          }
          emit(`execute store result score ${target} vars run random value ${minLit}..${maxLit}`);
          return;
        }

        // Math helpers
        if (tgt === "math" && name === "pi") {
          emit(`scoreboard players set ${target} vars 3`);
          diagnostics.push({ severity: "Info", message: `Math.PI approximated as 3 (int math)`, line: (e as any).line, col: (e as any).col });
          return;
        }
        if (tgt === "math" && (name === "min" || name === "max")) {
          const A = tmpScoreName(tmpCounter.n++), B = tmpScoreName(tmpCounter.n++); to(A, e.args[0]); to(B, e.args[1]);
          emit(`scoreboard players operation ${target} vars = ${A} vars`);
          if (name === "min") emit(`execute if score ${B} vars < ${target} vars run scoreboard players operation ${target} vars = ${B} vars`);
          else emit(`execute if score ${B} vars > ${target} vars run scoreboard players operation ${target} vars = ${B} vars`);
          return;
        }
        if (tgt === "math" && name === "pow") {
          const base = tmpScoreName(tmpCounter.n++); to(base, e.args[0]);
          const power = (e.args[1]?.kind === "Number" ? Math.trunc((e.args[1] as any).value) : 0);
          if (power < 0 || power > 10) diagnostics.push({ severity: "Warning", message: `Math.Pow supports 0..10`, line: (e as any).line, col: (e as any).col });
          emit(`scoreboard players set ${target} vars 1`);
          for (let i = 0; i < Math.max(0, Math.min(10, power)); i++) emit(`scoreboard players operation ${target} vars *= ${base} vars`);
          return;
        }
        if (tgt === "math" && name === "root") {
          const num = tmpScoreName(tmpCounter.n++); to(num, e.args[0]);
          const pwr = (e.args[1]?.kind === "Number" ? Math.trunc((e.args[1] as any).value) : 2);
          emit(`scoreboard players set ${target} vars 0`);
          for (let c = 0; c <= 100; c++) {
            const cScore = tmpScoreName(tmpCounter.n++); const prod = tmpScoreName(tmpCounter.n++);
            emit(`scoreboard players set ${cScore} vars ${c}`);
            emit(`scoreboard players set ${prod} vars 1`);
            for (let i = 0; i < Math.max(0, Math.min(10, pwr)); i++) emit(`scoreboard players operation ${prod} vars *= ${cScore} vars`);
            emit(`execute if score ${prod} vars <= ${num} vars run scoreboard players operation ${target} vars = ${cScore} vars`);
          }
          return;
        }

        // Ent.GetData(ent,"Health") inline form
        if (name === "getdata" && e.args.length >= 2) {
          const keyExpr = e.args[1];
          if (keyExpr.kind === "String") {
            if (e.args[0].kind === "CallExpr" &&
                ((e.args[0] as any).target || "").toLowerCase() === "ent" &&
                (e.args[0] as any).name.toLowerCase() === "get" &&
                (e.args[0] as any).args[0]?.kind === "String") {
              const selectorStr = `@e[limit=1,${(e.args[0] as any).args[0].value}]`;
              emit(`execute as ${selectorStr} store result score ${target} vars run data get entity @s ${(keyExpr as any).value} 1`);
              return;
            }
          }
          emit(`scoreboard players set ${target} vars 0`);
          return;
        }

        // default
        emit(`scoreboard players set ${target} vars 0`);
        return;
      }
      case "String": {
        emit(`scoreboard players set ${target} vars 0`);
        return;
      }
      default: {
        emit(`scoreboard players set ${target} vars 0`);
        return;
      }
    }
  };
  to(res, expr);
  return res;
}
// ===== Part B (continuation, revised for assign.op) =====

// Small file helper
function upsertFile(files: GeneratedFile[], path: string, contents: string) {
  const i = files.findIndex(f => f.path === path);
  if (i >= 0) files[i] = { path, contents };
  else files.push({ path, contents });
}

// Ensure a tiny macro function exists once
function ensureMacroFn(files: GeneratedFile[], ns: string, name: string, body: string) {
  const path = `data/${ns}/function/${name}.mcfunction`;
  if (!files.some(f => f.path === path)) {
    files.push({ path, contents: body.endsWith("\n") ? body : body + "\n" });
  }
}

// For Ent variables: binder function that writes UUID under storage ns:variables {var:{uuid:"$(UUID)"}}
function ensureEntBindFn(files: GeneratedFile[], ns: string, varName: string) {
  const bindName = `__ent_bind_${varName}`;
  ensureMacroFn(
    files,
    ns,
    bindName,
    `$data merge storage ${ns}:variables {${varName}:{uuid:"$(UUID)"}}\n`
  );
  return bindName;
}

// Strip a single leading '/' (mcfunction commands should not start with '/')
function stripLeadingSlash(cmd: string) {
  return cmd.startsWith("/") ? cmd.slice(1) : cmd;
}

// ---------- Generator ----------
export function generate(ast: Script): { files: GeneratedFile[]; diagnostics: Diagnostic[]; symbolIndex: SymbolIndex } {
  const diagnostics: Diagnostic[] = [];
  const files: GeneratedFile[] = [];

  // pack.mcmeta (root; one file at root for the whole pack preview)
  const description = ast.packs[0]?.packTitle ?? "Datapack";
  files.push({
    path: `pack.mcmeta`,
    contents: JSON.stringify({ pack: { pack_format: PACK_FORMAT_CONST, description } }, null, 2) + "\n"
  });

  // Symbol index
  const symbolIndex: SymbolIndex = { packs: {} };
  for (const p of ast.packs) {
    symbolIndex.packs[p.namespace] = {
      title: p.packTitle,
      vars: new Set(p.globals.map(g => g.name)),
      funcs: new Set(p.functions.map(f => f.name)),
      items: new Set(p.items.map(i => i.name)),
    };
  }

  // Per-pack variable type map
  const packVarTypes: Record<string, Record<string, VarKind>> = {};
  for (const p of ast.packs) {
    const types: Record<string, VarKind> = {};
    for (const g of p.globals) types[g.name] = g.varType;
    packVarTypes[p.namespace] = types;
  }

  // Emit each pack
  for (const p of ast.packs) {
    // bootstrap + setup
    files.push({
      path: `data/${p.namespace}/function/__bootstrap.mcfunction`,
      contents: `execute unless data storage ${p.namespace}:system bootstrap run function ${p.namespace}:__setup\n`
    });
    files.push({
      path: `data/${p.namespace}/function/__setup.mcfunction`,
      contents: [
        `scoreboard objectives add vars dummy`,
        `data modify storage ${p.namespace}:system bootstrap set value 1b`,
      ].join("\n") + "\n"
    });

    // Helpers used inside this pack emission
    const tmpState = { n: 0 };
    const resolveKind = (name: string) => packVarTypes[p.namespace][name];
    const resolveScore = (name: string) => scoreName(p.namespace, name);
    const withChainTo = (sink: string[]) => (chain: string, cmd: string) => sink.push(chain ? `execute ${chain} run ${cmd}` : cmd);

    // --- Global initialization ---
    const init: string[] = [];

    // Macro to run a dynamic command stored in storage key "__cmd"
    ensureMacroFn(files, p.namespace, "__run_cmd", `$$(__cmd)\n`);

    for (const g of p.globals) {
      const kind = g.varType;
      const b = baseOf(kind);

      if (isArrayKind(kind)) {
        if (g.init.kind === "Array") {
          const cmds = arrayInitCommands(p.namespace, g.name, kind, g.init.items, d => diagnostics.push(d));
          init.push(...cmds);
        } else {
          init.push(`data modify storage ${p.namespace}:variables ${g.name} set value []`);
        }
        continue;
      }

      if (b === "string") {
        const lit = isStaticString(g.init) ? evalStaticString(g.init)! : "";
        init.push(`data modify storage ${p.namespace}:variables ${g.name} set value ${JSON.stringify(lit)}`);
        continue;
      }

      if (b === "Ent") {
  let selector: string | undefined;

  // Support Ent.Get(...) as initializer (both shapes)
  if (g.init.kind === "CallExpr") {
    const selArg = getEntGetSelectorArg(g.init);
    if (selArg) {
      selector = selArg.trim().startsWith("@") ? selArg.trim() : `@e[limit=1,${selArg.trim()}]`;
    }
  }

  // Or a plain string initializer
  if (!selector && g.init.kind === "String" && !g.init.value.startsWith("$")) {
    const raw = g.init.value.trim();
    selector = raw.startsWith("@") ? raw : `@e[limit=1,${raw}]`;
  }

  if (!selector) {
    init.push(`data modify storage ${p.namespace}:variables ${g.name} set value ""`);
  } else {
    init.push(`data modify storage ${p.namespace}:variables ${g.name} set value ${JSON.stringify(selector)}`);

    const binderPath = `data/${p.namespace}/function/__ent_bind_${g.name}.mcfunction`;
    if (!files.some(f => f.path === binderPath)) {
      files.push({
        path: binderPath,
        contents: `$data merge storage ${p.namespace}:variables {${g.name}:{uuid:"$(UUID)"}}\n`,
      });
    }
    init.push(
      `execute as ${selector} run function ${p.namespace}:__ent_bind_${g.name} with storage ${p.namespace}:variables entity @s`
    );
  }
  continue;
}



      if (isStoredNumericKind(kind)) {
        const tmp = compileNumericExpr(g.init, p.namespace, c => init.push(c), tmpState, resolveScore, resolveKind, diagnostics);
        if (b === "int" || b === "bool") {
          init.push(`scoreboard players operation ${scoreName(p.namespace, g.name)} vars = ${tmp} vars`);
        }
        const stype = storageTypeFor(kind);
        init.push(`execute store result storage ${p.namespace}:variables ${g.name} ${stype} 1 run scoreboard players get ${tmp} vars`);
        continue;
      }

      diagnostics.push({ severity: "Error", message: `Unsupported global type for '${g.name}'`, line: g.line, col: g.col });
    }

    upsertFile(files, `data/${p.namespace}/function/__init.mcfunction`, init.join("\n") + (init.length ? "\n" : ""));

    // Counters for unique naming
    let forCounter = 0;
    let macroCounter = 0;
    let ifCounter = 0;

    // Emitters
    function emitMacroCall(
      macroBodyLine: string,
      refs: string[],
      chain: string,
      localScores: Record<string, string> | null,
      envTypes: Record<string, VarKind>,
      outArr: string[]
    ) {
      const withChain = withChainTo(outArr);
      for (const r of refs) {
        const isLocal = !!(localScores && r in localScores);
        const k = envTypes[r];
        if (!k) continue;
        if (isStoredNumericKind(k)) {
          if (isLocal) {
            withChain(chain, `execute store result storage ${p.namespace}:variables ${r} int 1 run scoreboard players get ${localScores![r]} vars`);
          } else if (isNumericKind(k)) {
            withChain(chain, `execute store result storage ${p.namespace}:variables ${r} int 1 run scoreboard players get ${scoreName(p.namespace, r)} vars`);
          }
        }
      }
      const macroName = `__macro_${macroCounter++}`;
      ensureMacroFn(files, p.namespace, macroName, `$${macroBodyLine}\n`);
      withChain(chain, `function ${p.namespace}:${macroName} with storage ${p.namespace}:variables`);
    }

    function emitSay(
      expr: Expr,
      chain: string,
      localScores: Record<string, string> | null,
      envTypes: Record<string, VarKind>,
      outArr: string[]
    ) {
      const withChain = withChainTo(outArr);

      if (exprIsMacroString(expr)) {
        const raw = expr.value.slice(1);
        const { line, refs } = renderMacroTemplate(`say ${raw}`);
        emitMacroCall(line, refs, chain, localScores, envTypes, outArr);
        return;
      }

      const tmpLines: string[] = [];
      const tmpStateLocal = { n: 0 };
      const resolveScore = (name: string) => (localScores && name in localScores) ? localScores[name] : scoreName(p.namespace, name);
      const tmp = compileNumericExpr(expr, p.namespace, c => tmpLines.push(chain ? `execute ${chain} run ${c}` : c), tmpStateLocal, resolveScore, n => envTypes[n], diagnostics);
      if (tmpLines.length) {
        outArr.push(...tmpLines);
        withChain(chain, `tellraw @a {"score":{"name":"${tmp}","objective":"vars"}}`);
        return;
      }

      if (isStaticString(expr)) {
        withChain(chain, `say ${JSON.stringify(evalStaticString(expr)!)}`);
        return;
      }

      if (expr.kind === "Var") {
        const k = envTypes[expr.name];
        if (k) {
          const b = baseOf(k);
          if (b === "string" || b === "Ent") {
            withChain(chain, `tellraw @a {"nbt":"${expr.name}","storage":"${p.namespace}:variables"}`);
            return;
          }
          if (isStoredNumericKind(k)) {
            const tmp2 = tmpScoreName(tmpState.n++);
            if (isNumericKind(k)) {
              withChain(chain, `scoreboard players operation ${tmp2} vars = ${(localScores && expr.name in localScores) ? localScores[expr.name] : scoreName(p.namespace, expr.name)} vars`);
            } else {
              withChain(chain, `execute store result score ${tmp2} vars run data get storage ${p.namespace}:variables ${expr.name} 1`);
            }
            withChain(chain, `tellraw @a {"score":{"name":"${tmp2}","objective":"vars"}}`);
            return;
          }
        }
      }

      diagnostics.push({ severity: "Error", message: `Say(...) supports numeric expressions, variables, and static/macro strings.`, line: (expr as any).line ?? 0, col: (expr as any).col ?? 0 });
    }

    function emitRun(
      expr: Expr,
      chain: string,
      localScores: Record<string, string> | null,
      envTypes: Record<string, VarKind>,
      outArr: string[]
    ) {
      const withChain = withChainTo(outArr);

      if (exprIsMacroString(expr)) {
        const raw = expr.value.slice(1);
        const { line, refs } = renderMacroTemplate(stripLeadingSlash(raw));
        emitMacroCall(line, refs, chain, localScores, envTypes, outArr);
        return;
      }

      if (isStaticString(expr)) {
        withChain(chain, stripLeadingSlash(evalStaticString(expr)!));
        return;
      }

      if (expr.kind === "Var") {
        const k = envTypes[expr.name];
        if (k && (baseOf(k) === "string" || baseOf(k) === "Ent")) {
          withChain(chain, `data modify storage ${p.namespace}:variables __cmd set from storage ${p.namespace}:variables ${expr.name}`);
          withChain(chain, `function ${p.namespace}:__run_cmd with storage ${p.namespace}:variables`);
          return;
        }
      }

      diagnostics.push({ severity: "Error", message: `Run(...) must be a static/macro string or a string variable.`, line: (expr as any).line ?? 0, col: (expr as any).col ?? 0 });
    }

    function emitAssign(
      assign: any,
      chain: string,
      localScores: Record<string, string> | null,
      envTypes: Record<string, VarKind>,
      outArr: string[]
    ) {
      const withChain = withChainTo(outArr);
      const kind = envTypes[assign.name];
      if (!kind) { diagnostics.push({ severity: "Error", message: `Unknown variable '${assign.name}'`, line: assign.line, col: assign.col }); return; }

      if (isArrayKind(kind)) {
        if (assign.op !== "=") { diagnostics.push({ severity: "Error", message: `Only '=' supported for arrays`, line: assign.line, col: assign.col }); return; }
        if (assign.expr.kind !== "Array") { diagnostics.push({ severity: "Error", message: `Array assignment must use [...] literal`, line: assign.line, col: assign.col }); return; }
        const cmds = arrayInitCommands(p.namespace, assign.name, kind, assign.expr.items, d => diagnostics.push(d));
        cmds.forEach(c => withChain(chain, c));
        return;
      }

      const b = baseOf(kind);
      if (b === "string") {
        if (assign.op !== "=") { diagnostics.push({ severity: "Error", message: `Only '=' supported for string`, line: assign.line, col: assign.col }); return; }
        if (isStaticString(assign.expr)) {
          withChain(chain, `data modify storage ${p.namespace}:variables ${assign.name} set value ${JSON.stringify(evalStaticString(assign.expr)!)}`);
        } else if (assign.expr.kind === "Var" && baseOf(envTypes[assign.expr.name] || "string") === "string") {
          withChain(chain, `data modify storage ${p.namespace}:variables ${assign.name} set from storage ${p.namespace}:variables ${assign.expr.name}`);
        } else {
          diagnostics.push({ severity: "Error", message: `String assignment must be static or from another string var`, line: assign.line, col: assign.col });
        }
        return;
      }

      // --- Ent assignment (supports Ent.Get("…"), test.Get("…"), or selector strings) ---
// --- Ent assignment ---
if (b === "Ent") {
  if (assign.op !== "=") {
    diagnostics.push({ severity: "Error", message: `Only '=' supported for Ent`, line: assign.line, col: assign.col });
    return;
  }

  // Accept:
  //  - Ent.Get("type=player")
  //  - Get(Ent, "type=player")  (older parse)
  //  - A raw selector string like "@e[limit=1,type=player]"
  //  - A plain string "type=player" which we wrap into @e[limit=1,...]
  let selector: string | undefined;

  // Try Ent.Get(...) in either parse shape
  if (assign.expr.kind === "CallExpr") {
    const selArg = getEntGetSelectorArg(assign.expr);
    if (selArg) {
      selector = selArg.trim().startsWith("@") ? selArg.trim() : `@e[limit=1,${selArg.trim()}]`;
    }
  }

  // Plain string
  if (!selector && assign.expr.kind === "String") {
    const raw = assign.expr.value.trim();
    selector = raw.startsWith("@") ? raw : `@e[limit=1,${raw}]`;
  }

  if (!selector) {
    diagnostics.push({
      severity: "Error",
      message: `Ent assignment must be Ent.Get("...") or a selector string`,
      line: assign.line,
      col: assign.col
    });
    return;
  }

  // Store the literal selector string
  withChain(chain, `data modify storage ${p.namespace}:variables ${assign.name} set value ${JSON.stringify(selector)}`);

  // Also bind UUID using a macro function
  const fname = `__ent_bind_${assign.name}`;
  const fpath = `data/${p.namespace}/function/${fname}.mcfunction`;
  if (!files.some(f => f.path === fpath)) {
    files.push({
      path: fpath,
      contents: `$data merge storage ${p.namespace}:variables {${assign.name}:{uuid:"$(UUID)"}}\n`,
    });
  }
  withChain(chain, `execute as ${selector} run function ${p.namespace}:${fname} with storage ${p.namespace}:variables entity @s`);
  return;
}




      if (isStoredNumericKind(kind)) {
        const resolveScore = (name: string) => (localScores && name in localScores) ? localScores[name] : scoreName(p.namespace, name);
        const tmp = compileNumericExpr(assign.expr, p.namespace, c => outArr.push(chain ? `execute ${chain} run ${c}` : c), { n: 0 }, resolveScore, n => envTypes[n], diagnostics);

        let target = scoreName(p.namespace, assign.name);
        if (isNumericKind(kind) && localScores && (assign.name in localScores)) {
          target = localScores[assign.name];
        }

        // SAFE mapping without index signature issues
        let opStr: string;
        switch (assign.op) {
          case "=":  opStr = "="; break;
          case "+=": opStr = "+="; break;
          case "-=": opStr = "-="; break;
          case "*=": opStr = "*="; break;
          case "/=": opStr = "/="; break;
          case "%=": opStr = "%="; break;
          default:   opStr = "="; break;
        }

        outArr.push(
          chain
            ? `execute ${chain} run scoreboard players operation ${target} vars ${opStr} ${tmp} vars`
            : `scoreboard players operation ${target} vars ${opStr} ${tmp} vars`
        );

        const stype = storageTypeFor(kind);
        outArr.push(
          chain
            ? `execute ${chain} run execute store result storage ${p.namespace}:variables ${assign.name} ${stype} 1 run scoreboard players get ${target} vars`
            : `execute store result storage ${p.namespace}:variables ${assign.name} ${stype} 1 run scoreboard players get ${target} vars`
        );

        return;
      }

      diagnostics.push({ severity: "Error", message: `Unsupported assignment to type '${b}'`, line: assign.line, col: assign.col });
    }

    function condToVariants(
      cond: Condition | null | undefined,
      chain: string,
      localScores: Record<string,string> | null,
      envTypes: Record<string, VarKind>,
      outArr: string[],
      tmpStateLocal: { n: number },
      negate = false
    ): string[][] {
      const pref = (cmd: string) => (chain ? `execute ${chain} run ${cmd}` : cmd);

      function leaf(c: CmpCond | { kind: "Raw"; raw: string; line: number; col: number }): string[] {
        if ((c as any).kind === "Raw") {
          const cr = c as any;
          return [ `${negate ? "unless" : "if"} ${cr.raw}` ];
        } else {
          const cc = c as CmpCond;
          const L = compileNumericExpr(cc.left,  p.namespace, (c)=>outArr.push(pref(c)), tmpStateLocal,
            (n)=> localScores && n in localScores ? localScores[n] : scoreName(p.namespace, n),
            (n)=> envTypes[n], diagnostics);
          const R = compileNumericExpr(cc.right, p.namespace, (c)=>outArr.push(pref(c)), tmpStateLocal,
            (n)=> localScores && n in localScores ? localScores[n] : scoreName(p.namespace, n),
            (n)=> envTypes[n], diagnostics);
          const map: Record<CmpOp, string> = { "==":"=", "!=":"!=", "<":"<", "<=":"<=", ">":">", ">=":">=" };
          return [ `${negate ? "unless" : "if"} score ${L} vars ${map[cc.op]} ${R} vars` ];
        }
      }

      function walk(c: Condition): string[][] {
        if (c.kind === "Bool") {
          if (c.op === "&&") {
            const Ls = walk(c.left);
            const Rs = walk(c.right);
            const acc: string[][] = [];
            for (const l of Ls) for (const r of Rs) acc.push([...l, ...r]);
            return acc;
          } else { // ||
            const Ls = walk(c.left);
            const Rs = walk(c.right);
            return [...Ls, ...Rs];
          }
        } else {
          return [ leaf(c as any) ];
        }
      }

      if (!cond) return [[]];
      return walk(cond);
    }

    function emitExecute(stmt: any, chain: string, localScores: Record<string, string> | null, envTypes: Record<string, VarKind>, outArr: string[]) {
      if (!stmt.variants.length) { for (const s of stmt.body) emitStmt(s, chain, localScores, envTypes, outArr); return; }
      for (const v of stmt.variants) {
        const parts: string[] = [];
        for (const m of v.mods) {
          if (m.kind === "as") parts.push(`as ${m.arg}`);
          else if (m.kind === "at") parts.push(`at ${m.arg}`);
          else if (m.kind === "positioned") parts.push(`positioned ${m.x} ${m.y} ${m.z}`);
        }
        const next = [chain, parts.join(" ")].filter(Boolean).join(" ");
        for (const s of stmt.body) emitStmt(s, next, localScores, envTypes, outArr);
      }
    }

    function emitIfChain(first: IfBlock, chain: string, localScores: Record<string,string> | null, envTypes: Record<string, VarKind>, outArr: string[]) {
      const withChain = withChainTo(outArr);
      const branches: Array<{ negated: boolean; cond: Condition | null | undefined; body: Stmt[] }> = [];
      let cur: IfBlock | ElseBlock | null | undefined = first;
      while (cur) {
        if ((cur as IfBlock).kind === "If") {
          const ib = cur as IfBlock;
          branches.push({ negated: ib.negated, cond: ib.cond, body: ib.body });
          cur = ib.elseBranch ?? null;
        } else {
          const eb = cur as ElseBlock;
          branches.push({ negated: false, cond: null, body: eb.body });
          cur = null;
        }
      }

      const flag = `__ifdone_${p.namespace}_${ifCounter++}`;
      withChain(chain, `scoreboard players set ${flag} vars 0`);

      const tmpStateLocal = { n: 0 };

      for (const b of branches) {
        const variants = condToVariants(b.cond ?? null, chain, localScores, envTypes, outArr, tmpStateLocal, b.negated);
        for (const parts of variants) {
          const guard = [ `if score ${flag} vars matches 0`, ...parts ].join(" ");
          const next = [chain, guard].filter(Boolean).join(" ");
          for (const s of b.body) emitStmt(s, next, localScores, envTypes, outArr);
          withChain(next, `scoreboard players set ${flag} vars 1`);
        }
      }
    }

    

    function emitFor(stmt: any, chain: string, envTypes: Record<string, VarKind>, outArr: string[]) {
      const withChainParent = withChainTo(outArr);
      const loopId = forCounter++;
      const entryName = `__for_${loopId}`;
      const stepName  = `__for_${loopId}__step`;

      const localScores: Record<string, string> = {};
      const localTypes: Record<string, VarKind> = { ...envTypes };

      // init
      if (stmt.init && "kind" in stmt.init) {
        if (stmt.init.kind === "VarDecl" && !(stmt.init as VarDeclStmt).isGlobal) {
          const d = stmt.init as VarDeclStmt;
          localTypes[d.name] = d.varType;
          const b = baseOf(d.varType);

          const tmp = compileNumericExpr(d.init, p.namespace, (c) => outArr.push(chain ? `execute ${chain} run ${c}` : c),
            { n: 0 },
            (n)=> localScores[n] ?? scoreName(p.namespace, n),
            (n)=> localTypes[n],
            diagnostics
          );

          if (b === "int" || b === "bool") {
            localScores[d.name] = localScores[d.name] ?? localScoreName(p.namespace, "fn", loopId, d.name);
            withChainParent(chain, `scoreboard players operation ${localScores[d.name]} vars = ${tmp} vars`);
            withChainParent(chain, `execute store result storage ${p.namespace}:variables ${d.name} ${storageTypeFor(d.varType)} 1 run scoreboard players get ${localScores[d.name]} vars`);
          } else {
            withChainParent(chain, `execute store result storage ${p.namespace}:variables ${d.name} ${storageTypeFor(d.varType)} 1 run scoreboard players get ${tmp} vars`);
          }
        } else if (stmt.init.kind === "Assign") {
          emitAssign(stmt.init, chain, null, envTypes, outArr);
        }
      }

      // entry function (condition)
      const entryLines: string[] = [];
      const tmpStateEntry = { n: 0 };
      const variants = condToVariants(stmt.cond ?? null, chain, localScores, localTypes, entryLines, tmpStateEntry, false);
      if (variants.length === 0) variants.push([]);
      for (const parts of variants) {
        const guard = parts.length ? `execute ${parts.join(" ")} run function ${p.namespace}:${stepName}` : `function ${p.namespace}:${stepName}`;
        entryLines.push(chain ? `execute ${chain} run ${guard}` : guard);
      }

      // step
      const stepLines: string[] = [];
      for (const s of stmt.body) emitStmt(s, chain, localScores, localTypes, stepLines);
      if (stmt.incr) emitAssign(stmt.incr, chain, localScores, localTypes, stepLines);
      stepLines.push(chain ? `execute ${chain} run function ${p.namespace}:${entryName}` : `function ${p.namespace}:${entryName}`);

      upsertFile(files, `data/${p.namespace}/function/${entryName}.mcfunction`, entryLines.join("\n") + "\n");
      upsertFile(files, `data/${p.namespace}/function/${stepName}.mcfunction`, stepLines.join("\n") + "\n");

      withChainParent(chain, `function ${p.namespace}:${entryName}`);
    }

    // --- While loops ---
function emitWhile(
  stmt: { kind: "While"; cond: Condition | null; body: Stmt[]; line: number; col: number },
  chain: string,
  envTypes: Record<string, VarKind>,
  outArr: string[]
) {
  const withChainParent = withChainTo(outArr);

  // unique ids for this while
  const loopId = forCounter++; // re-use the same counter you use for for-loops
  const entryName = `__while_${loopId}`;
  const stepName  = `__while_${loopId}__step`;

  // Build the entry function: check condition -> run step -> recurse
  const entryLines: string[] = [];
  const tmpStateEntry = { n: 0 };

  // Turn the while condition into execute-guard variants
  // (this can emit numeric-eval setup lines into entryLines)
  const variants = condToVariants(stmt.cond ?? null, chain, null, envTypes, entryLines, tmpStateEntry, false);
  if (variants.length === 0) variants.push([]);

  for (const parts of variants) {
    // If condition true, run step
    if (parts.length) {
      // was:
// entryLines.push(tokensToPref(chain)(`execute ${parts.join(" ")} run function ${p.namespace}:${stepName}`));
// now:
entryLines.push(`execute ${parts.join(" ")} run function ${p.namespace}:${stepName}`);

    } else {
      entryLines.push(`function ${p.namespace}:${stepName}`);
    }
  }

  // Step function: run body, then jump back to entry (re-check condition)
  const stepLines: string[] = [];
  for (const s of stmt.body) emitStmt(s, chain, null, envTypes, stepLines);
  stepLines.push(`function ${p.namespace}:${entryName}`);

  // Emit the two helper files
  files.push({ path: `data/${p.namespace}/function/${entryName}.mcfunction`, contents: entryLines.join("\n") + "\n" });
  files.push({ path: `data/${p.namespace}/function/${stepName}.mcfunction`, contents: stepLines.join("\n") + "\n" });

  // Kick off the loop
  withChainParent(chain, `function ${p.namespace}:${entryName}`);
}


    // Dispatcher
    function emitStmt(st: Stmt, chain: string, localScores: Record<string, string> | null, envTypes: Record<string, VarKind>, outArr: string[]) {
      const withChain = withChainTo(outArr);
      switch (st.kind) {
        case "While":
          return emitWhile(st as any, chain, envTypes, outArr);
        case "VarDecl": {
          const b = baseOf(st.varType);
          const isLocal = !st.isGlobal;

          if (isArrayKind(st.varType)) {
            if (st.init.kind === "Array") {
              const cmds = arrayInitCommands(p.namespace, st.name, st.varType, st.init.items, d => diagnostics.push(d));
              cmds.forEach(c => withChain(chain, c));
            } else {
              withChain(chain, `data modify storage ${p.namespace}:variables ${st.name} set value []`);
            }
            envTypes[st.name] = st.varType;
            return;
          }

          if (b === "string") {
            const lit = isStaticString(st.init) ? evalStaticString(st.init)! : "";
            withChain(chain, `data modify storage ${p.namespace}:variables ${st.name} set value ${JSON.stringify(lit)}`);
            envTypes[st.name] = st.varType;
            return;
          }

          if (b === "Ent") {
  const withChain = withChainTo(outArr);
  const selArg = extractSelectorStringFromExpr(st.init);
  if (selArg) {
    const selector = selArg.trim().startsWith("@")
      ? selArg.trim()
      : `@e[limit=1,${selArg.trim()}]`;

    withChain(chain,
      `data modify storage ${p.namespace}:variables ${st.name} set value ${JSON.stringify(selector)}`
    );

    const binderPath = `data/${p.namespace}/function/__ent_bind_${st.name}.mcfunction`;
    if (!files.some(f => f.path === binderPath)) {
      files.push({
        path: binderPath,
        contents: `$data merge storage ${p.namespace}:variables {${st.name}:{uuid:"$(UUID)"}}\n`,
      });
    }

    withChain(
      chain,
      `execute as ${selector} run function ${p.namespace}:__ent_bind_${st.name} with storage ${p.namespace}:variables entity @s`
    );
  } else {
    // no recognizable init → empty string
    withChain(chain,
      `data modify storage ${p.namespace}:variables ${st.name} set value ""`
    );
  }
  envTypes[st.name] = st.varType;
  return;
}



          if (isStoredNumericKind(st.varType)) {
            const resolveScore = (name: string) => (localScores && name in localScores) ? localScores[name] : scoreName(p.namespace, name);
            const tmp = compileNumericExpr(st.init, p.namespace, (c)=>outArr.push(chain ? `execute ${chain} run ${c}` : c), { n: 0 }, resolveScore, (n)=>envTypes[n], diagnostics);

            if (isLocal && isNumericKind(st.varType) && localScores) {
              localScores[st.name] = localScores[st.name] ?? `__local_${st.name}_${Date.now() % 997}`;
              withChain(chain, `scoreboard players operation ${localScores[st.name]} vars = ${tmp} vars`);
              withChain(chain, `execute store result storage ${p.namespace}:variables ${st.name} ${storageTypeFor(st.varType)} 1 run scoreboard players get ${localScores[st.name]} vars`);
            } else {
              withChain(chain, `execute store result storage ${p.namespace}:variables ${st.name} ${storageTypeFor(st.varType)} 1 run scoreboard players get ${tmp} vars`);
              if (!isLocal && isNumericKind(st.varType)) {
                withChain(chain, `scoreboard players operation ${scoreName(p.namespace, st.name)} vars = ${tmp} vars`);
              }
            }
            envTypes[st.name] = st.varType;
            return;
          }

          diagnostics.push({ severity: "Error", message: `Unsupported local variable type '${b}'`, line: (st as any).line, col: (st as any).col });
          return;
        }

        case "Assign": return emitAssign(st as any, chain, localScores, envTypes, outArr);
        case "Say":    return emitSay((st as any).expr, chain, localScores, envTypes, outArr);
        case "Run":    return emitRun((st as any).expr, chain, localScores, envTypes, outArr);
        case "Call": {
          const tns = (st as any).targetPack ?? p.namespace;
          withChain(chain, `function ${tns}:${(st as any).func.toLowerCase()}`);
          return;
        }
        case "Execute": return emitExecute(st as any, chain, localScores, envTypes, outArr);
        case "If": return emitIfChain(st as IfBlock, chain, localScores, envTypes, outArr);
        case "For": return emitFor(st as any, chain, envTypes, outArr);
      }
    }

    // Emit all functions
    for (const f of p.functions) {
      const out: string[] = [];
      const localScores: Record<string, string> = {};
      const envTypes: Record<string, VarKind> = { ...packVarTypes[p.namespace] };
      for (const st of f.body) emitStmt(st, "", localScores, envTypes, out);
      upsertFile(files, `data/${p.namespace}/function/${f.name}.mcfunction`, out.join("\n") + (out.length ? "\n" : ""));
    }

    // Advancements
    for (const a of p.advs) {
      const advObj: any = {
        display: {
          title: a.props.title ?? a.name,
          description: a.props.description ?? "",
          icon: a.props.icon ? { item: a.props.icon } : { item: "minecraft:paper" },
          frame: "task",
          show_toast: true,
          announce_to_chat: false,
          hidden: false,
        },
        criteria: {} as Record<string, any>,
      };
      if ((a.props as any).parent) advObj.parent = (a.props as any).parent;
      for (const c of a.props.criteria) advObj.criteria[c.name] = { trigger: c.trigger };
      upsertFile(files, `data/${p.namespace}/advancements/${a.name}.json`, JSON.stringify(advObj, null, 2) + "\n");
    }

    // Recipes
    for (const r of p.recipes) {
      let body: any;
      if (r.type === "shaped") {
        body = {
          type: "minecraft:crafting_shaped",
          pattern: r.pattern ?? ["   ","   ","   "],
          key: Object.fromEntries(Object.entries(r.keys ?? {}).map(([k,v]) => [k, { item: v }])),
          result: r.result?.id?.includes(":") ? { item: r.result.id, count: r.result.count ?? 1 } : { item: `${p.namespace}:${r.result?.id}`, count: r.result?.count ?? 1 }
        };
      } else {
        body = {
          type: "minecraft:crafting_shapeless",
          ingredients: (r.ingredients ?? []).map(i => ({ item: i })),
          result: r.result?.id?.includes(":") ? { item: r.result.id, count: r.result.count ?? 1 } : { item: `${p.namespace}:${r.result?.id}`, count: r.result?.count ?? 1 }
        };
      }
      upsertFile(files, `data/${p.namespace}/recipes/${r.name}.json`, JSON.stringify(body, null, 2) + "\n");
    }

    // Items
    for (const it of p.items) {
      const comps = componentTokensToMap((it as any).componentTokens) ?? {};
      const body = { base: it.baseId, components: comps };
      upsertFile(files, `data/${p.namespace}/items/${it.name}.json`, JSON.stringify(body, null, 2) + "\n");
      upsertFile(files, `data/${p.namespace}/function/give.${it.name}.mcfunction`, `give @s ${it.baseId}\n`);
    }
  }

  // Hook into load/tick across packs
  const loadVals: string[] = [];
  const tickVals: string[] = [];
  for (const p of ast.packs) {
    loadVals.push(`${p.namespace}:__bootstrap`, `${p.namespace}:__init`);
    if (p.functions.some(f => f.name === "load")) loadVals.push(`${p.namespace}:load`);
    if (p.functions.some(f => f.name === "tick")) tickVals.push(`${p.namespace}:tick`);
  }
  if (loadVals.length) {
    upsertFile(files, `data/minecraft/tags/function/load.json`, JSON.stringify({ values: Array.from(new Set(loadVals)) }, null, 2) + "\n");
  }
  if (tickVals.length) {
    upsertFile(files, `data/minecraft/tags/function/tick.json`, JSON.stringify({ values: Array.from(new Set(tickVals)) }, null, 2) + "\n");
  }

  return { files, diagnostics, symbolIndex };
}
