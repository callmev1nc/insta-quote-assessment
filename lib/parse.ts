import type { LineItem, Totals, TracedNumber } from "./schema";

/**
 * Deterministic parser for the Ironbark table layout.
 *
 * Strict by design: a row is only emitted when every cell matches the
 * grammar below AND its source tokens are retained as evidence. This parser
 * returns candidates and problems; extractFromPages performs validation and
 * turns the problems into refusals before the API returns anything.
 *
 * Grammar (one token per cell; tokens are non-blank lines from the joined
 * pdfjs text-item stream):
 *   code        ^[A-Z]{2}-\d{3,4}$          e.g. "FX-201", "CX-1000"
 *   description any non-empty token that is not a code/number/money/marker
 *   qty         ^[\d,]+$                    e.g. "24", "2,000"
 *   unit        any non-empty token         e.g. "box" | "640g total"
 *   unitPrice   $x.xx with optional "/per"  e.g. "$52.00", "$74.00 /carton"
 *   amount      $x.xx                       e.g. "$1,248.00" (only if the
 *                                           header prints an Amount column)
 */

const CODE_RE = /^[A-Z]{2}-\d{3,4}$/;
// Reject malformed grouping such as "12,3" or ",," instead of silently
// turning it into a plausible value with parseInt/parseFloat.
const INTEGER = "(?:0|[1-9]\\d*|[1-9]\\d{0,2}(?:,\\d{3})+)";
const QTY_RE = new RegExp(`^${INTEGER}$`);
const MONEY_RE = new RegExp(`^\\$(${INTEGER}\\.\\d{2})$`);
const UNIT_PRICE_RE = new RegExp(`^\\$(${INTEGER}\\.\\d{2})(?:\\s*\\/\\s*([A-Za-z]+))?\\s*$`);

const FOOTER_MARKERS = [
  "subtotal:",
  "gst ",
  "total",
  "total consignment",
  "warehouse notes:",
  "summary:",
  "note:",
  "payment due",
  "page ",
];

function isFooterToken(token: string): boolean {
  const lower = token.toLowerCase();
  return (
    FOOTER_MARKERS.some((m) => lower.startsWith(m)) ||
    /^-{5,}/.test(token) ||
    /^page \d+ of \d+$/i.test(token)
  );
}

function parseMoney(raw: string): number {
  return Number.parseFloat(raw.replace(/[$,]/g, ""));
}

function validMoney(raw: string): boolean {
  const value = parseMoney(raw);
  return Number.isFinite(value) && Number.isSafeInteger(Math.round(value * 100));
}

/** Classify a totals label ("Subtotal:", "GST (15%):", "Total:", …). */
function totalsKind(label: string): "subtotal" | "gst" | "total" | null {
  const lower = label.toLowerCase().trim();
  if (lower.startsWith("subtotal")) return "subtotal";
  if (lower.startsWith("gst")) return "gst";
  if (lower.startsWith("total (incl gst)")) return "total";
  if (lower === "total" || lower === "total:") return "total";
  return null;
}

function parseQty(raw: string): number {
  return Number.parseInt(raw.replace(/,/g, ""), 10);
}

function traced(
  raw: string,
  value: number,
  page: number,
  sourceText: string,
): TracedNumber {
  return { value, raw, evidence: { page, sourceText } };
}

/** Intermediate candidates only: a parsed amount or total may still be refused. */
export interface ParsedPage {
  page: number;
  tableFound: boolean;
  tableProblems: Array<{ reason: string; sourceText: string }>;
  /** "Unit" | "Weight" | null when no table header was found. */
  qtyHeader: string | null;
  hasAmountColumn: boolean;
  docNo: string | null;
  docNoSource: string | null;
  date: string | null;
  dateSource: string | null;
  billTo: string | null;
  billToSource: string | null;
  jobRef: string | null;
  jobRefSource: string | null;
  lineItems: LineItem[];
  totals: Totals;
  totalConflicts: Array<{ kind: keyof Totals; first: TracedNumber; second: TracedNumber }>;
  totalProblems: Array<{ reason: string; sourceText: string }>;
  cartonCounts: Array<{ count: number; sourceText: string }>;
  notes: string[];
}

function looksLikeDescription(token: string): boolean {
  return (
    !CODE_RE.test(token) &&
    !QTY_RE.test(token) &&
    !MONEY_RE.test(token) &&
    !UNIT_PRICE_RE.test(token) &&
    !isFooterToken(token)
  );
}

