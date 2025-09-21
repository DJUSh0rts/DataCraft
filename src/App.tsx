import { useEffect, useMemo, useRef, useState } from "react";
import "./monaco-setup";
import JSZip from "jszip";
import Editor, { useMonaco } from "@monaco-editor/react";

// =============================
// Datapack Web Compiler
// - Packs, Execute{ as/at/positioned }, if()/unless(), Run("...")
// - GLOBAL VARS:
//     * Strings -> storage <ns>:variables <Name>
//     * Numbers -> scoreboard objective "vars", holder "_<ns>.<Name>"
// - Numeric math: =, +=, -=, *=, /=, %=  (+ - * / % in expressions)
// - if(num == 1) style conditions (==, !=, <, <=, >, >=)
// - for-loops: for (var i = 0 | i < 10 | i++) { ... }  /  for (num | num < 10 | num++) { ... }
// - adv / recipe blocks (pack-scope) to emit JSON helpers
// - Global scoreboard bootstrap (__core__:__setup) added once to load
// - Macro strings: Say($"Hello {i}") => macro line `$say Hello $(i)`
// - Outputs (singular):
//     data/<ns>/function/*.mcfunction
//     data/<ns>/advancements/*.json
//     data/<ns>/recipes/*.json
//     data/minecraft/tags/function/load.json|tick.json
// =============================

// ---------- Types ----------
type TokenType =
  | "Identifier" | "String" | "MacroString" | "Number"
  | "LBrace" | "RBrace" | "LParen" | "RParen"
  | "Semicolon" | "Comma" | "Dot" | "Pipe"
  | "Plus" | "Minus" | "Star" | "Slash" | "Percent"
  | "PlusEquals" | "MinusEquals" | "StarEquals" | "SlashEquals" | "PercentEquals"
  | "PlusPlus" | "MinusMinus"
  | "Equals" | "EqEq" | "BangEq" | "Lt" | "Le" | "Gt" | "Ge"
  | "EOF";

type Token = { type: TokenType; value?: string; line: number; col: number };
type Diagnostic = { severity: "Error" | "Warning" | "Info"; message: string; line: number; col: number };

// Expressions
type StringExpr = { kind: "String"; value: string; line: number; col: number };
type MacroStringExpr = { kind: "MacroString"; raw: string; line: number; col: number };
type NumberExpr = { kind: "Number"; value: number; line: number; col: number };
type VarExpr    = { kind: "Var"; name: string; line: number; col: number };
type BinaryExpr = { kind: "Binary"; op: "+" | "-" | "*" | "/" | "%"; left: Expr; right: Expr; line: number; col: number };
type Expr = StringExpr | MacroStringExpr | NumberExpr | VarExpr | BinaryExpr;

// Conditions
type CmpOp = "==" | "!=" | "<" | "<=" | ">" | ">=";
type RawCond = { kind: "Raw"; raw: string; line: number; col: number };
type CmpCond = { kind: "Cmp"; op: CmpOp; left: Expr; right: Expr; line: number; col: number };
type Condition = RawCond | CmpCond;

// Execute helpers
type ExecMod =
  | { kind: "as"; arg: string }
  | { kind: "at"; arg: string }
  | { kind: "positioned"; x: string; y: string; z: string };
type ExecVariant = { mods: ExecMod[] };

// Statements
type SayStmt    = { kind: "Say"; expr: Expr };
type RunStmt    = { kind: "Run"; expr: Expr };
type VarDeclStmt = { kind: "VarDecl"; isGlobal: boolean; name: string; init: Expr; line: number; col: number };
type AssignStmt  = { kind: "Assign"; name: string; op: "=" | "+=" | "-=" | "*=" | "/=" | "%="; expr: Expr; line: number; col: number };
type CallStmt    = { kind: "Call"; targetPack?: string; func: string; line: number; col: number };
type IfBlock     = { kind: "If"; negated: boolean; cond?: Condition | null; body: Stmt[]; line: number; col: number };
type ExecuteStmt = { kind: "Execute"; variants: ExecVariant[]; body: Stmt[] };
type ForStmt = {
  kind: "For";
  init?: VarDeclStmt | AssignStmt | { kind: "Noop" } | null;
  cond?: Condition | null;
  incr?: AssignStmt | null;
  body: Stmt[];
  line: number; col: number;
};
type Stmt = SayStmt | VarDeclStmt | AssignStmt | CallStmt | ExecuteStmt | IfBlock | RunStmt | ForStmt;

// Adv / Recipe (pack-scope)
type AdvDecl = {
  kind: "Adv";
  name: string;
  props: { title?: string; description?: string; icon?: string; parent?: string; criteria: Array<{ name: string; trigger: string }> };
};
type RecipeDecl = {
  kind: "Recipe";
  name: string;
  type?: "shapeless";
  result?: { id: string; count?: number };
  ingredients: string[];
};

// Decls
type FuncDecl = { name: string; nameOriginal: string; body: Stmt[] };
type PackDecl = {
  packTitle: string;
  namespace: string;
  namespaceOriginal: string;
  globals: VarDeclStmt[];
  functions: FuncDecl[];
  advs: AdvDecl[];
  recipes: RecipeDecl[];
};
type Script = { packs: PackDecl[] };

type GeneratedFile = { path: string; contents: string };
type SymbolIndex = { packs: Record<string, { title: string; vars: Set<string>; funcs: Set<string> }> };

