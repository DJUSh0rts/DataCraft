// src/App.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import "./monaco-setup"; // if you're not using the vite Monaco plugin
import JSZip from "jszip";
import Editor, { useMonaco } from "@monaco-editor/react";

// =============================
// Datapack Web Compiler
// - Packs (class-like)
// - Execute{ as/at/positioned } + if()/unless() + Run("...")
// - GLOBAL VARS with runtime backing:
//     * Strings -> data storage <ns>:variables <name>
//     * Numbers -> scoreboard objective "vars" with fake player "_<ns>.<name>"
// - Numeric assignments: =, +=, -=, *=, /=, %=
// - Idempotent scoreboard bootstrap (no "already exists" spam)
// - IntelliSense + Zip export
// - Outputs (singular):
//     data/<ns>/function/*.mcfunction
//     data/minecraft/tags/function/load.json|tick.json
// =============================

// ---------- Types ----------
type TokenType =
  | "Identifier"
  | "String"
  | "Number"
  | "LBrace"
  | "RBrace"
  | "LParen"
  | "RParen"
  | "Semicolon"
  | "Comma"
  | "Plus"
  | "Minus"
  | "Star"
  | "Slash"
  | "Percent"
  | "Equals"
  | "PlusEquals"
  | "MinusEquals"
  | "StarEquals"
  | "SlashEquals"
  | "PercentEquals"
  | "Dot"
  | "EOF";

type Token = { type: TokenType; value?: string; line: number; col: number };
type Diagnostic = { severity: "Error" | "Warning" | "Info"; message: string; line: number; col: number };

// Expressions
type StringExpr = { kind: "String"; value: string; line: number; col: number };
type NumberExpr = { kind: "Number"; value: number; line: number; col: number };
type VarExpr = { kind: "Var"; name: string; line: number; col: number };
type BinaryExpr = { kind: "Binary"; op: "+" | "-" | "*" | "/" | "%"; left: Expr; right: Expr };
type Expr = StringExpr | NumberExpr | VarExpr | BinaryExpr;

// Execute helpers
type ExecMod =
  | { kind: "as"; arg: string }
  | { kind: "at"; arg: string }
  | { kind: "positioned"; x: string; y: string; z: string };
type ExecVariant = { mods: ExecMod[] };

// Statements
type SayStmt = { kind: "Say"; expr: Expr };
type RunStmt = { kind: "Run"; expr: Expr };
type VarDeclStmt = { kind: "VarDecl"; isGlobal: boolean; name: string; init: Expr; line: number; col: number };
type AssignStmt = { kind: "Assign"; name: string; op: "=" | "+=" | "-=" | "*=" | "/=" | "%="; expr: Expr; line: number; col: number };
type CallStmt = { kind: "Call"; targetPack?: string; func: string; line: number; col: number };
type IfBlock = { kind: "If"; negated: boolean; cond?: Expr | null; body: Stmt[] };
type ExecuteStmt = { kind: "Execute"; variants: ExecVariant[]; body: Stmt[] };
type Stmt = SayStmt | VarDeclStmt | AssignStmt | CallStmt | ExecuteStmt | IfBlock | RunStmt;

// Decls
type FuncDecl = { name: string; nameOriginal: string; body: Stmt[] };
type PackDecl = {
  packTitle: string;
  namespace: string;
  namespaceOriginal: string;
  globals: VarDeclStmt[]; // global var decls
  functions: FuncDecl[];
};
type Script = { packs: PackDecl[] };

type GeneratedFile = { path: string; contents: string };

// Symbol index for IntelliSense
type SymbolIndex = { packs: Record<string, { title: string; vars: Set<string>; funcs: Set<string> }> };

