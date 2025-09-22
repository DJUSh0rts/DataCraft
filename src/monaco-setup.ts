// src/monaco-setup.ts
// Tell Vite to bundle Monaco’s workers and how to load them.
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker   from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker    from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker   from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker     from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

declare const self: any;

self.MonacoEnvironment = {
  getWorker(_: string, label: string) {
    switch (label) {
      case 'json':        return new jsonWorker();
      case 'css':
      case 'scss':
      case 'less':        return new cssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':       return new htmlWorker();
      case 'typescript':
      case 'javascript':  return new tsWorker();
      default:            return new editorWorker();
    }
  }
};


// src/monaco-setup.ts
import loader from "@monaco-editor/loader";

// lock to a specific monaco version for stability
loader.config({
  paths: { vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.44.0/min/vs" },
});

// (Optional) you can hook when monaco is ready
// loader.init().then((monaco) => { /* e.g., extra languages config */ });
