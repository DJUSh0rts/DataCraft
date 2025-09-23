import type { Monaco } from "@monaco-editor/react";
import { monarchTokens } from "./monarch";
import { languageConfig } from "./config";
import { completionProvider } from "./completions";

export const LANGUAGE_ID = "dplang";

export function setupLanguage(monaco: Monaco) {
  try {
    if (!monaco.languages.getLanguages().some((l) => l.id === LANGUAGE_ID)) {
      monaco.languages.register({ id: LANGUAGE_ID });
      monaco.languages.setMonarchTokensProvider(LANGUAGE_ID, monarchTokens);
      monaco.languages.setLanguageConfiguration(LANGUAGE_ID, languageConfig);
      monaco.languages.registerCompletionItemProvider(LANGUAGE_ID, completionProvider);
    }
  } catch (e) {
    console.error("Failed to setup language:", e);
  }
}