// ---------- Lexer ----------
function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0, line = 1, col = 1;
  const push = (t: Token) => tokens.push(t);

  function advance(n = 1) {
    for (let k = 0; k < n; k++) {
      const ch = input[i++];
      if (ch === "\n") { line++; col = 1; } else { col++; }
    }
  }

  while (i < input.length) {
    const ch = input[i];

    // newline
    if (ch === "\n") { advance(); continue; }

    // whitespace
    if (ch === " " || ch === "\t" || ch === "\r") { advance(); continue; }

    // line comments
    if (ch === "/" && input[i + 1] === "/") {
      while (i < input.length && input[i] !== "\n") advance();
      continue;
    }

    // numbers (simple int)
    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < input.length && /[0-9]/.test(input[j])) j++;
      const num = Number(input.slice(i, j));
      push({ type: "Number", value: String(num), line, col });
      col += (j - i); i = j; continue;
    }
    // negative numbers if we see '-' followed by digits (without consuming as operator)
    if (ch === "-" && /[0-9]/.test(input[i + 1] ?? "")) {
      let j = i + 2;
      while (j < input.length && /[0-9]/.test(input[j])) j++;
      const num = Number(input.slice(i, j));
      push({ type: "Number", value: String(num), line, col });
      col += (j - i); i = j; continue;
    }

    // strings
    if (ch === "\"") {
      let j = i + 1; let text = ""; const strLine = line, strCol = col;
      while (j < input.length) {
        const c = input[j];
        if (c === "\\") {
          const n = input[j + 1];
          if (n === "\"" || n === "\\" || n === "n" || n === "t") {
            text += n === "n" ? "\n" : n === "t" ? "\t" : n;
            j += 2; continue;
          }
        }
        if (c === "\"") { j++; break; }
        text += c; j++;
      }
      push({ type: "String", value: text, line: strLine, col: strCol });
      col += (j - i); i = j; continue;
    }

    // compound ops
    if (ch === "+" && input[i + 1] === "=") { push({ type: "PlusEquals", line, col }); advance(2); continue; }
    if (ch === "-" && input[i + 1] === "=") { push({ type: "MinusEquals", line, col }); advance(2); continue; }
    if (ch === "*" && input[i + 1] === "=") { push({ type: "StarEquals", line, col }); advance(2); continue; }
    if (ch === "/" && input[i + 1] === "=") { push({ type: "SlashEquals", line, col }); advance(2); continue; }
    if (ch === "%" && input[i + 1] === "=") { push({ type: "PercentEquals", line, col }); advance(2); continue; }

    // symbols / single-char ops
    const sym: Record<string, TokenType> = {
      "{": "LBrace", "}": "RBrace", "(": "LParen", ")": "RParen",
      ";": "Semicolon", ",": "Comma", "+": "Plus", "-": "Minus",
      "*": "Star", "/": "Slash", "%": "Percent", "=": "Equals", ".": "Dot"
    };
    if (sym[ch]) { push({ type: sym[ch], line, col }); advance(); continue; }

    // identifiers (allow @ ~ ^ : _ . letters digits) — (dash removed to reserve '-' as operator)
    if (/[A-Za-z_@~^:.[\]a-zA-Z0-9]/.test(ch)) {
      let j = i + 1;
      while (j < input.length && /[A-Za-z0-9_@~^:.[\]]/.test(input[j])) j++;
      const ident = input.slice(i, j);
      push({ type: "Identifier", value: ident, line, col }); col += (j - i); i = j; continue;
    }

    throw { message: `Unexpected character '${ch}'`, line, col };
  }
  push({ type: "EOF", line, col });
  return tokens;
}

