import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractDocument } from "../lib/extract";
import { extractPageTexts } from "../lib/pdf";
import { EnvelopeSchema, type Envelope } from "../lib/schema";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

type Success = Extract<Envelope, { ok: true }>;

async function extract(name: string): Promise<Success> {
  const buf = await readFile(join(fixtures, name));
  const env = await extractDocument(buf, name);
  expect(env.ok).toBe(true);
  return env as Success;
}

function reasons(env: Success): string[] {
  return env.refusals.map((r) => r.reasonCode);
}

describe("refusal rules (real sample PDFs)", () => {
  it("clean invoice is fully extracted with no refusals", async () => {
    const env = await extract("IB-55871.pdf");
    expect(env.lineItems).toHaveLength(4);
    expect(env.totals?.subtotal?.raw).toBe("$3,259.00");
    expect(env.totals?.gst?.raw).toBe("$488.85");
    expect(env.totals?.total?.raw).toBe("$3,747.85");
    expect(env.refusals).toHaveLength(0);
  });

  it("scanned image-only PDF is refused with zero items, never guessed", async () => {
    const env = await extract("IB-55902.pdf");
    expect(env.lineItems).toHaveLength(0);
    expect(env.totals).toBeNull();
    expect(reasons(env)).toContain("SCANNED_NO_TEXT");
    expect(env.pageResults).toEqual([
      { page: 1, status: "refused", itemCount: 0 },
    ]);
  });

  it("one unreadable page is contained; the other seven survive", async () => {
    const env = await extract("IB-STMT47.pdf");
    expect(env.lineItems).toHaveLength(21);
    const byPage = new Map(env.pageResults.map((p) => [p.page, p]));
    expect(byPage.get(4)).toMatchObject({ status: "refused", itemCount: 0 });
    for (const p of [1, 2, 3, 5, 6, 7, 8]) {
      expect(byPage.get(p)).toMatchObject({ status: "ok", itemCount: 3 });
    }
    const scan = env.refusals.find((r) => r.reasonCode === "SCANNED_NO_TEXT");
    expect(scan?.page).toBe(4);
    // Statement bundles invoices + freight + credit + delivery: no grand total.
    expect(reasons(env)).toContain("MIXED_DOCUMENT_TYPES");
    expect(env.totals).toBeNull();
  });

  it("printed total that disagrees with the lines is refused, lines kept", async () => {
    const env = await extract("IB-56150.pdf");
    expect(env.lineItems).toHaveLength(4);
    expect(env.totals?.subtotal?.raw).toBe("$1,270.00");
    expect(env.totals?.gst?.raw).toBe("$190.50");
    expect(env.totals?.total).toBeNull();
    const mismatch = env.refusals.find(
      (r) => r.reasonCode === "ARITHMETIC_MISMATCH",
    );
    expect(mismatch?.message).toContain("$1,501.80");
    expect(mismatch?.message).toContain("$1,460.50");
  });

  it("contradicting carton counts are refused while lines and total survive", async () => {
    const env = await extract("IB-56088.pdf");
    expect(env.lineItems).toHaveLength(3);
    expect(env.totals?.total?.raw).toBe("$2,050.00");
    const conflict = env.refusals.find(
      (r) => r.reasonCode === "CONFLICTING_SOURCES",
    );
    expect(conflict?.message).toContain("9 cartons");
    expect(conflict?.message).toContain("11 cartons");
  });

  it("unconverted weights are surfaced; no amounts are computed from them", async () => {
    const env = await extract("IB-56010.pdf");
    expect(env.lineItems).toHaveLength(4);
    for (const item of env.lineItems) {
      expect(item.amount).toBeNull();
    }
    expect(reasons(env)).toContain("AMBIGUOUS_UNIT");
    expect(reasons(env)).toContain("UNIT_CONVERSION_REFUSED");
    expect(reasons(env)).toContain("MISSING_TOTAL");
    // Quantities and prices are still traced to their source.
    expect(env.lineItems[0].quantity.raw).toBe("3");
    expect(env.lineItems[0].unitPrice.raw).toBe("$74.00 /carton");
  });

  it("every emitted number carries a page and the source text it came from", async () => {
    for (const name of [
      "IB-55871.pdf",
      "IB-55902.pdf",
      "IB-56010.pdf",
      "IB-56088.pdf",
      "IB-56150.pdf",
      "IB-STMT47.pdf",
    ]) {
      const env = await extract(name);
      expect(EnvelopeSchema.safeParse(env).success).toBe(true);
      const pages = await extractPageTexts(await readFile(join(fixtures, name)));
      const numbers = [
        ...env.lineItems.flatMap((i) => [
          i.quantity,
          i.unitPrice,
          ...(i.amount ? [i.amount] : []),
        ]),
        ...(env.totals?.subtotal ? [env.totals.subtotal] : []),
        ...(env.totals?.gst ? [env.totals.gst] : []),
        ...(env.totals?.total ? [env.totals.total] : []),
      ];
      // A fully refused document emits no numbers at all — that is the
      // correct result, not a gap. Everything else must be fully traced.
      if (name === "IB-55902.pdf") {
        expect(numbers).toHaveLength(0);
        expect(env.refusals.length).toBeGreaterThan(0);
        continue;
      }
      expect(numbers.length).toBeGreaterThan(0);
      for (const n of numbers) {
        expect(n.evidence.page).toBeGreaterThanOrEqual(1);
        expect(n.raw.length).toBeGreaterThan(0);
        expect(n.evidence.sourceText).toContain(n.raw);
        expect(pages[n.evidence.page - 1].text).toContain(n.evidence.sourceText);
      }
      for (const field of [
        [env.document.docNo, env.document.docNoEvidence],
        [env.document.date, env.document.dateEvidence],
        [env.document.billTo, env.document.billToEvidence],
        [env.document.jobRef, env.document.jobRefEvidence],
      ] as const) {
        if (!field[0]) continue;
        expect(field[1]).not.toBeNull();
        expect(field[1]?.sourceText).toContain(field[0]);
        expect(pages[field[1]!.page - 1].text).toContain(field[1]!.sourceText);
      }
    }
  });

  it("no refusal or error message collapses into a generic string", async () => {
    const banned = ["an error occurred", "something went wrong"];
    for (const name of [
      "IB-55902.pdf",
      "IB-56010.pdf",
      "IB-56088.pdf",
      "IB-56150.pdf",
      "IB-STMT47.pdf",
    ]) {
      const env = await extract(name);
      const blob = JSON.stringify(env).toLowerCase();
      for (const phrase of banned) {
        expect(blob).not.toContain(phrase);
      }
      for (const r of env.refusals) {
        expect(r.plainMessage.length).toBeGreaterThan(40);
      }
    }
  });
});
