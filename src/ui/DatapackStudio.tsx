// src/ui/DatapackStudio.tsx
import React, { useEffect, useRef, useState } from "react";
import Editor, { useMonaco } from "@monaco-editor/react";
import type { OnMount } from "@monaco-editor/react";
import { compile } from "../compiler/compile";
import type * as monacoEditor from "monaco-editor";
import JSZip from "jszip";

// Keep styles lightweight; you can replace with your own theme
const rootBg = "#111";
const panelBorder = "#333";

type FileNode = { path: string; contents: string };

const DEFAULT_SOURCE = `pack "Hello World" namespace helloWorld{
  func Tick(){
    Say("Hello World")
    Run("/title @a actionbar \\"Hi from Web Compiler\\"")
  }
}
`;

function useDebounced<T>(val: T, delay = 250) {
  const [v, setV] = useState(val);
  useEffect(() => {
    const id = setTimeout(() => setV(val), delay);
    return () => clearTimeout(id);
  }, [val, delay]);
  return v;
}

async function downloadZip(files: FileNode[], name = "datapack.zip") {
  if (!files?.length) return;
  const zip = new JSZip();
  for (const f of files) zip.file(f.path, f.contents ?? "");
  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: any }
> {
  constructor(p: any) {
    super(p);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }
  render() {
    if (this.state.hasError) {
      const msg =
        this.state.error instanceof Error
          ? this.state.error.message
          : String(this.state.error);
      return (
        <div style={{ padding: 16, color: "#fff" }}>
          <h2>Runtime error</h2>
          <pre>{msg}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function DatapackStudio() {
  const [code, setCode] = useState<string>(DEFAULT_SOURCE);
  const debounced = useDebounced(code, 200);

  const monaco = useMonaco();
  const editorRef = useRef<monacoEditor.editor.IStandaloneCodeEditor | null>(
    null
  );

  // Layout state
  const [leftWidth, setLeftWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem("leftWidth"));
    return Number.isFinite(v) && v >= 180 ? v : 240;
  });
  const [bottomHeight, setBottomHeight] = useState<number>(() => {
    const v = Number(localStorage.getItem("bottomHeight"));
    return Number.isFinite(v) && v >= 120 ? v : 220;
  });
  const [editorHeight, setEditorHeight] = useState<number>(() => {
    const v = Number(localStorage.getItem("editorHeight"));
    return Number.isFinite(v) && v >= 140 ? v : 420;
  });
  useEffect(() => localStorage.setItem("leftWidth", String(leftWidth)), [leftWidth]);
  useEffect(() => localStorage.setItem("bottomHeight", String(bottomHeight)), [bottomHeight]);
  useEffect(() => localStorage.setItem("editorHeight", String(editorHeight)), [editorHeight]);

  const dragging = useRef<null | "vert" | "horiz" | "editor">(null);
  const startDragVert = () => {
    dragging.current = "vert";
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  };
  const startDragHoriz = () => {
    dragging.current = "horiz";
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";
  };
  const startDragEditor = () => {
    dragging.current = "editor";
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";
  };

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (dragging.current === "vert") {
        const next = Math.min(Math.max(e.clientX, 200), window.innerWidth * 0.6);
        setLeftWidth(next);
      } else if (dragging.current === "horiz") {
        const vh = window.innerHeight;
        const next = Math.min(Math.max(vh - e.clientY, 120), vh * 0.8);
        setBottomHeight(next);
      } else if (dragging.current === "editor") {
        const paneTop =
          (document.querySelector("#editorPane") as HTMLElement | null)
            ?.getBoundingClientRect()?.top ?? 0;
        const next = Math.min(Math.max(e.clientY - paneTop, 140), window.innerHeight * 0.8);
        setEditorHeight(next);
      }
    }
    function onUp() {
      dragging.current = null;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  // Re-layout Monaco on size changes and window resizes
  useEffect(() => {
    editorRef.current?.layout?.();
  }, [leftWidth, bottomHeight, editorHeight]);
  useEffect(() => {
    const onResize = () => editorRef.current?.layout?.();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Monaco language registration (idempotent)
  useEffect(() => {
    if (!monaco) return;

    try { monaco.languages.register({ id: "datapack-lang" }); } catch {}

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

    monaco.languages.setLanguageConfiguration("datapack-lang", {
      brackets: [["{", "}" ], ["[", "]"], ["(", ")"]],
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
          action: { indentAction: monaco.languages.IndentAction.IndentOutdent },
        },
        {
          beforeText: /.*\{[^}"']*$/,
          action: { indentAction: monaco.languages.IndentAction.Indent },
        },
      ],
      autoCloseBefore: ";:.,=}]) \n\t",
    });

    monaco.languages.registerCompletionItemProvider("datapack-lang", {
      triggerCharacters: [".", '"', "$", ":", "["],
      provideCompletionItems: (model, position) => {
        const word = model.getWordUntilPosition(position);
        const range: monacoEditor.IRange = {
          startLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endLineNumber: position.lineNumber,
          endColumn: word.endColumn,
        };
        const asSnippet =
          monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;

        const suggestions: monacoEditor.languages.CompletionItem[] = [
          {
            label: "pack",
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertTextRules: asSnippet,
            insertText: 'pack "${1:My Pack}" namespace ${2:myns}{\n\t$0\n}',
            range,
          },
          {
            label: "func",
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertTextRules: asSnippet,
            insertText: "func ${1:Name}(){\n\t$0\n}",
            range,
          },
          {
            label: "Say",
            kind: monaco.languages.CompletionItemKind.Function,
            insertTextRules: asSnippet,
            insertText: 'Say("${1:Hello World}")',
            range,
          },
          {
            label: "Run",
            kind: monaco.languages.CompletionItemKind.Function,
            insertTextRules: asSnippet,
            insertText: 'Run("/say ${1:hi}")',
            range,
          },
        ];

        return { suggestions };
      },
    });
  }, [monaco]);

  // Compile on debounce
  const [files, setFiles] = useState<FileNode[]>([]);
  const [problems, setProblems] = useState<
    { severity: "Error" | "Warning" | "Info"; message: string; line: number; col: number }[]
  >([]);
  const [selectedPath, setSelectedPath] = useState<string>("");

  useEffect(() => {
    const { files, diagnostics } = compile(debounced);
    setFiles(files);
    setProblems(diagnostics);
    if (!selectedPath && files.length) setSelectedPath(files[0].path);

    // Push markers into Monaco
    const model = editorRef.current?.getModel?.();
    if (monaco && model) {
      const markers = diagnostics.map((d) => ({
        startLineNumber: Math.max(1, d.line || 1),
        startColumn: Math.max(1, d.col || 1),
        endLineNumber: Math.max(1, d.line || 1),
        endColumn: Math.max(1, (d.col || 1) + 1),
        message: d.message,
        severity:
          d.severity === "Error"
            ? monaco.MarkerSeverity.Error
            : d.severity === "Warning"
            ? monaco.MarkerSeverity.Warning
            : monaco.MarkerSeverity.Info,
        source: "datapack-compiler",
      }));
      monaco.editor.setModelMarkers(model, "datapack-compiler", markers);
    }
  }, [debounced, monaco, selectedPath]);

  const onMount: OnMount = (editor, monacoInstance) => {
    editorRef.current = editor;
    try {
      const model = editor.getModel();
      if (model && monacoInstance) {
        monacoInstance.editor.setModelLanguage(model, "datapack-lang");
      }
    } catch {}
  };

  const selectedFile = files.find((f) => f.path === selectedPath);

  return (
    <ErrorBoundary>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `${leftWidth}px 6px minmax(0, 1fr)`,
          gridTemplateRows: `1fr 6px ${bottomHeight}px`,
          height: "100vh",
          background: rootBg,
          overflow: "hidden",
        }}
      >
        {/* File tree */}
        <div
          style={{
            gridColumn: "1 / 2",
            gridRow: "1 / 4",
            borderRight: `1px solid ${panelBorder}`,
            overflow: "auto",
            padding: 8,
            color: "#ddd",
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Files</div>
          {files.length === 0 ? (
            <div style={{ color: "#777" }}>No files (type a pack to generate)</div>
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
                      border: `1px solid ${panelBorder}`,
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

        {/* Editor + Preview */}
        <div
          id="editorPane"
          style={{
            gridColumn: "3 / 4",
            gridRow: "1 / 2",
            display: "grid",
            gridTemplateRows: `${editorHeight}px 6px 1fr`,
            gap: 0,
            padding: 8,
            minWidth: 0,
            minHeight: 0,
          }}
        >
          {/* Editor */}
          <div style={{ border: `1px solid ${panelBorder}`, minHeight: 0 }}>
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

          {/* Editor/Preview splitter */}
          <div
            onMouseDown={startDragEditor}
            style={{ height: 6, cursor: "row-resize", background: "#181818" }}
          />

          {/* Preview */}
          <div
            style={{
              border: `1px solid ${panelBorder}`,
              overflow: "auto",
              background: "#0b0b0b",
              minHeight: 0,
            }}
          >
            <div
              style={{
                padding: "6px 8px",
                borderBottom: `1px solid ${panelBorder}`,
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
                  onClick={() => downloadZip(files)}
                  style={{
                    background: "#1e1e1e",
                    border: `1px solid ${panelBorder}`,
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

        {/* Problems panel */}
        <div
          style={{
            gridColumn: "3 / 4",
            gridRow: "3 / 4",
            borderTop: `1px solid ${panelBorder}`,
            background: "#141414",
            color: "#ddd",
            overflow: "auto",
            minHeight: 0,
          }}
        >
          <div
            style={{
              padding: "6px 8px",
              borderBottom: `1px solid ${panelBorder}`,
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
    </ErrorBoundary>
  );
}
