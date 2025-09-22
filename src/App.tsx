import { useEffect, useMemo, useRef, useState } from "react";
import "./monaco-setup";
import JSZip from "jszip";
import Editor, { useMonaco } from "@monaco-editor/react";
import "./basic-dark.css";

/**
 * Datapack Web Compiler
 * - for-loops, if/else-if/else, && / ||
 * - Execute blocks, Say/Run (with macro strings $"...")
 * - Globals (strings -> storage <ns>:variables, numbers -> scoreboard "vars")
 * - Items + give alias: give.<item>()
 * - Advancements & Recipes (shaped + shapeless) with custom-item result resolution
 * - Tags: BlockTag, ItemTag (replace, values:[...])
 * - VS Code-ish dark UI + IntelliSense + Zip export
 */

// ---------- Types ----------
type TokenType =
  | "Identifier" | "String" | "Number"
  | "LBrace" | "RBrace" | "LParen" | "RParen"
  | "LBracket" | "RBracket" | "Colon"
  | "Semicolon" | "Comma" | "Dot" | "Pipe"
  | "Plus" | "Minus" | "Star" | "Slash" | "Percent"
  | "PlusEquals" | "MinusEquals" | "StarEquals" | "SlashEquals" | "PercentEquals"
  | "PlusPlus" | "MinusMinus"
  | "Equals" | "EqEq" | "BangEq" | "Lt" | "Le" | "Gt" | "Ge"
  | "AndAnd" | "OrOr"
  | "EOF";

type Token = { type: TokenType; value?: string; line: number; col: number };
type Diagnostic = { severity: "Error" | "Warning" | "Info"; message: string; line: number; col: number };

// Expressions
type StringExpr = { kind: "String"; value: string; line: number; col: number };
type NumberExpr = { kind: "Number"; value: number; line: number; col: number };
type VarExpr   = { kind: "Var"; name: string; line: number; col: number };
type BinaryExpr= { kind: "Binary"; op: "+" | "-" | "*" | "/" | "%"; left: Expr; right: Expr; line: number; col: number };
type Expr = StringExpr | NumberExpr | VarExpr | BinaryExpr;

// Conditions
type CmpOp = "==" | "!=" | "<" | "<=" | ">" | ">=";
type RawCond = { kind: "Raw"; raw: string; line: number; col: number };
type CmpCond = { kind: "Cmp"; op: CmpOp; left: Expr; right: Expr; line: number; col: number };
type BoolCond= { kind: "Bool"; op: "&&" | "||"; left: Condition; right: Condition; line: number; col: number };
type Condition = RawCond | CmpCond | BoolCond;

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
type ElseBlock = { kind: "Else"; body: Stmt[]; line: number; col: number };
type IfBlock = {
  kind: "If";
  negated: boolean;
  cond?: Condition | null;
  body: Stmt[];
  elseBranch?: IfBlock | ElseBlock | null;
  line: number; col: number;
};
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

// Adv / Recipe
type AdvDecl = {
  kind: "Adv";
  name: string;
  props: { title?: string; description?: string; icon?: string; parent?: string; criteria: Array<{ name: string; trigger: string }> };
};

type RecipeDecl = {
  kind: "Recipe";
  name: string;
  type?: "shapeless" | "shaped";
  // shapeless:
  ingredients: string[];
  // shaped:
  pattern?: string[];            // [" A ", " B ", " C "]
  keys?: Record<string, string>; // { A: "minecraft:stick" }
  // result: vanilla id or custom item alias ns.name
  result?: { id: string; count?: number };
};

// Items
type ItemDecl = {
  kind: "Item";
  name: string;
  baseId: string;
  componentTokens?: Token[];
  line: number; col: number;
};

// Tags
type TagCategory = "blocks" | "items";
type TagDecl = {
  kind: "Tag";
  category: TagCategory;
  name: string;
  replace: boolean;
  values: string[];
  line: number; col: number;
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
  items: ItemDecl[];
  tags: TagDecl[];
};
type Script = { packs: PackDecl[] };

