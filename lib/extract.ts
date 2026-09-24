import { extractPageTexts, MIN_READABLE_CHARS } from "./pdf";
import { parsePage, type ParsedPage } from "./parse";
import {
  ambiguousUnit,
  arithmeticMismatch,
  conflictingSources,
  conversionRefused,
  missingTotal,
  mixedDocumentTypes,
  scannedPage,
  unreadablePage,
} from "./refusals";
import type {
  DocumentMeta,
  Envelope,
  LineItem,
  PageResult,
  Refusal,
  Totals,
} from "./schema";

/**
 * Orchestrator: per-page containment + cross-page validation rules.
 *
 * Two guarantees:
 * 1. A failure on one page never takes down the rest (per-page try/catch).
 * 2. A number only survives into the output if it is traced to a page and
 *    source text AND survives every validation gate. Otherwise it becomes a
 *    refusal that names both the printed and the recomputed figure.
 */

const KNOWN_UNITS = new Set([
  "ea",
  "box",
  "length",
  "pack",
  "kit",
  "carton",
  "tub",
]);

const MONEY_TOLERANCE = 0.01;
const GST_RATE = 0.15;

/** Section titles that mark a statement bundling several document types. */
const SECTION_KINDS: Array<{ kind: string; re: RegExp }> = [
  { kind: "invoice", re: /invoice \d+ of \d+/i },
  { kind: "materials", re: /\bmaterials\b/i },
  { kind: "fixings", re: /\bfixings\b/i },
  { kind: "summary", re: /statement summary/i },
  { kind: "freight", re: /freight charges/i },
  { kind: "credit", re: /credit note/i },
  { kind: "delivery", re: /delivery confirmation/i },
];

