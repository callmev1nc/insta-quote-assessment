/**
 * Page-level PDF text extraction (server-side only).
 *
 * Returns one entry per page with the raw text plus the signals the refusal
 * rules need: character count and whether the page paints an image. A page
 * with no text but a painted image is a scan/photo — callers must refuse it
 * (SCANNED_NO_TEXT), never guess at it.
 */

export interface PageText {
  /** 1-based page number. */
  page: number;
  /** Text items joined with newlines, in content order. */
  text: string;
  /** Non-whitespace character count — drives the unreadable-page check. */
  charCount: number;
  /** True when the page paints at least one image XObject. */
  hasImage: boolean;
}

interface PdfJsPage {
  getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
  getOperatorList(): Promise<{ fnArray: number[] }>;
}

/** Minimum non-whitespace chars before a page counts as readable. */
export const MIN_READABLE_CHARS = 20;

export async function extractPageTexts(
  buffer: Buffer,
): Promise<PageText[]> {
  // Dynamic import keeps pdfjs-dist out of the client bundle entirely.
  const pdfjs = (await import(
    "pdfjs-dist/legacy/build/pdf.mjs"
  )) as typeof import("pdfjs-dist/legacy/build/pdf.mjs");

  const doc = await pdfjs.getDocument({
    data: new Uint8Array(
      buffer.buffer,
      buffer.byteOffset,
      buffer.byteLength,
    ),
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;

  const pages: PageText[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = (await doc.getPage(n)) as unknown as PdfJsPage;
      let text = "";
      let hasImage = false;
      try {
        const content = await page.getTextContent();
        text = content.items
          .map((item) => (typeof item.str === "string" ? item.str : ""))
          .join("\n");
      } catch {
        text = "";
      }
      try {
        const ops = await page.getOperatorList();
        const OPS = (
          pdfjs as unknown as {
            OPS: Record<string, number>;
          }
        ).OPS;
        hasImage =
          ops.fnArray.includes(OPS.paintImageXObject) ||
          ops.fnArray.includes(OPS.paintInlineImageXObject) ||
          ops.fnArray.includes(OPS.paintImageXObjectRepeat);
      } catch {
        hasImage = false;
      }
      pages.push({
        page: n,
        text,
        charCount: text.replace(/\s/g, "").length,
        hasImage,
      });
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}
