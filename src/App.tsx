import { useEffect, useRef, useState } from "react";
import "./monaco-setup";
import Editor, { useMonaco } from "@monaco-editor/react";
import type { Monaco, OnMount } from "@monaco-editor/react";
import "./basic-dark.css";
import JSZip from "jszip";
// add this near the top with your other imports
import * as monacoEditor from "monaco-editor";



/**
 * Datapack Web Compiler (Typed)
 * - Types: string | int | float | double | bool | Ent (+ arrays of each)
 * - Commands: Say($"..."), Run($"..."), Execute{...}, for/if/else, &&, ||
 * - Globals stored in storage <ns>:variables; int/bool mirrored to scoreboard "vars"
 * - Math: Min/Max/Pow/Root/PI (int math), Random.value(min,max) -> /random value <min>..<max>
 * - Ent: Ent.Get("<selector args>") stores literal selector "@e[limit=1,<args>]"
 * - Items, Advancements, Recipes, Tags
 * - Monaco syntax + IntelliSense + Problems panel + File tree + Preview
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
type CallExpr  = { kind: "CallExpr"; target?: string; name: string; args: Expr[]; line: number; col: number };
type MemberExpr= { kind: "Member"; object: Expr; name: string; line: number; col: number };
type ArrayExpr = { kind: "Array"; items: Expr[]; line: number; col: number };
type Expr = StringExpr | NumberExpr | VarExpr | BinaryExpr | CallExpr | MemberExpr | ArrayExpr;

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

// Type system
type TypeName =
  | "string" | "int" | "float" | "double" | "bool" | "Ent"
  | "string[]" | "int[]" | "float[]" | "double[]" | "bool[]" | "Ent[]";

// Statements
type SayStmt = { kind: "Say"; expr: Expr };
type RunStmt = { kind: "Run"; expr: Expr };
type VarDeclStmt = { kind: "VarDecl"; isGlobal: boolean; varType: TypeName; name: string; init: Expr; line: number; col: number };
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
  ingredients: string[];
  pattern?: string[];
  keys?: Record<string, string>;
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

    // numbers (int or float)
    if (/[0-9]/.test(ch) || (ch === "-" && /[0-9]/.test(peek(1) ?? ""))) {
      let j = i + 1;
      let sawDot = false;
      while (j < input.length && (/[0-9]/.test(input[j]) || (!sawDot && input[j] === "."))) {
        if (input[j] === ".") sawDot = true;
        j++;
      }
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

  function parseTypeName(): TypeName {
    const t = expect("Identifier", "type name");
    const baseLower = (t.value || "").toLowerCase();
    let array = false;
    if (peek().type === "LBracket" && tokens[pos + 1]?.type === "RBracket") { pos += 2; array = true; }
    const canonicalBase = baseLower === "ent" ? "Ent" : baseLower;
    const valid = ["string","int","float","double","bool","Ent"];
    if (!valid.includes(canonicalBase)) throw { message: `Unknown type '${t.value}'`, line: t.line, col: t.col };
    return (canonicalBase + (array ? "[]":"")) as TypeName;
  }

  function parseArgList(): Expr[] {
    const args: Expr[] = [];
    expect("LParen");
    if (peek().type !== "RParen") {
      args.push(parseExpr());
      while (match("Comma")) args.push(parseExpr());
    }
    expect("RParen");
    return args;
  }

  function parseArrayLiteral(L: number, C: number): Expr {
    const items: Expr[] = [];
    while (peek().type !== "RBracket" && peek().type !== "EOF") {
      items.push(parseExpr());
      match("Comma");
    }
    expect("RBracket");
    return { kind: "Array", items, line: L, col: C };
  }

  function parsePrimary(): Expr {
    const t = peek();
    if (t.type === "String") { pos++; return { kind: "String", value: t.value!, line: t.line, col: t.col }; }
    if (t.type === "Number") { pos++; return { kind: "Number", value: Number(t.value!), line: t.line, col: t.col }; }
    if (t.type === "LBracket") {
      const L = t.line, C = t.col; pos++;
      return parseArrayLiteral(L, C);
    }
    if (t.type === "Identifier") {
      const idTok = t; pos++;
      // Dotted call like Math.Min(...)
      if (peek().type === "Dot") {
        pos++;
        const nameTok = expect("Identifier", "function");
        const name = nameTok.value!;
        if (peek().type === "LParen") {
          const args = parseArgList();
          return parsePostfix({ kind: "CallExpr", target: idTok.value, name, args, line: idTok.line, col: idTok.col });
        } else {
          return parsePostfix({ kind: "Member", object: { kind: "Var", name: idTok.value!, line: idTok.line, col: idTok.col }, name: nameTok.value!, line: nameTok.line, col: nameTok.col });
        }
      }
      // Simple call Foo(...)
      if (peek().type === "LParen") {
        const args = parseArgList();
        return parsePostfix({ kind: "CallExpr", name: idTok.value!, args, line: idTok.line, col: idTok.col });
      }
      // Plain var
      return parsePostfix({ kind: "Var", name: idTok.value!, line: idTok.line, col: idTok.col });
    }
    if (t.type === "LParen") { pos++; const e = parseExpr(); expect("RParen", "')'"); return e; }
    throw { message: `Unexpected token in expression: ${t.value ?? t.type}`, line: t.line, col: t.col };
  }

  function parsePostfix(base: Expr): Expr {
    while (peek().type === "Dot") {
      pos++;
      const nameTok = expect("Identifier", "member");
      const name = nameTok.value!;
      if (peek().type === "LParen") {
        const args = parseArgList();
        base = { kind: "CallExpr", target: undefined, name, args: [base, ...args], line: nameTok.line, col: nameTok.col };
      } else {
        base = { kind: "Member", object: base, name, line: nameTok.line, col: nameTok.col };
      }
    }
    return base;
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

  function defaultInitFor(varType: TypeName): Expr {
    const base = (varType.endsWith("[]") ? varType.slice(0, -2) : varType) as Exclude<TypeName, `${string}[]`>;
    if (varType.endsWith("[]")) return { kind: "Array", items: [], line: 0, col: 0 };
    switch (base) {
      case "string": return { kind: "String", value: "", line: 0, col: 0 };
      case "Ent":    return { kind: "String", value: "", line: 0, col: 0 };
      case "bool":   return { kind: "Number", value: 0, line: 0, col: 0 };
      case "int":    return { kind: "Number", value: 0, line: 0, col: 0 };
      case "float":  return { kind: "Number", value: 0, line: 0, col: 0 };
      case "double": return { kind: "Number", value: 0, line: 0, col: 0 };
      default:       return { kind: "Number", value: 0, line: 0, col: 0 };
    }
  }

  function parseVarDecl(isGlobalForced = false): VarDeclStmt {
    // forms:
    //   global <type> name [= expr] ;
    //   <type> name [= expr] ;
    let isGlobal = isGlobalForced;
    let first = expect("Identifier");
    let low = (first.value ?? "").toLowerCase();

    let varType: TypeName;
    if (low === "global") {
      isGlobal = true;
      varType = parseTypeName();
    } else if (low === "var" || low === "let") {
      diags.push({ severity: "Error", message: `Use typed declarations: global <type> name = ... or <type> name = ...`, line: first.line, col: first.col });
      varType = "int";
    } else {
      pos--;
      varType = parseTypeName();
    }

    const name = expect("Identifier", "variable name").value!;
    let init: Expr | null = null;
    if (match("Equals")) {
      init = parseExpr();
    }
    match("Semicolon");
    return { kind: "VarDecl", isGlobal, varType, name, init: init ?? defaultInitFor(varType), line: first.line, col: first.col };
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
      if (t.type === "Identifier" && ((t.value ?? "").toLowerCase() === "global")) {
        diags.push({ severity: "Error", message: `Use local typed declaration without 'global' inside for-init`, line: t.line, col: t.col });
        pos++;
        const d = parseVarDecl(false);
        init = d;
      } else if (t.type === "Identifier") {
        const save = pos;
        try {
          const decl = parseVarDecl(false);
          init = decl;
        } catch {
          pos = save;
          const nameTok = expect("Identifier");
          if (peek().type === "PlusPlus" || peek().type === "MinusMinus" || peek().type === "Equals" || peek().type === "PlusEquals" || peek().type === "MinusEquals" || peek().type === "StarEquals" || peek().type === "SlashEquals" || peek().type === "PercentEquals") {
            init = parseAssignAfterName(nameTok);
          } else {
            init = { kind: "Noop" };
          }
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
        if (v.type === "String" || v.type === "Identifier" || v.type === "Number") {
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
    const kw = expect("Identifier");
    const kwVal = (kw.value || "");
    if (!/tag$/i.test(kwVal)) {
      throw { message: `Expected <Something>Tag (e.g. BlockTag, ItemTag)`, line: kw.line, col: kw.col };
    }
    const head = kwVal.toLowerCase();
    const category: TagCategory = head === "blocktag" ? "blocks" : head === "itemtag" ? "items" : "blocks";

    const nameTok = expect("Identifier");
    const name = nameTok.value!;

    if (match("LParen")) expect("RParen");
    expect("LBrace");

    let replace = false;
    let values: string[] = [];

    while (peek().type !== "RBrace" && peek().type !== "EOF") {
      const t = expect("Identifier");
      const rawKey = t.value || "";
      const key = rawKey.toLowerCase().replace(/[:\[]+$/, "");

      if (key === "replace") {
        if (peek().type === "Equals" || peek().type === "Colon") pos++;
        const vTok = expect("Identifier", "true/false");
        replace = (vTok.value || "").toLowerCase() === "true";
        match("Semicolon");
        continue;
      }

      if (key === "values") {
        if (peek().type === "Colon") pos++;
        const hadBracketInKey = /[:\[]$/.test(rawKey);
        if (!hadBracketInKey) expect("LBracket");

        const arr: string[] = [];
        while (peek().type !== "RBracket" && peek().type !== "EOF") {
          const s = expect("String", "tag value string");
          arr.push(s.value || "");
          match("Comma");
        }
        expect("RBracket");
        match("Semicolon");
        values = arr;
        continue;
      }

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
      category,
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
      if (nxt.type === "Identifier") {
        const d = parseVarDecl(true); return d;
      }
      diags.push({ severity: "Error", message: `Expected type after 'global'`, line: t.line, col: t.col });
      return null;
    }

    if (low === "var" || low === "let") {
      const d = parseVarDecl(false);
      diags.push({ severity: "Error", message: `Use typed declarations instead of 'var/let'`, line: t.line, col: t.col });
      return d;
    }

    if (low === "adv") { diags.push({ severity: "Error", message: `adv not allowed inside functions`, line: t.line, col: t.col }); parseAdv(); return null; }
    if (low === "recipe") { diags.push({ severity: "Error", message: `recipe not allowed inside functions`, line: t.line, col: t.col }); parseRecipe(); return null; }
    if (low === "item") { diags.push({ severity: "Error", message: `Item not allowed inside functions`, line: t.line, col: t.col }); parseItem(); return null; }
    if (low === "blocktag" || low === "itemtag") {
      diags.push({ severity: "Error", message: `Tag declarations are not allowed inside functions`, line: t.line, col: t.col });
      if (peek().type !== "LBrace") { while (peek().type !== "LBrace" && peek().type !== "EOF") pos++; }
      if (peek().type === "LBrace") {
        let depth = 0;
        do {
          const tk = peek(); pos++;
          if (tk.type === "LBrace") depth++;
          if (tk.type === "RBrace") depth--;
        } while (depth > 0 && peek().type !== "EOF");
      }
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
        if (["string","int","float","double","bool","ent"].includes(low) || (low === "string[]" || low === "int[]" || low === "float[]" || low === "double[]" || low === "bool[]" || low === "ent[]")) {
          const decl = parseVarDecl(true); globals.push(decl); continue;
        }
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
const PACK_FORMAT_CONST = 48;

type VarKind = TypeName;

function scoreName(ns: string, varName: string) { return `_${ns}.${varName}`; }
function localScoreName(_ns: string, fn: string, idx: number, name: string) { return `__${fn}_for${idx}_${name}`; }
function tmpScoreName(idx: number) { return `__tmp${idx}`; }

function isArrayKind(k: VarKind) { return /\[\]$/.test(k); }
function baseOf(k: VarKind): Exclude<VarKind, `${string}[]`> {
  return (isArrayKind(k) ? (k.replace(/\[\]$/, "") as any) : (k as any)) as any;
}
function isNumericKind(k: VarKind) {
  const b = baseOf(k) as any;
  return b === "int" || b === "bool";
}
function isStoredNumericKind(k: VarKind) {
  const b = baseOf(k) as any;
  return b === "int" || b === "bool" || b === "float" || b === "double";
}

function storageTypeFor(k: VarKind): "int" | "float" | "double" | "byte" | "string" | "raw" {
  const b = baseOf(k);
  if (b === "int") return "int";
  if (b === "float") return "float";
  if (b === "double") return "double";
  if (b === "bool") return "byte";
  if (b === "string" || b === "Ent") return "string";
  return "raw";
}

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

// function tokensToText(ts: Token[]): string {
//   let out = "";
//   for (const t of ts) {
//     switch (t.type) {
//       case "String": out += JSON.stringify(t.value ?? ""); break;
//       case "Identifier":
//       case "Number": out += t.value ?? ""; break;
//       case "Comma": out += ", "; break;
//       case "Colon": out += ":"; break;
//       case "Equals": out += "="; break;
//       case "LBrace": out += "{"; break;
//       case "RBrace": out += "}"; break;
//       case "LBracket": out += "["; break;
//       case "RBracket": out += "]"; break;
//       default: out += t.value ?? ""; break;
//     }
//   }
//   return out;
// }


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
    default:
      return undefined;
  }
}

function snbtFromLiteral(kind: VarKind, num: number | boolean | string): string {
  const b = baseOf(kind);
  if (b === "string" || b === "Ent") return JSON.stringify(String(num));
  if (b === "bool") return (num ? "1b" : "0b");
  if (b === "int") return `${Math.trunc(Number(num))}`;
  if (b === "float") {
    const n = Number(num);
    const s = Number.isInteger(n) ? `${n.toFixed(1)}f` : `${n}f`;
    return s;
  }
  if (b === "double") {
    const n = Number(num);
    const s = Number.isInteger(n) ? `${n.toFixed(1)}d` : `${n}d`;
    return s;
  }
  return JSON.stringify(num);
}

function arrayInitCommands(ns: string, name: string, kind: VarKind, items: Expr[], pushDiag: (d: Diagnostic)=>void): string[] {
  const b = baseOf(kind);
  const cmds: string[] = [];
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
    if (lit === undefined) { pushDiag({ severity: "Error", message: `Array element ${idx} for ${name} must be literal of type ${b}`, line: it.line ?? 0, col: it.col ?? 0 }); return; }
    cmds.push(`data modify storage ${ns}:variables ${name}[${idx}] set value ${lit}`);
  });
  return cmds;
}

// ---------- Numeric expression compiler ----------
function compileNumericExpr(
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
      case "Number":
        emit(`scoreboard players set ${target} vars ${Math.trunc(e.value)}`);
        return;
      case "Var": {
        const vk = resolveKindForVar(e.name);
        if (!vk || !isStoredNumericKind(vk)) {
          diagnostics.push({ severity: "Error", message: `Variable '${e.name}' is not numeric`, line: e.line, col: e.col });
          emit(`scoreboard players set ${target} vars 0`);
          return;
        }
        if (isNumericKind(vk)) {
          emit(`scoreboard players operation ${target} vars = ${resolveScoreForVar(e.name)} vars`);
        } else {
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
        const tgt = (e.target || "").toLowerCase();
        const name = e.name.toLowerCase();

        // Random.value(min, max)
        if (tgt === "random" && name === "value") {
          let minLit: number | undefined = undefined, maxLit: number | undefined = undefined;
          if (e.args[0]?.kind === "Number") minLit = Math.trunc(e.args[0].value);
          if (e.args[1]?.kind === "Number") maxLit = Math.trunc(e.args[1].value);
          if (minLit === undefined || maxLit === undefined) {
            diagnostics.push({ severity: "Warning", message: `Random.value(...) expects literal numeric bounds. Using 0..100 as fallback.`, line: e.line, col: e.col });
            minLit = 0; maxLit = 100;
          }
          emit(`execute store result score ${target} vars run random value ${minLit}..${maxLit}`);
          return;
        }

        // Math.PI()
        if (tgt === "math" && name === "pi") {
          emit(`scoreboard players set ${target} vars 3`);
          diagnostics.push({ severity: "Info", message: `Math.PI approximated as 3 (int math)`, line: e.line, col: e.col });
          return;
        }

        if (tgt === "math" && (name === "min" || name === "max")) {
          const A = tmpScoreName(tmpCounter.n++), B = tmpScoreName(tmpCounter.n++);
          to(A, e.args[0]); to(B, e.args[1]);
          emit(`scoreboard players operation ${target} vars = ${A} vars`);
          if (name === "min") emit(`execute if score ${B} vars < ${target} vars run scoreboard players operation ${target} vars = ${B} vars`);
          else emit(`execute if score ${B} vars > ${target} vars run scoreboard players operation ${target} vars = ${B} vars`);
          return;
        }

        // Math.Pow(n, p) small p
        if (tgt === "math" && name === "pow") {
          const base = tmpScoreName(tmpCounter.n++); to(base, e.args[0]);
          const power = (e.args[1]?.kind === "Number" ? Math.trunc(e.args[1].value) : 0);
          if (power < 0 || power > 10) {
            diagnostics.push({ severity: "Warning", message: `Math.Pow supports 0..10`, line: e.line, col: e.col });
          }
          emit(`scoreboard players set ${target} vars 1`);
          for (let i = 0; i < Math.max(0, Math.min(10, power)); i++) emit(`scoreboard players operation ${target} vars *= ${base} vars`);
          return;
        }

        // Math.Root(n, p) rough
        if (tgt === "math" && name === "root") {
          const num = tmpScoreName(tmpCounter.n++); to(num, e.args[0]);
          const pwr = (e.args[1]?.kind === "Number" ? Math.trunc(e.args[1].value) : 2);
          emit(`scoreboard players set ${target} vars 0`);
          for (let c = 0; c <= 100; c++) {
            const cScore = tmpScoreName(tmpCounter.n++);
            const prod = tmpScoreName(tmpCounter.n++);
            emit(`scoreboard players set ${cScore} vars ${c}`);
            emit(`scoreboard players set ${prod} vars 1`);
            for (let i = 0; i < Math.max(0, Math.min(10, pwr)); i++) emit(`scoreboard players operation ${prod} vars *= ${cScore} vars`);
            emit(`execute if score ${prod} vars <= ${num} vars run scoreboard players operation ${target} vars = ${cScore} vars`);
          }
          return;
        }

        // Ent.GetData(ent,"Health") -> numeric
        if (name === "getdata" && e.args.length >= 2) {
          const keyExpr = e.args[1];
          if (keyExpr.kind === "String") {
            // inline Ent.Get
            if (e.args[0].kind === "CallExpr" && ((e.args[0].target || "").toLowerCase() === "ent") && e.args[0].name.toLowerCase() === "get" && e.args[0].args[0]?.kind === "String") {
              const selectorStr = `@e[limit=1,${(e.args[0].args[0] as StringExpr).value}]`;
              emit(`execute as ${selectorStr} store result score ${target} vars run data get entity @s ${keyExpr.value} 1`);
              return;
            }
            diagnostics.push({ severity: "Warning", message: `GetData works best with inline Ent.Get(...) in this build`, line: e.line, col: e.col });
          }
          emit(`scoreboard players set ${target} vars 0`);
          return;
        }

        // Ent.Get(...) itself is not numeric
        if ((e.target || "").toLowerCase() === "ent" && e.name.toLowerCase() === "get") {
          diagnostics.push({ severity: "Error", message: `Ent.Get(...) is not numeric`, line: e.line, col: e.col });
          emit(`scoreboard players set ${target} vars 0`);
          return;
        }

        diagnostics.push({ severity: "Error", message: `Unsupported call in numeric expression: ${(e.target ? e.target + "." : "") + e.name}`, line: e.line, col: e.col });
        emit(`scoreboard players set ${target} vars 0`);
        return;
      }
      case "String":
        emit(`scoreboard players set ${target} vars 0`);
        return;
      case "Member":
      case "Array":
        diagnostics.push({ severity: "Error", message: `Unsupported expression in numeric context`, line: e.line, col: e.col });
        emit(`scoreboard players set ${target} vars 0`);
        return;
    }
  };
  to(res, expr);
  return res;
}

// ---------- Generation ----------
function generate(ast: Script): { files: GeneratedFile[]; diagnostics: Diagnostic[]; symbolIndex: SymbolIndex } {
  const diagnostics: Diagnostic[] = [];
  const files: GeneratedFile[] = [];

  const description = ast.packs[0]?.packTitle ?? "Datapack";
  files.push({ path: `pack.mcmeta`, contents: JSON.stringify({ pack: { pack_format: PACK_FORMAT_CONST, description } }, null, 2) + "\n" });

  const symbolIndex: SymbolIndex = { packs: {} };
  for (const p of ast.packs) {
    symbolIndex.packs[p.namespace] = { title: p.packTitle, vars: new Set(p.globals.map(g => g.name)), funcs: new Set(p.functions.map(f => f.name)), items: new Set(p.items.map(i => i.name)) };
  }

  const packVarTypes: Record<string, Record<string, VarKind>> = {};
  for (const p of ast.packs) {
    const types: Record<string, VarKind> = {};
    for (const g of p.globals) types[g.name] = g.varType;
    packVarTypes[p.namespace] = types;
  }

  for (const p of ast.packs) {
    // bootstrap + setup
    const boot = [`execute unless data storage ${p.namespace}:system bootstrap run function ${p.namespace}:__setup`];
    files.push({ path: `data/${p.namespace}/function/__bootstrap.mcfunction`, contents: boot.join("\n") + "\n" });
    const setup = [`scoreboard objectives add vars dummy`, `data modify storage ${p.namespace}:system bootstrap set value 1b`];
    files.push({ path: `data/${p.namespace}/function/__setup.mcfunction`, contents: setup.join("\n") + "\n" });

    const init: string[] = [];
    const tmpState = { n: 0 };
    const resolveKind = (name: string) => packVarTypes[p.namespace][name];
    const resolveScore = (name: string) => scoreName(p.namespace, name);

    // --- Global initializers ---
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
        if (g.init.kind === "CallExpr" && (g.init.target || "").toLowerCase() === "ent" && g.init.name.toLowerCase() === "get" && g.init.args[0]?.kind === "String") {
          const selector = `@e[limit=1,${(g.init.args[0] as StringExpr).value}]`;
          init.push(`data modify storage ${p.namespace}:variables ${g.name} set value ${JSON.stringify(selector)}`);
        } else if (g.init.kind === "String" && !g.init.value.startsWith("$")) {
          init.push(`data modify storage ${p.namespace}:variables ${g.name} set value ${JSON.stringify(g.init.value)}`);
        } else {
          init.push(`data modify storage ${p.namespace}:variables ${g.name} set value ""`);
        }
        continue;
      }

      if (isStoredNumericKind(kind)) {
        if (b === "int" || b === "bool") {
          const tmp = compileNumericExpr(g.init, p.namespace, c => init.push(c), tmpState, resolveScore, resolveKind, diagnostics);
          init.push(`scoreboard players operation ${scoreName(p.namespace, g.name)} vars = ${tmp} vars`);
          const stype = storageTypeFor(kind);
          init.push(`execute store result storage ${p.namespace}:variables ${g.name} ${stype} 1 run scoreboard players get ${scoreName(p.namespace, g.name)} vars`);
        } else {
          if (g.init.kind === "Number") {
            init.push(`data modify storage ${p.namespace}:variables ${g.name} set value ${snbtFromLiteral(kind, g.init.value)}`);
          } else {
            init.push(`data modify storage ${p.namespace}:variables ${g.name} set value ${snbtFromLiteral(kind, 0)}`);
          }
        }
        continue;
      }

      diagnostics.push({ severity: "Error", message: `Unsupported global type for '${g.name}'`, line: g.line, col: g.col });
    }

    files.push({ path: `data/${p.namespace}/function/__init.mcfunction`, contents: init.join("\n") + (init.length ? "\n" : "") });

    // --- Function emit utilities ---
    let forCounter = 0;
    let macroCounter = 0;
    let ifCounter = 0;

    const tokensToPref = (chain: string) => (cmd: string) => (chain ? `execute ${chain} run ${cmd}` : cmd);
    const withChainTo = (sink: string[]) => (chain: string, cmd: string) => sink.push(tokensToPref(chain)(cmd));

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
      const resolveVarScore = (name: string) => localScores && name in localScores ? localScores[name] : scoreName(p.namespace, name);

      function leaf(c: CmpCond | RawCond): string[] {
        if ((c as RawCond).kind === "Raw") {
          const cr = c as RawCond;
          return [ `${negate ? "unless" : "if"} ${cr.raw}` ];
        } else {
          const cc = c as CmpCond;
          const L = compileNumericExpr(cc.left,  p.namespace, (c)=>outArr.push(pref(c)), tmpState, resolveVarScore, (n)=>envTypes[n], diagnostics);
          const R = compileNumericExpr(cc.right, p.namespace, (c)=>outArr.push(pref(c)), tmpState, resolveVarScore, (n)=>envTypes[n], diagnostics);
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
        const local = localScores && (r in localScores);
        const k = envTypes[r];
        if (local) {
          withChain(chain, `execute store result storage ${p.namespace}:variables ${r} int 1 run scoreboard players get ${localScores![r]} vars`);
        } else if (k && isStoredNumericKind(k) && (k === "int" || k === "bool")) {
          withChain(chain, `execute store result storage ${p.namespace}:variables ${r} int 1 run scoreboard players get ${scoreName(p.namespace, r)} vars`);
        }
      }
      const macroName = `__macro_${macroCounter++}`;
      const macroBody = `$${macroBodyLine}\n`;
      files.push({ path: `data/${p.namespace}/function/${macroName}.mcfunction`, contents: macroBody });
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
      const resolveScore = (name: string) => localScores && name in localScores ? localScores[name] : scoreName(p.namespace, name);
      const tmp = compileNumericExpr(expr, p.namespace, c => tmpLines.push(tokensToPref(chain)(c)), tmpStateLocal, resolveScore, (n)=>envTypes[n], diagnostics);
      if (tmpLines.length) {
        outArr.push(...tmpLines);
        withChain(chain, `tellraw @a {"score":{"name":"${tmp}","objective":"vars"}}`);
        return;
      }

      if (isStaticString(expr)) {
        withChain(chain, `say ${JSON.stringify(evalStaticString(expr)!)}`);
      } else {
        diagnostics.push({ severity: "Error", message: `Say(...) supports numeric expressions and static/macro strings.`, line: (expr as any).line ?? 0, col: (expr as any).col ?? 0 });
      }
    }

    function emitRun(
      expr: Expr,
      chain: string,
      _localScores: Record<string, string> | null,
      envTypes: Record<string, VarKind>,
      outArr: string[]
    ) {
      const withChain = withChainTo(outArr);
      if (exprIsMacroString(expr)) {
        const raw = expr.value.slice(1);
        const { line, refs } = renderMacroTemplate(raw);
        emitMacroCall(line, refs, chain, _localScores, envTypes, outArr);
        return;
      }
      if (!isStaticString(expr)) { diagnostics.push({ severity: "Error", message: `Run(...) must be a static string or macro string`, line: (expr as any).line ?? 0, col: (expr as any).col ?? 0 }); return; }
      withChain(chain, evalStaticString(expr)!);
    }

    function emitAssign(
      assign: AssignStmt,
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
        if (isStaticString(assign.expr)) withChain(chain, `data modify storage ${p.namespace}:variables ${assign.name} set value ${JSON.stringify(evalStaticString(assign.expr)!)}`);
        else diagnostics.push({ severity: "Error", message: `String assignment must be static or macro-driven (use Run/Say macros)`, line: assign.line, col: assign.col });
        return;
      }

      if (b === "Ent") {
        if (assign.op !== "=") { diagnostics.push({ severity: "Error", message: `Only '=' supported for Ent`, line: assign.line, col: assign.col }); return; }
        if (assign.expr.kind === "CallExpr" && (assign.expr.target || "").toLowerCase() === "ent" && assign.expr.name.toLowerCase() === "get" && assign.expr.args[0]?.kind === "String") {
          const selector = `@e[limit=1,${(assign.expr.args[0] as StringExpr).value}]`;
          withChain(chain, `data modify storage ${p.namespace}:variables ${assign.name} set value ${JSON.stringify(selector)}`);
        } else if (assign.expr.kind === "String") {
          withChain(chain, `data modify storage ${p.namespace}:variables ${assign.name} set value ${JSON.stringify(assign.expr.value)}`);
        } else {
          diagnostics.push({ severity: "Error", message: `Ent assignment must be Ent.Get("...") or a selector string`, line: assign.line, col: assign.col });
        }
        return;
      }

      if (isStoredNumericKind(kind)) {
        const resolveScore = (name: string) => localScores && name in localScores ? localScores[name] : scoreName(p.namespace, name);
        const tmp = compileNumericExpr(assign.expr, p.namespace, c => outArr.push(tokensToPref(chain)(c)), { n: 0 }, resolveScore, (n)=>envTypes[n], diagnostics);
        const target = localScores && (assign.name in localScores) ? localScores[assign.name] : scoreName(p.namespace, assign.name);
        const opMap: Record<AssignStmt["op"], string> = { "=": "=", "+=": "+=", "-=": "-=", "*=": "*=", "/=": "/=", "%=": "%=" };
        withChain(chain, `scoreboard players operation ${target} vars ${opMap[assign.op]} ${tmp} vars`);
        if (b === "int" || b === "bool") {
          const st = storageTypeFor(kind);
          withChain(chain, `execute store result storage ${p.namespace}:variables ${assign.name} ${st} 1 run scoreboard players get ${target} vars`);
        }
        return;
      }

      diagnostics.push({ severity: "Error", message: `Unsupported assignment to ${b}`, line: assign.line, col: assign.col });
    }

    function emitExecute(stmt: ExecuteStmt, chain: string, localScores: Record<string, string> | null, envTypes: Record<string, VarKind>, outArr: string[]) {
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

    function emitFor(stmt: ForStmt, chain: string, envTypes: Record<string, VarKind>, outArr: string[]) {
      const withChainParent = withChainTo(outArr);
      const loopId = forCounter++;
      const entryName = `__for_${loopId}`;
      const stepName  = `__for_${loopId}__step`;

      const localScores: Record<string, string> = {};
      const localTypes: Record<string, VarKind> = { ...envTypes };

      if (stmt.init && "kind" in stmt.init) {
        if ((stmt.init as any).kind === "VarDecl" && !(stmt.init as VarDeclStmt).isGlobal) {
          const d = stmt.init as VarDeclStmt;
          if (baseOf(d.varType) !== "int") {
            diagnostics.push({ severity: "Error", message: `for-init local must be int`, line: d.line, col: d.col });
          } else {
            localScores[d.name] = localScoreName(p.namespace, "fn", loopId, d.name);
            localTypes[d.name] = "int";
            const tmp = compileNumericExpr(d.init, p.namespace, (c) => outArr.push(tokensToPref(chain)(c)), { n: 0 }, (n)=>localScores[n] ?? scoreName(p.namespace, n), (n)=>localTypes[n], diagnostics);
            withChainParent(chain, `scoreboard players operation ${localScores[d.name]} vars = ${tmp} vars`);
          }
        } else if ((stmt.init as any).kind === "Assign") {
          emitAssign(stmt.init as AssignStmt, chain, null, envTypes, outArr);
        }
      }

      const entryLines: string[] = [];
      const tmpStateEntry = { n: 0 };
      const variants = condToVariants(stmt.cond ?? null, chain, localScores, localTypes, entryLines, tmpStateEntry, false);
      if (variants.length === 0) variants.push([]);
      for (const parts of variants) {
        const guard = parts.length ? `execute ${parts.join(" ")} run function ${p.namespace}:${stepName}` : `function ${p.namespace}:${stepName}`;
        entryLines.push(tokensToPref(chain)(guard));
      }

      const stepLines: string[] = [];
      for (const s of stmt.body) emitStmt(s, chain, localScores, localTypes, stepLines);
      if (stmt.incr) emitAssign(stmt.incr, chain, localScores, localTypes, stepLines);
      stepLines.push(tokensToPref(chain)(`function ${p.namespace}:${entryName}`));

      files.push({ path: `data/${p.namespace}/function/${entryName}.mcfunction`, contents: entryLines.join("\n") + "\n" });
      files.push({ path: `data/${p.namespace}/function/${stepName}.mcfunction`, contents: stepLines.join("\n") + "\n" });

      withChainParent(chain, `function ${p.namespace}:${entryName}`);
    }

    // local counter for unnamed scoreboard locals
    let localCounter = 0;

    function emitStmt(st: Stmt, chain: string, localScores: Record<string, string> | null, envTypes: Record<string, VarKind>, outArr: string[]) {
      const withChain = withChainTo(outArr);
      switch (st.kind) {
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
            if (st.init.kind === "CallExpr" && (st.init.target || "").toLowerCase() === "ent" && st.init.name.toLowerCase() === "get" && st.init.args[0]?.kind === "String") {
              const selector = `@e[limit=1,${(st.init.args[0] as StringExpr).value}]`;
              withChain(chain, `data modify storage ${p.namespace}:variables ${st.name} set value ${JSON.stringify(selector)}`);
            } else if (st.init.kind === "String" && !st.init.value.startsWith("$")) {
              withChain(chain, `data modify storage ${p.namespace}:variables ${st.name} set value ${JSON.stringify(st.init.value)}`);
            } else {
              withChain(chain, `data modify storage ${p.namespace}:variables ${st.name} set value ""`);
            }
            envTypes[st.name] = st.varType;
            return;
          }

          if (isStoredNumericKind(st.varType)) {
            const resolveScore = (name: string) => (localScores && name in localScores) ? localScores[name] : scoreName(p.namespace, name);
            const tmp = compileNumericExpr(st.init, p.namespace, (c)=>outArr.push(tokensToPref(chain)(c)), { n: 0 }, resolveScore, (n)=>envTypes[n], diagnostics);

            // allocate local scoreboard slot if needed
            let target = scoreName(p.namespace, st.name);
            if (isLocal) {
              if (localScores) {
                localScores[st.name] = localScores[st.name] ?? `__local_${localCounter++}_${st.name}`;
                target = localScores[st.name];
              }
            }

            withChain(chain, `scoreboard players operation ${target} vars = ${tmp} vars`);
            const stype = storageTypeFor(st.varType);
            withChain(chain, `execute store result storage ${p.namespace}:variables ${st.name} ${stype} 1 run scoreboard players get ${target} vars`);
            envTypes[st.name] = st.varType;
            return;
          }

          diagnostics.push({ severity: "Error", message: `Unsupported local variable type '${b}'`, line: st.line, col: st.col });
          return;
        }

        case "Assign": return emitAssign(st, chain, localScores, envTypes, outArr);
        case "Say":    return emitSay(st.expr, chain, localScores, envTypes, outArr);
        case "Run":    return emitRun(st.expr, chain, localScores, envTypes, outArr);
        case "Call": {
          const tns = st.targetPack ?? p.namespace;
          withChainTo(outArr)(chain, `function ${tns}:${st.func.toLowerCase()}`);
          return;
        }
        case "Execute": return emitExecute(st, chain, localScores, envTypes, outArr);
        case "If": return emitIfChain(st, chain, localScores, envTypes, outArr);
        case "For": return emitFor(st, chain, envTypes, outArr);
      }
    }

    // ---- Emit functions ----
    for (const f of p.functions) {
      const out: string[] = [];
      const localScores: Record<string, string> = {};
      const envTypes: Record<string, VarKind> = { ...packVarTypes[p.namespace] };
      for (const st of f.body) emitStmt(st, "", localScores, envTypes, out);
      files.push({ path: `data/${p.namespace}/function/${f.name}.mcfunction`, contents: out.join("\n") + (out.length ? "\n" : "") });
    }

    // ---- Advancements ----
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
      if (a.props.parent) advObj.parent = a.props.parent;
      for (const c of a.props.criteria) advObj.criteria[c.name] = { trigger: c.trigger };
      files.push({ path: `data/${p.namespace}/advancements/${a.name}.json`, contents: JSON.stringify(advObj, null, 2) + "\n" });
    }

    // ---- Recipes ----
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
      files.push({ path: `data/${p.namespace}/recipes/${r.name}.json`, contents: JSON.stringify(body, null, 2) + "\n" });
    }

    // ---- Items ----
    for (const it of p.items) {
      const comps = componentTokensToMap(it.componentTokens) ?? {};
      const body = { base: it.baseId, components: comps };
      files.push({ path: `data/${p.namespace}/items/${it.name}.json`, contents: JSON.stringify(body, null, 2) + "\n" });
      // convenience giver
      files.push({
        path: `data/${p.namespace}/function/give.${it.name}.mcfunction`,
        contents: `give @s ${it.baseId}\n`,
      });
    }

    // ---- Tags ----
    for (const t of p.tags) {
      const body = { replace: !!t.replace, values: t.values ?? [] };
      files.push({ path: `data/${p.namespace}/tags/${t.category}/${t.name}.json`, contents: JSON.stringify(body, null, 2) + "\n" });
    }
  }

  // Hook into load/tick based on presence
  const loadVals: string[] = [];
  const tickVals: string[] = [];
  for (const p of ast.packs) {
    loadVals.push(`${p.namespace}:__bootstrap`, `${p.namespace}:__init`);
    if (p.functions.some(f => f.name === "load")) loadVals.push(`${p.namespace}:load`);
    if (p.functions.some(f => f.name === "tick")) tickVals.push(`${p.namespace}:tick`);
  }
  if (loadVals.length) files.push({ path: `data/minecraft/tags/function/load.json`, contents: JSON.stringify({ values: Array.from(new Set(loadVals)) }, null, 2) + "\n" });
  if (tickVals.length) files.push({ path: `data/minecraft/tags/function/tick.json`, contents: JSON.stringify({ values: Array.from(new Set(tickVals)) }, null, 2) + "\n" });

  return { files, diagnostics, symbolIndex };
}

// ---------- Driver (lex/parse/generate) ----------
function compileSource(src: string) {
  let diagnostics: Diagnostic[] = [];
  let files: GeneratedFile[] = [];
  let symbols: SymbolIndex = { packs: {} };
  try {
    const tokens = lex(src);
    const { ast, diagnostics: d1 } = parse(tokens);
    diagnostics = diagnostics.concat(d1);
    if (ast) {
      const gen = generate(ast);
      files = gen.files;
      diagnostics = diagnostics.concat(gen.diagnostics);
      symbols = gen.symbolIndex;
    }
  } catch (e: any) {
    diagnostics.push({ severity: "Error", message: e?.message ?? "Unknown error", line: 0, col: 0 });
  }
  return { files, diagnostics, symbols };
}

// ---------- UI ----------

type FileNode = { path: string; contents: string };

function useDebounced<T>(val: T, delay = 250) {
  const [v, setV] = useState(val);
  useEffect(() => {
    const id = setTimeout(() => setV(val), delay);
    return () => clearTimeout(id);
  }, [val, delay]);
  return v;
}

const DEFAULT_SOURCE = `pack "Typed Demo" namespace typedemo{

  // Global typed variable
  global Ent test;

  func Load(){
    // pick nearest player entity selector and store as literal selector string
    test = Ent.Get("type=player,sort=nearest");
    Say($"Loaded. Using selector {test}");
  }

  func Tick(){
    // int math + Random
    int r = Random.value(1, 10);
    int a = Math.Min(r, 3);
    if (a == 3 && r >= 5) {
      Run($"/title @a actionbar Random={r} a={a}")
    }

    // arrays of ints and strings
    int[] nums = [1,2,3,4];
    string[] names = ["Alex","Steve"];

    // simple loop
    for (int i = 0 | i < 3 | i++){
      Say($"Loop i={i}")
    }
  }
}
`;

function downloadDatapackZip(files: FileNode[], zipName = "datapack.zip") {
  if (!files?.length) return;
  const zip = new JSZip();
  for (const f of files) {
    zip.file(f.path, f.contents ?? "");
  }
  zip.generateAsync({ type: "blob" }).then((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = zipName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });
}



export default function DatapackStudio() {
  const [code, setCode] = useState<string>(DEFAULT_SOURCE);
  const debounced = useDebounced(code, 200);
  const monaco = useMonaco();

   // Register language + tokens + config + completions
useEffect(() => {
  if (!monaco) return;

  // 1) Register language (idempotent)
  try {
    monaco.languages.register({ id: "datapack-lang" });
  } catch {}

  // 2) Monarch tokens (expanded)
  monaco.languages.setMonarchTokensProvider("datapack-lang", {
    tokenizer: {
      root: [
        // keywords / decls / stmts
        [/\b(pack|namespace|global|func|for|if|else|unless|Execute|Say|Run|adv|recipe|item|BlockTag|ItemTag|type|key|pattern|ingredient|result|title|description|desc|icon|parent|criterion|replace|values|base_id|components)\b/, "keyword"],
        // types
        [/\b(int|bool|string|float|double|Ent)(\[\])?\b/, "type"],
        // macro-strings $"..."
        [/\$"(?:[^"\\]|\\.)*"/, "string"],
        // normal strings
        [/"/, { token: "string.quote", next: "@string" }],
        // numbers
        [/[0-9]+(?:\.[0-9]+)?/, "number"],
        // comments
        [/\/\/.*/, "comment"],
        // punctuation
        [/[{}()\[\];,.:]/, "delimiter"],
        // operators
        [/[+\-*\/%]=?/, "operator"],
        [/==|!=|<=|>=|<|>|&&|\|\|/, "operator"],
        // identifiers (allow @ and selector-ish chars)
        [/[A-Za-z_@~^\[\]:.][A-Za-z0-9_@~^\[\]:.]*/, "identifier"],
      ],
      string: [
        [/[^"\\]+/, "string"],
        [/\\./, "string.escape"],
        [/"/, { token: "string.quote", next: "@pop" }],
      ],
    },
  });

  // 3) Language configuration: brackets, auto-close, quotes, onEnter rules
  monaco.languages.setLanguageConfiguration("datapack-lang", {
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"', notIn: ["string", "comment"] },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
    ],
    indentationRules: {
      increaseIndentPattern: /.*\{[^}"']*$/,
      decreaseIndentPattern: /^\s*\}.*$/,
    },
    onEnterRules: [
  {
    beforeText: /.*\{[^}"']*$/,
    afterText: /^\s*\}.*$/,
    action: { indentAction: monacoEditor.languages.IndentAction.IndentOutdent },
  },
  {
    beforeText: /.*\{[^}"']*$/,
    action: { indentAction: monacoEditor.languages.IndentAction.Indent },
  },
],

    autoCloseBefore: ";:.,=}]) \n\t",
  });

  // 4) IntelliSense (completions) — strongly typed range & list
  // 4) IntelliSense (completions) — strongly typed range & list
