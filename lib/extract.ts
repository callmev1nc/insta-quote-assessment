import { extractPageTexts, MIN_READABLE_CHARS, type PageText } from "./pdf";
import { parsePage, type ParsedPage } from "./parse";
import {
  ambiguousUnit,
  arithmeticMismatch,
  conflictingSources,
  conversionRefused,
  dependentTotalRefused,
  missingTotal,
  mixedDocumentTypes,
  multiPageTotalsRefused,
  pageReadFailed,
  scannedPage,
  totalsWithheld,
  unparsedRow,
  unparsedTotal,
  unreadablePage,
  unsupportedLayout,
} from "./refusals";
import type {
  DocumentMeta,
  Evidence,
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

/** Section titles that mark a statement bundling several document types. */
const SECTION_KINDS: Array<{ kind: string; re: RegExp }> = [
  { kind: "invoice", re: /invoice \d+ of \d+/i },
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
  return `$${n.toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
      sources: [],
    };
    return { ok: false, fileName, error: { code: "PDF_UNREADABLE", message, plainMessage: refusal.plainMessage }, refusals: [refusal] };
  }

  return extractFromPages(pages, fileName);
}

/** Pure orchestration boundary so page containment can be tested without a PDF fixture. */
export function extractFromPages(pages: PageText[], fileName: string): Envelope {
  const refusals: Refusal[] = [];
  const lineItems: LineItem[] = [];
  const parsedPages: ParsedPage[] = [];
  const pageTexts: string[] = [];
  const pageResults: PageResult[] = [];

  const meta: DocumentMeta = {
    docNo: null,
    docNoEvidence: null,
    date: null,
    dateEvidence: null,
    billTo: null,
    billToEvidence: null,
    jobRef: null,
    jobRefEvidence: null,
  };
  const docNos = new Map<string, Evidence>();

  for (const { page, text, charCount, hasImage, readError } of pages) {
    pageTexts.push(text);
    if (readError) {
      refusals.push(pageReadFailed(page, readError));
      pageResults.push({ page, status: "refused", itemCount: 0 });
      continue;
    }
    if (charCount < MIN_READABLE_CHARS) {
      refusals.push(hasImage ? scannedPage(page) : unreadablePage(page, charCount));
      pageResults.push({ page, status: "refused", itemCount: 0 });
      continue;
    }
    let parsed: ParsedPage;
    try {
      parsed = parsePage(page, text);
    } catch (err) {
      refusals.push(pageReadFailed(page, err instanceof Error ? err.message : "The page parser failed."));
      pageResults.push({ page, status: "refused", itemCount: 0 });
      continue;
    }

    if (!parsed.tableFound) {
      refusals.push(unsupportedLayout(page, text.slice(0, 180)));
      pageResults.push({ page, status: "refused", itemCount: 0 });
      continue;
    }
    if (parsed.lineItems.length === 0 && parsed.tableProblems.length === 0) {
      refusals.push(unsupportedLayout(page, text.slice(0, 180)));
      pageResults.push({ page, status: "refused", itemCount: 0 });
      continue;
    }

    parsedPages.push(parsed);
    for (const problem of parsed.tableProblems) {
      refusals.push(unparsedRow(page, problem.reason, problem.sourceText));
    }
    for (const problem of parsed.totalProblems) {
      refusals.push(unparsedTotal(page, problem.reason, problem.sourceText));
    }

    if (parsed.docNo && !meta.docNo) {
      meta.docNo = parsed.docNo;
      meta.docNoEvidence = parsed.docNoSource ? { page, sourceText: parsed.docNoSource } : null;
    }
    if (parsed.date && !meta.date) {
      meta.date = parsed.date;
      meta.dateEvidence = parsed.dateSource ? { page, sourceText: parsed.dateSource } : null;
    }
    if (parsed.billTo && !meta.billTo) {
      meta.billTo = parsed.billTo;
      meta.billToEvidence = parsed.billToSource ? { page, sourceText: parsed.billToSource } : null;
    }
    if (parsed.jobRef && !meta.jobRef) {
      meta.jobRef = parsed.jobRef;
      meta.jobRefEvidence = parsed.jobRefSource ? { page, sourceText: parsed.jobRefSource } : null;
    }
    if (parsed.docNo && parsed.docNoSource) docNos.set(parsed.docNo, { page, sourceText: parsed.docNoSource });

    // Line-amount gate: printed amount must equal qty x unit price.
    for (const item of parsed.lineItems) {
      const trustedUnit = parsed.qtyHeader !== "Weight" && KNOWN_UNITS.has(item.unit.trim().toLowerCase());
      if (!item.amount || !trustedUnit) {
        lineItems.push(trustedUnit ? item : { ...item, amount: null });
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

    pageResults.push({
      page,
      status: parsed.lineItems.length === 0 ? "refused" : parsed.tableProblems.length || parsed.totalProblems.length ? "partial" : "ok",
      itemCount: parsed.lineItems.length,
    });
  }

  if (docNos.size > 1) {
    const [first, second] = [...docNos.values()];
    refusals.push(
      conflictingSources("document number", first, second, null),
    );
    meta.docNo = null;
    meta.docNoEvidence = null;
  }

  const metadataChecks = [
    {
      what: "date",
      entries: parsedPages.map((p) => ({ value: p.date, source: p.dateSource, page: p.page })),
      clear: () => { meta.date = null; meta.dateEvidence = null; },
    },
    {
      what: "bill-to name",
      entries: parsedPages.map((p) => ({ value: p.billTo, source: p.billToSource, page: p.page })),
      clear: () => { meta.billTo = null; meta.billToEvidence = null; },
    },
    {
      what: "job reference",
      entries: parsedPages.map((p) => ({ value: p.jobRef, source: p.jobRefSource, page: p.page })),
      clear: () => { meta.jobRef = null; meta.jobRefEvidence = null; },
    },
  ];
  for (const check of metadataChecks) {
    const first = check.entries.find((entry) => entry.value && entry.source);
    const second = check.entries.find((entry) => first && entry.value && entry.source && entry.value !== first.value);
    if (first?.source && second?.source) {
      refusals.push(conflictingSources(
        check.what,
        { page: first.page, sourceText: first.source },
        { page: second.page, sourceText: second.source },
        null,
      ));
      check.clear();
    }
  }

  // ---- Unit gates ---------------------------------------------------------
  const ambiguousPages = new Set<number>();
  for (const parsed of parsedPages) {
    const unknownUnits = parsed.lineItems
      .map((item) => item.unit)
      .filter((unit) => !KNOWN_UNITS.has(unit.trim().toLowerCase()));
    if (parsed.qtyHeader === "Weight" || unknownUnits.length > 0) {
      ambiguousPages.add(parsed.page);
      refusals.push(ambiguousUnit(parsed.page, unknownUnits.length ? unknownUnits : ["Weight"]));
      refusals.push(conversionRefused(parsed.page));
    }
  }

  // ---- Totals gates ---------------------------------------------------------
  const multiPage = pages.length > 1;
  const kinds = new Set(pageTexts.flatMap(kindsOnPage));
  const isMixedBundle =
    multiPage && kinds.size > 1 && kinds.has("invoice");

  let totals: Totals | null = null;
  if (isMixedBundle) {
    // Never sum invoices + freight + credit + delivery into one number.
    refusals.push(mixedDocumentTypes(pages.length));
    totals = null;
  } else if (pages.length === 1 && parsedPages.length === 1) {
    const parsed = parsedPages[0];
    const { subtotal, gst, total } = parsed.totals;
    const validatedLines = lineItems.filter((item) => item.blockEvidence.page === parsed.page);
    const pageAmounts = validatedLines
      .map((i) => i.amount?.value ?? null)
      .filter((v): v is number => v !== null);
    const canRecompute = pageAmounts.length === parsed.lineItems.length && pageAmounts.length > 0;
    const incompleteTable = parsed.tableProblems.length > 0 || ambiguousPages.has(parsed.page) ||
      (parsed.lineItems.length > 0 && !canRecompute);

    let keptSubtotal = subtotal;
    let keptGst = gst;
    let keptTotal = total;

    for (const conflict of parsed.totalConflicts) {
      refusals.push(conflictingSources(
        `the ${conflict.kind}`,
        conflict.first.evidence,
        conflict.second.evidence,
        parsed.page,
      ));
      if (conflict.kind === "subtotal") keptSubtotal = null;
      if (conflict.kind === "gst") keptGst = null;
      if (conflict.kind === "total") keptTotal = null;
    }

    if (incompleteTable && (subtotal || gst || total)) {
      refusals.push(totalsWithheld(parsed.page));
      keptSubtotal = null;
      keptGst = null;
      keptTotal = null;
    }

    if (keptSubtotal && canRecompute && !incompleteTable) {
      const expected = pageAmounts.reduce((a, b) => a + b, 0);
      if (Math.abs(keptSubtotal.value - expected) > MONEY_TOLERANCE) {
        refusals.push(
          arithmeticMismatch("total", "subtotal", keptSubtotal.raw, money(expected), parsed.page, keptSubtotal.evidence.sourceText),
        );
        keptSubtotal = null;
      }
    }
    const baseForGst = canRecompute ? pageAmounts.reduce((a, b) => a + b, 0) : null;
    const printedRate = keptGst?.evidence.sourceText.match(/\((\d+(?:\.\d+)?)%\)/)?.[1];
    if (keptGst && baseForGst !== null && printedRate !== undefined && !incompleteTable) {
      const expectedGst = baseForGst * (Number(printedRate) / 100);
      if (Math.abs(keptGst.value - expectedGst) > 0.02) {
        refusals.push(
          arithmeticMismatch("total", "GST", keptGst.raw, money(expectedGst), parsed.page, keptGst.evidence.sourceText),
        );
        keptGst = null;
      }
    }
    const baseForTotal = canRecompute ? pageAmounts.reduce((a, b) => a + b, 0) : null;
    if (keptTotal && gst && !keptGst && !incompleteTable) {
      refusals.push(dependentTotalRefused(parsed.page, keptTotal.evidence.sourceText));
      keptTotal = null;
    }
    if (keptTotal && baseForTotal !== null && !incompleteTable) {
      // No GST line printed (e.g. a GST-inclusive "Total:" with no breakdown):
      // the total must equal the lines. With a GST line, it must equal
      // base + the printed GST if that GST survived its validation.
      const gstShare = keptGst?.value ?? 0;
      const expectedTotal = baseForTotal + gstShare;
      if (Math.abs(keptTotal.value - expectedTotal) > MONEY_TOLERANCE) {
        refusals.push(
          arithmeticMismatch("total", "total", keptTotal.raw, money(expectedTotal), parsed.page, keptTotal.evidence.sourceText),
        );
        keptTotal = null;
      }
    }

    if (!subtotal && !gst && !total && parsed.totalConflicts.length === 0) {
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
  } else if (pages.length > 1 && parsedPages.length > 0) {
    refusals.push(multiPageTotalsRefused());
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
    const first = cartonCounts[0];
    const second = cartonCounts.find((count) => count.count !== first.count)!;
    refusals.push(
      conflictingSources(
        "the carton count",
        { page: first.page, sourceText: first.sourceText },
        { page: second.page, sourceText: second.sourceText },
        first.page,
      ),
    );
  }

  for (const result of pageResults) {
    if (result.status === "ok" && refusals.some((refusal) => refusal.page === result.page)) {
      result.status = "partial";
    }
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
