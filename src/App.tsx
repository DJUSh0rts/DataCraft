import { useEffect, useMemo, useRef, useState } from "react";
import Editor, { useMonaco, type Monaco, type BeforeMount, type OnMount } from "@monaco-editor/react";
import * as monacoEditor from "monaco-editor"; // for IndentAction / enums


import { lex, parse, generate, type Diagnostic, type GeneratedFile } from "./compiler";

/* ----------------------- Sample Program ----------------------- */
const SAMPLE = `pack "Fizz Buzz Pack" namespace fizzbuzz {

  global bool temp = 1

  func Test(){
    while(temp < 20){
      Say($"hello bud")
      temp++
    }
  }

  func Load(){
  }
}
`;

/* ----------------------- Minimal ZIP (STORE) -----------------------
   Creates a .zip Blob with files stored (no compression).
   - UTF-8 file names
   - DOS time/date set to now
   - CRC32 calculated in JS
------------------------------------------------------------------- */
type ZipInputFile = { path: string; contents: string | Uint8Array };

function crc32(buf: Uint8Array): number {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) {
    c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  }
  return (c ^ -1) >>> 0;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function dosTimeDate(d = new Date()) {
  const sec = Math.floor(d.getSeconds() / 2);
  const min = d.getMinutes();
  const hr  = d.getHours();
  const year = d.getFullYear();
  const mon = d.getMonth() + 1;
  const day = d.getDate();
  const time = (hr << 11) | (min << 5) | sec;
  const date = ((year - 1980) << 9) | (mon << 5) | day;
  return { time, date };
}

function strToU8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

const handleOnMount: OnMount = (editor, monaco) => {
  // enforce language & theme for the model
  const model = editor.getModel();
  if (model) monaco.editor.setModelLanguage(model, "datacraft");
  monaco.editor.setTheme("datacraft-dark");

  // optional: better UX
  editor.updateOptions({
    tabSize: 2,
    insertSpaces: true,
    detectIndentation: false,
    autoClosingBrackets: "languageDefined",
    autoClosingQuotes: "languageDefined",
    autoIndent: "full",
    quickSuggestions: { other: true, comments: false, strings: true },
    suggestOnTriggerCharacters: true,
    wordBasedSuggestions: "currentDocument",
    suggestSelection: "first",
    snippetSuggestions: "inline",
    bracketPairColorization: { enabled: true },
  });
};