monaco.languages.registerCompletionItemProvider("datapack-lang", {
  triggerCharacters: [".", '"', "$", ":", "["],
  provideCompletionItems: (
    model,
    position
  ): monacoEditor.languages.ProviderResult<monacoEditor.languages.CompletionList> => {
    const word = model.getWordUntilPosition(position);
    const range: monacoEditor.IRange = {
      startLineNumber: position.lineNumber,
      startColumn: word.startColumn,
      endLineNumber: position.lineNumber,
      endColumn: word.endColumn,
    };

    const lineText = model.getLineContent(position.lineNumber);
    const uptoCursor = lineText.slice(0, position.column - 1);

    const asSnippet =
      monacoEditor.languages.CompletionItemInsertTextRule.InsertAsSnippet;

    const suggestions: monacoEditor.languages.CompletionItem[] = [];

    // Top-level keywords / snippets
    suggestions.push(
      {
        label: "pack",
        kind: monacoEditor.languages.CompletionItemKind.Keyword,
        insertTextRules: asSnippet,
        insertText: 'pack "${1:My Pack}" namespace ${2:myns}{\n\t$0\n}',
        range,
      },
      {
        label: "func",
        kind: monacoEditor.languages.CompletionItemKind.Keyword,
        insertTextRules: asSnippet,
        insertText: "func ${1:Name}(){\n\t$0\n}",
        range,
      },
      {
        label: "global",
        kind: monacoEditor.languages.CompletionItemKind.Keyword,
        insertText: "global int varName;",
        range,
      },
      {
        label: "if",
        kind: monacoEditor.languages.CompletionItemKind.Keyword,
        insertTextRules: asSnippet,
        insertText:
          "if (${1:a} == ${2:b}){\n\t$0\n} else {\n\t\n}",
        range,
      },
      {
        label: "unless",
        kind: monacoEditor.languages.CompletionItemKind.Keyword,
        insertTextRules: asSnippet,
        insertText: "unless (${1:a} == ${2:b}){\n\t$0\n}",
        range,
      },
      {
        label: "for",
        kind: monacoEditor.languages.CompletionItemKind.Keyword,
        insertTextRules: asSnippet,
        insertText:
          "for (int ${1:i} = 0 | ${1:i} < ${2:10} | ${1:i}++){\n\t$0\n}",
        range,
      },
      {
        label: "Execute",
        kind: monacoEditor.languages.CompletionItemKind.Keyword,
        insertTextRules: asSnippet,
        insertText: "Execute(){\n\t$0\n}",
        range,
      },
      {
        label: "Say",
        kind: monacoEditor.languages.CompletionItemKind.Function,
        insertTextRules: asSnippet,
        insertText: 'Say($"${1:Hello} ${2:name}")',
        range,
      },
      {
        label: "Run",
        kind: monacoEditor.languages.CompletionItemKind.Function,
        insertTextRules: asSnippet,
        insertText: 'Run($"/say ${1:hi}")',
        range,
      },
      {
        label: "adv",
        kind: monacoEditor.languages.CompletionItemKind.Keyword,
        insertTextRules: asSnippet,
        insertText: "adv ${1:name}(){\n\t$0\n}",
        range,
      },
      {
        label: "recipe",
        kind: monacoEditor.languages.CompletionItemKind.Keyword,
        insertTextRules: asSnippet,
        insertText:
          'recipe ${1:name}(){\n\ttype shaped;\n\tpattern ["${2:ABC}","${3:DEF}","${4:GHI}"];\n\tkey A = ${5:minecraft:stone};\n\tresult ${6:minecraft:stone} 1;\n}',
        range,
      },
      {
        label: "item",
        kind: monacoEditor.languages.CompletionItemKind.Keyword,
        insertTextRules: asSnippet,
        insertText:
          "item ${1:name}(){\n\tbase_id: ${2:minecraft:stone};\n\tcomponents: [${3:key}=${4:value}];\n}",
        range,
      },
      {
        label: "BlockTag",
        kind: monacoEditor.languages.CompletionItemKind.Keyword,
        insertTextRules: asSnippet,
        insertText:
          'BlockTag ${1:name}(){\n\treplace: ${2:false};\n\tvalues: ["${3:minecraft:stone}"];\n}',
        range,
      },
      {
        label: "ItemTag",
        kind: monacoEditor.languages.CompletionItemKind.Keyword,
        insertTextRules: asSnippet,
        insertText:
          'ItemTag ${1:name}(){\n\treplace: ${2:false};\n\tvalues: ["${3:minecraft:stone}"];\n}',
        range,
      }
    );

    // Execute modifiers
    ["as", "at", "positioned", "or"].forEach((m) =>
      suggestions.push({
        label: m,
        kind: monacoEditor.languages.CompletionItemKind.Operator,
        insertText: m,
        range,
      })
    );

    // Member completions after Math., Random., Ent.
    const endsWith = (s: string) => uptoCursor.endsWith(s);

    if (endsWith("Math.")) {
      ["Min", "Max", "Pow", "Root", "PI"].forEach((name) =>
        suggestions.push({
          label: `Math.${name}`,
          kind: monacoEditor.languages.CompletionItemKind.Function,
          insertTextRules: asSnippet,
          insertText:
            name === "PI"
              ? "PI()"
              : name === "Pow"
              ? "Pow(${1:base}, ${2:power})"
              : name === "Root"
              ? "Root(${1:value}, ${2:power})"
              : name + "(${1:a}, ${2:b})",
          range,
        })
      );
    }

    if (endsWith("Random.")) {
      suggestions.push({
        label: "Random.value",
        kind: monacoEditor.languages.CompletionItemKind.Function,
        insertTextRules: asSnippet,
        insertText: "value(${1:min}, ${2:max})",
        range,
      });
    }

    if (endsWith("Ent.")) {
      ["Get", "GetData"].forEach((name) =>
        suggestions.push({
          label: `Ent.${name}`,
          kind: monacoEditor.languages.CompletionItemKind.Function,
          insertTextRules: asSnippet,
          insertText:
            name === "Get"
              ? 'Get("${1:type=player,limit=1}")'
              : 'GetData(${1:ent}, "${2:Health}")',
          range,
        })
      );
    }

    // Common block properties
    [
      "title",
      "description",
      "desc",
      "icon",
      "parent",
      "criterion",
      "type",
      "ingredient",
      "pattern",
      "key",
      "result",
      "base_id",
      "components",
      "replace",
      "values",
    ].forEach((k) =>
      suggestions.push({
        label: k,
        kind: monacoEditor.languages.CompletionItemKind.Property,
        insertText: k,
        range,
      })
    );

    return { suggestions };
  },
});

}, [monaco]);


  const [files, setFiles] = useState<FileNode[]>([]);
  const [problems, setProblems] = useState<Diagnostic[]>([]);
  const [selectedPath, setSelectedPath] = useState<string>("");
  const editorRef = useRef<import("monaco-editor").editor.IStandaloneCodeEditor | null>(null);



  

  const [leftWidth, setLeftWidth] = useState<number>(() => {
  const v = Number(localStorage.getItem("leftWidth"));
  return Number.isFinite(v) && v >= 180 ? v : 220;  // was 280
});

