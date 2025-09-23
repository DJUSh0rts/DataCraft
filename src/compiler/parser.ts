import type {
  Token, TokenType, Diagnostic,
  Script, PackDecl, FuncDecl, Stmt,
  VarDeclStmt, Expr, Condition, ItemDecl, RecipeDecl, AdvDecl, TagDecl,
  TypeName, RawCond, CmpCond, CmpOp, BoolCond
} from "./types";
/**
 * Recursive-descent parser for the DatapackScript language.
 * Produces AST + diagnostics (continues on errors where possible).
 */
export function parse(tokens: Token[]): { ast?: Script; diagnostics: Diagnostic[] } {
  let pos = 0;
  const diags: Diagnostic[] = [];

  // ------------- Core token helpers -------------
  const peek = (o = 0): Token => tokens[Math.min(pos + o, tokens.length - 1)];
  const match = (tt: TokenType): Token | null => (peek().type === tt ? tokens[pos++] : null);
  const expect = (tt: TokenType, what?: string): Token => {
    const t = peek();
    if (t.type === tt) { pos++; return t; }
    throw { message: `Expected ${what ?? tt} but found ${t.value ?? t.type}`, line: t.line, col: t.col };
  };

  // ------------- Types -------------
  function parseTypeName(): TypeName {
    const t = expect("Identifier", "type name");
    const baseLower = (t.value || "").toLowerCase();
    let array = false;
    if (peek().type === "LBracket" && tokens[pos + 1]?.type === "RBracket") { pos += 2; array = true; }
    const canonicalBase = baseLower === "ent" ? "Ent" : baseLower;
    const valid = ["string", "int", "float", "double", "bool", "Ent"];
    if (!valid.includes(canonicalBase)) {
      throw { message: `Unknown type '${t.value}'`, line: t.line, col: t.col };
    }
    return (canonicalBase + (array ? "[]":"")) as TypeName;
  }

  // ------------- Expressions -------------
  function parseArgList(): Expr[] {
    const args: Expr[] = [];
    expect("LParen", "'('");
    if (peek().type !== "RParen") {
      args.push(parseExpr());
      while (match("Comma")) args.push(parseExpr());
    }
    expect("RParen", "')'");
    return args;
  }

  function parseArrayLiteral(L: number, C: number): Expr {
    const items: Expr[] = [];
    while (peek().type !== "RBracket" && peek().type !== "EOF") {
      items.push(parseExpr());
      match("Comma");
    }
    expect("RBracket", "']'");
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
    // IMPORTANT: keep 'target' = idTok.value so Ent.Get(...) is recognized later
    return { kind: "CallExpr", target: idTok.value, name, args, line: idTok.line, col: idTok.col };
  } else {
    // Just a member access chain (rare in this language); keep as Member
    return parsePostfix({
      kind: "Member",
      object: { kind: "Var", name: idTok.value!, line: idTok.line, col: idTok.col },
      name: nameTok.value!, line: nameTok.line, col: nameTok.col
    });
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
  // Only extend with .member or .member(args) — and keep the target string if possible.
  while (peek().type === "Dot") {
    pos++;
    const nameTok = expect("Identifier", "member");
    const name = nameTok.value!;

    if (peek().type === "LParen") {
      // Turn obj.method(...) into CallExpr with target if obj is a Var (e.g., Ent.Get)
      const args = parseArgList();
      const target =
        base.kind === "Var" ? base.name :
        base.kind === "Member" && base.object.kind === "Var" ? base.object.name :
        undefined;

      // Keep 'target' so codegen can recognize Ent/Math/Random
      base = { kind: "CallExpr", target, name, args, line: nameTok.line, col: nameTok.col };
    } else {
      base = { kind: "Member", object: base, name, line: nameTok.line, col: nameTok.col };
    }
  }
  return base;
}


  function parseUnary(): Expr {
    if (match("Minus")) {
      const e = parseUnary();
      return {
        kind: "Binary",
        op: "-",
        left: { kind: "Number", value: 0, line: e.line, col: e.col },
        right: e,
        line: e.line, col: e.col
      };
    }
    return parsePrimary();
  }

  function parseMul(): Expr {
    let e = parseUnary();
    while (peek().type === "Star" || peek().type === "Slash" || peek().type === "Percent") {
      const opTok = peek(); pos++;
      const r = parseUnary();
      e = {
        kind: "Binary",
        op: opTok.type === "Star" ? "*" : opTok.type === "Slash" ? "/" : "%",
        left: e, right: r, line: opTok.line, col: opTok.col
      };
    }
    return e;
  }

  function parseAdd(): Expr {
    let e = parseMul();
    while (peek().type === "Plus" || peek().type === "Minus") {
      const opTok = peek(); pos++;
      const r = parseMul();
      e = {
        kind: "Binary",
        op: opTok.type === "Plus" ? "+" : "-",
        left: e, right: r, line: opTok.line, col: opTok.col
      };
    }
    return e;
  }

  function parseExpr(): Expr { return parseAdd(); }

  // ------------- Conditions -------------
  function parseCondCmp(): Condition | null {
    const t = peek();
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

  // ------------- Decls / Statements helpers -------------
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
    //   global <type> name [= expr] [;]
    //   <type> name [= expr] [;]
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
    match("Semicolon"); // optional
    return { kind: "VarDecl", isGlobal, varType, name, init: init ?? defaultInitFor(varType), line: first.line, col: first.col };
  }

  function parseAssignAfterName(nameTok: Token) {
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
    // default noop-assignment (keeps parser moving)
    return { kind: "Assign", name: nameTok.value!, op: "+=", expr: { kind: "Number", value: 0, line: nameTok.line, col: nameTok.col }, line: nameTok.line, col: nameTok.col } as Stmt;
  }

  // ------------- if / unless -------------
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
        elseBranch = { kind: "Else", body: eb, line: kw.line, col: kw.col } as any;
      }
    }

    return { kind: "If", negated: neg, cond, body, elseBranch, line: kw.line, col: kw.col } as Stmt;
  }

  // ------------- Execute -------------
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

  // ------------- For -------------
  function parseFor(): Stmt {
    const kw = expect("Identifier");
    if ((kw.value ?? "").toLowerCase() !== "for") {
      throw { message: "Expected 'for'", line: kw.line, col: kw.col };
    }
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
          if (peek().type === "PlusPlus" || peek().type === "MinusMinus" ||
              peek().type === "Equals" || peek().type === "PlusEquals" || peek().type === "MinusEquals" ||
              peek().type === "StarEquals" || peek().type === "SlashEquals" || peek().type === "PercentEquals") {
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
    return { kind: "For", init, cond, incr, body, line: kw.line, col: kw.col } as Stmt;
  }

  // ------------- Misc helpers for decls inside pack -------------
  function consumeBalancedBlock(): void {
    if (!match("LBrace")) return;
    let depth = 1;
    while (depth > 0 && peek().type !== "EOF") {
      const t = peek(); pos++;
      if (t.type === "LBrace") depth++;
      if (t.type === "RBrace") depth--;
    }
  }

  // ------------- Statement dispatcher -------------
  function parseAssignOrCallOrSayRun(): Stmt | null {
    const t = expect("Identifier"); const low = (t.value ?? "").toLowerCase();
    if (low === "run") { expect("LParen"); const expr = parseExpr(); expect("RParen"); match("Semicolon"); return { kind: "Run", expr } as Stmt; }
    if (low === "say") { expect("LParen"); const expr = parseExpr(); expect("RParen"); match("Semicolon"); return { kind: "Say", expr } as Stmt; }

    if (low === "global") {
      const nxt = peek();
      if (nxt.type === "Identifier") {
        const d = parseVarDecl(true); return d as unknown as Stmt;
      }
      diags.push({ severity: "Error", message: `Expected type after 'global'`, line: t.line, col: t.col });
      return null;
    }

    if (low === "var" || low === "let") {
      const d = parseVarDecl(false);
      diags.push({ severity: "Error", message: `Use typed declarations instead of 'var/let'`, line: t.line, col: t.col });
      return d as unknown as Stmt;
    }

    if (low === "adv" || low === "recipe" || low === "item" || low === "blocktag" || low === "itemtag") {
      // Not allowed inside functions — consume to recover
      diags.push({ severity: "Error", message: `${t.value} not allowed inside functions`, line: t.line, col: t.col });
      if (peek().type !== "LBrace") { while (peek().type !== "LBrace" && peek().type !== "EOF") pos++; }
      consumeBalancedBlock();
      return null;
    }

    const nameTok = t;
    if (peek().type === "PlusPlus" || peek().type === "MinusMinus" ||
        peek().type === "Equals" || peek().type === "PlusEquals" || peek().type === "MinusEquals" ||
        peek().type === "StarEquals" || peek().type === "SlashEquals" || peek().type === "PercentEquals") {
      return parseAssignAfterName(nameTok);
    }

    if (match("LParen")) {
      expect("RParen"); match("Semicolon");
      return { kind: "Call", func: nameTok.value!, line: t.line, col: t.col } as Stmt;
    }

    if (match("Dot")) {
      const funcName = expect("Identifier").value!; expect("LParen"); expect("RParen"); match("Semicolon");
      return { kind: "Call", targetPack: nameTok.value!, func: funcName, line: t.line, col: t.col } as Stmt;
    }

    diags.push({ severity: "Error", message: `Unknown statement '${nameTok.value}'`, line: t.line, col: t.col });
    return null;
  }

  function parseStmt(): Stmt | null {
    const t = peek();
    if (t.type === "Identifier") {
      const low = (t.value ?? "").toLowerCase();
      if (low === "execute") return parseExecute();
      if (low === "if" || low === "unless") return parseIfUnless();
      if (low === "for") return parseFor();
      return parseAssignOrCallOrSayRun();
    }
    if (t.type === "RBrace") return null;

    diags.push({ severity: "Error", message: `Unexpected '${t.value ?? t.type}'`, line: t.line, col: t.col });
    while (peek().type !== "Semicolon" && peek().type !== "RBrace" && peek().type !== "EOF") pos++;
    match("Semicolon");
    return null;
  }

  // ------------- Function -------------
  function parseFunc(): FuncDecl {
    const kw = expect("Identifier"); // func
    if ((kw.value ?? "").toLowerCase() !== "func") {
      throw { message: "Expected 'func'", line: kw.line, col: kw.col };
    }
    const name = expect("Identifier", "function name").value!;
    // Accept optional () for `func Name(){...}`
    if (match("LParen")) expect("RParen");
    expect("LBrace");
    const body: Stmt[] = [];
    while (peek().type !== "RBrace" && peek().type !== "EOF") {
      const s = parseStmt();
      if (s) body.push(s);
    }
    expect("RBrace");
    return { name: name.toLowerCase(), nameOriginal: name, body } as FuncDecl;
  }

  // ------------- Pack -------------
  function parsePack(): PackDecl {
    const kw = expect("Identifier"); // pack
    if ((kw.value ?? "").toLowerCase() !== "pack") {
      throw { message: "Expected 'pack'", line: kw.line, col: kw.col };
    }

    // Grammar: pack "Title" namespace myns { ... }
    const titleTok = expect("String", "pack title");
    const nsKw = expect("Identifier", "'namespace' keyword");
    if ((nsKw.value ?? "").toLowerCase() !== "namespace") {
      throw { message: "Expected 'namespace' after pack title", line: nsKw.line, col: nsKw.col };
    }
    const nsTok = expect("Identifier", "namespace id");
    const packTitle = titleTok.value ?? "";
    const namespace = nsTok.value ?? "";

    expect("LBrace");

    const globals: VarDeclStmt[] = [];
    const funcs: FuncDecl[] = [];
    const advs: AdvDecl[] = [];
    const recipes: RecipeDecl[] = [];
    const items: ItemDecl[] = [];
    const tags: TagDecl[] = [];

    while (peek().type !== "RBrace" && peek().type !== "EOF") {
      const t = peek();
      if (t.type === "Identifier") {
        const low = (t.value ?? "").toLowerCase();

        if (low === "global") { pos++; const decl = parseVarDecl(true); globals.push(decl); continue; }
        if (["string","int","float","double","bool","ent","string[]","int[]","float[]","double[]","bool[]","ent[]"].includes(low)) {
          const decl = parseVarDecl(true); globals.push(decl); continue;
        }
        if (low === "func") { funcs.push(parseFunc()); continue; }

        // Minimal stubs so parser doesn't blow up on these:
        if (low === "adv") {
          pos++;
          const nameTok = expect("Identifier", "advancement name");
          consumeBalancedBlock();
          advs.push({ kind: "Adv", name: nameTok.value!, props: { title: "", description: "", icon: "minecraft:paper", criteria: [] }, line: t.line, col: t.col } as any);
          continue;
        }
        if (low === "recipe") {
          pos++;
          const nameTok = expect("Identifier", "recipe name");
          consumeBalancedBlock();
          recipes.push({ kind: "Recipe", name: nameTok.value!, type: "shapeless", ingredients: [], line: t.line, col: t.col } as any);
          continue;
        }
        if (low === "item") {
          pos++;
          const nameTok = expect("Identifier", "item name");
          consumeBalancedBlock();
          items.push({ kind: "Item", name: nameTok.value!, baseId: "minecraft:stone", componentTokens: [], line: t.line, col: t.col } as any);
          continue;
        }
        if (low === "blocktag" || low === "itemtag") {
          pos++;
          const nameTok = expect("Identifier", "tag name");
          consumeBalancedBlock();
          tags.push({ kind: "Tag", category: low === "blocktag" ? "blocks" : "items", name: nameTok.value!, replace: false, values: [], line: t.line, col: t.col } as any);
          continue;
        }

        // Fallback: treat as global decl attempt
        try {
          const decl = parseVarDecl(true);
          globals.push(decl);
          continue;
        } catch (e: any) {
          diags.push({ severity: "Error", message: e?.message ?? `Unexpected token '${t.value ?? t.type}' in pack`, line: t.line, col: t.col });
          pos++;
        }
      } else {
        diags.push({ severity: "Error", message: `Unexpected '${t.value ?? t.type}' in pack`, line: t.line, col: t.col });
        pos++;
      }
    }

    expect("RBrace");
    return { packTitle, namespace: (namespace || "").toLowerCase(), namespaceOriginal: namespace, globals, functions: funcs, advs, recipes, items, tags } as PackDecl;
  }

  // ------------- Top-level -------------
  const packs: PackDecl[] = [];
  while (peek().type !== "EOF") {
    const t = peek();
    if (t.type === "Identifier" && (t.value ?? "").toLowerCase() === "pack") {
      packs.push(parsePack());
    } else {
      diags.push({ severity: "Error", message: `Unexpected top-level token '${t.value ?? t.type}', expected 'pack'`, line: t.line, col: t.col });
      pos++;
    }
  }

  return { ast: { packs }, diagnostics: diags };
}
