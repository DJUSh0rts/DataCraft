import { useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import Editor, { useMonaco } from "@monaco-editor/react";
import './monaco-setup';


// =============================
// Multi-Pack Datapack Web Compiler
// - Multiple `pack ... { }` blocks (class-like)
// - Pack-scope variables (var/let)
// - Functions per pack
// - Cross-pack calls: `util.Ping()` or intra-pack `Ping()`
// - Say("text" + Var)
// - Simple IntelliSense via Monaco (keywords, pack names, functions, vars)
// - Nicer UI
// =============================

// ---------- Types ----------
type TokenType =
  | "Identifier"
  | "String"
  | "LBrace"
  | "RBrace"
  | "LParen"
  | "RParen"
  | "Semicolon"
  | "Comma"
  | "Plus"
  | "Equals"
  | "Dot"
  | "EOF";

type Token = { type: TokenType; value?: string; line: number; col: number };

type Diagnostic = { severity: "Error" | "Warning" | "Info"; message: string; line: number; col: number };

// Expressions
type StringExpr = { kind: "String"; value: string; line: number; col: number };
type VarExpr = { kind: "Var"; name: string; line: number; col: number };
type ConcatExpr = { kind: "Concat"; left: Expr; right: Expr };
type Expr = StringExpr | VarExpr | ConcatExpr;

// Statements
type SayStmt = { kind: "Say"; expr: Expr };
type VarDeclStmt = { kind: "VarDecl"; name: string; init: Expr; line: number; col: number };
type CallStmt = { kind: "Call"; targetPack?: string; func: string; line: number; col: number };
type Stmt = SayStmt | VarDeclStmt | CallStmt;

// Decls
type FuncDecl = { name: string; nameOriginal: string; body: Stmt[] };
type PackDecl = { packTitle: string; namespace: string; namespaceOriginal: string; globals: VarDeclStmt[]; functions: FuncDecl[] };
type Script = { packs: PackDecl[] };

type GeneratedFile = { path: string; contents: string };

// Used in compile() signatures; define early to avoid any tooling complaints.
type SymbolIndex = { packs: Record<string, { title: string; vars: Set<string>; funcs: Set<string> }> };

// ---------- Lexer ----------
function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0, line = 1, col = 1;
  const push = (t: Token) => tokens.push(t);

  while (i < input.length) {
    const ch = input[i];

    // newline
    if (ch === "\n") { i++; line++; col = 1; continue; }

    // whitespace
    if (ch === " " || ch === "\t" || ch === "\r") { i++; col++; continue; }

    // line comments
    if (ch === "/" && input[i + 1] === "/") { while (i < input.length && input[i] !== "\n") i++; continue; }

    // strings
    if (ch === "\"") {
      let j = i + 1; let text = ""; const strLine = line, strCol = col;
      while (j < input.length) {
        const c = input[j];
        if (c === "\\") {
          const n = input[j + 1];
          if (n === "\"" || n === "\\" || n === "n" || n === "t") {
            text += n === "n" ? "\n" : n === "t" ? "\t" : n;
            j += 2; col += 2; continue;
          }
        }
        if (c === "\"") { j++; col++; break; }
        if (c === "\n") { line++; col = 1; } else { col++; }
        text += c; j++;
      }
      push({ type: "String", value: text, line: strLine, col: strCol }); i = j; continue;
    }

    // identifiers
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1; while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) j++;
      const ident = input.slice(i, j);
      push({ type: "Identifier", value: ident, line, col }); col += (j - i); i = j; continue;
    }

    // symbols
    const sym: Record<string, TokenType> = {
      "{": "LBrace", "}": "RBrace", "(": "LParen", ")": "RParen",
      ";": "Semicolon", ",": "Comma", "+": "Plus", "=": "Equals", ".": "Dot"
    };
    if (sym[ch]) { push({ type: sym[ch], line, col }); i++; col++; continue; }

    throw { message: `Unexpected character '${ch}'`, line, col };
  }
  push({ type: "EOF", line, col });
  return tokens;
}