const [bottomHeight, setBottomHeight] = useState<number>(() => {
  const v = Number(localStorage.getItem("bottomHeight"));
  return Number.isFinite(v) && v >= 120 ? v : 180;
});

// --- Height of the EDITOR area inside the right pane ---
const [editorHeight, setEditorHeight] = useState<number>(() => {
  const v = Number(localStorage.getItem("editorHeight"));
  return Number.isFinite(v) && v >= 120 ? v : 400; // default ~400px
});
useEffect(() => localStorage.setItem("editorHeight", String(editorHeight)), [editorHeight]);



useEffect(() => localStorage.setItem("leftWidth", String(leftWidth)), [leftWidth]);
useEffect(() => localStorage.setItem("bottomHeight", String(bottomHeight)), [bottomHeight]);

// dragging refs
const dragging = useRef<null | "vert" | "horiz" | "editor">(null);


useEffect(() => {
  function onMove(e: MouseEvent) {
  if (dragging.current === "vert") {
    // min 200, max 60% viewport
    const next = Math.min(Math.max(e.clientX, 200), window.innerWidth * 0.6);
    setLeftWidth(next);
  } else if (dragging.current === "horiz") {
    const viewportH = window.innerHeight;
    // bottom panel height from bottom drag-bar
    const next = Math.min(Math.max(viewportH - e.clientY, 120), viewportH * 0.8);
    setBottomHeight(next);
  } else if (dragging.current === "editor") {
    // resize the editor height inside the right pane
    const paneTop =
      (document.querySelector("#editorPane") as HTMLElement | null)?.getBoundingClientRect()
        ?.top ?? 0;
    // distance from top of the pane to the mouse
    const next = Math.min(Math.max(e.clientY - paneTop, 120), window.innerHeight * 0.8);
    setEditorHeight(next);
  }
}

  function onUp() { dragging.current = null; document.body.style.userSelect = ""; document.body.style.cursor = ""; }
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  return () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };
}, []);

