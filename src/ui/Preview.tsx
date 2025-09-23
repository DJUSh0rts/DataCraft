import React from "react";
import type { GeneratedFile } from "../compiler/types";

type Props = {
  files: GeneratedFile[];
  selectedPath: string | null;
};

export const Preview: React.FC<Props> = ({ files, selectedPath }) => {
  const file = files.find((f) => f.path === selectedPath);
  return (
    <div className="p-2 border-t border-gray-700">
      <h3 className="text-sm font-bold mb-2">Preview</h3>
      {file ? (
        <pre className="bg-black text-green-300 text-xs p-2 rounded overflow-auto max-h-48">
          {file.contents}
        </pre>
      ) : (
        <p className="text-xs text-gray-400">Select a file to preview</p>
      )}
    </div>
  );
};
