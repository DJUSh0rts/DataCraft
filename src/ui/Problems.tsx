import React from "react";
import type { Diagnostic } from "../compiler/types";

type Props = {
  diagnostics: Diagnostic[];
};

export const Problems: React.FC<Props> = ({ diagnostics }) => {
  if (diagnostics.length === 0) return null;

  return (
    <div className="border-t border-gray-700 p-2 max-h-40 overflow-auto">
      <h3 className="text-sm font-bold mb-2">Problems</h3>
      <ul className="text-xs space-y-1">
        {diagnostics.map((d, i) => (
          <li
            key={i}
            className={
              d.severity === "Error"
                ? "text-red-400"
                : d.severity === "Warning"
                ? "text-yellow-400"
                : "text-blue-400"
            }
          >
            {d.severity}: {d.message} (line {d.line}, col {d.col})
          </li>
        ))}
      </ul>
    </div>
  );
};