// ---------- Parser ----------
function parse(tokens: Token[]): { ast?: Script; diagnostics: Diagnostic[] } {
  let pos = 0; const diags: Diagnostic[] = [];
  const peek = (o = 0): Token => tokens[Math.min(pos + o, tokens.length - 1)];
  const match = (tt: TokenType): Token | null => (peek().type === tt ? tokens[pos++] : null);
  const expect = (tt: TokenType, what?: string): Token => {
    const t = peek();
    if (t.type === tt) { pos++; return t; }
    throw { message: `Expected ${what ?? tt} but found ${t.value ?? t.type}`, line: t.line, col: t.col };
  };

  function parsePrimary(): Expr {
    const t = peek();
    if (t.type === "String") { pos++; return { kind: "String", value: t.value!, line: t.line, col: t.col }; }
    if (t.type === "Number") { pos++; return { kind: "Number", value: Number(t.value!), line: t.line, col: t.col }; }
    if (t.type === "Identifier") { pos++; return { kind: "Var", name: t.value!, line: t.line, col: t.col }; }
    if (t.type === "LParen") { pos++; const e = parseExpr(); expect("RParen", "')'"); return e; }
    throw { message: `Unexpected token in expression: ${t.value ?? t.type}`, line: t.line, col: t.col };
  }
  function parseUnary(): Expr {
    if (match("Minus")) {
      const e = parseUnary();
      return { kind: "Binary", op: "-", left: { kind: "Number", value: 0, line: e.line, col: e.col }, right: e };
    }
    return parsePrimary();
  }
  function parseMul(): Expr {
    let e = parseUnary();
    while (peek().type === "Star" || peek().type === "Slash" || peek().type === "Percent") {
      const opTok = peek(); pos++;
      const r = parseUnary();
      e = { kind: "Binary", op: opTok.type === "Star" ? "*" : opTok.type === "Slash" ? "/" : "%", left: e, right: r };
    }
    return e;
  }
  function parseAdd(): Expr {
    let e = parseMul();
    while (peek().type === "Plus" || peek().type === "Minus") {
      const opTok = peek(); pos++;
      const r = parseMul();
      e = { kind: "Binary", op: opTok.type === "Plus" ? "+" : "-", left: e, right: r };
    }
    return e;
  }
  function parseExpr(): Expr { return parseAdd(); }

  function parseVarDecl(isGlobalForced = false): VarDeclStmt {
    const first = expect("Identifier"); // "var" or "let"
    const low = first.value!.toLowerCase();
    if (low !== "var" && low !== "let") throw { message: `Expected 'var' or 'let'`, line: first.line, col: first.col };
    const name = expect("Identifier").value!;
    expect("Equals");
    const init = parseExpr();
    match("Semicolon");
    return { kind: "VarDecl", isGlobal: isGlobalForced, name, init, line: first.line, col: first.col };
  }

  function parseIfUnless(): IfBlock {
    const kw = expect("Identifier"); const neg = kw.value!.toLowerCase() === "unless";
    if (!neg && kw.value!.toLowerCase() !== "if") throw { message: `Expected 'if' or 'unless'`, line: kw.line, col: kw.col };
    expect("LParen");
    let cond: Expr | null = null;
    if (peek().type !== "RParen") cond = parseExpr();
    expect("RParen");
    expect("LBrace");
    const body: Stmt[] = [];
    while (peek().type !== "RBrace" && peek().type !== "EOF") { const s = parseStmt(); if (s) body.push(s); }
    expect("RBrace");
    return { kind: "If", negated: neg, cond, body };
  }

  function parseExecute(): ExecuteStmt {
    const kw = expect("Identifier"); if (kw.value!.toLowerCase() !== "execute") throw { message: `Expected 'Execute'`, line: kw.line, col: kw.col };
    expect("LParen");
    const variants: ExecVariant[] = [];
    let current: ExecVariant = { mods: [] };
    const pushCurrent = () => { if (current.mods.length) { variants.push(current); current = { mods: [] }; } };

    while (peek().type !== "RParen" && peek().type !== "EOF") {
      const t = expect("Identifier");
      const low = t.value!.toLowerCase();
      if (low === "or") { pushCurrent(); if (peek().type === "Comma") match("Comma"); continue; }
      if (low === "as") { const target = expect("Identifier").value!; current.mods.push({ kind: "as", arg: target }); }
      else if (low === "at") { const target = expect("Identifier").value!; current.mods.push({ kind: "at", arg: target }); }
      else if (low === "positioned") {
        const x = expect("Identifier").value!; const y = expect("Identifier").value!; const z = expect("Identifier").value!;
        current.mods.push({ kind: "positioned", x, y, z });
      } else {
        diags.push({ severity: "Error", message: `Unknown execute modifier '${t.value}'`, line: t.line, col: t.col });
        while (peek().type !== "Comma" && !(peek().type === "Identifier" && peek().value === "or") && peek().type !== "RParen" && peek().type !== "EOF") pos++;
      }
      match("Comma");
    }
    expect("RParen");
    pushCurrent();

    expect("LBrace");
    const body: Stmt[] = [];
    while (peek().type !== "RBrace" && peek().type !== "EOF") { const s = parseStmt(); if (s) body.push(s); }
    expect("RBrace");

    if (!variants.length) variants.push({ mods: [] });
    return { kind: "Execute", variants, body };
  }

  function parseAssignOrCallOrSayRun(): Stmt | null {
    const t = expect("Identifier"); const low = t.value!.toLowerCase();

    // Execute / if / unless / run / say handled before calling this
    if (low === "global") {
      // global var inside a pack block (handled at pack level); if here -> in function -> error+recover
      const nxt = peek();
      if (nxt.type === "Identifier" && (nxt.value === "var" || nxt.value === "let")) {
        pos++; // consume var/let
        const nameTok = expect("Identifier"); const name = nameTok.value!;
        if (!match("Equals")) { diags.push({ severity: "Error", message: `Expected '='`, line: nameTok.line, col: nameTok.col }); return null; }
        const init = parseExpr(); match("Semicolon");
        diags.push({ severity: "Error", message: `global var not allowed inside functions`, line: t.line, col: t.col });
        return { kind: "VarDecl", isGlobal: true, name, init, line: t.line, col: t.col };
      }
      diags.push({ severity: "Error", message: `Expected 'var' after 'global'`, line: t.line, col: t.col });
      return null;
    }

    if (low === "run") { expect("LParen"); const expr = parseExpr(); expect("RParen"); match("Semicolon"); return { kind: "Run", expr }; }
    if (low === "say") { expect("LParen"); const expr = parseExpr(); expect("RParen"); match("Semicolon"); return { kind: "Say", expr }; }

    // assignment? name (=, +=, -=, *=, /=, %=)
    const name = t.value!;
    const nt = peek().type;
    if (nt === "Equals" || nt === "PlusEquals" || nt === "MinusEquals" || nt === "StarEquals" || nt === "SlashEquals" || nt === "PercentEquals") {
      pos++;
      const op = (nt === "Equals" ? "=" :
        nt === "PlusEquals" ? "+=" :
          nt === "MinusEquals" ? "-=" :
            nt === "StarEquals" ? "*=" :
              nt === "SlashEquals" ? "/=" : "%=") as AssignStmt["op"];
      const expr = parseExpr(); match("Semicolon");
      return { kind: "Assign", name, op, expr, line: t.line, col: t.col };
    }

    // Calls: Pack.Func() or Func()
    if (match("Dot")) {
      const funcName = expect("Identifier").value!; expect("LParen"); expect("RParen"); match("Semicolon");
      return { kind: "Call", targetPack: name, func: funcName, line: t.line, col: t.col };
    } else {
      if (!match("LParen")) { diags.push({ severity: "Error", message: `Unknown statement '${name}'`, line: t.line, col: t.col }); return null; }
      expect("RParen"); match("Semicolon");
      return { kind: "Call", func: name, line: t.line, col: t.col };
    }
  }

  function parseStmt(): Stmt | null {
    const t = peek();
    if (t.type === "Identifier") {
      const low = t.value!.toLowerCase();
      if (low === "execute") return parseExecute();
      if (low === "if" || low === "unless") return parseIfUnless();
      return parseAssignOrCallOrSayRun();
    }
    if (t.type === "RBrace") return null;

    diags.push({ severity: "Error", message: `Unexpected '${t.value ?? t.type}'`, line: t.line, col: t.col });
    while (peek().type !== "Semicolon" && peek().type !== "RBrace" && peek().type !== "EOF") pos++;
    match("Semicolon");
    return null;
  }

  function parseFunc(): FuncDecl {
    const kw = expect("Identifier"); if (kw.value !== "func") throw { message: `Expected 'func'`, line: kw.line, col: kw.col };
    const nameTok = expect("Identifier"); const nameOriginal = nameTok.value!; const lowered = nameOriginal.toLowerCase();
    expect("LParen"); expect("RParen"); expect("LBrace");
    const body: Stmt[] = [];
    while (peek().type !== "RBrace" && peek().type !== "EOF") { const s = parseStmt(); if (s) body.push(s); }
    expect("RBrace");
    return { name: lowered, nameOriginal, body };
  }

  function parsePack(): PackDecl {
    const kwPack = expect("Identifier"); if (kwPack.value !== "pack") throw { message: `Expected 'pack'`, line: kwPack.line, col: kwPack.col };
    const nameTok = expect("String");
    const nsKw = expect("Identifier"); if (nsKw.value !== "namespace") throw { message: `Expected 'namespace'`, line: nsKw.line, col: nsKw.col };
    const nsTok = expect("Identifier"); const nsOriginal = nsTok.value!; const nsLower = nsOriginal.toLowerCase();
    expect("LBrace");

    const globals: VarDeclStmt[] = []; const funcs: FuncDecl[] = [];
    while (peek().type !== "RBrace" && peek().type !== "EOF") {
      const t = peek();
      if (t.type === "Identifier") {
        const low = t.value!.toLowerCase();
        if (low === "global") {
          pos++;
          const decl = parseVarDecl(true);
          globals.push(decl);
          continue;
        }
        if (low === "var" || low === "let") {
          // Back-compat: treat top-level var/let as global
          const decl = parseVarDecl(true);
          globals.push(decl);
          continue;
        }
        if (low === "func") { funcs.push(parseFunc()); continue; }
      }
      diags.push({ severity: "Error", message: `Unexpected token '${t.value ?? t.type}' in pack`, line: t.line, col: t.col });
      while (peek().type !== "RBrace" && peek().type !== "EOF") pos++;
    }

    expect("RBrace");
    return { packTitle: nameTok.value!, namespace: nsLower, namespaceOriginal: nsOriginal, globals, functions: funcs };
  }

  const packs: PackDecl[] = [];
  try {
    while (peek().type !== "EOF") { packs.push(parsePack()); }
    return { ast: { packs }, diagnostics: diags };
  } catch (e: any) {
    diags.push({ severity: "Error", message: e.message || "Parse error", line: e.line ?? 0, col: e.col ?? 0 });
    return { diagnostics: diags };
  }
}