// ---------- Lexer ----------
function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0, line = 1, col = 1;
  const push = (t: Token) => tokens.push(t);
  const peek = (o = 0) => input[i + o];

  function adv(n = 1) {
    for (let k = 0; k < n; k++) {
      const ch = input[i++];
      if (ch === "\n") { line++; col = 1; } else { col++; }
    }
  }

  while (i < input.length) {
    const ch = input[i];
    if (ch === "\n") { adv(); continue; }
    if (ch === " " || ch === "\t" || ch === "\r") { adv(); continue; }

    // line comments
    if (ch === "/" && peek(1) === "/") {
      while (i < input.length && input[i] !== "\n") adv();
      continue;
    }

    // numbers (int)
    if (/[0-9]/.test(ch) || (ch === "-" && /[0-9]/.test(peek(1) ?? ""))) {
      let j = i + 1;
      while (j < input.length && /[0-9]/.test(input[j])) j++;
      push({ type: "Number", value: String(Number(input.slice(i, j))), line, col });
      col += (j - i); i = j; continue;
    }

    // MACRO string: $" ... "
    if (ch === "$" && peek(1) === "\"") {
      const L = line, C = col;
      // consume $" opener
      i += 2; col += 2;
      let text = "";
      while (i < input.length) {
        const c = input[i];
        if (c === "\\") {
          const n = input[i + 1];
          if (n === "\"" || n === "\\" || n === "n" || n === "t") {
            text += n === "n" ? "\n" : n === "t" ? "\t" : n;
            i += 2; col += 2; continue;
          }
        }
        if (c === "\"") { i++; col++; break; }
        if (c === "\n") { i++; line++; col = 1; continue; }
        text += c; i++; col++;
      }
      push({ type: "MacroString", value: text, line: L, col: C });
      continue;
    }

    // strings
    if (ch === "\"") {
      let j = i + 1; let text = ""; const L = line, C = col;
      while (j < input.length) {
        const c = input[j];
        if (c === "\\") {
          const n = input[j + 1];
          if (n === "\"" || n === "\\" || n === "n" || n === "t") { text += n === "n" ? "\n" : n === "t" ? "\t" : n; j += 2; continue; }
        }
        if (c === "\"") { j++; break; }
        text += c; j++;
      }
      push({ type: "String", value: text, line: L, col: C });
      col += (j - i); i = j; continue;
    }

    // compound ops
    if (ch === "|") { push({ type: "Pipe", line, col }); adv(); continue; }
    if (ch === "+" && peek(1) === "+") { push({ type: "PlusPlus", line, col }); adv(2); continue; }
    if (ch === "-" && peek(1) === "-") { push({ type: "MinusMinus", line, col }); adv(2); continue; }
    if (ch === "+" && peek(1) === "=") { push({ type: "PlusEquals", line, col }); adv(2); continue; }
    if (ch === "-" && peek(1) === "=") { push({ type: "MinusEquals", line, col }); adv(2); continue; }
    if (ch === "*" && peek(1) === "=") { push({ type: "StarEquals", line, col }); adv(2); continue; }
    if (ch === "/" && peek(1) === "=") { push({ type: "SlashEquals", line, col }); adv(2); continue; }
    if (ch === "%" && peek(1) === "=") { push({ type: "PercentEquals", line, col }); adv(2); continue; }
    if (ch === "=" && peek(1) === "=") { push({ type: "EqEq", line, col }); adv(2); continue; }
    if (ch === "!" && peek(1) === "=") { push({ type: "BangEq", line, col }); adv(2); continue; }
    if (ch === "<" && peek(1) === "=") { push({ type: "Le", line, col }); adv(2); continue; }
    if (ch === ">" && peek(1) === "=") { push({ type: "Ge", line, col }); adv(2); continue; }

    // single-char ops/syms
    const sym: Record<string, TokenType> = {
      "{": "LBrace", "}": "RBrace", "(": "LParen", ")": "RParen",
      ";": "Semicolon", ",": "Comma", ".": "Dot",
      "+": "Plus", "-": "Minus", "*": "Star", "/": "Slash", "%": "Percent",
      "=": "Equals", "<": "Lt", ">": "Gt"
    };
    if (sym[ch]) { push({ type: sym[ch], line, col }); adv(); continue; }

    // identifiers (allow @ ~ ^ : . [ ] _ and digits)
    if (/[A-Za-z_@~^\[\]:.0-9]/.test(ch)) {
      let j = i + 1;
      while (j < input.length && /[A-Za-z0-9_@~^\[\]:.]/.test(input[j])) j++;
      push({ type: "Identifier", value: input.slice(i, j), line, col });
      col += (j - i); i = j; continue;
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
    if (t.type === "MacroString") { pos++; return { kind: "MacroString", raw: t.value!, line: t.line, col: t.col }; }
    if (t.type === "String") { pos++; return { kind: "String", value: t.value!, line: t.line, col: t.col }; }
    if (t.type === "Number") { pos++; return { kind: "Number", value: Number(t.value!), line: t.line, col: t.col }; }
    if (t.type === "Identifier") { pos++; return { kind: "Var", name: t.value!, line: t.line, col: t.col }; }
    if (t.type === "LParen") { pos++; const e = parseExpr(); expect("RParen", "')'"); return e; }
    throw { message: `Unexpected token in expression: ${t.value ?? t.type}`, line: t.line, col: t.col };
  }

  function parseUnary(): Expr {
    const t = peek();
    if (t.type === "Minus") {
      pos++; // consume '-'
      const e = parseUnary();
      return { kind: "Binary", op: "-", left: { kind: "Number", value: 0, line: t.line, col: t.col }, right: e, line: t.line, col: t.col };
    }
    return parsePrimary();
  }

  function parseMul(): Expr {
    let e = parseUnary();
    while (peek().type === "Star" || peek().type === "Slash" || peek().type === "Percent") {
      const opTok = peek(); pos++;
      const r = parseUnary();
      e = { kind: "Binary", op: opTok.type === "Star" ? "*" : opTok.type === "Slash" ? "/" : "%", left: e, right: r, line: opTok.line, col: opTok.col };
    }
    return e;
  }
  function parseAdd(): Expr {
    let e = parseMul();
    while (peek().type === "Plus" || peek().type === "Minus") {
      const opTok = peek(); pos++;
      const r = parseMul();
      e = { kind: "Binary", op: opTok.type === "Plus" ? "+" : "-", left: e, right: r, line: opTok.line, col: opTok.col };
    }
    return e;
  }
  function parseExpr(): Expr { return parseAdd(); }

  function parseCondition(): Condition | null {
    const t = peek();
    if (t.type === "String") { pos++; return { kind: "Raw", raw: t.value!, line: t.line, col: t.col }; }
    const left = parseExpr();
    const opTok = peek();
    const map: Record<TokenType, CmpOp> = {
      "EqEq": "==", "BangEq": "!=", "Lt": "<", "Le": "<=", "Gt": ">", "Ge": ">="
    } as any;
    if (!(opTok.type in map)) {
      diags.push({ severity: "Error", message: `Expected comparison operator (==, !=, <, <=, >, >=)`, line: opTok.line, col: opTok.col });
      return null;
    }
    pos++;
    const right = parseExpr();
    return { kind: "Cmp", op: map[opTok.type], left, right, line: opTok.line, col: opTok.col };
  }

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

  function parseAssignAfterName(nameTok: Token): AssignStmt {
    if (match("PlusPlus")) return { kind: "Assign", name: nameTok.value!, op: "+=", expr: { kind: "Number", value: 1, line: nameTok.line, col: nameTok.col }, line: nameTok.line, col: nameTok.col };
    if (match("MinusMinus")) return { kind: "Assign", name: nameTok.value!, op: "-=", expr: { kind: "Number", value: 1, line: nameTok.line, col: nameTok.col }, line: nameTok.line, col: nameTok.col };
    const nt = peek().type;
    if (nt === "Equals" || nt === "PlusEquals" || nt === "MinusEquals" || nt === "StarEquals" || nt === "SlashEquals" || nt === "PercentEquals") {
      pos++;
      const op = (nt === "Equals" ? "=" :
        nt === "PlusEquals" ? "+=" :
        nt === "MinusEquals" ? "-=" :
        nt === "StarEquals" ? "*=" :
        nt === "SlashEquals" ? "/=" : "%=") as AssignStmt["op"];
      const expr = parseExpr(); match("Semicolon");
      return { kind: "Assign", name: nameTok.value!, op, expr, line: nameTok.line, col: nameTok.col };
    }
    return { kind: "Assign", name: nameTok.value!, op: "+=", expr: { kind: "Number", value: 0, line: nameTok.line, col: nameTok.col }, line: nameTok.line, col: nameTok.col };
  }

  function parseIfUnless(): IfBlock {
    const kw = expect("Identifier"); const neg = kw.value!.toLowerCase() === "unless";
    if (!neg && kw.value!.toLowerCase() !== "if") throw { message: `Expected 'if' or 'unless'`, line: kw.line, col: kw.col };
    expect("LParen");
    let cond: Condition | null = null;
    if (peek().type !== "RParen") cond = parseCondition();
    expect("RParen");
    expect("LBrace");
    const body: Stmt[] = [];
    while (peek().type !== "RBrace" && peek().type !== "EOF") { const s = parseStmt(); if (s) body.push(s); }
    expect("RBrace");
    return { kind: "If", negated: neg, cond, body, line: kw.line, col: kw.col };
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

  function parseFor(): ForStmt {
    const kw = expect("Identifier"); // for
    expect("LParen");

    // init
    let init: VarDeclStmt | AssignStmt | { kind: "Noop" } | null = null;
    if (peek().type !== "Pipe") {
      const t = peek();
      if (t.type === "Identifier" && (t.value === "var" || t.value === "let")) {
        init = parseVarDecl(false);
      } else if (t.type === "Identifier") {
        const nameTok = expect("Identifier");
        if (peek().type === "PlusPlus" || peek().type === "MinusMinus" || peek().type === "Equals" || peek().type === "PlusEquals" || peek().type === "MinusEquals" || peek().type === "StarEquals" || peek().type === "SlashEquals" || peek().type === "PercentEquals") {
          init = parseAssignAfterName(nameTok);
        } else {
          init = { kind: "Noop" };
        }
      } else {
        init = { kind: "Noop" };
      }
    }
    expect("Pipe");

    // condition
    let cond: Condition | null = null;
    if (peek().type !== "Pipe") cond = parseCondition();
    expect("Pipe");

    // increment
    let incr: AssignStmt | null = null;
    if (peek().type !== "RParen") {
      if (peek().type === "Identifier") {
        const nameTok = expect("Identifier");
        incr = parseAssignAfterName(nameTok);
      } else {
        diags.push({ severity: "Error", message: `Expected increment expression`, line: peek().line, col: peek().col });
      }
    }
    expect("RParen");

    expect("LBrace");
    const body: Stmt[] = [];
    while (peek().type !== "RBrace" && peek().type !== "EOF") { const s = parseStmt(); if (s) body.push(s); }
    expect("RBrace");
    return { kind: "For", init, cond, incr, body, line: kw.line, col: kw.col };
  }

  function parseAdv(): AdvDecl {
    expect("Identifier"); // adv
    const nameTok = expect("Identifier"); const name = nameTok.value!;
    if (match("LParen")) { expect("RParen"); }
    expect("LBrace");
    const props: AdvDecl["props"] = { criteria: [] };
    while (peek().type !== "RBrace" && peek().type !== "EOF") {
      const t = expect("Identifier");
      const low = t.value!.toLowerCase();
      if (low === "title") { const s = expect("String"); props.title = s.value!; match("Semicolon"); continue; }
      if (low === "description" || low === "desc") { const s = expect("String"); props.description = s.value!; match("Semicolon"); continue; }
      if (low === "icon") { const s = expect("Identifier"); props.icon = s.value!; match("Semicolon"); continue; }
      if (low === "parent") { const s = expect("Identifier"); props.parent = s.value!; match("Semicolon"); continue; }
      if (low === "criterion") {
        const cname = expect("Identifier").value!;
        const trig = expect("String").value!;
        props.criteria.push({ name: cname, trigger: trig }); match("Semicolon"); continue;
      }
      diags.push({ severity: "Warning", message: `Unknown adv property '${t.value}'`, line: t.line, col: t.col });
      while (peek().type !== "Semicolon" && peek().type !== "RBrace" && peek().type !== "EOF") pos++;
      match("Semicolon");
    }
    expect("RBrace");
    return { kind: "Adv", name, props };
  }

  function parseRecipe(): RecipeDecl {
    expect("Identifier"); // recipe
    const nameTok = expect("Identifier"); const name = nameTok.value!;
    expect("LBrace");
    const decl: RecipeDecl = { kind: "Recipe", name, ingredients: [], type: "shapeless" };
    while (peek().type !== "RBrace" && peek().type !== "EOF") {
      const t = expect("Identifier");
      const low = t.value!.toLowerCase();
      if (low === "type") { const v = expect("Identifier").value!; decl.type = v.toLowerCase() === "shapeless" ? "shapeless" : "shapeless"; match("Semicolon"); continue; }
      if (low === "ingredient") { const id = expect("Identifier").value!; decl.ingredients.push(id); match("Semicolon"); continue; }
      if (low === "result") {
        const id = expect("Identifier").value!;
        let count: number | undefined;
        if (peek().type === "Number") { count = Number(expect("Number").value!); }
        decl.result = { id, count }; match("Semicolon"); continue;
      }
      diags.push({ severity: "Warning", message: `Unknown recipe property '${t.value}'`, line: t.line, col: t.col });
      while (peek().type !== "Semicolon" && peek().type !== "RBrace" && peek().type !== "EOF") pos++;
      match("Semicolon");
    }
    expect("RBrace");
    return decl;
  }

  function parseAssignOrCallOrSayRun(): Stmt | null {
    const t = expect("Identifier"); const low = t.value!.toLowerCase();
    if (low === "run") { expect("LParen"); const expr = parseExpr(); expect("RParen"); match("Semicolon"); return { kind: "Run", expr }; }
    if (low === "say") { expect("LParen"); const expr = parseExpr(); expect("RParen"); match("Semicolon"); return { kind: "Say", expr }; }

    if (low === "global") {
      const nxt = peek();
      if (nxt.type === "Identifier" && (nxt.value === "var" || nxt.value === "let")) {
        pos++; const d = parseVarDecl(true); return d;
      }
      diags.push({ severity: "Error", message: `Expected 'var' after 'global'`, line: t.line, col: t.col });
      return null;
    }

    if (low === "var" || low === "let") {
      const d = parseVarDecl(false);
      diags.push({ severity: "Warning", message: `Local 'var' ignored outside for-loops. Use global var at pack scope.`, line: t.line, col: t.col });
      return d;
    }

    // assignment? name (=, +=, -=, *=, /=, %=, ++, --)
    const nameTok = t;
    if (peek().type === "PlusPlus" || peek().type === "MinusMinus" ||
        peek().type === "Equals" || peek().type === "PlusEquals" || peek().type === "MinusEquals" || peek().type === "StarEquals" || peek().type === "SlashEquals" || peek().type === "PercentEquals") {
      return parseAssignAfterName(nameTok);
    }

    // Calls: Pack.Func() or Func()
    if (match("Dot")) {
      const funcName = expect("Identifier").value!; expect("LParen"); expect("RParen"); match("Semicolon");
      return { kind: "Call", targetPack: nameTok.value!, func: funcName, line: t.line, col: t.col };
    } else {
      if (!match("LParen")) { diags.push({ severity: "Error", message: `Unknown statement '${nameTok.value}'`, line: t.line, col: t.col }); return null; }
      expect("RParen"); match("Semicolon");
      return { kind: "Call", func: nameTok.value!, line: t.line, col: t.col };
    }
  }

  function parseStmt(): Stmt | null {
    const t = peek();
    if (t.type === "Identifier") {
      const low = t.value!.toLowerCase();
      if (low === "execute") return parseExecute();
      if (low === "if" || low === "unless") return parseIfUnless();
      if (low === "for") return parseFor();
      // adv/recipe are pack-scope only; here only inside funcs.
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

    const globals: VarDeclStmt[] = []; const funcs: FuncDecl[] = []; const advs: AdvDecl[] = []; const recipes: RecipeDecl[] = [];
    while (peek().type !== "RBrace" && peek().type !== "EOF") {
      const t = peek();
      if (t.type === "Identifier") {
        const low = t.value!.toLowerCase();
        if (low === "global") { pos++; const decl = parseVarDecl(true); globals.push(decl); continue; }
        if (low === "var" || low === "let") { const decl = parseVarDecl(true); globals.push(decl); continue; }
        if (low === "func") { funcs.push(parseFunc()); continue; }
        if (low === "adv") { advs.push(parseAdv()); continue; }
        if (low === "recipe") { recipes.push(parseRecipe()); continue; }
      }
      diags.push({ severity: "Error", message: `Unexpected token '${t.value ?? t.type}' in pack`, line: t.line, col: t.col });
      while (peek().type !== "RBrace" && peek().type !== "EOF") pos++;
    }

    expect("RBrace");
    return { packTitle: nameTok.value!, namespace: nsLower, namespaceOriginal: nsOriginal, globals, functions: funcs, advs, recipes };
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

function scoreName(ns: string, varName: string) { return `_${ns}.${varName}`; }
function localScoreName(fn: string, idx: number, name: string) { return `__${fn}_for${idx}_${name}`; }
function tmpScoreName(idx: number) { return `__tmp${idx}`; }

function inferType(expr: Expr, envTypes: Record<string, VarKind | undefined>): VarKind | undefined {
  switch (expr.kind) {
    case "MacroString": return "string";
    case "String": return "string";
    case "Number": return "number";
    case "Var": return envTypes[expr.name];
    case "Binary": {
      const l = inferType(expr.left, envTypes), r = inferType(expr.right, envTypes);
      if (expr.op === "+") {
        if (l === "string" || r === "string") return "string";
        if (l === "number" && r === "number") return "number";
      } else if (l === "number" && r === "number") return "number";
      return undefined;
    }
  }
}

function isStaticString(expr: Expr, envTypes: Record<string, VarKind | undefined>): boolean {
  switch (expr.kind) {
    case "String": return true;
    case "Number": return true;
    case "MacroString": return false;
    case "Var": return false;
    case "Binary": return expr.op === "+" && isStaticString(expr.left, envTypes) && isStaticString(expr.right, envTypes);
  }
}
function evalStaticString(expr: Expr): string | undefined {
  switch (expr.kind) {
    case "String": return expr.value;
    case "Number": return String(expr.value);
    case "Binary": {
      if (expr.op !== "+") return undefined;
      const l = evalStaticString(expr.left), r = evalStaticString(expr.right);
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

// compile numeric expressions into scoreboard temps
function compileNumericExpr(
  expr: Expr,
  emit: (cmd: string) => void,
  tmpCounter: { n: number },
  resolveVarScore: (name: string) => string
): string {
  const res = tmpScoreName(tmpCounter.n++);

  function emitTo(target: string, e: Expr): void {
    switch (e.kind) {
      case "Number":
        emit(`scoreboard players set ${target} vars ${Math.trunc(e.value)}`);
        return;
      case "Var": {
        emit(`scoreboard players operation ${target} vars = ${resolveVarScore(e.name)} vars`);
        return;
      }
      case "Binary": {
        const L = tmpScoreName(tmpCounter.n++), R = tmpScoreName(tmpCounter.n++);
        emitTo(L, e.left); emitTo(R, e.right);
        const map: Record<string, string> = { "+": "+=", "-": "-=", "*": "*=", "/": "/=", "%": "%=" };
        emit(`scoreboard players operation ${L} vars ${map[e.op]} ${R} vars`);
        emit(`scoreboard players operation ${target} vars = ${L} vars`);
        return;
      }
      case "String":
      case "MacroString":
        emit(`scoreboard players set ${target} vars 0`);
        return;
    }
  }

  emitTo(res, expr);
  return res;
}

function exprToTellrawComponents(
  expr: Expr,
  ns: string,
  types: Record<string, VarKind>,
  resolveVarScore: (name: string) => string
): { comps: any[], ok: boolean } {
  const parts: any[] = [];
  let ok = true;

  function pushExpr(e: Expr) {
    switch (e.kind) {
      case "String": parts.push({ text: e.value }); return;
      case "Number": parts.push({ text: String(e.value) }); return;
      case "MacroString":
        parts.push({ text: e.raw }); return;
      case "Var": {
        const t = types[e.name];
        if (!t) { parts.push({ text: `<${e.name}>` }); ok = false; return; }
        if (t === "string") parts.push({ nbt: e.name, storage: `${ns}:variables` });
        else parts.push({ score: { name: resolveVarScore(e.name), objective: "vars" } });
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

function generate(ast: Script): { files: GeneratedFile[]; diagnostics: Diagnostic[]; symbolIndex: SymbolIndex } {
  const diagnostics: Diagnostic[] = [];
  const files: GeneratedFile[] = [];

  const description = ast.packs[0]?.packTitle ?? "Datapack";
  files.push({ path: `pack.mcmeta`, contents: JSON.stringify({ pack: { pack_format: PACK_FORMAT, description } }, null, 2) + "\n" });

  // one global setup to create the objective once
  files.push({ path: `data/__core__/function/__setup.mcfunction`, contents: `scoreboard objectives add vars dummy\n` });

  const symbolIndex: SymbolIndex = { packs: {} };
  for (const p of ast.packs) {
    symbolIndex.packs[p.namespace] = { title: p.packTitle, vars: new Set(p.globals.map(g => g.name)), funcs: new Set(p.functions.map(f => f.name)) };
  }

  // Build per-pack global types
  const packVarTypes: Record<string, Record<string, VarKind>> = {};
  for (const p of ast.packs) {
    const types: Record<string, VarKind> = {};
    for (const g of p.globals) {
      const t = inferType(g.init, types);
      if (!t) diagnostics.push({ severity: "Error", message: `Cannot infer type of global '${g.name}'`, line: g.line, col: g.col });
      else types[g.name] = t;
    }
    packVarTypes[p.namespace] = types;
  }

  // Per-pack bootstrap & init
  for (const p of ast.packs) {
    // bootstrap marker only
    const boot = [`execute unless data storage ${p.namespace}:system bootstrap run function ${p.namespace}:__setup`];
    files.push({ path: `data/${p.namespace}/function/__bootstrap.mcfunction`, contents: boot.join("\n") + "\n" });
    const setup = [`data modify storage ${p.namespace}:system bootstrap set value 1b`];
    files.push({ path: `data/${p.namespace}/function/__setup.mcfunction`, contents: setup.join("\n") + "\n" });

    // init globals
    const types = packVarTypes[p.namespace];
    const init: string[] = [];
    for (const g of p.globals) {
      const t = types[g.name];
      if (!t) continue;
      if (t === "string") {
        if (isStaticString(g.init, types)) {
          init.push(`data modify storage ${p.namespace}:variables ${g.name} set value ${JSON.stringify(evalStaticString(g.init)!)}`);
        } else {
          diagnostics.push({ severity: "Warning", message: `String init for '${g.name}' must be a static literal/concat; skipped`, line: g.line, col: g.col });
        }
      } else {
        // number
        let tmpIdx = { n: 0 };
        const tmpLines: string[] = [];
        const tmp = compileNumericExpr(g.init, (c) => tmpLines.push(c), tmpIdx, (n) => scoreName(p.namespace, n));
        tmpLines.push(`scoreboard players operation ${scoreName(p.namespace, g.name)} vars = ${tmp} vars`);
        init.push(...tmpLines);
      }
    }
    files.push({ path: `data/${p.namespace}/function/__init.mcfunction`, contents: init.join("\n") + (init.length ? "\n" : "") });

    // --- Functions ---
    let forCounter = 0;
    for (const fn of p.functions) {
      const out: string[] = [];

      const withChainTo = (arr: string[], chain: string, cmd: string) => {
        arr.push(chain ? `execute ${chain} run ${cmd}` : cmd);
      };
      const makePrefTo = (chain: string) => (cmd: string) => (chain ? `execute ${chain} run ${cmd}` : cmd);

      const emitAssign = (assign: AssignStmt, chain: string, localScores: Record<string, string> | null, envTypes: Record<string, VarKind>, sink: string[]) => {
        const resolveVar = (name: string) => localScores && name in localScores ? localScores[name] : scoreName(p.namespace, name);
        const vk = envTypes[assign.name] || (localScores && assign.name in localScores ? "number" : undefined);
        if (!vk) { diagnostics.push({ severity: "Error", message: `Unknown variable '${assign.name}'`, line: assign.line, col: assign.col }); return; }
        if (vk === "string") {
          if (assign.op !== "=") { diagnostics.push({ severity: "Error", message: `Only '=' supported for string variables`, line: assign.line, col: assign.col }); return; }
          if (isStaticString(assign.expr, envTypes)) withChainTo(sink, chain, `data modify storage ${p.namespace}:variables ${assign.name} set value ${JSON.stringify(evalStaticString(assign.expr)!)}`);
          else diagnostics.push({ severity: "Error", message: `Dynamic string assignment not supported`, line: assign.line, col: assign.col });
          return;
        }
        // number
        const tmpIdx = { n: 0 };
        const tmpLines: string[] = [];
        const tmp = compileNumericExpr(assign.expr, (c) => tmpLines.push(makePrefTo(chain)(c)), tmpIdx, resolveVar);
        const target = `${resolveVar(assign.name)} vars`;
        const opMap: Record<AssignStmt["op"], string> = { "=": "=", "+=": "+=", "-=": "-=", "*=": "*=", "/=": "/=", "%=": "%=" };
        sink.push(...tmpLines);
        withChainTo(sink, chain, `scoreboard players operation ${target} ${opMap[assign.op]} ${tmp} vars`);
      };

      const emitSay = (expr: Expr, chain: string, localScores: Record<string, string> | null, envTypes: Record<string, VarKind>, sink: string[]) => {
        // Macro-string fast path: Say($"Hello {i}") -> $say Hello $(i)  (or $execute ... run say ...)
        if (expr.kind === "MacroString") {
          const text = expr.raw.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name) => `$(${name})`);
          if (chain && chain.trim().length) {
            sink.push(`$execute ${chain} run say ${text}`);
          } else {
            sink.push(`$say ${text}`);
          }
          return;
        }

        const types: Record<string, VarKind> = { ...envTypes };
        if (localScores) for (const k of Object.keys(localScores)) types[k] = "number";
        const resolveVar = (name: string) => localScores && name in localScores ? localScores[name] : scoreName(p.namespace, name);

        const t = inferType(expr, types);
        if (t === "number" && expr.kind !== "Var" && expr.kind !== "Number") {
          const tmpIdx = { n: 0 };
          const tmpLines: string[] = [];
          const tmp = compileNumericExpr(expr, (c) => tmpLines.push(makePrefTo(chain)(c)), tmpIdx, resolveVar);
          sink.push(...tmpLines);
          withChainTo(sink, chain, `tellraw @a {"score":{"name":"${tmp}","objective":"vars"}}`);
          return;
        }
        const { comps, ok } = exprToTellrawComponents(expr, p.namespace, types, resolveVar);
        if (ok && comps.length === 1 && "text" in comps[0]) withChainTo(sink, chain, `say ${JSON.stringify(comps[0].text)}`);
        else if (ok) withChainTo(sink, chain, `tellraw @a ${JSON.stringify(comps)}`);
        else diagnostics.push({ severity: "Error", message: `Say(...) supports literals, +, and simple vars.`, line: (expr as any).line ?? 0, col: (expr as any).col ?? 0 });
      };

      const condToExecuteSuffix = (
        cond: Condition | null | undefined,
        chain: string,
        localScores: Record<string, string> | null
      ): { lines: string[], suffix: string } => {
        const lines: string[] = [];
        if (!cond) return { lines, suffix: "" };
        if (cond.kind === "Raw") return { lines, suffix: `if ${cond.raw}` };
        // numeric compare
        const resolveVar = (name: string) => localScores && name in localScores ? localScores[name] : scoreName(p.namespace, name);
        const tmpIdx = { n: 0 };
        const l = compileNumericExpr(cond.left, (c) => lines.push(makePrefTo(chain)(c)), tmpIdx, resolveVar);
        const r = compileNumericExpr(cond.right, (c) => lines.push(makePrefTo(chain)(c)), tmpIdx, resolveVar);
        const map: Record<CmpOp, string> = { "==": "=", "!=": "!=", "<": "<", "<=": "<=", ">": ">", ">=": ">=" };
        return { lines, suffix: `if score ${l} vars ${map[cond.op]} ${r} vars` };
      };

      const condToExecuteSuffixWithNegate = (
        cond: Condition | null | undefined,
        chain: string,
        localScores: Record<string, string> | null,
        negate: boolean
      ): { lines: string[], suffix: string } => {
        const r = condToExecuteSuffix(cond, chain, localScores);
        if (!r.suffix) return r;
        return { lines: r.lines, suffix: (negate ? r.suffix.replace(/^if /, "unless ") : r.suffix) };
      };

      const emitExecute = (stmt: ExecuteStmt, chain: string, localScores: Record<string, string> | null, envTypes: Record<string, VarKind>, sink: string[]) => {
        if (!stmt.variants.length) { for (const s of stmt.body) emitStmt(s, chain, localScores, envTypes, sink); return; }
        for (const v of stmt.variants) {
          const parts: string[] = [];
          for (const m of v.mods) {
            if (m.kind === "as") parts.push(`as ${m.arg}`);
            else if (m.kind === "at") parts.push(`at ${m.arg}`);
            else if (m.kind === "positioned") parts.push(`positioned ${m.x} ${m.y} ${m.z}`);
          }
          const next = [chain, parts.join(" ")].filter(Boolean).join(" ");
          for (const s of stmt.body) emitStmt(s, next, localScores, envTypes, sink);
        }
      };

      const emitFor = (stmt: ForStmt, chain: string, envTypes: Record<string, VarKind>, sink: string[]) => {
        const loopId = forCounter++;
        const entryName = `__for_${fn.name}_${loopId}`;
        const stepName  = `__for_${fn.name}_${loopId}__step`;

        const localScores: Record<string, string> = {};
        const localTypes: Record<string, VarKind> = { ...envTypes };

        // init
        if (stmt.init && "kind" in stmt.init) {
          if ((stmt.init as any).kind === "VarDecl" && !(stmt.init as VarDeclStmt).isGlobal) {
            const d = stmt.init as VarDeclStmt;
            localScores[d.name] = localScoreName(fn.name, loopId, d.name);
            localTypes[d.name] = "number";
            const tmpIdx = { n: 0 };
            const tmpLines: string[] = [];
            const tmp = compileNumericExpr(d.init, (c) => tmpLines.push(makePrefTo(chain)(c)), tmpIdx, (n) => localScores[n] ?? scoreName(p.namespace, n));
            sink.push(...tmpLines);
            withChainTo(sink, chain, `scoreboard players operation ${localScores[d.name]} vars = ${tmp} vars`);
          } else if ((stmt.init as any).kind === "Assign") {
            emitAssign(stmt.init as AssignStmt, chain, localScores, localTypes, sink);
          }
        }

        // entry: condition (if provided) -> step
        const entryLines: string[] = [];
        const prefix = (cmd: string) => (chain ? `execute ${chain} run ${cmd}` : cmd);
        const { lines: condLines, suffix } = condToExecuteSuffix(stmt.cond ?? null, chain, localScores);
        entryLines.push(...condLines.map(prefix));
        if (suffix) entryLines.push(prefix(`execute ${suffix} run function ${p.namespace}:${stepName}`));
        else entryLines.push(prefix(`function ${p.namespace}:${stepName}`));

        // step: body + incr + recurse (entry)
        const stepLines: string[] = [];
        for (const s of stmt.body) emitStmt(s, chain, localScores, localTypes, stepLines);
        if (stmt.incr) emitAssign(stmt.incr, chain, localScores, localTypes, stepLines);
        stepLines.push(prefix(`function ${p.namespace}:${entryName}`));

        files.push(
          { path: `data/${p.namespace}/function/${entryName}.mcfunction`, contents: entryLines.join("\n") + "\n" },
          { path: `data/${p.namespace}/function/${stepName}.mcfunction`,  contents: stepLines.join("\n") + "\n" }
        );

        // kick off
        withChainTo(sink, chain, `function ${p.namespace}:${entryName}`);
      };

      function emitStmt(st: Stmt, chain: string, localScores: Record<string, string> | null, envTypes: Record<string, VarKind>, sink: string[]) {
        switch (st.kind) {
          case "VarDecl":
            if (st.isGlobal) { diagnostics.push({ severity: "Warning", message: `global var must be declared at pack scope`, line: st.line, col: st.col }); }
            else { diagnostics.push({ severity: "Warning", message: `Local 'var' outside for-init is ignored`, line: st.line, col: st.col }); }
            return;

          case "Assign":
            emitAssign(st, chain, localScores, envTypes, sink);
            return;

          case "Run":
            if (!isStaticString(st.expr, envTypes)) { diagnostics.push({ severity: "Error", message: `Run(...) must be a static string`, line: (st.expr as any).line ?? 0, col: (st.expr as any).col ?? 0 }); return; }
            withChainTo(sink, chain, evalStaticString(st.expr)!);
            return;

          case "Say":
            emitSay(st.expr, chain, localScores, envTypes, sink);
            return;

          case "Call": {
            const targetNs = st.targetPack ? st.targetPack.toLowerCase() : p.namespace;
            withChainTo(sink, chain, `function ${targetNs}:${st.func.toLowerCase()}`);
            return;
          }

          case "If": {
            const { lines, suffix } = condToExecuteSuffixWithNegate(st.cond ?? null, chain, localScores, st.negated);
            sink.push(...lines);
            for (const inner of st.body) emitStmt(inner, [chain, suffix].filter(Boolean).join(" "), localScores, envTypes, sink);
            return;
          }

          case "Execute":
            emitExecute(st, chain, localScores, envTypes, sink);
            return;

          case "For":
            emitFor(st, chain, envTypes, sink);
            return;
        }
      }

      // emit body into `out`
      for (const st of fn.body) emitStmt(st, "", null, packVarTypes[p.namespace], out);

      files.push({ path: `data/${p.namespace}/function/${fn.name}.mcfunction`, contents: out.join("\n") + (out.length ? "\n" : "") });
    }

    // Advancements
    for (const a of p.advs) {
      const n = a.name.toLowerCase();
      const crit = a.props.criteria.length ? a.props.criteria : [{ name: "auto", trigger: "minecraft:impossible" }];
      const criteria = Object.fromEntries(crit.map(c => [c.name, { trigger: c.trigger }]));
      const display: any = {};
      if (a.props.title) display.title = a.props.title;
      if (a.props.description) display.description = a.props.description;
      if (a.props.icon) display.icon = { item: a.props.icon };
      const advJson: any = { criteria };
      if (a.props.parent) advJson.parent = a.props.parent;
      if (Object.keys(display).length) advJson.display = display;
      files.push({ path: `data/${p.namespace}/advancements/${n}.json`, contents: JSON.stringify(advJson, null, 2) + "\n" });
    }

    // Recipes (shapeless only)
    for (const r of p.recipes) {
      const n = r.name.toLowerCase();
      const type = r.type === "shapeless" ? "minecraft:crafting_shapeless" : "minecraft:crafting_shapeless";
      const ingredients = r.ingredients.map(id => ({ item: id }));
      const result = r.result ?? { id: "minecraft:stone", count: 1 };
      const json = {
        type,
        ingredients,
        result: { id: result.id, count: result.count ?? 1 }
      };
      files.push({ path: `data/${p.namespace}/recipes/${n}.json`, contents: JSON.stringify(json, null, 2) + "\n" });
    }
  }

  // Tags (singular "function")
  const loadValues: string[] = [`__core__:__setup`];
  const tickValues: string[] = [];
  for (const p of ast.packs) {
    loadValues.push(`${p.namespace}:__bootstrap`, `${p.namespace}:__init`);
    for (const f of p.functions) {
      if (f.name.toLowerCase() === "load") loadValues.push(`${p.namespace}:${f.name}`);
      if (f.name.toLowerCase() === "tick") tickValues.push(`${p.namespace}:${f.name}`);
    }
  }
  if (loadValues.length) files.push({ path: `data/minecraft/tags/function/load.json`, contents: JSON.stringify({ values: loadValues }, null, 2) + "\n" });
  if (tickValues.length) files.push({ path: `data/minecraft/tags/function/tick.json`, contents: JSON.stringify({ values: tickValues }, null, 2) + "\n" });

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
            // try to color macro strings as strings
            [/\$\"[^\"]*\"/, "string"],
            [/pack|namespace|func|global|var|let|Say|say|Execute|execute|if|unless|Run|run|for|adv|recipe|criterion|title|description|desc|icon|parent|type|ingredient|result/, "keyword"],
            [/\d+/, "number"],
            [/\"[^\"]*\"/, "string"],
            [/[a-zA-Z_@~^\[\]:.][a-zA-Z0-9_@~^\[\]:.]*/, "identifier"],
            [/[{()}.;,|]/, "delimiter"],
            [/(==|!=|<=|>=|[+\-*/%]=|[+\-*/%]|[<>]|(\+\+|--))/, "operator"],
          ],
        },
      });
    }

    const disp = monaco.languages.registerCompletionItemProvider(id, {
      triggerCharacters: [".", " ", "\"", "(", ")", "+", "-", "*", "/", "%", "|", "="],
      provideCompletionItems: (model: any, position: any) => {
        const suggestions: any[] = [];

        const kw = ["pack", "namespace", "func", "global", "var", "let", "Say", "Execute", "if", "unless", "Run", "for", "adv", "recipe"];
        for (const k of kw) suggestions.push({ label: k, kind: monaco.languages.CompletionItemKind.Keyword, insertText: k });

        // snippets
        suggestions.push({
          label: "for loop (local)",
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: `for (var i = 0 | i < 10 | i++){\n    Say("i=" + i)\n}\n`,
          detail: "Local numeric loop"
        });
        suggestions.push({
          label: "for loop (global)",
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: `for (num | num < 10 | num++){\n    Say("num=" + num)\n}\n`,
          detail: "Loop over a global number"
        });
        suggestions.push({
          label: "macro say",
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: `Say($\"Hello {i}\")`,
          detail: "Macro-interpolated Say"
        });
        suggestions.push({
          label: "adv block",
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: `adv MyAdv(){\n    title "My Advancement";\n    description "Do the thing";\n    icon minecraft:stone;\n    // criterion name "minecraft:impossible"\n}\n`,
          detail: "Advancement skeleton"
        });
        suggestions.push({
          label: "recipe block (shapeless)",
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: `recipe MyRecipe{\n    type shapeless;\n    ingredient minecraft:stick;\n    ingredient minecraft:planks;\n    result minecraft:torch 4;\n}\n`,
          detail: "Recipe skeleton"
        });

        // packs & symbols
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
    for (var i = 0 | i < 10 | i++){
      Say(i)
      Say($\"i is {i}\")
      Say("literal {i} (no macro)")
    }
  }

  func Tick(){
  }
}
`;

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
  }, [debouncedSource, selectedPath]);

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
    <div className="min-h-screen bg-gradient-to-b from-white to -slate-50 text-black">
      <div className="mx-auto max-w-7xl p-6">
        <header className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-xl bg-black/90 text-white grid place-items-center font-bold">DP</div>
            <div>
              <h1 className="text-xl font-bold">Datapack Web Compiler</h1>
              <p className="text-xs text-black/60">Globals • Execute • for-loops • Macros in strings • Adv/Recipes • IntelliSense • Zip export</p>
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
              <Editor height="560px" language="datapackdsl" value={source} onChange={(v) => setSource(v ?? "")}
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
              <div className="border rounded-xl p-3 border-black/10 h-[240px]">
                <FileList files={compiled.files} selected={selectedPath} onSelect={setSelectedPath} />
              </div>
              <div className="border rounded-xl p-3 border-black/10 h-[300px] overflow-auto bg-white">
                {selectedFile ? (
                  <pre className="font-mono text-sm whitespace-pre-wrap break-words">{selectedFile.contents}</pre>
                ) : (
                  <div className="text-sm text-black/60">No file selected.</div>
                )}
              </div>
            </div>

            <div className="text-xs text-black/60 mt-2 space-y-1">
              <p><b>for:</b> <code>for (var i = 0 | i &lt; 10 | i++)</code> or <code>for (num | num &lt; 10 | num++)</code></p>
              <p><b>macro strings:</b> <code>Say($\"Hello {`{`}i{`}`}\")</code> ⇒ <code>$say Hello $(i)</code> (literal <code>Say("Hello {`{`}i{`}`}")</code> is not a macro)</p>
              <p><b>if:</b> <code>if(num == 1)</code> or raw <code>if("entity @s")</code></p>
              <p><b>adv:</b> <code>adv Name() {'{'} title "X"; icon minecraft:stone; criterion got "minecraft:impossible"; {'}'}</code> (pack scope)</p>
              <p><b>recipe:</b> <code>recipe Name {'{'} type shapeless; ingredient minecraft:stick; result minecraft:torch 4; {'}'}</code> (pack scope)</p>
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