function makeZip(files: ZipInputFile[]): Blob {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const { time, date } = dosTimeDate(new Date());

  for (const f of files) {
    const name = strToU8(f.path.replace(/^\/+/, ""));
    const data = typeof f.contents === "string" ? strToU8(f.contents) : f.contents;
    const crc = crc32(data);
    const size = data.length;

    // Local file header
    const lf = new DataView(new ArrayBuffer(30));
    let p = 0;
    lf.setUint32(p, 0x04034b50, true); p += 4; // signature
    lf.setUint16(p, 20, true); p += 2;        // version needed
    lf.setUint16(p, 0x0800, true); p += 2;    // flags (UTF-8)
    lf.setUint16(p, 0, true); p += 2;         // method 0 = store
    lf.setUint16(p, time, true); p += 2;      // time
    lf.setUint16(p, date, true); p += 2;      // date
    lf.setUint32(p, crc, true); p += 4;       // CRC32
    lf.setUint32(p, size, true); p += 4;      // size
    lf.setUint32(p, size, true); p += 4;      // size
    lf.setUint16(p, name.length, true); p += 2; // file name length
    lf.setUint16(p, 0, true); p += 2;         // extra length

    chunks.push(new Uint8Array(lf.buffer));
    chunks.push(name);
    chunks.push(data);

    // Central directory header
    const cf = new DataView(new ArrayBuffer(46));
    p = 0;
    cf.setUint32(p, 0x02014b50, true); p += 4; // signature
    cf.setUint16(p, 20, true); p += 2;        // version made by
    cf.setUint16(p, 20, true); p += 2;        // version needed
    cf.setUint16(p, 0x0800, true); p += 2;    // flags (UTF-8)
    cf.setUint16(p, 0, true); p += 2;         // method
    cf.setUint16(p, time, true); p += 2;      // time
    cf.setUint16(p, date, true); p += 2;      // date
    cf.setUint32(p, crc, true); p += 4;       // CRC32
    cf.setUint32(p, size, true); p += 4;      // size
    cf.setUint32(p, size, true); p += 4;      // size
    cf.setUint16(p, name.length, true); p += 2; // name len
    cf.setUint16(p, 0, true); p += 2;         // extra len
    cf.setUint16(p, 0, true); p += 2;         // comment len
    cf.setUint16(p, 0, true); p += 2;         // disk start
    cf.setUint16(p, 0, true); p += 2;         // int attrs
    cf.setUint32(p, 0, true); p += 4;         // ext attrs
    cf.setUint32(p, offset, true); p += 4;    // relative offset

    central.push(new Uint8Array(cf.buffer));
    central.push(name);

    // advance offset by local header + name + data
    offset += 30 + name.length + size;
  }

  // End of central directory
  const centralSize = central.reduce((n, a) => n + a.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  let q = 0;
  end.setUint32(q, 0x06054b50, true); q += 4; // signature
  end.setUint16(q, 0, true); q += 2;          // disk num
  end.setUint16(q, 0, true); q += 2;          // start disk
  end.setUint16(q, files.length, true); q += 2; // total entries
  end.setUint16(q, files.length, true); q += 2; // total entries
  end.setUint32(q, centralSize, true); q += 4;  // central size
  end.setUint32(q, offset, true); q += 4;       // central offset
  end.setUint16(q, 0, true); q += 2;            // comment len

  const blobParts = [...chunks, ...central, new Uint8Array(end.buffer)];
  return new Blob((blobParts as unknown as BlobPart[]), { type: "application/zip" });
}

/* ----------------------- App ----------------------- */
export default function App() {
  const [code, setCode] = useState(SAMPLE);
  const [buildOutput, setBuildOutput] = useState<string>("");
  const [files, setFiles] = useState<GeneratedFile[]>([]);
  const [problems, setProblems] = useState<Diagnostic[]>([]);
  const monacoRef = useRef<Monaco | null>(null);

  const handleBeforeMount: BeforeMount = (monaco) => {
  const LANG_ID = "datacraft";

  // Register language once
  if (!monaco.languages.getLanguages().some(l => l.id === LANG_ID)) {
    monaco.languages.register({ id: LANG_ID });
  }

  // --- Monarch: clean, high-contrast dark palette (simple & readable) ---
  monaco.languages.setMonarchTokensProvider(LANG_ID, {
    // keep it minimal so the theme can stay subtle
    keywords: [
      "pack","namespace","func","global",
      "if","else","unless","for","while",
      "run","say",
      "adv","recipe","item","blocktag","itemtag"
    ],
    typeKeywords: ["int","float","double","bool","string","Ent"],
    operators: [
      "=", "+=", "-=", "*=", "/=", "%=",
      "==","!=", "<","<=",">",">=","&&","||","+","-","*","/","%"
    ],
    symbols: /[=><!~?:&|+\-*/%]+/,
    tokenizer: {
      root: [
        // comments
        [/\/\/.*$/, "comment"],

        // macro strings: $"..."
        [/\$"(?:[^"\\]|\\.)*"/, "string"],

        // normal strings: "..."
        [/"/, { token: "string.quote", next: "@string" }],

        // numbers
        [/\d+(\.\d+)?/, "number"],

        // delimiters
        [/[{}()[\]]/, "@brackets"],
        [/[;,.]/, "delimiter"],

        // operators
        [/@symbols/, { cases: { "@operators":"operator", "@default": "" } }],

        // identifiers / keywords / types
        [/[A-Za-z_][A-Za-z0-9_]*/, {
          cases: {
            "@typeKeywords": "type",
            "@keywords": "keyword",
            "@default": "identifier"
          }
        }],
      ],
      string: [
        [/[^"\\]+/, "string"],
        [/\\./, "string.escape"],
        [/"/,  { token: "string.quote", next: "@pop" }],
      ],
    },
  });

  // --- Language configuration: brackets, auto-close, and smart onEnter rules ---
  monaco.languages.setLanguageConfiguration(LANG_ID, {
    comments: { lineComment: "//" },
    brackets: [
      ["{","}"], ["[","]"], ["(",")"]
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"', notIn: ["string","comment"] },
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
      // } smart outdent
      {
        beforeText: /^\s*\}.*$/,
        action: { indentAction: monacoEditor.languages.IndentAction.None, removeText: 0 }
      },
      // block open + next line indented, then } outdent
      {
        beforeText: /.*\{[^}"']*$/,
        afterText: /^\s*\}.*$/,
        action: { indentAction: monacoEditor.languages.IndentAction.IndentOutdent }
      },
      {
        beforeText: /.*\{[^}"']*$/,
        action: { indentAction: monacoEditor.languages.IndentAction.Indent }
      },
    ],
    // ensure auto-close plays nicely
    autoCloseBefore: ";:.,=}]) \n\t",
  });

  // --- Completion provider: keywords + smart snippets ---
  monaco.languages.registerCompletionItemProvider(LANG_ID, {
    triggerCharacters: [" ", "(", "{", '"', ".", "$"],
    provideCompletionItems(model, position) {
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: position.column,
        endColumn: position.column,
      };

      const K = monacoEditor.languages.CompletionItemKind;

      const kw = (label: string): monacoEditor.languages.CompletionItem => ({
        label, kind: K.Keyword, insertText: label, range,
      });

      const snip = (label: string, insertText: string, detail?: string): monacoEditor.languages.CompletionItem => ({
        label,
        kind: K.Snippet,
        insertTextRules: monacoEditor.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        insertText,
        detail,
        range,
      });

      // context helpers
      const line = model.getLineContent(position.lineNumber);
      const left = line.slice(0, position.column - 1);

      const suggestions: monacoEditor.languages.CompletionItem[] = [
        // basic keywords
        kw("pack"), kw("namespace"), kw("func"), kw("global"),
        kw("if"), kw("else"), kw("unless"), kw("for"), kw("while"),
        kw("run"), kw("say"),
        kw("adv"), kw("recipe"), kw("item"), kw("blocktag"), kw("itemtag"),

        // types
        kw("int"), kw("float"), kw("double"), kw("bool"), kw("string"), kw("Ent"),

        // core snippets (auto-brackets, correct indentation)
        snip("func", `func \${1:Name}(){\n\t\${0}\n}`, "function"),
        snip("if", `if (\${1:cond}){\n\t\${0}\n}`, "if block"),
        snip("unless", `unless (\${1:cond}){\n\t\${0}\n}`, "unless block"),
        snip("else", `else{\n\t\${0}\n}`, "else"),
        snip("else if", `else if (\${1:cond}){\n\t\${0}\n}`, "else if chain"),
        snip("for", `for (\${1:int} \${2:i} = \${3:0} | \${2:i} < \${4:10} | \${2:i}++){\n\t\${0}\n}`, "for loop"),
        snip("while", `while (\${1:cond}){\n\t\${0}\n}`, "while loop"),
        snip("Say", `Say(\${1:"$"\\"\${2:text}\\""});`, "Say(...)"),
        snip("Run", `Run(\${1:"$"\\"\${2:cmd}\\""});`, "Run(...)"),
        snip("Ent.Get", `Ent.Get(\${1:"type=player,limit=1"})`, "select entity"),
        snip("Ent.GetData", `Ent.GetData(\${1:ent}, "\${2:Key}")`, "entity data"),
        snip("global", `global \${1:int} \${2:name} = \${3:0}`, "global variable"),
      ];

      // tiny bit of context awareness for "else if"
      if (/\belse\s*$/.test(left)) {
        suggestions.unshift(
          snip("else if (...) { }", `if (\${1:cond}){\n\t\${0}\n}`, "continue conditional chain")
        );
      }

      return { suggestions };
    },
  });

  // --- Dark subtle theme w/ good contrast ---
  monaco.editor.defineTheme("datacraft-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "", foreground: "D0D0D0" },            // default text
      { token: "comment", foreground: "6A9955" },
      { token: "keyword", foreground: "C586C0" },
      { token: "type", foreground: "4EC9B0" },        // types
      { token: "number", foreground: "B5CEA8" },
      { token: "string", foreground: "CE9178" },
      { token: "string.escape", foreground: "D7BA7D" },
      { token: "operator", foreground: "D4D4D4" },
      { token: "delimiter", foreground: "808080" },
      { token: "identifier", foreground: "D0D0D0" },
    ],
    colors: {
      "editor.background": "#0E1116",
      "editor.foreground": "#D0D0D0",
      "editorLineNumber.foreground": "#4B5563",
      "editorCursor.foreground": "#E5E7EB",
      "editorIndentGuide.background": "#1F2937",
      "editorIndentGuide.activeBackground": "#374151",
      "editor.selectionBackground": "#264F78",
      "editor.inactiveSelectionBackground": "#264F7833",
      "editorLineNumber.activeForeground": "#9CA3AF",
    },
  });
};


  const build = useMemo(() => {
    return () => {
      try {
        const tokens = lex(code);
        const parsed = parse(tokens);
        const diags: Diagnostic[] = [...(parsed.diagnostics ?? [])];

        if (!parsed.ast) {
          setBuildOutput(renderDiagnostics(diags));
          setProblems(diags);
          setFiles([]);
          return;
        }

        const gen = generate(parsed.ast);
        diags.push(...gen.diagnostics);

        const summary =
          [
            `Files: ${gen.files?.length ?? 0}`,
            ...(gen.files ?? []).map(
              (f) => ` - ${f.path ?? "(unknown)"} (${String(f.contents ?? "").length} bytes)`
            ),
            `Problems: ${diags.length}`,
            ...diags.map(d => `${d.severity}\t${d.message}${loc(d)}`),
          ].join("\n");

        setBuildOutput(summary);
        setFiles(gen.files ?? []);
        setProblems(diags);
      } catch (err: any) {
        setBuildOutput(`Build failed: ${err?.message ?? String(err)}`);
        setProblems([{ severity: "Error", message: String(err?.message ?? err), line: 0, col: 0 }]);
        setFiles([]);
      }
    };
  }, [code]);

  useEffect(() => {
    build();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function downloadDatapack() {
    // Ensure we have latest build artifacts in state
    const list = files ?? [];
    if (!list.length) {
      alert("No files to download. Try Build first.");
      return;
    }
    const blob = makeZip(
      list.map(f => ({
        path: f.path || "unknown.txt",
        contents: String(f.contents ?? ""),
      }))
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    // Try to infer a pack name (use first pack.mcmeta if present)
    const fallback = "datapack.zip";
    const packMetaFile = list.find(f => f.path?.endsWith("pack.mcmeta"));
    let name = fallback;
    if (packMetaFile?.contents) {
      try {
        const j = JSON.parse(String(packMetaFile.contents));
        const desc: string = j?.pack?.description ?? "datapack";
        name = (desc.replace(/[^\w\-]+/g, "_") || "datapack") + ".zip";
      } catch {
        // ignore
      }
    }
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="app">
      {/* Left: Editor */}
      <div className="panel" style={{ overflow: "hidden" }}>
        <div className="toolbar" style={{ justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="button button--primary" onClick={build}>Build</button>
            <button className="button" onClick={downloadDatapack}>Download</button>
            <button className="button button--ghost" onClick={() => setCode(SAMPLE)}>Reset</button>
          </div>
          <div style={{ color: "var(--text-dim)", fontSize: 12 }}>DataCraft</div>
        </div>
        <Editor
  height="100%"
  defaultLanguage="datacraft"
  beforeMount={handleBeforeMount}
  onMount={handleOnMount}
  value={code}
  onChange={(v) => setCode(v || "")}
  options={{
    fontSize: 14,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    tabSize: 2,
    // these keep IntelliSense lively
    quickSuggestions: { other: true, comments: false, strings: true },
    suggestOnTriggerCharacters: true,
    snippetSuggestions: "inline",
    autoClosingBrackets: "languageDefined",
    autoClosingQuotes: "languageDefined",
    autoIndent: "full",
  }}
/>


      </div>

      {/* Right: Sidebar */}
      <div className="panel sidebar">
        <div className="toolbar">
          <button className="button button--primary" onClick={build}>Build</button>
          <button className="button" onClick={downloadDatapack}>Download</button>
          <button
            className="button"
            onClick={() => navigator.clipboard.writeText(buildOutput)}
            title="Copy build log"
          >
            Copy Log
          </button>
        </div>

        {/* Files */}
        <div className="section">
          <h4 className="section__title">Files</h4>
        </div>
        <div className="scroll">
          <div className="files">
            {(files.length === 0) && (
              <div className="file">
                <p className="file__path">(no files)</p>
                <div className="file__meta">
                  <span className="pill">—</span>
                </div>
              </div>
            )}
            {files.map((f, i) => (
              <div className="file" key={`${f.path}-${i}`}>
                <p className="file__path">{f.path}</p>
                <div className="file__meta">
                  <span className="pill pill--info">
                    {String(f.contents ?? "").length.toLocaleString()} bytes
                  </span>
                  <span className="pill">mcfunction</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Problems */}
        <div className="section">
          <h4 className="section__title">Problems</h4>
        </div>
        <div className="scroll">
          <div className="problems">
            {problems.length === 0 && (
              <div className="problem problem--info">
                <div className="problem__icon">i</div>
                <div>
                  <p className="problem__title">No diagnostics</p>
                  <div className="problem__loc">All good!</div>
                </div>
                <span className="pill pill--ok">OK</span>
              </div>
            )}
            {problems.map((p, idx) => {
              const level = (p.severity || "Info").toLowerCase();
              const cls =
                level === "error" ? "problem problem--error" :
                level === "warning" ? "problem problem--warn" :
                "problem problem--info";
              return (
                <div className={cls} key={idx}>
                  <div className="problem__icon">
                    {level === "error" ? "!" : level === "warning" ? "!" : "i"}
                  </div>
                  <div>
                    <p className="problem__title">{p.message}</p>
                    <div className="problem__loc">
                      {p.line ?? 0}:{p.col ?? 0}
                    </div>
                  </div>
                  <span className={`pill ${level === "error" ? "pill--err" : level === "warning" ? "pill--warn" : "pill--info"}`}>
                    {p.severity ?? "Info"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Raw Build Log */}
        <div className="section">
          <h4 className="section__title">Build Log</h4>
        </div>
        <div style={{ overflow: "auto", maxHeight: 220 }}>
          <pre>{buildOutput}</pre>
        </div>
      </div>
    </div>
  );
}

/* ----------------------- Helpers ----------------------- */
function loc(d: Diagnostic) {
  const lc = (d.line ?? 0) || (d as any).line;
  const cc = (d.col ?? 0) || (d as any).col;
  return lc || cc ? `\t${lc}:${cc}` : "";
}
function renderDiagnostics(diags: Diagnostic[]): string {
  if (!diags?.length) return "No diagnostics.";
  return [
    "Diagnostics:",
    ...diags.map(d => ` - ${d.severity}\t${d.message}${loc(d)}`)
  ].join("\n");
}
