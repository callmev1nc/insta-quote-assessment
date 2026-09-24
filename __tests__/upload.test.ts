import { describe, expect, it } from "vitest";
import { POST } from "../app/api/extract/route";
import { MAX_PDF_BYTES } from "../lib/limits";
import { EnvelopeSchema } from "../lib/schema";

async function upload(file: File) {
  const form = new FormData();
  form.append("file", file);
  return POST(new Request("http://localhost/api/extract", { method: "POST", body: form }));
}

describe("upload refusals", () => {
  it("returns a specific 413 envelope before reading an oversized PDF", async () => {
    const response = await upload(new File([new Uint8Array(MAX_PDF_BYTES + 1)], "large.pdf", { type: "application/pdf" }));
    const body: unknown = await response.json();
    expect(response.status).toBe(413);
    expect(EnvelopeSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ ok: false, error: { code: "FILE_TOO_LARGE" } });
    if (typeof body === "object" && body && "error" in body) {
      expect(JSON.stringify(body.error)).toContain("4 MB");
    }
  });

  it("distinguishes an unreadable PDF from a non-PDF upload", async () => {
    const notPdf = await upload(new File(["hello"], "notes.txt", { type: "text/plain" }));
    expect(notPdf.status).toBe(400);
    expect(await notPdf.json()).toMatchObject({ ok: false, error: { code: "NOT_A_PDF" } });

    const brokenPdf = await upload(new File(["%PDF-not-a-real-pdf"], "broken.pdf", { type: "application/pdf" }));
    expect(brokenPdf.status).toBe(422);
    expect(await brokenPdf.json()).toMatchObject({ ok: false, error: { code: "PDF_UNREADABLE" } });
  });
});