const startDragVert = () => { dragging.current = "vert"; document.body.style.userSelect = "none"; document.body.style.cursor = "col-resize"; };
const startDragHoriz = () => { dragging.current = "horiz"; document.body.style.userSelect = "none"; document.body.style.cursor = "row-resize"; };

const startDragEditor = () => {
  dragging.current = "editor";
  document.body.style.userSelect = "none";
  document.body.style.cursor = "row-resize";
};


// Re-layout Monaco when sizes change
useEffect(() => {
  editorRef.current?.layout?.();
}, [leftWidth, bottomHeight, editorHeight]);


// Also do it on window resize (defensive)
useEffect(() => {
  const onResize = () => editorRef.current?.layout?.();
  window.addEventListener("resize", onResize);
  return () => window.removeEventListener("resize", onResize);
}, []);


  useEffect(() => {
    const { files, diagnostics } = compileSource(debounced);
    setFiles(files);
    setProblems(diagnostics);
    if (!selectedPath && files.length) setSelectedPath(files[0].path);

    // push markers into Monaco
const model = editorRef.current?.getModel?.();
if (monaco && model) {
  const markers: monacoEditor.editor.IMarkerData[] = diagnostics.map((d) => ({
    startLineNumber: Math.max(1, d.line || 1),
    startColumn: Math.max(1, d.col || 1),
    endLineNumber: Math.max(1, d.line || 1),
    endColumn: Math.max(1, (d.col || 1) + 1),
    message: d.message,
    severity:
      d.severity === "Error"
        ? monacoEditor.MarkerSeverity.Error
        : d.severity === "Warning"
        ? monacoEditor.MarkerSeverity.Warning
        : monacoEditor.MarkerSeverity.Info,
    source: "typed-datapack",
  }));

  // Use module setter (safe for types) with the model instance you already have
  monacoEditor.editor.setModelMarkers(model, "typed-datapack", markers);
}

  }, [debounced, monaco, selectedPath]);

  const onMount: OnMount = (editor, monacoInstance) => {
  editorRef.current = editor;
  // Ensure our custom language is applied even if the model is reused.
  try {
    const model = editor.getModel();
    if (model && monacoInstance) {
      monacoInstance.editor.setModelLanguage(model, "datapack-lang");
    }
  } catch {}
};



  const selectedFile = files.find(f => f.path === selectedPath);

  return (
    <div
  style={{
    display: "grid",
    gridTemplateColumns: `${leftWidth}px 6px minmax(0, 1fr)`,
    gridTemplateRows: `1fr 6px ${bottomHeight}px`,
    height: "100vh",
    background: "#111",
    overflow: "hidden",
  }}
>
  {/* File tree (left) */}
  <div
    style={{
      gridColumn: "1 / 2",
      gridRow: "1 / 4",
      borderRight: "1px solid #333",
      overflow: "auto",
      padding: 8,
      color: "#ddd",
    }}
  >
    <div style={{ fontWeight: 700, marginBottom: 8 }}>Files</div>
    {files.length === 0 ? (
      <div style={{ color: "#777" }}>No files (fix errors or type something)</div>
    ) : (
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {files.map((f) => (
          <li key={f.path} style={{ margin: "2px 0" }}>
            <button
              onClick={() => setSelectedPath(f.path)}
              style={{
                width: "100%",
                textAlign: "left",
                background: selectedPath === f.path ? "#1e1e1e" : "transparent",
                border: "1px solid #333",
                borderRadius: 6,
                padding: "6px 8px",
                color: "#ddd",
                cursor: "pointer",
              }}
            >
              {f.path}
            </button>
          </li>
        ))}
      </ul>
    )}
  </div>

  {/* Vertical splitter */}
  <div
    onMouseDown={startDragVert}
    style={{
      gridColumn: "2 / 3",
      gridRow: "1 / 4",
      cursor: "col-resize",
      background: "#181818",
    }}
  />

  {/* Editor + Preview (top-right) */}
  <div
    id="editorPane"
    style={{
      gridColumn: "3 / 4",
      gridRow: "1 / 2",
      display: "grid",
      gridTemplateRows: `${editorHeight}px 6px 1fr`, // editor | splitter | preview
      gap: 0,
      padding: 8,
      minWidth: 0,
      minHeight: 0,
    }}
  >
    {/* Editor */}
    <div style={{ border: "1px solid #333", minHeight: 0 }}>
      <Editor
        height="100%"
        defaultLanguage="datapack-lang"
        theme="vs-dark"
        value={code}
        onChange={(v) => setCode(v ?? "")}
        onMount={onMount}
        options={{
  fontSize: 14,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  wordWrap: "on",
  quickSuggestions: { other: true, comments: false, strings: true },
  suggestOnTriggerCharacters: true,
  tabCompletion: "on",
  snippetSuggestions: "inline",
  autoClosingBrackets: "languageDefined",
  autoClosingQuotes: "languageDefined",
  autoSurround: "languageDefined",
  autoIndent: "advanced",
}}

      />

      
    </div>

    {/* Editor/Preview splitter (row 2) */}
    <div
      onMouseDown={startDragEditor}
      style={{ height: 6, cursor: "row-resize", background: "#181818" }}
    />

    {/* Preview of selected file (row 3) */}
    <div
      style={{
        border: "1px solid #333",
        overflow: "auto",
        background: "#0b0b0b",
        minHeight: 0,
      }}
    >
      <div
        style={{
          padding: "6px 8px",
          borderBottom: "1px solid #222",
          color: "#bbb",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
        }}
      >
        <div>
          Preview: <code>{selectedFile?.path || "(none)"}</code>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div>{files.length} files</div>
          <button
            onClick={() => downloadDatapackZip(files)}
            style={{
              background: "#1e1e1e",
              border: "1px solid #444",
              borderRadius: 6,
              color: "#ddd",
              padding: "6px 10px",
              cursor: "pointer",
            }}
            disabled={!files.length}
            title={files.length ? "Download datapack.zip" : "No files to download"}
          >
            Download .zip
          </button>
        </div>
      </div>
      <pre
        style={{
          margin: 0,
          padding: 12,
          whiteSpace: "pre-wrap",
          color: "#ddd",
        }}
      >
        {selectedFile?.contents ?? ""}
      </pre>
    </div>
  </div>

  {/* Horizontal splitter */}
  <div
    onMouseDown={startDragHoriz}
    style={{
      gridColumn: "3 / 4",
      gridRow: "2 / 3",
      cursor: "row-resize",
      background: "#181818",
    }}
  />

  {/* Problems panel (bottom-right) */}
  <div
    style={{
      gridColumn: "3 / 4",
      gridRow: "3 / 4",
      borderTop: "1px solid #333",
      background: "#141414",
      color: "#ddd",
      overflow: "auto",
      minHeight: 0,
    }}
  >
    <div
      style={{
        padding: "6px 8px",
        borderBottom: "1px solid #222",
        display: "flex",
        justifyContent: "space-between",
      }}
    >
      <div>Problems</div>
      <div>{problems.length}</div>
    </div>
    {problems.length === 0 ? (
      <div style={{ padding: 8, color: "#7aa06a" }}>No problems</div>
    ) : (
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: 13,
        }}
      >
        <thead>
          <tr style={{ background: "#1c1c1c" }}>
            <th
              style={{
                textAlign: "left",
                padding: 6,
                borderBottom: "1px solid #333",
              }}
            >
              Severity
            </th>
            <th
              style={{
                textAlign: "left",
                padding: 6,
                borderBottom: "1px solid #333",
              }}
            >
              Message
            </th>
            <th
              style={{
                textAlign: "left",
                padding: 6,
                borderBottom: "1px solid #333",
              }}
            >
              Line
            </th>
            <th
              style={{
                textAlign: "left",
                padding: 6,
                borderBottom: "1px solid #333",
              }}
            >
              Col
            </th>
          </tr>
        </thead>
        <tbody>
          {problems.map((p, i) => (
            <tr key={i} style={{ borderBottom: "1px solid #222" }}>
              <td
                style={{
                  padding: 6,
                  color:
                    p.severity === "Error"
                      ? "#ff6b6b"
                      : p.severity === "Warning"
                      ? "#ffd56b"
                      : "#7aa0ff",
                }}
              >
                {p.severity}
              </td>
              <td style={{ padding: 6 }}>{p.message}</td>
              <td style={{ padding: 6 }}>{p.line ?? 0}</td>
              <td style={{ padding: 6 }}>{p.col ?? 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </div>
</div>

 );
}