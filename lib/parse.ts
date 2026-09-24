import type { LineItem, Totals, TracedNumber } from "./schema";

/**
 * Deterministic parser for the Ironbark table layout.
 *
 * Strict by design: a row is only emitted when every cell matches the
 * grammar below AND the exact source tokens are retained as evidence. Anything
 * that does not fit is left unparsed — the caller turns leftovers into
 * refusals rather than guesses.
 *
 * Grammar (one token per cell, tokens = non-blank pdfjs text items):
 *   code        ^[A-Z]{2}-\d{3,4}$          e.g. "FX-201", "CX-1000"
 *   description any non-empty token that is not a code/number/money/marker
 *   qty         ^[\d,]+$                    e.g. "24", "2,000"
 *   unit        any non-empty token         e.g. "box" | "640g total"
 *   unitPrice   $x.xx with optional "/per"  e.g. "$52.00", "$74.00 /carton"
 *   amount      $x.xx                       e.g. "$1,248.00" (only if the
 *                                           header prints an Amount column)
 */

const CODE_RE = /^[A-Z]{2}-\d{3,4}$/;
const QTY_RE = /^[\d,]+$/;
const MONEY_RE = /^\$([\d,]+\.\d{2})$/;
const UNIT_PRICE_RE = /^\$([\d,]+\.\d{2})(?:\s*\/\s*([A-Za-z]+))?\s*$/;

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

