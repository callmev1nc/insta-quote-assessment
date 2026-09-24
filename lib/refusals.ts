import type { Refusal, RefusalReason } from "./schema";

/**
 * Refusal taxonomy. Every refusal carries two messages:
 * - `message`: technical, for logs and reviewers.
 * - `plainMessage`: shown verbatim in the UI. Written for a trade business
 *   owner, not an engineer. Never jargon, never "an error occurred".
 */

type Scope = Refusal["scope"];

function make(
  scope: Scope,
  reasonCode: RefusalReason,
  message: string,
  plainMessage: string,
  page: number | null = null,
  sourceText: string | null = null,
): Refusal {
  return { scope, reasonCode, message, plainMessage, page, sourceText };
}

export function scannedPage(page: number): Refusal {
  return make(
    "page",
    "SCANNED_NO_TEXT",
    `Page ${page} contains only an image (scan/photo) with no extractable text.`,
    `Page ${page} looks like a photo or scan, so we couldn't read any text from it. ` +
      `Nothing from that page is included below — it needs re-scanning as a readable PDF or manual entry.`,
    page,
  );
}

export function unreadablePage(page: number, chars: number): Refusal {
  return make(
    "page",
    "UNREADABLE_PAGE",
    `Page ${page} yielded only ${chars} readable characters; too little to parse safely.`,
    `Page ${page} didn't contain enough readable text to work with, so we left it out. ` +
      `Every other readable page is still included below.`,
    page,
  );
}

export function ambiguousUnit(page: number, rawUnits: string[]): Refusal {
  const shown = [...new Set(rawUnits)].slice(0, 4).join(", ");
  return make(
    "field",
    "AMBIGUOUS_UNIT",
    `Page ${page} uses a Weight column with unconverted units (${shown}); no unit normalisation applied.`,
    `Page ${page} lists weights (like "${shown}") instead of plain quantities, and the file itself says ` +
      `they're unconverted. We listed the lines as printed but didn't convert between grams and kilos — ` +
      `that maths is left for you to confirm.`,
    page,
    rawUnits[0] ?? null,
  );
}

export function conversionRefused(page: number): Refusal {
  return make(
    "total",
    "UNIT_CONVERSION_REFUSED",
    `Page ${page}: line amounts and totals need unit conversion; refused rather than computed.`,
    `Because page ${page} mixes units like grams and kilos, we didn't calculate any line amounts or totals ` +
      `from them. The quantities and prices above are exactly as printed.`,
    page,
  );
}

export function arithmeticMismatch(
  scope: Scope,
  what: string,
  printed: string,
  recomputed: string,
  page: number | null,
  sourceText: string | null,
): Refusal {
  return make(
    scope,
    "ARITHMETIC_MISMATCH",
    `${what} mismatch: printed ${printed} but recomputed ${recomputed}.`,
    `The ${what} printed on the document (${printed}) doesn't match what the line items add up to ` +
      `(${recomputed}), so we're not showing it. The individual lines above are still fine — ` +
      `it's the ${what} that can't be trusted.`,
    page,
    sourceText,
  );
}

export function conflictingSources(
  what: string,
  first: string,
  second: string,
  page: number | null,
): Refusal {
  return make(
    "field",
    "CONFLICTING_SOURCES",
    `${what} conflict: "${first}" vs "${second}" in the same file.`,
    `The document says two different things about ${what}: "${first}" in one place and "${second}" ` +
      `in another. Rather than pick one, we're showing neither — please check the original.`,
    page,
    `${first} / ${second}`,
  );
}

export function mixedDocumentTypes(pages: number): Refusal {
  return make(
    "total",
    "MIXED_DOCUMENT_TYPES",
    `Document bundles multiple types (invoices, summary, freight, credit, delivery) across ${pages} pages; no grand total emitted.`,
    `This file bundles several different kinds of paperwork (invoices, freight charges, a credit note ` +
      `reference and a delivery confirmation). Adding them into one grand total would mix money in with ` +
      `money out, so we haven't done that. Each page's lines are listed separately above.`,
  );
}

export function missingTotal(detail: string): Refusal {
  return make(
    "total",
    "MISSING_TOTAL",
    `No total printed on the document: ${detail}.`,
    `The document doesn't print a total to show (${detail}). The lines above are everything we could read.`,
  );
}
