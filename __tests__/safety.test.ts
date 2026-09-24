import { describe, expect, it } from "vitest";
import { extractFromPages } from "../lib/extract";
import type { PageText } from "../lib/pdf";
import { EnvelopeSchema } from "../lib/schema";

function page(text: string, number = 1): PageText {
  return {
    page: number,
    text,
    charCount: text.replace(/\s/g, "").length,
    hasImage: false,
    readError: null,
  };
}

function table(rows: string[], footer: string[] = []): string {
  return [
    "Ironbark Trade Merchants Ltd",
    "Document No: TEST-123",
    "Date: 24 September 2026",
    "Job ref: JOB-42",
    "Code", "Description", "Qty", "Unit", "Unit Price", "Amount",
    "-----------------------------------------",
    ...rows,
    ...footer,
  ].join("\n");
}

const goodRow = ["AA-100", "Valid first line", "2", "ea", "$3.00", "$6.00"];

describe("fail-closed extraction", () => {
  it("keeps clear rows around a malformed row and withholds incomplete totals", () => {
    const text = table([
      ...goodRow,
      "AA-101", "Damaged middle line", "1,2", "ea", "$4.00", "$4.00",
      "AA-102", "Valid last line", "3", "ea", "$5.00", "$15.00",
    ], ["Subtotal:", "$25.00", "Total:", "$25.00"]);
    const result = extractFromPages([page(text)], "damaged.pdf");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lineItems.map((item) => item.code)).toEqual(["AA-100", "AA-102"]);
    expect(result.pageResults[0].status).toBe("partial");
    expect(result.totals?.subtotal).toBeNull();
    expect(result.totals?.total).toBeNull();
    const skipped = result.refusals.find((refusal) => refusal.reasonCode === "UNPARSED_ROW" && refusal.scope === "line");
    expect(skipped?.sources[0].sourceText).toContain("1,2");
    expect(result.refusals.map((refusal) => refusal.reasonCode)).toContain("UNVERIFIED_TOTAL");
    for (const item of result.lineItems) {
      expect(text).toContain(item.blockEvidence.sourceText);
      expect(text).toContain(item.quantity.evidence.sourceText);
    }
    expect(EnvelopeSchema.safeParse(result).success).toBe(true);
  });

  it("refuses readable text with an unsupported table", () => {
    const result = extractFromPages([page("Invoice with Item, Description, Count and Cost columns that this parser has never verified")], "unknown.pdf");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lineItems).toHaveLength(0);
    expect(result.pageResults[0].status).toBe("refused");
    expect(result.refusals[0].reasonCode).toBe("UNSUPPORTED_LAYOUT");
    expect(result.refusals[0].plainMessage).toContain("table layout");
  });

  it("refuses contradictory totals and preserves both exact sources", () => {
    const text = table(goodRow, ["Total: $6.00", "Total: $8.00"]);
    const result = extractFromPages([page(text)], "two-totals.pdf");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.totals?.total).toBeNull();
    const conflict = result.refusals.find((refusal) => refusal.reasonCode === "CONFLICTING_SOURCES");
    expect(conflict?.sources.map((source) => source.sourceText)).toEqual(["Total: $6.00", "Total: $8.00"]);
  });

  it("contains one page read failure without treating surviving pages as a complete document", () => {
    const first = page(table(goodRow, ["Total: $6.00"]));
    const second = { ...page("", 2), readError: "damaged page object" };
    const result = extractFromPages([first, second], "two-pages.pdf");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lineItems).toHaveLength(1);
    expect(result.totals).toBeNull();
    expect(result.pageResults.map((entry) => entry.status)).toEqual(["ok", "refused"]);
    expect(result.refusals.map((refusal) => refusal.reasonCode)).toContain("PAGE_READ_FAILED");
    expect(result.refusals.map((refusal) => refusal.reasonCode)).toContain("MULTI_PAGE_TOTAL_REFUSED");
  });

  it("refuses conflicting metadata instead of displaying the first value", () => {
    const first = page(table(goodRow));
    const second = page(table(goodRow).replace("Date: 24 September 2026", "Date: 25 September 2026"), 2);
    const result = extractFromPages([first, second], "conflicting-dates.pdf");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.date).toBeNull();
    const conflict = result.refusals.find((refusal) => refusal.message.startsWith("date conflict"));
    expect(conflict?.sources.map((source) => source.page)).toEqual([1, 2]);
  });
});