// ---------- Validation & Generation ----------

const PACK_FORMAT = 48; // MC 1.21+
type VarKind = "string" | "number";

function inferType(expr: Expr, packVarTypes: Record<string, VarKind | undefined>, diags: Diagnostic[]): VarKind | undefined {
  switch (expr.kind) {
    case "String": return "string";
    case "Number": return "number";
    case "Var": return packVarTypes[expr.name]; // may be undefined if forward ref across packs
    case "Binary": {
      const l = inferType(expr.left, packVarTypes, diags);
      const r = inferType(expr.right, packVarTypes, diags);
      if (expr.op === "+") {
        if (l === "string" || r === "string") return "string";
        if (l === "number" && r === "number") return "number";
      } else {
        if (l === "number" && r === "number") return "number";
      }
      return undefined;
    }
  }
}

function isStaticString(expr: Expr, packVarTypes: Record<string, VarKind | undefined>): boolean {
  switch (expr.kind) {
    case "String": return true;
    case "Number": return true; // can stringify
    case "Var": return packVarTypes[expr.name] === "string" || packVarTypes[expr.name] === "number"; // dynamic at runtime, not static
    case "Binary":
      // static only if both sides static strings and op is '+'
      if (expr.op !== "+") return false;
      return isStaticString(expr.left, packVarTypes) && isStaticString(expr.right, packVarTypes);
  }
}

function evalStaticString(expr: Expr): string | undefined {
  switch (expr.kind) {
    case "String": return expr.value;
    case "Number": return String(expr.value);
    case "Binary": {
      if (expr.op !== "+") return undefined;
      const l = evalStaticString(expr.left);
      const r = evalStaticString(expr.right);
      if (l === undefined || r === undefined) return undefined;
      return l + r;
    }
    default: return undefined;
  }
}

function validate(ast: Script): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const nsSet = new Set<string>();
  for (const p of ast.packs) {
    if (!/^[a-z0-9_.-]+$/.test(p.namespace)) diags.push({ severity: "Error", message: `Namespace '${p.namespaceOriginal}' must match [a-z0-9_.-]`, line: 1, col: 1 });
    if (nsSet.has(p.namespace)) diags.push({ severity: "Error", message: `Duplicate namespace '${p.namespace}' across packs`, line: 1, col: 1 });
    nsSet.add(p.namespace);
    for (const f of p.functions) {
      if (!/^[a-z0-9_/.+-]+$/.test(f.name)) diags.push({ severity: "Error", message: `Function '${f.nameOriginal}' has invalid characters`, line: 1, col: 1 });
    }
  }
  return diags;
}

function scoreName(ns: string, varName: string) { return `_${ns}.${varName}`; }
function tmpScoreName(idx: number) { return `__tmp${idx}`; }