function kindsOnPage(text: string): string[] {
  return SECTION_KINDS.filter(({ re }) => re.test(text)).map(
    ({ kind }) => kind,
  );
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

export async function extractDocument(
  buffer: Buffer,
  fileName: string,
): Promise<Envelope> {
  let pages;
  try {
    pages = await extractPageTexts(buffer);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "PDF could not be opened.";
    const refusal: Refusal = {
      scope: "document",
      reasonCode: "PDF_UNREADABLE",
      message,
      plainMessage:
        "We couldn't open this file as a PDF at all — it may be corrupted or password-protected. " +
        "Nothing was extracted.",
      page: null,
      sourceText: null,
    };
    return { ok: false, fileName, error: { code: "PDF_UNREADABLE", message, plainMessage: refusal.plainMessage }, refusals: [refusal] };
  }

  const refusals: Refusal[] = [];
  const lineItems: LineItem[] = [];
  const parsedPages: ParsedPage[] = [];
  const pageTexts: string[] = [];
  const pageResults: PageResult[] = [];

  let meta: DocumentMeta = {
    docNo: null,
    docNoEvidence: null,
    date: null,
    billTo: null,
    jobRef: null,
  };
  const docNos = new Map<string, number>();

  for (const { page, text, charCount, hasImage } of pages) {
    pageTexts.push(text);
    if (charCount < MIN_READABLE_CHARS) {
      refusals.push(hasImage ? scannedPage(page) : unreadablePage(page, charCount));
      pageResults.push({ page, status: "refused", itemCount: 0 });
      continue;
    }
    let parsed: ParsedPage;
    try {
      parsed = parsePage(page, text);
    } catch (err) {
      refusals.push(
        unreadablePage(
          page,
          charCount,
        ),
      );
      void err;
      pageResults.push({ page, status: "refused", itemCount: 0 });
      continue;
    }

    parsedPages.push(parsed);

    if (parsed.docNo && !meta.docNo) {
      meta = {
        docNo: parsed.docNo,
        docNoEvidence: parsed.docNoSource
          ? { page, sourceText: parsed.docNoSource }
          : null,
        date: parsed.date,
        billTo: parsed.billTo,
        jobRef: parsed.jobRef,
      };
    }
    if (parsed.docNo) docNos.set(parsed.docNo, page);

    // Line-amount gate: printed amount must equal qty x unit price.
    for (const item of parsed.lineItems) {
      if (!item.amount) {
        lineItems.push(item);
        continue;
      }
      const expected = item.quantity.value * item.unitPrice.value;
      if (Math.abs(item.amount.value - expected) > MONEY_TOLERANCE) {
        refusals.push(
          arithmeticMismatch(
            "line",
            `line amount for ${item.code}`,
            item.amount.raw,
            money(expected),
            page,
            item.blockEvidence.sourceText,
          ),
        );
        lineItems.push({ ...item, amount: null });
      } else {
        lineItems.push(item);
      }
    }

    pageResults.push({ page, status: "ok", itemCount: parsed.lineItems.length });
  }

  if (docNos.size > 1) {
    const [first, second] = [...docNos.keys()];
    refusals.push(
      conflictingSources("document number", first, second, null),
    );
  }

  // ---- Unit gates ---------------------------------------------------------
  const rawUnits = parsedPages.flatMap((p) =>
    p.lineItems.map((i) => i.unit),
  );
  const hasWeightColumn = parsedPages.some((p) => p.qtyHeader === "Weight");
  const unknownUnits = rawUnits.filter(
    (u) => !KNOWN_UNITS.has(u.trim().toLowerCase()),
  );
  const readablePages = parsedPages.map((p) => p.page);
  const unitScopePage = readablePages[0] ?? null;
  if ((hasWeightColumn || unknownUnits.length > 0) && unitScopePage !== null) {
    refusals.push(ambiguousUnit(unitScopePage, unknownUnits.length > 0 ? unknownUnits : ["Weight"]));
    refusals.push(conversionRefused(unitScopePage));
  }

  // ---- Totals gates ---------------------------------------------------------
  const multiPage = parsedPages.length > 1;
  const kinds = new Set(pageTexts.flatMap(kindsOnPage));
  const isMixedBundle =
    multiPage && kinds.size > 1 && kinds.has("invoice");

  let totals: Totals | null = null;
  if (isMixedBundle) {
    // Never sum invoices + freight + credit + delivery into one number.
    refusals.push(mixedDocumentTypes(parsedPages.length));
    totals = null;
  } else if (parsedPages.length === 1) {
    const parsed = parsedPages[0];
    const { subtotal, gst, total } = parsed.totals;
    const pageAmounts = parsed.lineItems
      .map((i) => i.amount?.value ?? null)
      .filter((v): v is number => v !== null);
    const canRecompute = pageAmounts.length === parsed.lineItems.length && pageAmounts.length > 0;

    let keptSubtotal = subtotal;
    let keptGst = gst;
    let keptTotal = total;

    if (subtotal && canRecompute) {
      const expected = pageAmounts.reduce((a, b) => a + b, 0);
      if (Math.abs(subtotal.value - expected) > MONEY_TOLERANCE) {
        refusals.push(
          arithmeticMismatch("total", "subtotal", subtotal.raw, money(expected), parsed.page, subtotal.evidence.sourceText),
        );
        keptSubtotal = null;
      }
    }
    const baseForGst = keptSubtotal?.value ?? (canRecompute ? pageAmounts.reduce((a, b) => a + b, 0) : null);
    if (gst && baseForGst !== null) {
      const expectedGst = baseForGst * GST_RATE;
      if (Math.abs(gst.value - expectedGst) > 0.02) {
        refusals.push(
          arithmeticMismatch("total", "GST", gst.raw, money(expectedGst), parsed.page, gst.evidence.sourceText),
        );
        keptGst = null;
      }
    }
    const baseForTotal = keptSubtotal?.value ?? (canRecompute ? pageAmounts.reduce((a, b) => a + b, 0) : null);
    if (total && baseForTotal !== null) {
      // No GST line printed (e.g. a GST-inclusive "Total:" with no breakdown):
      // the total must equal the lines. With a GST line, it must equal
      // base + GST, using recomputed GST when the printed GST failed.
      const gstShare = gst ? (keptGst?.value ?? baseForTotal * GST_RATE) : 0;
      const expectedTotal = baseForTotal + gstShare;
      if (Math.abs(total.value - expectedTotal) > MONEY_TOLERANCE) {
        refusals.push(
          arithmeticMismatch("total", "total", total.raw, money(expectedTotal), parsed.page, total.evidence.sourceText),
        );
        keptTotal = null;
      }
    }

    if (!subtotal && !gst && !total) {
      refusals.push(
        missingTotal(
          parsed.lineItems.length > 0
            ? "this file lists lines but prints no subtotal, GST or total"
            : "no totals section was found",
        ),
      );
      totals = { subtotal: null, gst: null, total: null };
    } else {
      totals = { subtotal: keptSubtotal, gst: keptGst, total: keptTotal };
    }
  } else if (parsedPages.length > 1) {
    // Multi-page, single-type (not present in samples): refuse aggregation.
    refusals.push(mixedDocumentTypes(parsedPages.length));
    totals = null;
  } else {
    totals = null;
  }

  // ---- Carton-count gate ------------------------------------------------------
  const cartonCounts = parsedPages.flatMap((p) =>
    p.cartonCounts.map((c) => ({ ...c, page: p.page })),
  );
  const distinct = [...new Set(cartonCounts.map((c) => c.count))];
  if (distinct.length > 1) {
    const sources = cartonCounts.map((c) => c.sourceText);
    refusals.push(
      conflictingSources(
        "the carton count",
        sources[0],
        sources[1],
        cartonCounts[0].page,
      ),
    );
  }

  return {
    ok: true,
    fileName,
    document: meta,
    lineItems,
    totals,
    refusals,
    pageResults,
  };
}
