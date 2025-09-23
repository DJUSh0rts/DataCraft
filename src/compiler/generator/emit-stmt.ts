import type { Stmt } from "../types";
import { emitExpr } from "./emit-utils";

export function emitStmt(stmt: Stmt): string {
  switch (stmt.kind) {
    case "Say":
      return `say ${emitExpr(stmt.expr)}`;
    case "Run":
      return emitExpr(stmt.expr);
    case "Assign":
      return `scoreboard players set ${stmt.name} ${emitExpr(stmt.expr)}`;
    case "VarDecl":
      return `# var ${stmt.name} : ${stmt.varType} = ${emitExpr(stmt.init)}`;
    case "Call":
      return `function ${stmt.targetPack ? stmt.targetPack + ":" : ""}${stmt.func}`;
    case "If":
      return `# if (condition) { ... }`; // TODO: implement real emission
    case "For":
      return `# for (...) { ... }`; // TODO
    case "Execute":
      return `# execute { ... }`; // TODO
    default:
      return `# unknown stmt`;
  }
}