function generate(ast: Script): { files: GeneratedFile[]; diagnostics: Diagnostic[]; symbolIndex: SymbolIndex } {
  const diagnostics: Diagnostic[] = [];
  const files: GeneratedFile[] = [];

  const description = ast.packs[0]?.packTitle ?? "Datapack";
  files.push({
    path: `pack.mcmeta`,
    contents: JSON.stringify({ pack: { pack_format: PACK_FORMAT, description } }, null, 2) + "\n"
  });

  const symbolIndex: SymbolIndex = { packs: {} };
  for (const p of ast.packs) {
    symbolIndex.packs[p.namespace] = { title: p.packTitle, vars: new Set(p.globals.map(g => g.name)), funcs: new Set(p.functions.map(f => f.name)) };
  }

  // Build per-pack var type maps
  const packVarTypes: Record<string, Record<string, VarKind>> = {};
  for (const p of ast.packs) {
    const types: Record<string, VarKind> = {};
    // first pass infer from init
    for (const g of p.globals) {
      const t = inferType(g.init, types, diagnostics);
      if (!t) diagnostics.push({ severity: "Error", message: `Cannot infer type of global '${g.name}'`, line: g.line, col: g.col });
      else types[g.name] = t;
    }
    packVarTypes[p.namespace] = types;
  }

  // emit helper to compile numeric expressions into scoreboard temps
  function compileNumericExpr(expr: Expr, ns: string, out: string[], tmpCounter: { n: number }): string {
    const res = tmpScoreName(tmpCounter.n++);

    function emitTo(target: string, e: Expr): void {
      switch (e.kind) {
        case "Number":
          out.push(`scoreboard players set ${target} vars ${Math.trunc(e.value)}`);
          return;
        case "Var": {
          out.push(`scoreboard players operation ${target} vars = ${scoreName(ns, e.name)} vars`);
          return;
        }
        case "Binary": {
          // left -> L, right -> R, then L <op>= R, copy to target if needed
          const L = tmpScoreName(tmpCounter.n++), R = tmpScoreName(tmpCounter.n++);
          emitTo(L, e.left);
          emitTo(R, e.right);
          const map: Record<string, string> = { "+": "+=", "-": "-=", "*": "*=", "/": "/=", "%": "%=" };
          out.push(`scoreboard players operation ${L} vars ${map[e.op]} ${R} vars`);
          out.push(`scoreboard players operation ${target} vars = ${L} vars`);
          return;
        }
        case "String":
          // numeric expected; best effort -> 0 and warn
          out.push(`scoreboard players set ${target} vars 0`);
          diagnostics.push({ severity: "Warning", message: `String used in numeric expression; treated as 0`, line: e.line, col: e.col });
          return;
      }
    }

    emitTo(res, expr);
    return res;
  }

  // tellraw component builder for string-ish expressions composed of literals and simple vars
  function exprToTellrawComponents(expr: Expr, ns: string, types: Record<string, VarKind>): { comps: any[], ok: boolean } {
    const parts: any[] = [];
    let ok = true;

    function pushExpr(e: Expr) {
      switch (e.kind) {
        case "String": parts.push({ text: e.value }); return;
        case "Number": parts.push({ text: String(e.value) }); return;
        case "Var": {
          const t = types[e.name];
          if (!t) { parts.push({ text: `<${e.name}>` }); ok = false; return; }
          if (t === "string") parts.push({ nbt: e.name, storage: `${ns}:variables` });
          else parts.push({ score: { name: scoreName(ns, e.name), objective: "vars" } });
          return;
        }
        case "Binary": {
          if (e.op !== "+") { ok = false; return; }
          pushExpr(e.left); pushExpr(e.right); return;
        }
      }
    }

    pushExpr(expr);
    return { comps: parts, ok };
  }

  // Generate per-pack
  for (const p of ast.packs) {
    const types = packVarTypes[p.namespace];

    // --- BOOTSTRAP (runs once) ---
    const boot: string[] = [];
    boot.push(
      // if storage flag not set, run setup
      `execute unless data storage ${p.namespace}:system bootstrap run function ${p.namespace}:__setup`
    );
    files.push({ path: `data/${p.namespace}/function/__bootstrap.mcfunction`, contents: boot.join("\n") + "\n" });

    const setup: string[] = [];
    setup.push(`scoreboard objectives add vars dummy`);
    setup.push(`data modify storage ${p.namespace}:system bootstrap set value 1b`);
    files.push({ path: `data/${p.namespace}/function/__setup.mcfunction`, contents: setup.join("\n") + "\n" });

    // --- INIT (every load) ---
    const init: string[] = [];
    // string + number globals
    for (const g of p.globals) {
      const t = types[g.name];
      if (!t) continue;
      if (t === "string") {
        // allow compile-time concat of literals/numbers
        if (isStaticString(g.init, types)) {
          const s = evalStaticString(g.init)!;
          const escaped = JSON.stringify(s); // quoted
          init.push(`data modify storage ${p.namespace}:variables ${g.name} set value ${escaped}`);
        } else {
          diagnostics.push({ severity: "Warning", message: `String init for '${g.name}' must be a static literal/concat; skipped`, line: g.line, col: g.col });
        }
      } else {
        // number
        if (g.init.kind === "Number") {
          init.push(`scoreboard players set ${scoreName(p.namespace, g.name)} vars ${Math.trunc(g.init.value)}`);
        } else {
          // compute into temp and assign
          const tmp = compileNumericExpr(g.init, p.namespace, init, { n: 0 });
          init.push(`scoreboard players operation ${scoreName(p.namespace, g.name)} vars = ${tmp} vars`);
        }
      }
    }
    files.push({ path: `data/${p.namespace}/function/__init.mcfunction`, contents: init.join("\n") + (init.length ? "\n" : "") });

    // --- FUNCTIONS ---
    for (const fn of p.functions) {
      const out: string[] = [];
      let tmpCounter = { n: 0 };

      function runWithChain(chain: string, cmd: string) {
        if (chain) out.push(`execute ${chain} run ${cmd}`); else out.push(cmd);
      }

      function emitStmt(st: Stmt, chain: string) {
        switch (st.kind) {
          case "VarDecl":
            diagnostics.push({ severity: "Warning", message: `Local 'var' not emitted; use 'global var' at pack scope`, line: st.line, col: st.col });
            return;

          case "Assign": {
            const vk = types[st.name];
            if (!vk) { diagnostics.push({ severity: "Error", message: `Unknown variable '${st.name}'`, line: st.line, col: st.col }); return; }
            if (vk === "string") {
              if (st.op !== "=") {
                diagnostics.push({ severity: "Error", message: `Only '=' supported for string variables`, line: st.line, col: st.col });
                return;
              }
              if (isStaticString(st.expr, types)) {
                const s = evalStaticString(st.expr)!;
                runWithChain(chain, `data modify storage ${p.namespace}:variables ${st.name} set value ${JSON.stringify(s)}`);
              } else {
                diagnostics.push({ severity: "Error", message: `Dynamic string assignment not supported (vanilla limitation)`, line: st.line, col: st.col });
              }
            } else {
              // number
              const tmp = compileNumericExpr(st.expr, p.namespace, out, tmpCounter);
              const target = `${scoreName(p.namespace, st.name)} vars`;
              const opMap: Record<AssignStmt["op"], string> = { "=": "=", "+=": "+=", "-=": "-=", "*=": "*=", "/=": "/=", "%=": "%=" };
              runWithChain(chain, `scoreboard players operation ${target} ${opMap[st.op]} ${tmp} vars`);
            }
            return;
          }

          case "Run": {
            // only allow static string literal or static concat
            if (!isStaticString(st.expr, types)) {
              diagnostics.push({ severity: "Error", message: `Run(...) must be a static string`, line: st.expr.line, col: st.expr.col });
              return;
            }
            const cmd = evalStaticString(st.expr)!;
            runWithChain(chain, cmd);
            return;
          }

          case "Say": {
            // If it's a pure number expression (not concat), compute and tellraw score
            const t = inferType(st.expr, types, diagnostics);
            if (t === "number" && st.expr.kind !== "Var" && st.expr.kind !== "Number") {
              const tmp = compileNumericExpr(st.expr, p.namespace, out, tmpCounter);
              runWithChain(chain, `tellraw @a {"score":{"name":"${tmp}","objective":"vars"}}`);
              return;
            }
            // Otherwise try to build components (concat of literals/vars)
            const { comps, ok } = exprToTellrawComponents(st.expr, p.namespace, types);
            if (ok && comps.length === 1 && "text" in comps[0]) {
              // just static text
              runWithChain(chain, `say ${JSON.stringify(comps[0].text)}`);
            } else if (ok) {
              runWithChain(chain, `tellraw @a ${JSON.stringify(comps)}`);
            } else {
              diagnostics.push({ severity: "Error", message: `Say(...) supports literals, +, and simple vars (string/number).`, line: st.expr.line, col: st.expr.col });
            }
            return;
          }

          case "Call": {
            const targetNs = st.targetPack ? st.targetPack.toLowerCase() : p.namespace;
            const funcName = st.func.toLowerCase();
            runWithChain(chain, `function ${targetNs}:${funcName}`);
            return;
          }

          case "If": {
            const condStr = st.cond ? evalStaticString(st.cond) ?? undefined : undefined;
            if (!condStr) {
              diagnostics.push({ severity: "Error", message: `if/unless requires raw vanilla fragment in quotes`, line: st.line, col: st.col });
              return;
            }
            const add = `${st.negated ? "unless" : "if"} ${condStr}`;
            for (const inner of st.body) emitStmt(inner, [chain, add].filter(Boolean).join(" "));
            return;
          }

          case "Execute": {
            if (!st.variants.length) { for (const inner of st.body) emitStmt(inner, chain); return; }
            for (const v of st.variants) {
              const parts: string[] = [];
              for (const m of v.mods) {
                if (m.kind === "as") parts.push(`as ${m.arg}`);
                else if (m.kind === "at") parts.push(`at ${m.arg}`);
                else if (m.kind === "positioned") parts.push(`positioned ${m.x} ${m.y} ${m.z}`);
              }
              const nextChain = [chain, parts.join(" ")].filter(Boolean).join(" ");
              for (const inner of st.body) emitStmt(inner, nextChain);
            }
            return;
          }
        }
      }

      for (const st of fn.body) emitStmt(st, "");
      files.push({
        path: `data/${p.namespace}/function/${fn.name}.mcfunction`,
        contents: out.join("\n") + (out.length ? "\n" : "")
      });
    }
  }

  // Tags (singular "function")
  const loadValues: string[] = []; const tickValues: string[] = [];
  for (const p of ast.packs) {
    // always include bootstrap and init
    loadValues.push(`${p.namespace}:__bootstrap`, `${p.namespace}:__init`);
    for (const f of p.functions) {
      if (f.name.toLowerCase() === "load") loadValues.push(`${p.namespace}:${f.name}`);
      if (f.name.toLowerCase() === "tick") tickValues.push(`${p.namespace}:${f.name}`);
    }
  }
  if (loadValues.length) files.push({
    path: `data/minecraft/tags/function/load.json`,
    contents: JSON.stringify({ values: loadValues }, null, 2) + "\n"
  });
  if (tickValues.length) files.push({
    path: `data/minecraft/tags/function/tick.json`,
    contents: JSON.stringify({ values: tickValues }, null, 2) + "\n"
  });

  return { files, diagnostics, symbolIndex };
}

