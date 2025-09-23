import type { languages } from "monaco-editor";

export const completionProvider: languages.CompletionItemProvider = {
  provideCompletionItems(model, position) {
    const word = model.getWordUntilPosition(position);
    const range = {
      startLineNumber: position.lineNumber,
      endLineNumber: position.lineNumber,
      startColumn: word.startColumn,
      endColumn: word.endColumn
    };

    const suggestions: languages.CompletionItem[] = [
      { label: "pack",   kind: 14, insertText: "pack ",   range }, // Keyword = 14
      { label: "func",   kind: 14, insertText: "func ",   range },
      { label: "global", kind: 14, insertText: "global ", range },
      { label: "if",     kind: 14, insertText: "if ",     range },
      { label: "else",   kind: 14, insertText: "else ",   range },
      { label: "for",    kind: 14, insertText: "for ",    range },
      { label: "Say",    kind: 3,  insertText: "Say(",    range }, // Function = 3
      { label: "Run",    kind: 3,  insertText: "Run(",    range },
      { label: "adv",    kind: 14, insertText: "adv ",    range },
      { label: "recipe", kind: 14, insertText: "recipe ", range },
      { label: "item",   kind: 14, insertText: "item ",   range },
      { label: "BlockTag", kind: 14, insertText: "BlockTag ", range },
      { label: "ItemTag",  kind: 14, insertText: "ItemTag ",  range },
    ];

    return { suggestions };
  }
};
