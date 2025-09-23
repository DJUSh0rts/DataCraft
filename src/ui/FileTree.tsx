import React from "react";
import type { GeneratedFile } from "../compiler/types";

type Props = {
  files: GeneratedFile[];
  selected: string | null;
  onSelect: (path: string) => void;
};

export const FileTree: React.FC<Props> = ({ files, selected, onSelect }) => {
  return (
    <div className="p-2">
      <h3 className="text-sm font-bold mb-2">Files</h3>
      <ul className="text-sm">
        {files.map((f) => (
          <li key={f.path}>
            <button
              className={`block w-full text-left px-1 rounded ${
                selected === f.path ? "bg-gray-700" : "hover:bg-gray-800"
              }`}
              onClick={() => onSelect(f.path)}
            >
              {f.path}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
};