function compile(source: string): { files: GeneratedFile[]; diagnostics: Diagnostic[]; symbolIndex: SymbolIndex } {
  let tokens: Token[]; const diagnostics: Diagnostic[] = [];
  try { tokens = lex(source); } catch (e: any) { diagnostics.push({ severity: "Error", message: e.message || "Lex error", line: e.line ?? 0, col: e.col ?? 0 }); return { files: [], diagnostics, symbolIndex: { packs: {} } }; }
  const { ast, diagnostics: parseDiags } = parse(tokens); diagnostics.push(...parseDiags); if (!ast) return { files: [], diagnostics, symbolIndex: { packs: {} } };
  diagnostics.push(...validate(ast)); if (diagnostics.some(d => d.severity === "Error")) return { files: [], diagnostics, symbolIndex: { packs: {} } };
  const { files, diagnostics: genDiags, symbolIndex } = generate(ast); diagnostics.push(...genDiags);
  return { files, diagnostics, symbolIndex };
}

// ---------- IntelliSense ----------
function useDslLanguage(monacoRef: any, symbols: SymbolIndex) {
  useEffect(() => {
    const monaco = monacoRef;
    if (!monaco) return;

    const id = "datapackdsl";
    if (!(monaco as any)._dpdslRegistered) {
      monaco.languages.register({ id });
      (monaco as any)._dpdslRegistered = true;
      monaco.languages.setMonarchTokensProvider(id, {
        tokenizer: {
          root: [
            [/pack|namespace|func|global|var|let|Say|say|Execute|execute|if|unless|Run|run/, "keyword"],
            [/\d+/, "number"],
            [/\"[^\"]*\"/, "string"],
            [/[a-zA-Z_@~^\[\]:.][a-zA-Z0-9_@~^\[\]:.]*/, "identifier"],
            [/[{()}.;,]/, "delimiter"],
            [/[+\-*\/%]=?/, "operator"],
          ],
        },
      });
    }

    const disp = monaco.languages.registerCompletionItemProvider(id, {
      triggerCharacters: [".", " ", "\"", "(", ")", "+", "-", "*", "/"],
      provideCompletionItems: (model: any, position: any) => {
        const suggestions: any[] = [];

        const kw = ["pack", "namespace", "func", "global", "var", "let", "Say", "Execute", "if", "unless", "Run"];
        for (const k of kw) suggestions.push({ label: k, kind: monaco.languages.CompletionItemKind.Keyword, insertText: k });

        // Snippets
        suggestions.push({
          label: "global string",
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: `global var Name = "Hello"\n`,
          detail: "Global string variable"
        });
        suggestions.push({
          label: "global number",
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: `global var Count = 0\n`,
          detail: "Global numeric variable"
        });
        suggestions.push({
          label: "Execute block",
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: `Execute(as @s, at @s){\n    if("entity @s"){\n        Say("Hi");\n    }\n}\n`,
          detail: "Insert Execute block",
        });

        // Known packs & symbols
        const packIds = Object.keys(symbols.packs);
        for (const p of packIds) suggestions.push({ label: p, kind: monaco.languages.CompletionItemKind.Module, insertText: p });

        const lineText = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
        const lastDot = lineText.lastIndexOf(".");
        if (lastDot >= 0) {
          const before = lineText.slice(0, lastDot);
          const packId = (before.split(/[^A-Za-z0-9_.]/).pop() || "").trim();
          const pack = symbols.packs[packId];
          if (pack) {
            for (const fn of Array.from(pack.funcs)) {
              suggestions.push({ label: fn, kind: monaco.languages.CompletionItemKind.Function, insertText: `${fn}()`, detail: `${packId}:${fn}` });
            }
          }
        } else {
          for (const [pid, s] of Object.entries(symbols.packs)) {
            for (const fn of Array.from(s.funcs)) suggestions.push({ label: `${pid}.${fn}`, kind: monaco.languages.CompletionItemKind.Function, insertText: `${pid}.${fn}()` });
            for (const v of Array.from(s.vars)) suggestions.push({ label: v, kind: monaco.languages.CompletionItemKind.Variable, insertText: v });
          }
        }

        return { suggestions };
      },
    });

    return () => disp.dispose();
  }, [monacoRef, symbols]);
}

// ---------- UI ----------
const DEFAULT_SOURCE = `pack "Hello World" namespace hw{
  func Load(){
    Say("Hello World")
  }

  func Tick(){
  }

}`;

function FileList({ files, onSelect, selected }: { files: GeneratedFile[]; selected?: string; onSelect: (p: string) => void }) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => files.filter(f => f.path.toLowerCase().includes(q.toLowerCase())), [files, q]);
  return (
    <div className="flex flex-col gap-2 h-full">
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter files..." className="w-full px-3 py-2 rounded-xl border border-black/10" />
      <div className="space-y-1 overflow-auto">
        {filtered.map(f => (
          <button key={f.path} onClick={() => onSelect(f.path)} className={`w-full text-left px-3 py-2 rounded-xl border ${selected === f.path ? "border-black/30 bg-black/5" : "border-black/10 hover:bg-black/5"}`}>
            <code className="text-sm break-all">{f.path}</code>
          </button>
        ))}
      </div>
    </div>
  );
}

