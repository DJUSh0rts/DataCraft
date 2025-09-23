// src/compiler/parser.ts
import type {
  Token,
  Diagnostic,
  Script,
  PackDecl,
  FuncDecl,
  Stmt,
  SayStmt,
  RunStmt,
  Expr,
  StringExpr,
} from "./types";

type ParseResult = { ast: Script; diagnostics: Diagnostic[] };

export function parse(tokens: Token[]): ParseResult {
  const diagnostics: Diagnostic[] = [];
  let pos = 0;

  const eof = () => peek().type === "EOF";
  const peek = (o = 0) => tokens[Math.min(pos + o, tokens.length - 1)];
  const isId = (t = peek()) => t.type === "Identifier";
  const isKw = (kw: string) => isId() && (peek().value ?? "").toLowerCase() === kw.toLowerCase();
  const match = (type: Token["type"]): Token | null => (peek().type === type ? tokens[pos++] : null);
  const expect = (type: Token["type"], what?: string): Token => {
    const t = peek();
    if (t.type === type) { pos++; return t; }
    diagnostics.push({
      severity: "Error",
      message: `Expected ${what ?? type} but found ${t.value ?? t.type}`,
      line: t.line,
      col: t.col,
    });
    pos++;
    return { ...t, type } as Token;
  };

  // --- expressions (only string literals for now) ---
  function parseExpr(): Expr {
    const t = peek();
    if (t.type === "String") {
      pos++;
      return { kind: "String", value: t.value ?? "", line: t.line, col: t.col } as StringExpr;
    }
    diagnostics.push({
      severity: "Warning",
      message: `Only string literals are supported in this minimal parser.`,
      line: t.line, col: t.col,
    });
    pos++;
    return { kind: "String", value: String(t.value ?? t.type), line: t.line, col: t.col } as StringExpr;
  }

  // --- statements ---
  function parseStmt(): Stmt | null {
    if (isKw("say")) {
      const kw = peek(); pos++;
      expect("LParen", "'(' after Say");
      const e = parseExpr();
      expect("RParen", "')' after Say(...)");
      match("Semicolon");
      return { kind: "Say", expr: e } as SayStmt;
    }
    if (isKw("run")) {
      const kw = peek(); pos++;
      expect("LParen", "'(' after Run");
      const e = parseExpr();
      expect("RParen", "')' after Run(...)");
      match("Semicolon");
      return { kind: "Run", expr: e } as RunStmt;
    }

    const t = peek();
    diagnostics.push({
      severity: "Warning",
      message: `Unknown statement '${t.value ?? t.type}', skipping`,
      line: t.line, col: t.col,
    });
    pos++;
    return null;
  }

  // --- function ---
  function parseFunc(): FuncDecl {
    const fk = expect("Identifier", "'func'");
    if ((fk.value ?? "").toLowerCase() !== "func") {
      diagnostics.push({ severity: "Error", message: `Expected 'func'`, line: fk.line, col: fk.col });
    }
    const nameTok = expect("Identifier", "function name");
    expect("LParen", "'(' after function name");
    expect("RParen", "')' after function name");
    expect("LBrace", "'{' to open function body");

    const body: Stmt[] = [];
    while (!eof() && peek().type !== "RBrace") {
      const s = parseStmt();
      if (s) body.push(s);
    }
    expect("RBrace", "'}' to close function body");

    return { name: nameTok.value ?? "unnamed", nameOriginal: nameTok.value ?? "unnamed", body };
  }

  // --- pack ---
  function parsePack(): PackDecl {
    const pk = expect("Identifier", "'pack'");
    if ((pk.value ?? "").toLowerCase() !== "pack") {
      diagnostics.push({ severity: "Error", message: `Expected 'pack'`, line: pk.line, col: pk.col });
    }
    const titleTok = expect("String", 'pack title string (e.g. "My Pack")');
    const nsKw = expect("Identifier", "'namespace'");
    if ((nsKw.value ?? "").toLowerCase() !== "namespace") {
      diagnostics.push({ severity: "Error", message: `Expected 'namespace'`, line: nsKw.line, col: nsKw.col });
    }
    const nsTok = expect("Identifier", "namespace id");
    expect("LBrace", "'{' to open pack body");

    const funcs: FuncDecl[] = [];
    while (!eof() && peek().type !== "RBrace") {
      if (isKw("func")) {
        funcs.push(parseFunc());
        continue;
      }
      const t = peek();
      diagnostics.push({
        severity: "Warning",
        message: `Unknown top-level '${t.value ?? t.type}', skipping`,
        line: t.line, col: t.col,
      });
      pos++;
    }
    expect("RBrace", "'}' to close pack body");

    const pack: PackDecl = {
      packTitle: titleTok.value ?? "Pack",
      namespace: (nsTok.value ?? "default").toLowerCase(),
      namespaceOriginal: nsTok.value ?? "default",
      globals: [],
      functions: funcs,
      advs: [],
      recipes: [],
      items: [],
      tags: [],
    };
    return pack;
  }

  // --- program ---
  const packs: PackDecl[] = [];
  while (!eof()) {
    if (isKw("pack")) {
      packs.push(parsePack());
    } else if (peek().type === "EOF") {
      break;
    } else {
      const t = peek();
      diagnostics.push({
        severity: "Warning",
        message: `Unexpected token '${t.value ?? t.type}' before any 'pack', skipping`,
        line: t.line, col: t.col,
      });
      pos++;
    }
  }

  if (packs.length === 0) {
    packs.push({
      packTitle: "Default Pack",
      namespace: "default",
      namespaceOriginal: "default",
      globals: [],
      functions: [],
      advs: [],
      recipes: [],
      items: [],
      tags: [],
    });
  }

  return { ast: { packs }, diagnostics };
}
