import type { Evidence, Refusal, RefusalReason } from "./schema";

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
  sources: Evidence[] = [],
): Refusal {
  return { scope, reasonCode, message, plainMessage, page, sources };
}

export function pageReadFailed(page: number, detail: string): Refusal {
  return make(
    "page", "PAGE_READ_FAILED",
    `Page ${page} failed inside the PDF reader: ${detail}`,
    `We couldn't read page ${page} because the PDF reader reported a problem. Other pages were still checked.`,
    page,
  );
}

export function unsupportedLayout(page: number, sourceText: string): Refusal {
  return make(
    "page", "UNSUPPORTED_LAYOUT",
    `Page ${page} contains readable text but no supported line-item table.`,
    `Page ${page} has readable text, but its table layout isn't one this reader can verify. We left its values out rather than guess which numbers belong together.`,
    page,
    sourceText ? [{ page, sourceText }] : [],
  );
}

export function unparsedRow(page: number, reason: string, sourceText: string): Refusal {
  return make(
    "line", "UNPARSED_ROW",
    `Page ${page}: ${reason}.`,
    `We couldn't safely read one part of the table on page ${page}, so those values were left out. Other clear rows from the page are still shown.`,
    page,
    sourceText ? [{ page, sourceText }] : [],
  );
}

export function totalsWithheld(page: number): Refusal {
  return make(
    "total", "UNVERIFIED_TOTAL",
    `Page ${page} has unparsed table content; printed totals cannot be checked against all rows.`,
    `We left out the totals on page ${page} because at least one table row could not be read. A total checked against only the visible rows could be misleading.`,
    page,
  );
}

export function unparsedTotal(page: number, reason: string, sourceText: string): Refusal {
  return make(
    "total", "UNVERIFIED_TOTAL",
    `Page ${page}: ${reason}.`,
    `We couldn't safely read one of the totals on page ${page}, so that figure is left out.`,
    page,
    sourceText ? [{ page, sourceText }] : [],
  );
}

export function dependentTotalRefused(page: number, sourceText: string): Refusal {
  return make(
    "total", "UNVERIFIED_TOTAL",
    `Page ${page}: total depends on a GST value that was refused.`,
    `We left out the total on page ${page} because its GST figure could not be verified.`,
    page,
    [{ page, sourceText }],
  );
}

export function scannedPage(page: number): Refusal {
  return make(
    "page",
    "SCANNED_NO_TEXT",
    `Page ${page} paints an image but contains zero extractable PDF text characters.`,
    `You may be able to read page ${page} on screen, but it is a picture with no selectable text. ` +
      `This reader cannot extract its words or numbers, so nothing from that page is included. Please enter it manually or upload a searchable PDF.`,
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
    `Page ${page} has unit or weight cells (${shown}) that cannot be used safely for amount validation.`,
    `Page ${page} uses units or weights such as "${shown}" that we can't safely match to the prices. ` +
      `We kept the printed quantities and prices, but left out amounts that would need that assumption.`,
    page,
    rawUnits[0] ? [{ page, sourceText: rawUnits[0] }] : [],
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
  const plainMessage = scope === "line"
    ? `The ${what} printed on the document (${printed}) doesn't match quantity times unit price (${recomputed}). We kept the printed quantity and price, but left out that amount.`
    : `The ${what} printed on the document (${printed}) doesn't match the figure calculated from the readable lines (${recomputed}), so we left that total out.`;
  return make(
    scope,
    "ARITHMETIC_MISMATCH",
    `${what} mismatch: printed ${printed} but recomputed ${recomputed}.`,
    plainMessage,
    page,
    page !== null && sourceText ? [{ page, sourceText }] : [],
  );
}

export function conflictingSources(
  what: string,
  first: Evidence,
  second: Evidence,
  page: number | null,
): Refusal {
  return make(
    "field",
    "CONFLICTING_SOURCES",
    `${what} conflict: "${first.sourceText}" vs "${second.sourceText}" in the same file.`,
    `The document says two different things about ${what}: "${first.sourceText}" in one place and "${second.sourceText}" ` +
      `in another. Rather than pick one, we're showing neither — please check the original.`,
    page,
    [first, second],
  );
}

export function mixedDocumentTypes(pages: number): Refusal {
  return make(
    "total",
    "MIXED_DOCUMENT_TYPES",
    `Document bundles multiple document types across ${pages} pages; no grand total emitted.`,
    `This file combines different kinds of paperwork across ${pages} pages. Adding every line into one total could mix charges with credits or confirmations, so we left out a combined total. The readable lines remain listed by page.`,
  );
}

export function multiPageTotalsRefused(): Refusal {
  return make(
    "total", "MULTI_PAGE_TOTAL_REFUSED",
    "Multiple readable pages have line items but no verified document-level total.",
    "This file has line items on several pages. We haven't added them into one total because the document doesn't provide a combined figure we can verify.",
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
