import type { Expr } from "../types";

export function emitExpr(expr: Expr): string {
  switch (expr.kind) {
    case "String":
      return `"${expr.value}"`;
    case "Number":
      return String(expr.value);
    case "Var":
      return expr.name;
    case "Binary":
      return `${emitExpr(expr.left)} ${expr.op} ${emitExpr(expr.right)}`;
    case "CallExpr":
      const args = expr.args.map(emitExpr).join(" ");
      return `${expr.name} ${args}`;
    case "Member":
      return `${emitExpr(expr.object)}.${expr.name}`;
    case "Array":
      return `[${expr.items.map(emitExpr).join(", ")}]`;
    default:
      return "?";
  }
}
