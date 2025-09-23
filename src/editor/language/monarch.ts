import type { languages } from "monaco-editor";

export const monarchTokens: languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".dplang",

  keywords: [
    "pack","namespace","global","func","for","if","else","unless",
    "Execute","Say","Run","adv","recipe","item","BlockTag","ItemTag",
    "type","key","pattern","ingredient","result","title","description","desc",
    "icon","parent","criterion","replace","values","base_id","components",
    "true","false"
  ],

  operators: [
    "=", ">", "<", "!", "==", "<=", ">=", "!=", "&&", "||",
    "+", "-", "*", "/", "%", "++", "--", "+=", "-=", "*=", "/=", "%="
  ],

  symbols: /[=><!~?:&|+\-*\/%^]+/,

  tokenizer: {
    root: [
      [/\/\/.*/, "comment"],

      [/\$"(?:[^"\\]|\\.)*"/, "string"],
      [/"/, { token: "string.quote", next: "@string" }],

      [/\d+(?:\.\d+)?/, "number"],

      [/[A-Za-z_][\w]*/, {
        cases: { "@keywords": "keyword", "@default": "identifier" }
      }],

      [/[{}()\[\]]/, "@brackets"],
      [/[;,.]/, "delimiter"],

      [/@symbols/, {
        cases: { "@operators": "operator", "@default": "" }
      }],

      [/[ \t\r\n]+/, "white"],
    ],

    string: [
      [/[^\\"]+/, "string"],
      [/\\./, "string.escape"],
      [/"/, { token: "string.quote", next: "@root" }],
    ],
  },
};
