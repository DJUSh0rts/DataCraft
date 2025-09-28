// Core token & diagnostic
export type TokenType =
  | "Identifier" | "String" | "Number"
  | "LBrace" | "RBrace" | "LParen" | "RParen"
  | "LBracket" | "RBracket" | "Colon"
  | "Semicolon" | "Comma" | "Dot" | "Pipe"
  | "Plus" | "Minus" | "Star" | "Slash" | "Percent"
  | "PlusEquals" | "MinusEquals" | "StarEquals" | "SlashEquals" | "PercentEquals"
  | "PlusPlus" | "MinusMinus"
  | "Equals" | "EqEq" | "BangEq" | "Lt" | "Le" | "Gt" | "Ge"
  | "AndAnd" | "OrOr"
  | "EOF";

export type Token = { type: TokenType; value?: string; line: number; col: number };
export type Diagnostic = { severity: "Error" | "Warning" | "Info"; message: string; line: number; col: number };

// --- Expressions ---
export type StringExpr = { kind: "String"; value: string; line: number; col: number };
export type NumberExpr = { kind: "Number"; value: number; line: number; col: number };
export type VarExpr   = { kind: "Var"; name: string; line: number; col: number };
export type BinaryExpr= { kind: "Binary"; op: "+" | "-" | "*" | "/" | "%"; left: Expr; right: Expr; line: number; col: number };
export type CallExpr  = { kind: "CallExpr"; target?: string; name: string; args: Expr[]; line: number; col: number };
export type MemberExpr= { kind: "Member"; object: Expr; name: string; line: number; col: number };
export type ArrayExpr = { kind: "Array"; items: Expr[]; line: number; col: number };
export type Expr = StringExpr | NumberExpr | VarExpr | BinaryExpr | CallExpr | MemberExpr | ArrayExpr;

// --- Conditions ---
export type CmpOp = "==" | "!=" | "<" | "<=" | ">" | ">=";
export type RawCond = { kind: "Raw"; raw: string; line: number; col: number };
export type CmpCond = { kind: "Cmp"; op: CmpOp; left: Expr; right: Expr; line: number; col: number };
export type BoolCond= { kind: "Bool"; op: "&&" | "||"; left: Condition; right: Condition; line: number; col: number };
export type Condition = RawCond | CmpCond | BoolCond;

// --- Execute helpers ---
export type ExecMod =
  | { kind: "as"; arg: string }
  | { kind: "at"; arg: string }
  | { kind: "positioned"; x: string; y: string; z: string };
export type ExecVariant = { mods: ExecMod[] };

// --- Type system ---
export type TypeName =
  | "string" | "int" | "float" | "double" | "bool" | "Ent"
  | "string[]" | "int[]" | "float[]" | "double[]" | "bool[]" | "Ent[]";

// --- Statements ---
export type SayStmt = { kind: "Say"; expr: Expr };
export type RunStmt = { kind: "Run"; expr: Expr };
export type VarDeclStmt = { kind: "VarDecl"; isGlobal: boolean; varType: TypeName; name: string; init: Expr; line: number; col: number };
export type AssignStmt = { kind: "Assign"; name: string; op: "=" | "+=" | "-=" | "*=" | "/=" | "%="; expr: Expr; line: number; col: number };
export type CallStmt = { kind: "Call"; targetPack?: string; func: string; line: number; col: number };
export type ElseBlock = { kind: "Else"; body: Stmt[]; line: number; col: number };
export type IfBlock = {
  kind: "If";
  negated: boolean;
  cond?: Condition | null;
  body: Stmt[];
  elseBranch?: IfBlock | ElseBlock | null;
  line: number; col: number;
};
export type ExecuteStmt = { kind: "Execute"; variants: ExecVariant[]; body: Stmt[] };
export type ForStmt = {
  kind: "For";
  init?: VarDeclStmt | AssignStmt | { kind: "Noop" } | null;
  cond?: Condition | null;
  incr?: AssignStmt | null;
  body: Stmt[];
  line: number; col: number;
};
export type WhileStmt = {
  kind: "While";
  cond?: Condition | null;
  body: Stmt[];
  line: number; col: number;
};

export type Stmt = SayStmt | VarDeclStmt | AssignStmt | CallStmt | ExecuteStmt | IfBlock | RunStmt | ForStmt | WhileStmt;

// Adv / Recipe / Items / Tags (same as you already had)
export type AdvDecl = {
  kind: "Adv";
  name: string;
  props: { title?: string; description?: string; icon?: string; parent?: string; criteria: Array<{ name: string; trigger: string }> };
};
export type RecipeDecl = {
  kind: "Recipe";
  name: string;
  type?: "shapeless" | "shaped";
  ingredients: string[];
  pattern?: string[];
  keys?: Record<string, string>;
  result?: { id: string; count?: number };
};
export type ItemDecl = { kind: "Item"; name: string; baseId: string; componentTokens?: Token[]; line: number; col: number };
export type TagCategory = "blocks" | "items";
export type TagDecl = { kind: "Tag"; category: TagCategory; name: string; replace: boolean; values: string[]; line: number; col: number };

// Decls
export type FuncDecl = { name: string; nameOriginal: string; body: Stmt[] };
export type PackDecl = {
  packTitle: string;
  namespace: string;
  namespaceOriginal: string;
  globals: VarDeclStmt[];
  functions: FuncDecl[];
  advs: AdvDecl[];
  recipes: RecipeDecl[];
  items: ItemDecl[];
  tags: TagDecl[];
};
export type Script = { packs: PackDecl[] };

export type GeneratedFile = { path: string; contents: string };
export type SymbolIndex = { packs: Record<string, { title: string; vars: Set<string>; funcs: Set<string>; items: Set<string> }> };
