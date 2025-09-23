// src/compiler/lexer.ts
import type { Token, TokenType } from "./types";

/**
 * Lexer for the datapack language.
 * - Supports // line comments
 * - Numbers (int/float), strings "..." with escapes, macro-strings $"..."
 * - Identifiers allow selector-ish chars: @ ~ ^ [ ] : . _
 * - All operators and punctuation tokens used by the parser
 */
export function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0, line = 1, col = 1;

  const push = (t: Token) => tokens.push(t);
  const peek = (o = 0) => input[i + o];

  function adv(n = 1) {
    for (let k = 0; k < n; k++) {
      const ch = input[i++];
      if (ch === "\n") { line++; col = 1; } else { col++; }
    }
  }

  while (i < input.length) {
    const ch = input[i]!;

    // whitespace/newlines
    if (ch === "\n") { adv(); continue; }
    if (ch === " " || ch === "\t" || ch === "\r") { adv(); continue; }

    // line comments
    if (ch === "/" && peek(1) === "/") {
      while (i < input.length && input[i] !== "\n") adv();
      continue;
    }

    // numbers (int or float) and negative numbers
    if (/[0-9]/.test(ch) || (ch === "-" && /[0-9]/.test(peek(1) ?? ""))) {
      let j = i + 1;
      let sawDot = false;
      while (j < input.length && (/[0-9]/.test(input[j]!) || (!sawDot && input[j] === "."))) {
        if (input[j] === ".") sawDot = true;
        j++;
      }
      push({ type: "Number", value: String(Number(input.slice(i, j))), line, col });
      col += (j - i); i = j; continue;
    }

    // macro-strings: $"..."
    if (ch === "$" && peek(1) === "\"") {
      const L = line, C = col;
      adv(1); // skip $
      let j = i + 1; let text = "";
      while (j < input.length) {
        const c = input[j]!;
        if (c === "\\") {
          const n = input[j + 1]!;
          if (n === "\"" || n === "\\" || n === "n" || n === "t") {
            text += n === "n" ? "\n" : n === "t" ? "\t" : n;
            j += 2; continue;
          }
        }
        if (c === "\"") { j++; break; }
        text += c; j++;
      }
      push({ type: "String", value: "$" + text, line: L, col: C });
      col += (j - i); i = j; continue;
    }

    // normal strings: "..."
    if (ch === "\"") {
      let j = i + 1; let text = ""; const L = line, C = col;
      while (j < input.length) {
        const c = input[j]!;
        if (c === "\\") {
          const n = input[j + 1]!;
          if (n === "\"" || n === "\\" || n === "n" || n === "t") {
            text += n === "n" ? "\n" : n === "t" ? "\t" : n;
            j += 2; continue;
          }
        }
        if (c === "\"") { j++; break; }
        text += c; j++;
      }
      push({ type: "String", value: text, line: L, col: C });
      col += (j - i); i = j; continue;
    }

    // compound ops
    if (ch === "|" && peek(1) === "|") { push({ type: "OrOr", line, col }); adv(2); continue; }
    if (ch === "&" && peek(1) === "&") { push({ type: "AndAnd", line, col }); adv(2); continue; }

    if (ch === "+" && peek(1) === "+") { push({ type: "PlusPlus", line, col }); adv(2); continue; }
    if (ch === "-" && peek(1) === "-") { push({ type: "MinusMinus", line, col }); adv(2); continue; }

    if (ch === "+" && peek(1) === "=") { push({ type: "PlusEquals", line, col }); adv(2); continue; }
    if (ch === "-" && peek(1) === "=") { push({ type: "MinusEquals", line, col }); adv(2); continue; }
    if (ch === "*" && peek(1) === "=") { push({ type: "StarEquals", line, col }); adv(2); continue; }
    if (ch === "/" && peek(1) === "=") { push({ type: "SlashEquals", line, col }); adv(2); continue; }
    if (ch === "%" && peek(1) === "=") { push({ type: "PercentEquals", line, col }); adv(2); continue; }

    if (ch === "=" && peek(1) === "=") { push({ type: "EqEq", line, col }); adv(2); continue; }
    if (ch === "!" && peek(1) === "=") { push({ type: "BangEq", line, col }); adv(2); continue; }
    if (ch === "<" && peek(1) === "=") { push({ type: "Le", line, col }); adv(2); continue; }
    if (ch === ">" && peek(1) === "=") { push({ type: "Ge", line, col }); adv(2); continue; }

    // single-char ops/syms
    const sym: Record<string, TokenType> = {
      "{": "LBrace", "}": "RBrace", "(": "LParen", ")": "RParen",
      "[": "LBracket", "]": "RBracket", ":": "Colon",
      ";": "Semicolon", ",": "Comma", ".": "Dot",
      "|": "Pipe",
      "+": "Plus", "-": "Minus", "*": "Star", "/": "Slash", "%": "Percent",
      "=": "Equals", "<": "Lt", ">": "Gt",
    };
    if (sym[ch]) { push({ type: sym[ch], line, col }); adv(); continue; }

    // identifiers (allow @ ~ ^ : . [ ] _ and digits)
    if (/[A-Za-z_@~^\[\]:.0-9]/.test(ch)) {
      let j = i + 1;
      while (j < input.length && /[A-Za-z0-9_@~^\[\]:.]/.test(input[j]!)) j++;
      push({ type: "Identifier", value: input.slice(i, j), line, col });
      col += (j - i); i = j; continue;
    }

    // unknown char -> throw for easier debugging
    throw { message: `Unexpected character '${ch}'`, line, col };
  }

  push({ type: "EOF", line, col });
  return tokens;
}