// ---------- Parser ----------
function parse(tokens: Token[]): { ast?: Script; diagnostics: Diagnostic[] } {
  let pos = 0; const diags: Diagnostic[] = [];
  const peek = (o = 0): Token => tokens[Math.min(pos + o, tokens.length - 1)];
  const match = (type: TokenType, value?: string): Token | null => { const t = peek(); if (t.type !== type) return null; if (value !== undefined && t.value !== value) return null; pos++; return t; };
  const expect = (type: TokenType, value?: string): Token => { const t = peek(); if (t.type === type && (value === undefined || t.value === value)) { pos++; return t; } throw { message: `Expected ${value ?? type} but found ${t.value ?? t.type}`, line: t.line, col: t.col }; };

  function parseExprPrimary(): Expr {
    const t = peek();
    if (t.type === "String") { pos++; return { kind: "String", value: t.value!, line: t.line, col: t.col }; }
    if (t.type === "Identifier") { pos++; return { kind: "Var", name: t.value!, line: t.line, col: t.col }; }
    throw { message: `Unexpected token in expression: ${t.value ?? t.type}`, line: t.line, col: t.col };
  }
  function parseExpr(): Expr {
    let e = parseExprPrimary();
    while (peek().type === "Plus") { pos++; const r = parseExprPrimary(); e = { kind: "Concat", left: e, right: r }; }
    return e;
  }

  function parseVarDecl(): VarDeclStmt {
    const kw = expect("Identifier"); const low = kw.value!.toLowerCase();
    if (low !== "var" && low !== "let") throw { message: `Expected 'var' or 'let'`, line: kw.line, col: kw.col };
    const name = expect("Identifier").value!; expect("Equals"); const init = parseExpr(); match("Semicolon");
    return { kind: "VarDecl", name, init, line: kw.line, col: kw.col };
  }

  function parseStmt(): Stmt | null {
    const t = peek();
    if (t.type === "Identifier") {
      // Say(...)
      if (t.value === "Say" || t.value === "say") { pos++; expect("LParen"); const expr = parseExpr(); expect("RParen"); match("Semicolon"); return { kind: "Say", expr }; }
      // var/let
      if (t.value === "var" || t.value === "let") { return parseVarDecl(); }
      // Calls: Pack.Func() or Func()
      const id1 = expect("Identifier").value!;
      if (match("Dot")) {
        const funcName = expect("Identifier").value!; expect("LParen"); expect("RParen"); match("Semicolon");
        return { kind: "Call", targetPack: id1, func: funcName, line: t.line, col: t.col };
      } else {
        if (!match("LParen")) { diags.push({ severity: "Error", message: `Unknown statement '${id1}'`, line: t.line, col: t.col }); return null; }
        expect("RParen"); match("Semicolon");
        return { kind: "Call", func: id1, line: t.line, col: t.col };
      }
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
      if (t.type === "Identifier" && (t.value === "var" || t.value === "let")) { globals.push(parseVarDecl()); continue; }
      if (t.type === "Identifier" && t.value === "func") { funcs.push(parseFunc()); continue; }
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

function evalExprString(expr: Expr, varEnv: Record<string, string>, diags: Diagnostic[]): string | undefined {
  switch (expr.kind) {
    case "String": return expr.value;
    case "Var": {
      const v = varEnv[expr.name];
      if (v === undefined) { diags.push({ severity: "Error", message: `Unknown variable '${expr.name}'`, line: expr.line, col: expr.col }); return undefined; }
      return v;
    }
    case "Concat": {
      const l = evalExprString(expr.left, varEnv, diags);
      const r = evalExprString(expr.right, varEnv, diags);
      if (l === undefined || r === undefined) return undefined;
      return l + r;
    }
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

function generate(ast: Script): { files: GeneratedFile[]; diagnostics: Diagnostic[]; symbolIndex: SymbolIndex } {
  const diagnostics: Diagnostic[] = [];
  const files: GeneratedFile[] = [];

  const description = ast.packs[0]?.packTitle ?? "Datapack";
  files.push({ path: `pack.mcmeta`, contents: JSON.stringify({ pack: { pack_format: PACK_FORMAT, description } }, null, 2) + "\n" });

  const symbolIndex: SymbolIndex = { packs: {} };
  for (const p of ast.packs) {
    symbolIndex.packs[p.namespace] = { title: p.packTitle, vars: new Set(p.globals.map(g => g.name)), funcs: new Set(p.functions.map(f => f.name)) };
  }

  for (const p of ast.packs) {
    const env: Record<string, string> = {};
    for (const g of p.globals) {
      const v = evalExprString(g.init, env, diagnostics);
      if (v !== undefined) env[g.name] = v;
    }

    for (const fn of p.functions) {
      const out: string[] = [];
      for (const st of fn.body) {
        if (st.kind === "VarDecl") {
          diagnostics.push({ severity: "Warning", message: `Local variables are not emitted; only pack-scope vars are supported for now.`, line: st.line, col: st.col });
        } else if (st.kind === "Say") {
          const text = evalExprString(st.expr, env, diagnostics);
          if (text !== undefined) out.push(`say ${text}`);
        } else if (st.kind === "Call") {
          const targetNs = st.targetPack ? st.targetPack.toLowerCase() : p.namespace;
          const funcName = st.func.toLowerCase();
          out.push(`function ${targetNs}:${funcName}`);
        }
      }
      files.push({ path: `data/${p.namespace}/function/${fn.name}.mcfunction`, contents: out.join("\n") + (out.length ? "\n" : "") });
    }
  }

  const loadValues: string[] = []; const tickValues: string[] = [];
  for (const p of ast.packs) {
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
            [/pack|namespace|func|var|let|Say|say/, "keyword"],
            [/\"[^\"]*\"/, "string"],
            [/[a-zA-Z_][a-zA-Z0-9_]*/, "identifier"],
            [/[{()}.;=+]/, "delimiter"],
          ],
        },
      });
    }

    const disp = monaco.languages.registerCompletionItemProvider(id, {
      triggerCharacters: [".", " ", "\"", "(", ")"],
      provideCompletionItems: (model: any, position: any) => {
        const suggestions: any[] = [];

        const kw = ["pack", "namespace", "func", "var", "let", "Say"];
        for (const k of kw) suggestions.push({ label: k, kind: monaco.languages.CompletionItemKind.Keyword, insertText: k });

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

        suggestions.push({
          label: "pack block",
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: `pack "My Pack" namespace mypack{
    var Greeting = "Hello";
    func Load(){
        Say(Greeting);
    }
}
`,
          detail: "Insert pack template",
        });

        return { suggestions };
      },
    });

    return () => disp.dispose();
  }, [monacoRef, symbols]);
}

// ---------- UI ----------
const DEFAULT_SOURCE = `pack "Test Pack" namespace test{
    var Greeting = "Hello ";
    func Load(){
        Say(Greeting + "World");
    }

    func Tick(){
        // call cross-pack below each tick
        util.Ping();
    }
}

pack "Utilities" namespace util{
    func Ping(){
        Say("Pong");
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
  const t = useRef<number | null>(null); // 👈 initialize

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
              <p className="text-xs text-black/60">Multi-pack • Variables • IntelliSense • Zip export</p>
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
              <p><b>Calls:</b> <code>util.Ping()</code> → <code>function util:ping</code>. <b>Auto-tags:</b> any <code>Load()</code> and <code>Tick()</code> in any pack are added to <code>minecraft:load</code> and <code>minecraft:tick</code>.</p>
              <p><b>Vars:</b> pack-scope <code>var Name = "text" + Other;</code> usable in <code>Say(...)</code>.</p>
            </div>
          </div>
        </div>

        <footer className="mt-8 text-xs text-black/50">
          Pack format: 48 (MC 1.21+). Drop the zip into <code>%APPDATA%\.minecraft\saves\&lt;World&gt;\datapacks</code>.
        </footer>
      </div>
    </div>
  );
}