type GeneratedFile = { path: string; contents: string };
type SymbolIndex = { packs: Record<string, { title: string; vars: Set<string>; funcs: Set<string>; items: Set<string> }> };

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

    // macro-strings: $"..."
    if (ch === "$" && peek(1) === "\"") {
      const L = line, C = col;
      adv(1); // skip $
      let j = i + 1; let text = "";
      while (j < input.length) {
        const c = input[j];
        if (c === "\\") {
          const n = input[j + 1];
          if (n === "\"" || n === "\\" || n === "n" || n === "t") { text += n === "n" ? "\n" : n === "t" ? "\t" : n; j += 2; continue; }
        }
        if (c === "\"") { j++; break; }
        text += c; j++;
      }
      push({ type: "String", value: "$" + text, line: L, col: C });
      col += (j - i); i = j; continue;
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
    if (ch === "|" && peek(1) === "|") { push({ type: "OrOr", line, col }); adv(2); continue; }
    if (ch === "&" && peek(1) === "&") { push({ type: "AndAnd", line, col }); adv(2); continue; }

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
      "[": "LBracket", "]": "RBracket", ":": "Colon",
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
    if (t.type === "String") { pos++; return { kind: "String", value: t.value!, line: t.line, col: t.col }; }
    if (t.type === "Number") { pos++; return { kind: "Number", value: Number(t.value!), line: t.line, col: t.col }; }
    if (t.type === "Identifier") { pos++; return { kind: "Var", name: t.value!, line: t.line, col: t.col }; }
    if (t.type === "LParen") { pos++; const e = parseExpr(); expect("RParen", "')'"); return e; }
    throw { message: `Unexpected token in expression: ${t.value ?? t.type}`, line: t.line, col: t.col };
  }
  function parseUnary(): Expr {
    if (match("Minus")) {
      const e = parseUnary();
      return { kind: "Binary", op: "-", left: { kind: "Number", value: 0, line: e.line, col: e.col }, right: e, line: e.line, col: e.col };
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

  // Conditions with precedence: && over ||, both above comparisons
  function parseCondCmp(): Condition | null {
    const t = peek();
    if (t.type === "String") { pos++; return { kind: "Raw", raw: t.value!, line: t.line, col: t.col }; }
    const left = parseExpr();
    const opTok = peek();
    const map: Record<TokenType, CmpOp> = { EqEq: "==", BangEq: "!=", Lt: "<", Le: "<=", Gt: ">", Ge: ">=" } as any;
    if (!(opTok.type in map)) {
      diags.push({ severity: "Error", message: "Expected comparison operator (==, !=, <, <=, >, >=)", line: opTok.line, col: opTok.col });
      return null;
    }
    pos++;
    const right = parseExpr();
    return { kind: "Cmp", op: map[opTok.type], left, right, line: opTok.line, col: opTok.col };
  }
  function parseCondAnd(): Condition | null {
    let left = parseCondCmp();
    while (peek().type === "AndAnd") {
      const t = expect("AndAnd");
      const right = parseCondCmp();
      if (!left || !right) return left ?? right;
      left = { kind: "Bool", op: "&&", left, right, line: t.line, col: t.col };
    }
    return left;
  }
  function parseCondition(): Condition | null {
    let left = parseCondAnd();
    while (peek().type === "OrOr") {
      const t = expect("OrOr");
      const right = parseCondAnd();
      if (!left || !right) return left ?? right;
      left = { kind: "Bool", op: "||", left, right, line: t.line, col: t.col };
    }
    return left;
  }

  function parseVarDecl(isGlobalForced = false): VarDeclStmt {
    const first = expect("Identifier");
    const low = (first.value ?? "").toLowerCase();
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
    const kw = expect("Identifier");
    const low = (kw.value ?? "").toLowerCase();
    const neg = (low === "unless");
    if (!neg && low !== "if") throw { message: "Expected 'if' or 'unless'", line: kw.line, col: kw.col };

    expect("LParen");
    let cond: Condition | null = null;
    if (peek().type !== "RParen") cond = parseCondition();
    expect("RParen");

    expect("LBrace");
    const body: Stmt[] = [];
    while (peek().type !== "RBrace" && peek().type !== "EOF") { const s = parseStmt(); if (s) body.push(s); }
    expect("RBrace");

    // Optional else / else if
    let elseBranch: IfBlock | ElseBlock | null = null;
    if (peek().type === "Identifier" && (peek().value?.toLowerCase() === "else")) {
      pos++; // 'else'
      if (peek().type === "Identifier" && (peek().value?.toLowerCase() === "if" || peek().value?.toLowerCase() === "unless")) {
        elseBranch = parseIfUnless(); // else if / else unless
      } else {
        expect("LBrace");
        const eb: Stmt[] = [];
        while (peek().type !== "RBrace" && peek().type !== "EOF") { const s = parseStmt(); if (s) eb.push(s); }
        expect("RBrace");
        elseBranch = { kind: "Else", body: eb, line: kw.line, col: kw.col };
      }
    }

    return { kind: "If", negated: neg, cond, body, elseBranch, line: kw.line, col: kw.col };
  }

  function parseExecute(): ExecuteStmt {
    const kw = expect("Identifier"); if ((kw.value ?? "").toLowerCase() !== "execute") throw { message: `Expected 'Execute'`, line: kw.line, col: kw.col };
    expect("LParen");
    const variants: ExecVariant[] = [];
    let current: ExecVariant = { mods: [] };
    const pushCurrent = () => { if (current.mods.length) { variants.push(current); current = { mods: [] }; } };

    while (peek().type !== "RParen" && peek().type !== "EOF") {
      const t = expect("Identifier");
      const low = (t.value ?? "").toLowerCase();
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
    expect("Identifier"); // for
    expect("LParen");

    // init
    let init: VarDeclStmt | AssignStmt | { kind: "Noop" } | null = null;
    if (peek().type !== "Pipe") {
      const t = peek();
      if (t.type === "Identifier" && ((t.value ?? "").toLowerCase() === "var" || (t.value ?? "").toLowerCase() === "let")) {
        const d = parseVarDecl(false); init = d;
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
    return { kind: "For", init, cond, incr, body, line: 0, col: 0 };
  }

  function parseAdv(): AdvDecl {
    expect("Identifier"); // adv
    const nameTok = expect("Identifier"); const name = nameTok.value!;
    if (match("LParen")) { expect("RParen"); }
    expect("LBrace");
    const props: AdvDecl["props"] = { criteria: [] };
    while (peek().type !== "RBrace" && peek().type !== "EOF") {
      const t = expect("Identifier");
      const low = (t.value ?? "").toLowerCase();
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

  function parseStringArrayInBrackets(expectFn: (t: TokenType, what?: string) => Token, matchFn: (t: TokenType) => Token | null, peekFn: (o?: number) => Token): string[] {
    const rows: string[] = [];
    expectFn("LBracket", "'[' after pattern");
    while (peekFn().type !== "RBracket") {
      const s = expectFn("String", "pattern row as a string");
      rows.push(s.value ?? "");
      matchFn("Comma");
    }
    expectFn("RBracket", "']' to close pattern");
    return rows;
  }

  function parseRecipe(): RecipeDecl {
    expect("Identifier"); // recipe
    const nameTok = expect("Identifier"); const name = nameTok.value!;
    expect("LBrace");

    const decl: RecipeDecl = { kind: "Recipe", name, ingredients: [], type: "shapeless" };

    while (peek().type !== "RBrace" && peek().type !== "EOF") {
      const t = expect("Identifier");
      const low = (t.value ?? "").toLowerCase();

      if (low === "type") {
        const v = expect("Identifier").value!;
        decl.type = v.toLowerCase() === "shaped" ? "shaped" : "shapeless";
        match("Semicolon");
        continue;
      }

      if (low === "ingredient") {
        const idTok = expect("Identifier");
        decl.ingredients.push(idTok.value!);
        match("Semicolon");
        continue;
      }

      if (low === "pattern") {
        const rows = parseStringArrayInBrackets(expect, match, peek);
        match("Semicolon");
        decl.type = "shaped";
        decl.pattern = rows;
        continue;
      }

      if (low === "key") {
        const ch = expect("Identifier", "single pattern letter").value!;
        expect("Equals");
        const idTok = expect("Identifier", "item id");
        const itemId = idTok.value!;
        decl.keys = decl.keys ?? {};
        decl.keys[ch] = itemId;
        match("Semicolon");
        continue;
      }

      if (low === "result") {
        const idTok = expect("Identifier"); // vanilla id OR "ns.item"
        let count: number | undefined;
        if (peek().type === "Number") count = Number(expect("Number").value!);
        decl.result = { id: idTok.value!, count };
        match("Semicolon");
        continue;
      }

      diags.push({ severity: "Warning", message: `Unknown recipe property '${t.value}'`, line: t.line, col: t.col });
      while (peek().type !== "Semicolon" && peek().type !== "RBrace" && peek().type !== "EOF") pos++;
      match("Semicolon");
    }

    expect("RBrace");
    return decl;
  }

  function grabBracketTokenBlock(): Token[] {
    expect("LBracket");
    const collected: Token[] = [];
    let depth = 1;
    while (depth > 0) {
      const t = peek();
      if (t.type === "EOF") throw { message: "Unterminated components [...]", line: t.line, col: t.col };
      pos++;
      if (t.type === "LBracket") { depth++; collected.push(t); continue; }
      if (t.type === "RBracket") { depth--; if (depth === 0) break; collected.push(t); continue; }
      collected.push(t);
    }
    return collected;
  }

  function parseItem(): ItemDecl {
    expect("Identifier"); // Item
    const nameTok = expect("Identifier");
    if (match("LParen")) expect("RParen");
    expect("LBrace");

    let baseId = "minecraft:stone";
    let comps: Token[] | undefined;

    while (peek().type !== "RBrace" && peek().type !== "EOF") {
      const t = expect("Identifier");
      const rawKey = t.value || "";
      const key = rawKey.toLowerCase().replace(/:$/, "");

      if (key === "base_id") {
        if (peek().type === "Equals" || peek().type === "Colon") pos++;
        const v = peek();
        if (v.type === "String" || v.type === "Identifier") {
          pos++;
          baseId = String(v.value ?? "");
        } else {
          throw { message: `base_id must be string or identifier`, line: v.line, col: v.col };
        }
        match("Semicolon");
        continue;
      }

      if (key === "components") {
        if (peek().type === "Colon") pos++;
        comps = grabBracketTokenBlock();
        match("Semicolon");
        continue;
      }

      diags.push({ severity: "Warning", message: `Unknown Item property '${t.value}'`, line: t.line, col: t.col });
      while (peek().type !== "Semicolon" && peek().type !== "RBrace" && peek().type !== "EOF") pos++;
      match("Semicolon");
    }
    expect("RBrace");
    return { kind: "Item", name: nameTok.value!, baseId, componentTokens: comps, line: nameTok.line, col: nameTok.col };
  }

  function parseTag(): TagDecl {
  // Read the keyword: BlockTag / ItemTag / etc.
  const kw = expect("Identifier");
  const raw = (kw.value || "");
  if (!/tag$/i.test(raw)) {
    throw { message: `Expected <Something>Tag (e.g. BlockTag, ItemTag)`, line: kw.line, col: kw.col };
  }

  // Derive the tag category folder ("blocks", "items", ...)
  const base = raw.slice(0, -3).toLowerCase(); // "block", "item", ...
  let category: TagCategory;
  if (base === "block") category = "blocks";
  else if (base === "item") category = "items";
  else category = (base + "s") as TagCategory; // fallback, though we only use blocks/items for now

  const nameTok = expect("Identifier");
  const name = nameTok.value!;

  // Optional () like other decls (ignored)
  if (match("LParen")) expect("RParen");

  expect("LBrace");

  let replace = false;
  let values: string[] = [];

  while (peek().type !== "RBrace" && peek().type !== "EOF") {
    const t = expect("Identifier");
    const rawKey = t.value || "";
    const key = rawKey.toLowerCase().replace(/[:\[]+$/, ""); // normalize "values:[", "values :", etc.

    if (key === "replace") {
      if (peek().type === "Equals" || peek().type === "Colon") pos++; // allow "=" or ":"
      const vTok = expect("Identifier", "true/false");
      replace = (vTok.value || "").toLowerCase() === "true";
      match("Semicolon");
      continue;
    }

    // values: [ "minecraft:stone", "minecraft:air" ];
    if (key === "values") {
      if (peek().type === "Colon") pos++; // optional ":"
      const hadBracketInKey = /[:\[]$/.test(rawKey);
      if (!hadBracketInKey) expect("LBracket");
      const arr: string[] = [];
      while (peek().type !== "RBracket" && peek().type !== "EOF") {
        const s = expect("String", "tag value string");
        arr.push(s.value || "");
        match("Comma"); // optional comma
      }
      expect("RBracket");
      match("Semicolon"); // optional trailing semicolon
      values = arr;
      continue;
    }

    // Unknown property: warn and skip to next ';' or '}'.
    diags.push({
      severity: "Warning",
      message: `Unknown Tag property '${rawKey}'`,
      line: t.line,
      col: t.col,
    });
    while (peek().type !== "Semicolon" && peek().type !== "RBrace" && peek().type !== "EOF") pos++;
    match("Semicolon");
  }

  expect("RBrace");

  return {
    kind: "Tag",
    category,         // <-- matches your TagDecl type
    name,
    replace,
    values,
    line: kw.line,
    col: kw.col,
  };
}



  function parseAssignOrCallOrSayRun(): Stmt | null {
    const t = expect("Identifier"); const low = (t.value ?? "").toLowerCase();
    if (low === "run") { expect("LParen"); const expr = parseExpr(); expect("RParen"); match("Semicolon"); return { kind: "Run", expr }; }
    if (low === "say") { expect("LParen"); const expr = parseExpr(); expect("RParen"); match("Semicolon"); return { kind: "Say", expr }; }

    if (low === "global") {
      const nxt = peek();
      if (nxt.type === "Identifier" && ((nxt.value ?? "").toLowerCase() === "var" || (nxt.value ?? "").toLowerCase() === "let")) {
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

    // not allowed in function scope; recover
    if (low === "adv") { diags.push({ severity: "Error", message: `adv not allowed inside functions`, line: t.line, col: t.col }); parseAdv(); return null; }
    if (low === "recipe") { diags.push({ severity: "Error", message: `recipe not allowed inside functions`, line: t.line, col: t.col }); parseRecipe(); return null; }
    if (low === "item") { diags.push({ severity: "Error", message: `Item not allowed inside functions`, line: t.line, col: t.col }); parseItem(); return null; }
    if (low === "blocktag" || low === "itemtag") {
  diags.push({ severity: "Error", message: `Tag declarations are not allowed inside functions`, line: t.line, col: t.col });
  // Skip the tag block to recover
  // (we already consumed the keyword; skip name, optional (), and the {...} block)
  if (peek().type === "Identifier") pos++;                  // name
  if (match("LParen")) { while (peek().type !== "RParen" && peek().type !== "EOF") pos++; match("RParen"); }
  if (match("LBrace")) { let d = 1; while (d > 0 && peek().type !== "EOF") { const x = peek(); pos++; if (x.type === "LBrace") d++; else if (x.type === "RBrace") d--; } }
  return null;
}


    const nameTok = t;
    if (peek().type === "PlusPlus" || peek().type === "MinusMinus" ||
      peek().type === "Equals" || peek().type === "PlusEquals" || peek().type === "MinusEquals" || peek().type === "StarEquals" || peek().type === "SlashEquals" || peek().type === "PercentEquals") {
      return parseAssignAfterName(nameTok);
    }

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
      const low = (t.value ?? "").toLowerCase();
      if (low === "execute") return parseExecute();
      if (low === "if" || low === "unless") return parseIfUnless();
      if (low === "for") return parseFor();
      if (low === "adv" || low === "recipe" || low === "item" || low === "blocktag" || low === "itemtag") return parseAssignOrCallOrSayRun();
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

    const globals: VarDeclStmt[] = []; const funcs: FuncDecl[] = []; const advs: AdvDecl[] = []; const recipes: RecipeDecl[] = []; const items: ItemDecl[] = []; const tags: TagDecl[] = [];
    while (peek().type !== "RBrace" && peek().type !== "EOF") {
      const t = peek();
      if (t.type === "Identifier") {
        const low = (t.value ?? "").toLowerCase();
        if (low === "global") { pos++; const decl = parseVarDecl(true); globals.push(decl); continue; }
        if (low === "var" || low === "let") { const decl = parseVarDecl(true); globals.push(decl); continue; }
        if (low === "func") { funcs.push(parseFunc()); continue; }
        if (low === "adv") { advs.push(parseAdv()); continue; }
        if (low === "recipe") { recipes.push(parseRecipe()); continue; }
        if (low === "item") { items.push(parseItem()); continue; }
        if (low === "blocktag" || low === "itemtag") { tags.push(parseTag()); continue; }

      }
      diags.push({ severity: "Error", message: `Unexpected token '${t.value ?? t.type}' in pack`, line: t.line, col: t.col });
      while (peek().type !== "RBrace" && peek().type !== "EOF") pos++;
    }

    expect("RBrace");
    return { packTitle: nameTok.value!, namespace: nsLower, namespaceOriginal: nsOriginal, globals, functions: funcs, advs, recipes, items, tags };
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

// ---------- Validation & Helpers ----------
const PACK_FORMAT = 48;

void PACK_FORMAT;

type VarKind = "string" | "number";

function scoreName(ns: string, varName: string) { return `_${ns}.${varName}`; }
function localScoreName(ns: string, fn: string, idx: number, name: string) { void ns; return `__${fn}_for${idx}_${name}`; }
function tmpScoreName(idx: number) { return `__tmp${idx}`; }

function componentTokensToMap(ts?: Token[]): Record<string, any> | undefined {
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

function tokensToText(ts: Token[]): string {
  let out = "";
  for (const t of ts) {
    switch (t.type) {
      case "String": out += JSON.stringify(t.value ?? ""); break;
      case "Identifier":
      case "Number": out += t.value ?? ""; break;
      case "Comma": out += ", "; break;
      case "Colon": out += ":"; break;
      case "Equals": out += "="; break;
      case "LBrace": out += "{"; break;
      case "RBrace": out += "}"; break;
      case "LBracket": out += "["; break;
      case "RBracket": out += "]"; break;
      default: out += "";
    }
  }
  return out;
}

function inferType(expr: Expr, envTypes: Record<string, VarKind | undefined>): VarKind | undefined {
  switch (expr.kind) {
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

function isStaticString(_expr: Expr, envTypes: Record<string, VarKind | undefined>): boolean {
  const expr = _expr as Expr;
  switch (expr.kind) {
    case "String": return true;
    case "Number": return true;
    case "Var": return false;
    case "Binary": return expr.op === "+" && isStaticString(expr.left, envTypes) && isStaticString(expr.right, envTypes);
  }
}
function evalStaticString(expr: Expr): string | undefined {
  switch (expr.kind) {
    case "String": return expr.value.startsWith("$") ? expr.value.slice(1) : expr.value;
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

// compile numeric expressions into scoreboard temps (returns a temp holder name)
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
        emit(`scoreboard players set ${target} vars 0`);
        return;
    }
  }

  emitTo(res, expr);
  return res;
}

function renderMacroTemplate(src: string): { line: string; refs: string[] } {
  const refs: string[] = [];
  const line = src.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, g1) => {
    refs.push(g1);
    return `$(${g1})`;
  });
  return { line, refs: Array.from(new Set(refs)) };
}
function exprIsMacroString(e: Expr): e is StringExpr {
  return e.kind === "String" && e.value.startsWith("$");
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

function validate(ast: Script): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const nsSet = new Set<string>();
  for (const p of ast.packs) {
    if (!/^[a-z0-9_.-]+$/.test(p.namespace)) diags.push({ severity: "Error", message: `Namespace '${p.namespace}' must match [a-z0-9_.-]`, line: 1, col: 1 });
    if (nsSet.has(p.namespace)) diags.push({ severity: "Error", message: `Duplicate namespace '${p.namespace}' across packs`, line: 1, col: 1 });
    nsSet.add(p.namespace);
    for (const f of p.functions) {
      if (!/^[a-z0-9_/.+-]+$/.test(f.name)) diags.push({ severity: "Error", message: `Function '${f.name}' has invalid characters`, line: 1, col: 1 });
    }
  }
  return diags;
}

// ---------- Generation ----------
const PACK_FORMAT_CONST = 48;

function generate(ast: Script): { files: GeneratedFile[]; diagnostics: Diagnostic[]; symbolIndex: SymbolIndex } {
  const diagnostics: Diagnostic[] = [];
  const files: GeneratedFile[] = [];

  const description = ast.packs[0]?.packTitle ?? "Datapack";
  files.push({ path: `pack.mcmeta`, contents: JSON.stringify({ pack: { pack_format: PACK_FORMAT_CONST, description } }, null, 2) + "\n" });

  const symbolIndex: SymbolIndex = { packs: {} };
  for (const p of ast.packs) {
    symbolIndex.packs[p.namespace] = { title: p.packTitle, vars: new Set(p.globals.map(g => g.name)), funcs: new Set(p.functions.map(f => f.name)), items: new Set(p.items.map(i => i.name)) };
  }

  // per-pack global types
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

  // re-usable helpers
  const tokensToPref = (chain: string) => (cmd: string) => (chain ? `execute ${chain} run ${cmd}` : cmd);
  const withChainTo = (sink: string[]) => (chain: string, cmd: string) => sink.push(tokensToPref(chain)(cmd));

  for (const p of ast.packs) {
    // bootstrap
    const boot = [`execute unless data storage ${p.namespace}:system bootstrap run function ${p.namespace}:__setup`];
    files.push({ path: `data/${p.namespace}/function/__bootstrap.mcfunction`, contents: boot.join("\n") + "\n" });
    const setup = [`scoreboard objectives add vars dummy`, `data modify storage ${p.namespace}:system bootstrap set value 1b`];
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
        const tmpLines: string[] = [];
        const tmpState = { n: 0 };
        const tmp = compileNumericExpr(g.init, (c) => tmpLines.push(c), tmpState, (n) => scoreName(p.namespace, n));
        tmpLines.push(`scoreboard players operation ${scoreName(p.namespace, g.name)} vars = ${tmp} vars`);
        init.push(...tmpLines);
      }
    }
    files.push({ path: `data/${p.namespace}/function/__init.mcfunction`, contents: init.join("\n") + (init.length ? "\n" : "") });

    // --- Functions ---
    let forCounter = 0;
    let macroCounter = 0;
    let ifCounter = 0;

    function condToVariants(
      cond: Condition | null | undefined,
      chain: string,
      localScores: Record<string,string> | null,
      envTypes: Record<string, VarKind>,
      outArr: string[],
      tmpState: { n: number },
      negate = false
    ): string[][] {
      const pref = tokensToPref(chain);
      const resolveVar = (name: string) => localScores && name in localScores ? localScores[name] : scoreName(p.namespace, name);
      void envTypes;

      void outArr;

      function leaf(c: CmpCond | RawCond): string[] {
        if ((c as RawCond).kind === "Raw") {
          const cr = c as RawCond;
          return [ `${negate ? "unless" : "if"} ${cr.raw}` ];
        } else {
          const cc = c as CmpCond;
          const L = compileNumericExpr(cc.left,  (c)=>outArr.push(pref(c)), tmpState, resolveVar);
          const R = compileNumericExpr(cc.right, (c)=>outArr.push(pref(c)), tmpState, resolveVar);
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
          } else {
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

    for (const fn of p.functions) {
      const fnOut: string[] = [];
      const tmpState = { n: 0 };

      const emitAssign = (
        assign: AssignStmt,
        chain: string,
        localScores: Record<string, string> | null,
        envTypes: Record<string, VarKind>,
        outArr: string[]
      ) => {

        void outArr;
        
        const withChain = withChainTo(outArr);
        const makePref = tokensToPref(chain);
        const resolveVar = (name: string) => localScores && name in localScores ? localScores[name] : scoreName(p.namespace, name);
        const vk = envTypes[assign.name] || (localScores && assign.name in localScores ? "number" : undefined);
        if (!vk) { diagnostics.push({ severity: "Error", message: `Unknown variable '${assign.name}'`, line: assign.line, col: assign.col }); return; }
        if (vk === "string") {
          if (assign.op !== "=") { diagnostics.push({ severity: "Error", message: `Only '=' supported for string variables`, line: assign.line, col: assign.col }); return; }
          if (isStaticString(assign.expr, envTypes)) withChain(chain, `data modify storage ${p.namespace}:variables ${assign.name} set value ${JSON.stringify(evalStaticString(assign.expr)!)}`);
          else diagnostics.push({ severity: "Error", message: `Dynamic string assignment not supported`, line: assign.line, col: assign.col });
          return;
        }
        const tmpLines: string[] = [];
        const tmp = compileNumericExpr(assign.expr, (c) => tmpLines.push(makePref(c)), tmpState, resolveVar);
        outArr.push(...tmpLines);
        const target = `${resolveVar(assign.name)} vars`;
        const opMap: Record<AssignStmt["op"], string> = { "=": "=", "+=": "+=", "-=": "-=", "*=": "*=", "/=": "/=", "%=": "%=" };
        withChain(chain, `scoreboard players operation ${target} ${opMap[assign.op]} ${tmp} vars`);
      };

      const emitMacroCall = (
        cmdLine: string,
        refs: string[],
        chain: string,
        localScores: Record<string, string> | null,
        envTypes: Record<string, VarKind>,
        outArr: string[]
      ) => {
        const withChain = withChainTo(outArr);
        for (const r of refs) {
          const local = localScores && (r in localScores);
          const globalKind = envTypes[r];
          if (local) {
            withChain(chain, `execute store result storage ${p.namespace}:variables ${r} int 1 run scoreboard players get ${localScores![r]} vars`);
          } else if (globalKind === "number") {
            withChain(chain, `execute store result storage ${p.namespace}:variables ${r} int 1 run scoreboard players get ${scoreName(p.namespace, r)} vars`);
          }
        }
        const macroName = `__macro_${fn.name}_${macroCounter++}`;
        const macroBody = `$${cmdLine}\n`;
        files.push({ path: `data/${p.namespace}/function/${macroName}.mcfunction`, contents: macroBody });
        withChain(chain, `function ${p.namespace}:${macroName} with storage ${p.namespace}:variables`);
      };

      const emitSay = (
        expr: Expr,
        chain: string,
        localScores: Record<string, string> | null,
        envTypes: Record<string, VarKind>,
        outArr: string[]
      ) => {
        const withChain = withChainTo(outArr);
        if (exprIsMacroString(expr)) {
          const raw = expr.value.slice(1);
          const { line, refs } = renderMacroTemplate(`say ${raw}`);
          emitMacroCall(line, refs, chain, localScores, envTypes, outArr);
          return;
        }
        const typesLocal: Record<string, VarKind> = { ...envTypes };
        if (localScores) for (const k of Object.keys(localScores)) typesLocal[k] = "number";
        const resolveVar = (name: string) => localScores && name in localScores ? localScores[name] : scoreName(p.namespace, name);

        const t = inferType(expr, typesLocal);
        if (t === "number" && expr.kind !== "Var" && expr.kind !== "Number") {
          const tmp = compileNumericExpr(expr, (c) => outArr.push(tokensToPref(chain)(c)), { n: tmpState.n++ }, resolveVar);
          withChain(chain, `tellraw @a {"score":{"name":"${tmp}","objective":"vars"}}`);
          return;
        }
        const { comps, ok } = exprToTellrawComponents(expr, p.namespace, typesLocal, resolveVar);
        if (ok && comps.length === 1 && "text" in comps[0]) withChain(chain, `say ${JSON.stringify(comps[0].text)}`);
        else if (ok) withChain(chain, `tellraw @a ${JSON.stringify(comps)}`);
        else diagnostics.push({ severity: "Error", message: `Say(...) supports literals, +, and simple vars.`, line: expr.line, col: expr.col });
      };

      const emitRun = (
        expr: Expr,
        chain: string,
        _localScores: Record<string, string> | null,
        envTypes: Record<string, VarKind>,
        outArr: string[]
      ) => {
        const withChain = withChainTo(outArr);
        if (exprIsMacroString(expr)) {
          const raw = expr.value.slice(1);
          const { line, refs } = renderMacroTemplate(raw);
          emitMacroCall(line, refs, chain, _localScores, envTypes, outArr);
          return;
        }
        if (!isStaticString(expr, envTypes)) { diagnostics.push({ severity: "Error", message: `Run(...) must be a static string or macro string`, line: expr.line, col: expr.col }); return; }
        withChain(chain, evalStaticString(expr)!);
      };

      function emitExecute(
        stmt: ExecuteStmt,
        chain: string,
        localScores: Record<string, string> | null,
        envTypes: Record<string, VarKind>,
        outArr: string[]
      ) {
        void outArr;
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

      function emitIfChain(
        first: IfBlock,
        chain: string,
        localScores: Record<string,string> | null,
        envTypes: Record<string, VarKind>,
        outArr: string[]
      ) {
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

        const flag = `__ifdone_${fn.name}_${ifCounter++}`;
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

      function emitFor(
  stmt: ForStmt,
  chain: string,
  envTypes: Record<string, VarKind>
) {
        const withChainParent = withChainTo(fnOut);
        const loopId = forCounter++;
        const entryName = `__for_${fn.name}_${loopId}`;
        const stepName  = `__for_${fn.name}_${loopId}__step`;

        const localScores: Record<string, string> = {};
        const localTypes: Record<string, VarKind> = { ...envTypes };

        // init (parent sink)
        if (stmt.init && "kind" in stmt.init) {
          if ((stmt.init as any).kind === "VarDecl" && !(stmt.init as VarDeclStmt).isGlobal) {
            const d = stmt.init as VarDeclStmt;
            localScores[d.name] = localScoreName(p.namespace, fn.name, loopId, d.name);
            localTypes[d.name] = "number";
            const tmp = compileNumericExpr(d.init, (c) => fnOut.push(tokensToPref(chain)(c)), { n: 0 }, (n) => localScores[n] ?? scoreName(p.namespace, n));
            withChainParent(chain, `scoreboard players operation ${localScores[d.name]} vars = ${tmp} vars`);
          } else if ((stmt.init as any).kind === "Assign") {
            emitAssign(stmt.init as AssignStmt, chain, null, envTypes, fnOut);
          }
        }

        // entry file
        const entryLines: string[] = [];
        const tmpStateEntry = { n: 0 };
        const variants = condToVariants(stmt.cond ?? null, chain, localScores, localTypes, entryLines, tmpStateEntry, false);
        if (variants.length === 0) variants.push([]);
        for (const parts of variants) {
          const guard = parts.length ? `execute ${parts.join(" ")} run function ${p.namespace}:${stepName}` : `function ${p.namespace}:${stepName}`;
          entryLines.push(tokensToPref(chain)(guard));
        }

        // step file: body -> incr -> recurse
        const stepLines: string[] = [];
        for (const s of stmt.body) emitStmt(s, chain, localScores, localTypes, stepLines);
        if (stmt.incr) emitAssign(stmt.incr, chain, localScores, localTypes, stepLines);
        stepLines.push(tokensToPref(chain)(`function ${p.namespace}:${entryName}`));

        files.push({ path: `data/${p.namespace}/function/${entryName}.mcfunction`, contents: entryLines.join("\n") + "\n" });
        files.push({ path: `data/${p.namespace}/function/${stepName}.mcfunction`, contents: stepLines.join("\n") + "\n" });

        withChainParent(chain, `function ${p.namespace}:${entryName}`);
      }

      function emitStmt(
        st: Stmt,
        chain: string,
        localScores: Record<string, string> | null,
        envTypes: Record<string, VarKind>,
        outArr: string[]
      ) {
        switch (st.kind) {
          case "VarDecl":
            diagnostics.push({ severity: "Warning", message: st.isGlobal ? `global var must be declared at pack scope` : `Local 'var' outside for-init is ignored`, line: st.line, col: st.col });
            return;

          case "Assign":
            emitAssign(st, chain, localScores, envTypes, outArr);
            return;

          case "Run":
            emitRun(st.expr, chain, localScores, envTypes, outArr);
            return;

          case "Say":
            emitSay(st.expr, chain, localScores, envTypes, outArr);
            return;

          case "Call": {
            const withChain = withChainTo(outArr);
            if (st.targetPack && st.targetPack.toLowerCase() === "give") {
              withChain(chain, `function ${p.namespace}:give/${st.func.toLowerCase()}`);
              return;
            }
            const targetNs = st.targetPack ? st.targetPack.toLowerCase() : p.namespace;
            withChain(chain, `function ${targetNs}:${st.func.toLowerCase()}`);
            return;
          }

          case "If":
            emitIfChain(st, chain, localScores, envTypes, outArr);
            return;

          case "Execute":
            emitExecute(st, chain, localScores, envTypes, outArr);
            return;

          case "For":
  emitFor(st, chain, envTypes);
  return;

        }
      }

      // body -> file
      for (const st of fn.body) emitStmt(st, "", null, packVarTypes[p.namespace], fnOut);
      files.push({ path: `data/${p.namespace}/function/${fn.name}.mcfunction`, contents: fnOut.join("\n") + (fnOut.length ? "\n" : "") });
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

    // Recipes (shaped + shapeless) under data/<ns>/recipe/
    // Build item lookup for custom-item result resolution
    const itemLookup: Record<string, { baseId: string; comps?: Record<string, any> }> = {};
    for (const it of p.items) {
      itemLookup[`${p.namespace}.${it.name}`] = {
        baseId: it.baseId,
        comps: componentTokensToMap(it.componentTokens)
      };
    }

    for (const r of p.recipes) {
      const n = r.name.toLowerCase();

      let resId = (r.result?.id ?? "minecraft:stone");
      let resCount = r.result?.count ?? 1;
      let resComponents: Record<string, any> | undefined;

      if (!resId.includes(":") && resId.includes(".")) {
        const hit = itemLookup[resId];
        if (hit) {
          resComponents = hit.comps;
          resId = hit.baseId;
        } else {
          diagnostics.push({
            severity: "Warning",
            message: `Result '${resId}' not found as custom Item in namespace '${p.namespace}'. Using literal id.`,
            line: 1, col: 1
          });
        }
      }

      if ((r.type ?? "shapeless") === "shaped") {
        const type = "minecraft:crafting_shaped";
        const pattern = r.pattern && r.pattern.length ? r.pattern : ["###"];
        const key: Record<string, any> = {};
        for (const [ch, id] of Object.entries(r.keys ?? {})) key[ch] = { item: id };
        const result: any = { id: resId, count: resCount };
        if (resComponents && Object.keys(resComponents).length) result.components = resComponents;
        const json = { type, pattern, key, result };
        files.push({ path: `data/${p.namespace}/recipe/${n}.json`, contents: JSON.stringify(json, null, 2) + "\n" });
      } else {
        const type = "minecraft:crafting_shapeless";
        const ingredients = (r.ingredients ?? []).map(id => ({ item: id }));
        const result: any = { id: resId, count: resCount };
        if (resComponents && Object.keys(resComponents).length) result.components = resComponents;
        const json = { type, ingredients, result };
        files.push({ path: `data/${p.namespace}/recipe/${n}.json`, contents: JSON.stringify(json, null, 2) + "\n" });
      }
    }

    // Items -> give functions
    for (const it of p.items) {
      const comps = it.componentTokens ? tokensToText(it.componentTokens) : "";
      const giveLine = comps ? `give @s ${it.baseId}[${comps}] 1` : `give @s ${it.baseId} 1`;
      files.push({ path: `data/${p.namespace}/function/give/${it.name}.mcfunction`, contents: giveLine + "\n" });
    }

    // Tags
    for (const td of p.tags) {
      const tagPath = `data/${p.namespace}/tags/${td.category}/${td.name.toLowerCase()}.json`;
      const tagJson = { replace: td.replace, values: td.values };
      files.push({ path: tagPath, contents: JSON.stringify(tagJson, null, 2) + "\n" });
    }
  }

  // load/tick tags
  const loadValues: string[] = []; const tickValues: string[] = [];
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
  const val = validate(ast); diagnostics.push(...val); if (diagnostics.some(d => d.severity === "Error")) return { files: [], diagnostics, symbolIndex: { packs: {} } };
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
            [/pack|namespace|func|global|var|let|Say|say|Execute|execute|if|unless|else|Run|run|for|adv|recipe|criterion|title|description|desc|icon|parent|type|ingredient|result|pattern|key|Item|base_id|components|BlockTag|ItemTag|replace|values/, "keyword"],
            [/\"[^\"]*\"/, "string"],
            [/\d+/, "number"],
            [/[a-zA-Z_@~^\[\]:.][a-zA-Z0-9_@~^\[\]:.]*/, "identifier"],
            [/[{()\[\]}.;,|:]/, "delimiter"],
            [/(\&\&)|(\|\|)|==|!=|<=|>=|[+\-*/%]=|[+\-*/%]|[<>]|(\+\+|--)/, "operator"],
          ],
        },
      });
    }

    const disp = monaco.languages.registerCompletionItemProvider(id, {
      triggerCharacters: [".", " ", "\"", "(", ")", "+", "-", "*", "/", "%", "|", "=", "[", "]", ":", ",",
                          "A","B","C","D","E","F","G","H","I","J","K","L","M","N","O","P","Q","R","S","T","U","V","W","X","Y","Z"],
      provideCompletionItems: (model: any, position: any) => {
        const suggestions: any[] = [];

        const kw = ["pack", "namespace", "func", "global", "var", "let", "Say", "Execute", "if", "unless", "else", "Run", "for", "adv", "recipe", "Item", "BlockTag", "ItemTag", "pattern", "key"];
        for (const k of kw) suggestions.push({ label: k, kind: monaco.languages.CompletionItemKind.Keyword, insertText: k });

        const textBefore = model.getValueInRange({ startLineNumber: Math.max(1, position.lineNumber - 20), startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column });
        const inComponents = /components\s*:\s*\[[\s\S]*$/m.test(textBefore) && !/\]/.test(textBefore.split(/components\s*:/).pop() || "");
        if (inComponents) {
          const compKeys = [
            "minecraft:item_name=",
            "minecraft:item_model=",
            "minecraft:custom_name=",
            "minecraft:damage=",
            "minecraft:unbreakable=",
          ];
          for (const k of compKeys) suggestions.push({ label: k, kind: monaco.languages.CompletionItemKind.Property, insertText: k });
        }

        suggestions.push({
          label: "if / else if / else",
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText:
`if(i % 3 == 0 && i % 5 == 0){
  Say("FizzBuzz")
}else if(i % 3 == 0){
  Say("Fizz")
}else if(i % 5 == 0){
  Say("Buzz")
}else{
  Say(i)
}`,
          detail: "If-chain"
        });
        suggestions.push({
          label: "for loop (local)",
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: `for (var i = 0 | i < 10 | i++){\n    Say("i=" + i)\n}\n`,
          detail: "Local numeric loop"
        });
        suggestions.push({
          label: "Execute block",
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: `Execute(as @s, at @s){\n  if("entity @s"){\n    Say("Hi")\n  }\n}\n`,
          detail: "Execute with condition"
        });
        suggestions.push({
          label: "BlockTag",
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText:
`BlockTag \${1:Solid}{
  replace = \${2:true}
  values:[
    "minecraft:stone",
    "minecraft:air"
  ];
}`,
          detail: "data/<ns>/tags/blocks/<name>.json"
        });
        suggestions.push({
          label: "ItemTag",
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText:
`ItemTag \${1:Treasure}{
  replace = \${2:false}
  values:[
    "minecraft:stick",
    "minecraft:string"
  ];
}`,
          detail: "data/<ns>/tags/items/<name>.json"
        });
        suggestions.push({
          label: "Shaped recipe",
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText:
`recipe \${1:emerald_sword}{
  type shaped;
  pattern [
    " A ",
    " A ",
    " B ",
  ];
  key A = minecraft:emerald;
  key B = minecraft:stick;
  result \${2:zombiespawn.emerald_sword} 1;
}`,
          detail: "crafting_shaped with custom-item result"
        });

        // packs & symbols
        const packIds = Object.keys(symbols.packs);
        for (const p of packIds) suggestions.push({ label: p, kind: monaco.languages.CompletionItemKind.Module, insertText: p });

        // context after a dot: pack.func() OR give.<item>()
        const lineText = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
        const lastDot = lineText.lastIndexOf(".");
        if (lastDot >= 0) {
          const before = lineText.slice(0, lastDot);
          const packId = (before.split(/[^A-Za-z0-9_.]/).pop() || "").trim();
          if (packId === "give") {
            // offer item names from all packs in this file (or narrow to current pack only if desired)
            for (const [pid, s] of Object.entries(symbols.packs)) {
              for (const it of Array.from(s.items)) {
                suggestions.push({ label: it, kind: monaco.languages.CompletionItemKind.Function, insertText: `${it}()`, detail: `give ${pid}:${it}` });
              }
            }
          }
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
const DEFAULT_SOURCE = `pack "Hello World" namespace helloWorld{

  func Load(){
    Say("Hello World")
  }

  func Tick(){

  }

}

pack "Fizz Buzz" namespace FizzBuzz{

  func Load(){}

  func Tick(){}

  func FizzBuzz(){
    for (var i = 1 | i < 31 | i++){
      if(i % 3 == 0 && i % 5 == 0){
        Say("FizzBuzz")
      }else if(i % 3 == 0){
        Say("Fizz")
      }else if(i % 5 == 0){
        Say("Buzz")
      }else{
        Say(i)
      }
    }
  }
}

pack "Items + Recipes + Tags" namespace zombieSpawn{

  Item emerald_sword{
    base_id = "minecraft:wooden_sword";
    components: [
      minecraft:item_model="zombiespawn:emerald_sword",
      minecraft:item_name="Emerald Sword"
    ];
  }

  recipe emerald_sword{
    type shaped;
    pattern [
      " A ",
      " A ",
      " B ",
    ];
    key A = minecraft:emerald;
    key B = minecraft:stick;
    // Use custom item as result -> pulls base_id + components
    result zombiespawn.emerald_sword 1;
  }

  BlockTag Solid{
    replace = true;
    values:[
      "minecraft:stone",
      "minecraft:air"
    ];
  }

  func Load(){
    give.emerald_sword()
  }

  func Tick(){}
}
`;

function FileList({ files, onSelect, selected }: { files: GeneratedFile[]; selected?: string; onSelect: (p: string) => void }) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => files.filter(f => f.path.toLowerCase().includes(q.toLowerCase())), [files, q]);
  return (
    <div className="flex flex-col gap-2 h-full">
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter files..." className="w-full px-3 py-2 rounded-xl bg-neutral-800/60 border border-neutral-700 text-neutral-200 placeholder:text-neutral-400" />
      <div className="space-y-1 overflow-auto">
        {filtered.map(f => (
          <button key={f.path} onClick={() => onSelect(f.path)} className={`w-full text-left px-3 py-2 rounded-xl border ${selected === f.path ? "border-neutral-600 bg-neutral-800/70" : "border-neutral-800 hover:bg-neutral-800/50"} text-neutral-200`}>
            <code className="text-sm break-all">{f.path}</code>
          </button>
        ))}
      </div>
    </div>
  );
}

function DiagnosticsPanel({ diags }: { diags: Diagnostic[] }) {
  if (!diags.length) return (
    <div className="text-sm text-emerald-400 flex items-center gap-2">
      <span>✓</span> No diagnostics.
    </div>
  );
  return (
    <div className="space-y-2">
      {diags.map((d, i) => (
        <div key={i} className={`rounded-xl p-3 border ${d.severity === "Error" ? "border-red-500/40 bg-red-500/10" : "border-amber-500/40 bg-amber-500/10"} text-neutral-200`}>
          <div className="flex items-center justify-between">
            <div className="text-xs uppercase tracking-wide opacity-70">{d.severity}</div>
            <div className="text-xs opacity-70">Line {d.line}, Col {d.col}</div>
          </div>
          <div className="text-sm font-medium mt-1">{d.message}</div>
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    <div className="min-h-screen bg-neutral-950 text-neutral-200">
      <div className="mx-auto max-w-7xl p-6">
        <header className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-md bg-indigo-500 text-white grid place-items-center font-bold">DP</div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Datapack Web Compiler</h1>
              <p className="text-xs text-neutral-400">Globals • Execute • for/if • &&/|| • Items • Tags • Adv/Recipes • IntelliSense • Zip export</p>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={downloadZip} disabled={!compiled.files.length} className="px-4 py-2 rounded-md border border-neutral-700 bg-neutral-900 hover:bg-neutral-800 disabled:opacity-50">Download .zip</button>
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Editor */}
          <div className="lg:col-span-2 flex flex-col gap-2">
            <label className="text-sm font-medium text-neutral-300">Source</label>
            <div className="rounded-md overflow-hidden border border-neutral-800 shadow-inner">
              <Editor
                height="560px"
                language="datapackdsl"
                theme="vs-dark"
                value={source}
                onChange={(v) => setSource(v ?? "")}
                options={{
                  fontSize: 14,
                  minimap: { enabled: false },
                  wordWrap: "on",
                  automaticLayout: true,
                  fontLigatures: true,
                }}
              />
            </div>
            <div>
              <label className="text-sm font-medium text-neutral-300">Diagnostics</label>
              <div className="mt-2"><DiagnosticsPanel diags={compiled.diagnostics} /></div>
            </div>
          </div>

          {/* Output */}
          <div className="lg:col-span-1 flex flex-col gap-3">
            <label className="text-sm font-medium text-neutral-300">Generated Files</label>
            <div className="grid grid-cols-1 gap-3">
              <div className="border rounded-md p-3 border-neutral-800 bg-neutral-900 h-[240px]">
                <FileList files={compiled.files} selected={selectedPath} onSelect={setSelectedPath} />
              </div>
              <div className="border rounded-md p-3 border-neutral-800 bg-neutral-900 h-[300px] overflow-auto">
                {selectedFile ? (
                  <pre className="font-mono text-sm whitespace-pre-wrap break-words text-neutral-200">{selectedFile.contents}</pre>
                ) : (
                  <div className="text-sm text-neutral-400">No file selected.</div>
                )}
              </div>
            </div>

            <div className="text-xs text-neutral-400 mt-2 space-y-1">
              <p><b>Items:</b> <code>Item emerald_sword {'{'} base_id = "minecraft:wooden_sword"; components: [ minecraft:item_model="zombieSpawn:emerald_sword" ]; {'}'}</code> → <code>function &lt;ns&gt;:give/emerald_sword</code> or <code>give.emerald_sword()</code></p>
              <p><b>Macros:</b> <code>Say($&quot;Hello {'{'}i{'}'}&quot;)</code>, <code>Run($&quot;summon ~{'{'}x{'}'} ~ ~{'{'}z{'}'}&quot;)</code> — executed with <code>with storage &lt;ns&gt;:variables</code>.</p>
              <p><b>for:</b> <code>for (var i = 0 | i &lt; 10 | i++)</code> or <code>for (num | num &lt; 10 | num++)</code></p>
              <p><b>Tags:</b> <code>BlockTag Solid {'{'} replace = true; values:[ "minecraft:stone" ]; {'}'}</code> → <code>data/&lt;ns&gt;/tags/blocks/solid.json</code></p>
            </div>
          </div>
        </div>

        <footer className="mt-8 text-xs text-neutral-500">
          Pack format: 48. Drop the zip into <code>%APPDATA%\.minecraft\saves\&lt;World&gt;\datapacks</code>.
        </footer>
      </div>
    </div>
  );
}