function DiagnosticsPanel({ diags }: { diags: Diagnostic[] }) {
  if (!diags.length) return <div className="text-sm text-green-700">No diagnostics. ✓</div>;
  return (
    <div className="space-y-2">
      {diags.map((d, i) => (
        <div key={i} className={`rounded-xl p-3 border ${d.severity === "Error" ? "border-red-300 bg-red-50" : "border-amber-300 bg-amber-50"}`}>
          <div className="text-xs opacity-70">{d.severity}</div>
          <div className="text-sm font-medium">{d.message}</div>
          <div className="text-xs opacity-70">Line {d.line}, Col {d.col}</div>
        </div>
      ))}
    </div>
  );
}

function useDebounced<T>(value: T, delay = 300) {
  const [v, setV] = useState(value);
  const t = useRef<number | null>(null);
  useEffect(() => {
    if (t.current !== null) window.clearTimeout(t.current);
    t.current = window.setTimeout(() => setV(value), delay);
    return () => { if (t.current !== null) window.clearTimeout(t.current); };
  }, [value, delay]);
  return v;
}

export default function WebDatapackCompiler() {
  const monaco = useMonaco();
  const [source, setSource] = useState<string>(DEFAULT_SOURCE);
  const debouncedSource = useDebounced(source, 300);
  const [compiled, setCompiled] = useState<{ files: GeneratedFile[]; diagnostics: Diagnostic[]; symbolIndex: SymbolIndex }>({ files: [], diagnostics: [], symbolIndex: { packs: {} } });
  const [selectedPath, setSelectedPath] = useState<string | undefined>(undefined);

  useDslLanguage(monaco, compiled.symbolIndex);

  useEffect(() => {
    const res = compile(debouncedSource);
    setCompiled(res);
    if (res.files.length && !selectedPath) setSelectedPath(res.files[0].path);
  }, [debouncedSource]);

  async function downloadZip() {
    if (!compiled.files.length) return;
    const zip = new JSZip();
    for (const f of compiled.files) zip.file(f.path, f.contents);
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "datapack.zip";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  const selectedFile = useMemo(() => compiled.files.find(f => f.path === selectedPath), [compiled.files, selectedPath]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-white to-slate-50 text-black">
      <div className="mx-auto max-w-7xl p-6">
        <header className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-xl bg-black/90 text-white grid place-items-center font-bold">DP</div>
            <div>
              <h1 className="text-xl font-bold">Datapack Web Compiler</h1>
              <p className="text-xs text-black/60">Globals (storage/scoreboard) • Execute • IntelliSense • Zip export</p>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={downloadZip} disabled={!compiled.files.length} className="px-4 py-2 rounded-xl border border-black/10 disabled:opacity-50 hover:bg-black/5">Download .zip</button>
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Editor */}
          <div className="lg:col-span-2 flex flex-col gap-2">
            <label className="text-sm font-medium">Source</label>
            <div className="rounded-xl overflow-hidden border border-black/10">
              <Editor height="520px" language="datapackdsl" value={source} onChange={(v) => setSource(v ?? "")}
                options={{ fontSize: 14, minimap: { enabled: false }, wordWrap: "on", automaticLayout: true }} />
            </div>
            <div>
              <label className="text-sm font-medium">Diagnostics</label>
              <div className="mt-2"><DiagnosticsPanel diags={compiled.diagnostics} /></div>
            </div>
          </div>

          {/* Output */}
          <div className="lg:col-span-1 flex flex-col gap-3">
            <label className="text-sm font-medium">Generated Files</label>
            <div className="grid grid-cols-1 gap-3">
              <div className="border rounded-xl p-3 border-black/10 h-[220px]">
                <FileList files={compiled.files} selected={selectedPath} onSelect={setSelectedPath} />
              </div>
              <div className="border rounded-xl p-3 border-black/10 h-[280px] overflow-auto bg-white">
                {selectedFile ? (
                  <pre className="font-mono text-sm whitespace-pre-wrap break-words">{selectedFile.contents}</pre>
                ) : (
                  <div className="text-sm text-black/60">No file selected.</div>
                )}
              </div>
            </div>

            <div className="text-xs text-black/60 mt-2 space-y-1">
              <p><b>Strings:</b> <code>global var Name = "Alex"</code> → <code>data modify storage &lt;ns&gt;:variables Name set value "Alex"</code></p>
              <p><b>Numbers:</b> <code>global var Count = 0</code> → scoreboard <code>vars</code>, holder <code>_<i>ns</i>.<i>Name</i></code></p>
              <p><b>Math:</b> <code>Count += 2</code>, <code>Count = Count * 3</code> (scoreboard ops)</p>
              <p><b>Say:</b> concats of literals + vars use <code>tellraw</code> with NBT/score components.</p>
            </div>
          </div>
        </div>

        <footer className="mt-8 text-xs text-black/50">
          Pack format: 48. Drop the zip into <code>%APPDATA%\.minecraft\saves\&lt;World&gt;\datapacks</code>.
        </footer>
      </div>
    </div>
  );
}