export interface ParsedPage {
  page: number;
  /** "Unit" | "Weight" | null when no table header was found. */
  qtyHeader: string | null;
  hasAmountColumn: boolean;
  docNo: string | null;
  docNoSource: string | null;
  date: string | null;
  billTo: string | null;
  jobRef: string | null;
  lineItems: LineItem[];
  totals: Totals;
  totalsSources: string[];
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

/** Split raw page text into non-blank tokens (one cell each). */
export function tokenize(text: string): string[] {
  return text
    .split("\n")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

export function parsePage(page: number, text: string): ParsedPage {
  const tokens = tokenize(text);
  const parsed: ParsedPage = {
    page,
    qtyHeader: null,
    hasAmountColumn: false,
    docNo: null,
    docNoSource: null,
    date: null,
    billTo: null,
    jobRef: null,
    lineItems: [],
    totals: { subtotal: null, gst: null, total: null },
    totalsSources: [],
    cartonCounts: [],
    notes: [],
  };

  // Document meta + carton statements + notes can appear anywhere on the page.
  for (const token of tokens) {
    let m = token.match(/^Document No:\s*(.+)$/i);
    if (m && !parsed.docNo) {
      parsed.docNo = m[1].trim();
      parsed.docNoSource = token;
    }
    m = token.match(/^Date:\s*(.+)$/i);
    if (m && !parsed.date) parsed.date = m[1].trim();
    m = token.match(/^Bill to:\s*(.+)$/i);
    if (m && !parsed.billTo) parsed.billTo = m[1].trim();
    m = token.match(/^Job ref:\s*(.+)$/i);
    if (m && !parsed.jobRef) parsed.jobRef = m[1].trim();

    const carton = token.match(/(\d+)\s+cartons?\b/i);
    if (carton && /dispatched|picked|loaded/i.test(token)) {
      parsed.cartonCounts.push({
        count: Number.parseInt(carton[1], 10),
        sourceText: token,
      });
    }
    if (/^note:/i.test(token) || /^total consignment/i.test(token)) {
      parsed.notes.push(token);
    }
  }

  // Header: Code Description Qty (Unit|Weight) Unit Price [Amount]
  let rowStart = -1;
  for (let i = 0; i + 4 < tokens.length; i += 1) {
    if (
      tokens[i] === "Code" &&
      tokens[i + 1] === "Description" &&
      tokens[i + 2] === "Qty" &&
      (tokens[i + 3] === "Unit" || tokens[i + 3] === "Weight") &&
      tokens[i + 4] === "Unit Price"
    ) {
      parsed.qtyHeader = tokens[i + 3];
      parsed.hasAmountColumn = tokens[i + 5] === "Amount";
      rowStart = i + (parsed.hasAmountColumn ? 6 : 5);
      break;
    }
  }
  if (rowStart === -1) return parsed;

  // Rows.
  let i = rowStart;
  while (i < tokens.length) {
    const token = tokens[i];
    // Decorative rule lines (e.g. under the header) are neither rows nor footers.
    if (/^-{3,}$/.test(token)) {
      i += 1;
      continue;
    }
    if (isFooterToken(token)) break;
    if (!CODE_RE.test(token)) {
      i += 1;
      continue;
    }
    const block = [token];
    const code = token;
    const description = tokens[i + 1];
    const qtyRaw = tokens[i + 2];
    const unitRaw = tokens[i + 3];
    const unitPriceRaw = tokens[i + 4];
    const amountRaw = parsed.hasAmountColumn ? tokens[i + 5] : undefined;

    const okShape =
      description !== undefined &&
      looksLikeDescription(description) &&
      qtyRaw !== undefined &&
      QTY_RE.test(qtyRaw) &&
      unitRaw !== undefined &&
      !isFooterToken(unitRaw) &&
      unitPriceRaw !== undefined &&
      UNIT_PRICE_RE.test(unitPriceRaw) &&
      (!parsed.hasAmountColumn ||
        (amountRaw !== undefined && MONEY_RE.test(amountRaw)));

    if (!okShape) break; // strict: stop, never skip-and-guess

    block.push(description, qtyRaw, unitRaw, unitPriceRaw);
    const width = parsed.hasAmountColumn ? 6 : 5;
    if (parsed.hasAmountColumn && amountRaw) block.push(amountRaw);
    const sourceText = block.join("\n");

    const unitPriceMatch = unitPriceRaw.match(UNIT_PRICE_RE);
    if (!unitPriceMatch) break;
    parsed.lineItems.push({
      code,
      codeEvidence: { page, sourceText: code },
      description,
      descriptionEvidence: { page, sourceText: description },
      quantity: traced(qtyRaw, parseQty(qtyRaw), page, qtyRaw),
      unit: unitRaw,
      unitEvidence: { page, sourceText: unitRaw },
      unitPrice: traced(
        unitPriceRaw,
        parseMoney(unitPriceMatch[1]),
        page,
        unitPriceRaw,
      ),
      amount:
        parsed.hasAmountColumn && amountRaw
          ? traced(amountRaw, parseMoney(amountRaw), page, amountRaw)
          : null,
      blockEvidence: { page, sourceText },
    });
    i += width;
  }

  // Totals live in the footer region. Labels and values may arrive as two
  // tokens ("Total:" + "$2,050.00") or one ("Total: $2,050.00").
  for (let k = i; k < tokens.length; k += 1) {
    const token = tokens[k];
    const next = tokens[k + 1];
    let label: string | null = null;
    let moneyRaw: string | null = null;
    const combined = token.match(/^(.*?)\s+(\$[\d,]+\.\d{2})$/);
    if (combined && totalsKind(combined[1])) {
      label = combined[1];
      moneyRaw = combined[2];
    } else if (
      next !== undefined &&
      MONEY_RE.test(next) &&
      totalsKind(token)
    ) {
      label = token;
      moneyRaw = next;
    }
    if (!label || !moneyRaw) continue;
    const kind = totalsKind(label);
    const sourceText =
      moneyRaw === next ? label + "\n" + moneyRaw : token;
    if (kind === "subtotal" && !parsed.totals.subtotal) {
      parsed.totals.subtotal = traced(moneyRaw, parseMoney(moneyRaw), page, sourceText);
      parsed.totalsSources.push(label);
    } else if (kind === "gst" && !parsed.totals.gst) {
      parsed.totals.gst = traced(moneyRaw, parseMoney(moneyRaw), page, sourceText);
      parsed.totalsSources.push(label);
    } else if (kind === "total" && !parsed.totals.total) {
      parsed.totals.total = traced(moneyRaw, parseMoney(moneyRaw), page, sourceText);
      parsed.totalsSources.push(label);
    }
  }

  return parsed;
}
