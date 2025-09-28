import type {
  Token, TokenType, Diagnostic,
  Script, PackDecl, FuncDecl, Stmt,
  VarDeclStmt, Expr, Condition, ItemDecl, RecipeDecl, AdvDecl, TagDecl,
  TypeName, RawCond, CmpCond, CmpOp, BoolCond, ElseBlock, WhileStmt
} from "./types";
/**
 * Recursive-descent parser for the DatapackScript language.
 */
export function parse(tokens: Token[]): { ast?: Script; diagnostics: Diagnostic[] } {
  let pos = 0;
  const diags: Diagnostic[] = [];

  const peek = (o = 0): Token => tokens[Math.min(pos + o, tokens.length - 1)];
  const match = (tt: TokenType): Token | null => (peek().type === tt ? tokens[pos++] : null);
  const expect = (tt: TokenType, what?: string): Token => {
    const t = peek();
    if (t.type === tt) { pos++; return t; }
    throw { message: `Expected ${what ?? tt} but found ${t.value ?? t.type}`, line: t.line, col: t.col };
  };

  // ---------- Types ----------
  function parseTypeName(): TypeName {
    const t = expect("Identifier", "type name");
    const baseLower = (t.value || "").toLowerCase();
    let array = false;
    if (peek().type === "LBracket" && tokens[pos + 1]?.type === "RBracket") { pos += 2; array = true; }
    const canonicalBase = baseLower === "ent" ? "Ent" : baseLower;
    const valid = ["string","int","float","double","bool","Ent"];
    if (!valid.includes(canonicalBase)) {
      throw { message: `Unknown type '${t.value}'`, line: t.line, col: t.col };
    }
    return (canonicalBase + (array ? "[]":"")) as TypeName;
  }

  // ---------- Expressions ----------
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

  // ---------- Conditions ----------
  function parseCondCmp(): Condition | null {
    const t = peek();
    // String (including macro-strings) used as raw execute condition snippet
    if (t.type === "String") { pos++; return { kind: "Raw", raw: t.value!, line: t.line, col: t.col } as RawCond; }
    const left = parseExpr();
    const opTok = peek();
    const map: Record<TokenType, CmpOp> = { EqEq: "==", BangEq: "!=", Lt: "<", Le: "<=", Gt: ">", Ge: ">=" } as any;
    if (!(opTok.type in map)) {
      diags.push({ severity: "Error", message: "Expected comparison operator (==, !=, <, <=, >, >=)", line: opTok.line, col: opTok.col });
      return null;
    }
    pos++;
    const right = parseExpr();
    return { kind: "Cmp", op: map[opTok.type], left, right, line: opTok.line, col: opTok.col } as CmpCond;
  }
  function parseCondAnd(): Condition | null {
    let left = parseCondCmp();
    while (peek().type === "AndAnd") {
      const t = expect("AndAnd");
      const right = parseCondCmp();
      if (!left || !right) return left ?? right;
      left = { kind: "Bool", op: "&&", left, right, line: t.line, col: t.col } as BoolCond;
    }
    return left;
  }
  function parseCondition(): Condition | null {
    let left = parseCondAnd();
    while (peek().type === "OrOr") {
      const t = expect("OrOr");
      const right = parseCondAnd();
      if (!left || !right) return left ?? right;
      left = { kind: "Bool", op: "||", left, right, line: t.line, col: t.col } as BoolCond;
    }
    return left;
  }

  // ---------- Decls ----------
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
    // forms:  global <type> name [= expr] [;]   |   <type> name [= expr] [;]
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
    if (match("Equals")) init = parseExpr();
    match("Semicolon"); // optional
    return { kind: "VarDecl", isGlobal, varType, name, init: init ?? defaultInitFor(varType), line: first.line, col: first.col };
  }

  function parseAssignAfterName(nameTok: Token): Stmt {
    if (match("PlusPlus")) return { kind: "Assign", name: nameTok.value!, op: "+=", expr: { kind: "Number", value: 1, line: nameTok.line, col: nameTok.col }, line: nameTok.line, col: nameTok.col } as Stmt;
    if (match("MinusMinus")) return { kind: "Assign", name: nameTok.value!, op: "-=", expr: { kind: "Number", value: 1, line: nameTok.line, col: nameTok.col }, line: nameTok.line, col: nameTok.col } as Stmt;
    const nt = peek().type;
    if (nt === "Equals" || nt === "PlusEquals" || nt === "MinusEquals" || nt === "StarEquals" || nt === "SlashEquals" || nt === "PercentEquals") {
      pos++;
      const op = (nt === "Equals" ? "=" :
        nt === "PlusEquals" ? "+=" :
          nt === "MinusEquals" ? "-=" :
            nt === "StarEquals" ? "*=" :
              nt === "SlashEquals" ? "/=" : "%=") as any;
      const expr = parseExpr(); match("Semicolon");
      return { kind: "Assign", name: nameTok.value!, op, expr, line: nameTok.line, col: nameTok.col } as Stmt;
    }
    // default noop-assignment (rare recovery path)
    return { kind: "Assign", name: nameTok.value!, op: "+=", expr: { kind: "Number", value: 0, line: nameTok.line, col: nameTok.col }, line: nameTok.line, col: nameTok.col } as Stmt;
  }

  // ---------- If / Unless ----------
  function parseIfUnless(): Stmt {
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
    let elseBranch: any = null;
    if (peek().type === "Identifier" && (peek().value?.toLowerCase() === "else")) {
      pos++; // 'else'
      if (peek().type === "Identifier" && (peek().value?.toLowerCase() === "if" || peek().value?.toLowerCase() === "unless")) {
        elseBranch = parseIfUnless(); // else if / else unless
      } else {
        expect("LBrace");
        const eb: Stmt[] = [];
        while (peek().type !== "RBrace" && peek().type !== "EOF") { const s = parseStmt(); if (s) eb.push(s); }
        expect("RBrace");
        elseBranch = { kind: "Else", body: eb, line: kw.line, col: kw.col } as ElseBlock;
      }
    }

    return { kind: "If", negated: neg, cond, body, elseBranch, line: kw.line, col: kw.col } as Stmt;
  }

  // ---------- Execute ----------
  function parseExecute(): Stmt {
    const kw = expect("Identifier"); if ((kw.value ?? "").toLowerCase() !== "execute") throw { message: `Expected 'Execute'`, line: kw.line, col: kw.col };
    expect("LParen");
    const variants: any[] = [];
    let current: any = { mods: [] };
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
    return { kind: "Execute", variants, body } as Stmt;
  }

  // ---------- While ----------
  function parseWhile(): WhileStmt {
    const kw = expect("Identifier"); // while
    if ((kw.value ?? "").toLowerCase() !== "while") {
      throw { message: "Expected 'while'", line: kw.line, col: kw.col };
    }
    expect("LParen");
    let cond: Condition | null = null;
    if (peek().type !== "RParen") cond = parseCondition();
    expect("RParen");

    expect("LBrace");
    const body: Stmt[] = [];
    while (peek().type !== "RBrace" && peek().type !== "EOF") {
      const s = parseStmt();
      if (s) body.push(s);
    }
    expect("RBrace");
    return { kind: "While", cond, body, line: kw.line, col: kw.col };
  }

  // ---------- For ----------
  function parseFor(): Stmt {
    expect("Identifier"); // for
    expect("LParen");

    // init
    let init: any = null;
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
    let incr: any = null;
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
    return { kind: "For", init, cond, incr, body, line: 0, col: 0 } as Stmt;
  }

  // ---------- Adv / Recipe / Item / Tag ----------
  function parseStringArrayInBrackets(expectFn = expect, matchFn = match, peekFn = peek): string[] {
    const rows: string[] = [];
    expectFn("LBracket");
    while (peekFn().type !== "RBracket") {
      const s = expectFn("String", "string");
      rows.push(s.value ?? "");
      matchFn("Comma");
    }
    expectFn("RBracket");
    return rows;
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
        const rows = parseStringArrayInBrackets();
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
        const idTok = expect("Identifier");
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
    const category: TagDecl["category"] = head === "blocktag" ? "blocks" : head === "itemtag" ? "items" : "blocks";

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

    return { kind: "Tag", category, name, replace, values, line: kw.line, col: kw.col };
  }

  // ---------- Statement dispatcher ----------
  function parseAssignOrCallOrSayRun(): Stmt | null {
    const t = expect("Identifier"); const low = (t.value ?? "").toLowerCase();
    if (low === "run") { expect("LParen"); const expr = parseExpr(); expect("RParen"); match("Semicolon"); return { kind: "Run", expr } as Stmt; }
    if (low === "say") { expect("LParen"); const expr = parseExpr(); expect("RParen"); match("Semicolon"); return { kind: "Say", expr } as Stmt; }

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
      // Consume balanced block to recover:
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
      return { kind: "Call", targetPack: nameTok.value!, func: funcName, line: t.line, col: t.col } as Stmt;
    } else {
      if (!match("LParen")) { diags.push({ severity: "Error", message: `Unknown statement '${nameTok.value}'`, line: t.line, col: t.col }); return null; }
      expect("RParen"); match("Semicolon");
      return { kind: "Call", func: nameTok.value!, line: t.line, col: t.col } as Stmt;
    }
  }

  function parseStmt(): Stmt | null {
    const t = peek();
    if (t.type === "Identifier") {
      const low = (t.value ?? "").toLowerCase();
      if (low === "execute") return parseExecute();
      if (low === "if" || low === "unless") return parseIfUnless();
      if (low === "for") return parseFor();
      if (low === "while") return parseWhile();
      return parseAssignOrCallOrSayRun();
    }
    if (t.type === "RBrace") return null;

    diags.push({ severity: "Error", message: `Unexpected '${t.value ?? t.type}'`, line: t.line, col: t.col });
    while (peek().type !== "Semicolon" && peek().type !== "RBrace" && peek().type !== "EOF") pos++;
    match("Semicolon");
    return null;
  }

  // ---------- Function ----------
  function parseFunc(): FuncDecl {
    const kw = expect("Identifier"); if (kw.value !== "func") throw { message: `Expected 'func'`, line: kw.line, col: kw.col };
    const nameTok = expect("Identifier"); const nameOriginal = nameTok.value!; const lowered = nameOriginal.toLowerCase();
    expect("LParen"); expect("RParen"); expect("LBrace");
    const body: Stmt[] = [];
    while (peek().type !== "RBrace" && peek().type !== "EOF") { const s = parseStmt(); if (s) body.push(s); }
    expect("RBrace");
    return { name: lowered, nameOriginal, body };
  }

  // ---------- Pack ----------
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

  // ---------- Top-level ----------
  const packs: PackDecl[] = [];
  try {
    while (peek().type !== "EOF") { packs.push(parsePack()); }
    return { ast: { packs }, diagnostics: diags };
  } catch (e: any) {
    diags.push({ severity: "Error", message: e.message || "Parse error", line: e.line ?? 0, col: e.col ?? 0 });
    return { diagnostics: diags };
  }
}