interface Token {
  text: string;
  /** Exact substring of the PDF text stream for this cell. */
  sourceText: string;
  start: number;
  end: number;
}

/**
 * Match against trimmed cells, but retain offsets into the untrimmed text.
 * Those offsets let row evidence be an actual slice of the PDF text stream
 * instead of a sentence reconstructed from normalized cells.
 */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) {
      tokens.push({ text: trimmed, sourceText: line, start: offset, end: offset + line.length });
    }
    offset += line.length + 1;
  }
  return tokens;
}

export function parsePage(page: number, text: string): ParsedPage {
  const tokens = tokenize(text);
  const parsed: ParsedPage = {
    page,
    tableFound: false,
    tableProblems: [],
    qtyHeader: null,
    hasAmountColumn: false,
    docNo: null,
    docNoSource: null,
    date: null,
    dateSource: null,
    billTo: null,
    billToSource: null,
    jobRef: null,
    jobRefSource: null,
    lineItems: [],
    totals: { subtotal: null, gst: null, total: null },
    totalConflicts: [],
    totalProblems: [],
    cartonCounts: [],
    notes: [],
  };

  // Document meta + carton statements + notes can appear anywhere on the page.
  for (const token of tokens) {
    let m = token.text.match(/^Document No:\s*(.+)$/i);
    if (m && !parsed.docNo) {
      parsed.docNo = m[1].trim();
      parsed.docNoSource = token.sourceText;
    }
    m = token.text.match(/^Date:\s*(.+)$/i);
    if (m && !parsed.date) {
      parsed.date = m[1].trim();
      parsed.dateSource = token.sourceText;
    }
    m = token.text.match(/^Bill to:\s*(.+)$/i);
    if (m && !parsed.billTo) {
      parsed.billTo = m[1].trim();
      parsed.billToSource = token.sourceText;
    }
    m = token.text.match(/^Job ref:\s*(.+)$/i);
    if (m && !parsed.jobRef) {
      parsed.jobRef = m[1].trim();
      parsed.jobRefSource = token.sourceText;
    }

    const carton = token.text.match(/(\d+)\s+cartons?\b/i);
    if (carton && /dispatched|picked|loaded/i.test(token.text)) {
      parsed.cartonCounts.push({
        count: Number.parseInt(carton[1], 10),
        sourceText: token.sourceText,
      });
    }
    if (/^note:/i.test(token.text) || /^total consignment/i.test(token.text)) {
      parsed.notes.push(token.sourceText);
    }
  }

  // Only enter row parsing after this exact known header. A different layout
  // remains unsupported even if it contains plausible quantities and money.
  // Header: Code Description Qty (Unit|Weight) Unit Price [Amount]
  let rowStart = -1;
  for (let i = 0; i + 4 < tokens.length; i += 1) {
    if (
      tokens[i].text === "Code" &&
      tokens[i + 1].text === "Description" &&
      tokens[i + 2].text === "Qty" &&
      (tokens[i + 3].text === "Unit" || tokens[i + 3].text === "Weight") &&
      tokens[i + 4].text === "Unit Price"
    ) {
      parsed.qtyHeader = tokens[i + 3].text;
      parsed.hasAmountColumn = tokens[i + 5]?.text === "Amount";
      rowStart = i + (parsed.hasAmountColumn ? 6 : 5);
      parsed.tableFound = true;
      break;
    }
  }
  if (rowStart === -1) return parsed;

  // A malformed row is refused as a block. The next clear code boundary lets
  // later valid rows survive; shifting cells to fill a gap could attach a
  // quantity or price to the wrong product.
  let i = rowStart;
  while (i < tokens.length) {
    const token = tokens[i];
    if (/^-{3,}$/.test(token.text)) {
      i += 1;
      continue;
    }
    if (isFooterToken(token.text)) break;

    if (!CODE_RE.test(token.text)) {
      const start = i;
      while (i < tokens.length && !CODE_RE.test(tokens[i].text) && !isFooterToken(tokens[i].text)) i += 1;
      parsed.tableProblems.push({
        reason: "Unexpected text in the line-item table",
        sourceText: text.slice(tokens[start].start, tokens[i - 1].end),
      });
      continue;
    }

    const width = parsed.hasAmountColumn ? 6 : 5;
    const cells = tokens.slice(i, i + width);
    const [code, description, qty, unit, unitPrice, amount] = cells;
    const unitPriceMatch = unitPrice?.text.match(UNIT_PRICE_RE);
    const quantityValue = qty ? parseQty(qty.text) : NaN;
    const valid =
      cells.length === width &&
      description !== undefined && looksLikeDescription(description.text) &&
      qty !== undefined && QTY_RE.test(qty.text) && Number.isSafeInteger(quantityValue) &&
      unit !== undefined && !isFooterToken(unit.text) && !CODE_RE.test(unit.text) &&
      !QTY_RE.test(unit.text) && !MONEY_RE.test(unit.text) &&
      unitPrice !== undefined && unitPriceMatch !== null && unitPriceMatch !== undefined &&
      validMoney(unitPriceMatch[1]) &&
      (!parsed.hasAmountColumn || (amount !== undefined && MONEY_RE.test(amount.text) && validMoney(amount.text)));

    if (!valid) {
      const start = i;
      i += 1;
      while (i < tokens.length && !CODE_RE.test(tokens[i].text) && !isFooterToken(tokens[i].text)) i += 1;
      parsed.tableProblems.push({
        reason: `Could not safely read row ${code.text}`,
        sourceText: text.slice(tokens[start].start, tokens[i - 1].end),
      });
      continue;
    }

    // The validity check above establishes these cells and match exist. The
    // amount stays null if the document did not print an Amount column; the
    // parser does not manufacture one from quantity times unit price.
    const descriptionCell = description!;
    const qtyCell = qty!;
    const unitCell = unit!;
    const priceCell = unitPrice!;
    const priceMatch = unitPriceMatch!;
    const blockText = text.slice(code.start, cells[width - 1].end);
    parsed.lineItems.push({
      code: code.text,
      codeEvidence: { page, sourceText: code.sourceText },
      description: descriptionCell.text,
      descriptionEvidence: { page, sourceText: descriptionCell.sourceText },
      quantity: traced(qtyCell.text, quantityValue, page, qtyCell.sourceText),
      unit: unitCell.text,
      unitEvidence: { page, sourceText: unitCell.sourceText },
      unitPrice: traced(priceCell.text, parseMoney(priceMatch[1]), page, priceCell.sourceText),
      amount: parsed.hasAmountColumn && amount
        ? traced(amount.text, parseMoney(amount.text), page, amount.sourceText)
        : null,
      blockEvidence: { page, sourceText: blockText },
    });
    i += width;
  }

  // Totals live in the footer region. Labels and values may arrive as two
  // tokens ("Total:" + "$2,050.00") or one ("Total: $2,050.00"). Keep each
  // printed candidate and report conflicting copies; the orchestrator decides
  // whether any total can be checked against all retained line amounts.
  for (let k = i; k < tokens.length; k += 1) {
    const token = tokens[k];
    const next = tokens[k + 1];
    let label: string | null = null;
    let moneyRaw: string | null = null;
    const combined = token.text.match(/^(.*?)\s+(\$[\d,]+\.\d{2})$/);
    if (combined && totalsKind(combined[1])) {
      label = combined[1];
      moneyRaw = combined[2];
    } else if (
      next !== undefined &&
      MONEY_RE.test(next.text) &&
      totalsKind(token.text)
    ) {
      label = token.text;
      moneyRaw = next.text;
    }
    if ((!label || !moneyRaw) && totalsKind(token.text) && next?.text.startsWith("$")) {
      parsed.totalProblems.push({ reason: `Could not read ${token.text} value`, sourceText: text.slice(token.start, next.end) });
    }
    if (label && moneyRaw && (!MONEY_RE.test(moneyRaw) || !validMoney(moneyRaw))) {
      parsed.totalProblems.push({ reason: `Malformed ${label} value`, sourceText: token.sourceText });
    }
    if (!label || !moneyRaw || !MONEY_RE.test(moneyRaw) || !validMoney(moneyRaw)) continue;
    const kind = totalsKind(label);
    if (!kind) continue;
    const sourceText = moneyRaw === next?.text
      ? text.slice(token.start, next.end)
      : token.sourceText;
    const candidate = traced(moneyRaw, parseMoney(moneyRaw), page, sourceText);
    const first = parsed.totals[kind];
    if (!first) {
      parsed.totals[kind] = candidate;
    } else if (first.value !== candidate.value) {
      parsed.totalConflicts.push({ kind, first, second: candidate });
    }
  }

  return parsed;
}
