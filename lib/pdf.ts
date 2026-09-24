/**
 * Page-level PDF text extraction (server-side only).
 *
 * pdfjs reads the PDF text layer; it does not recognize letters inside an
 * image. A viewer can therefore display a readable-looking page while this
 * function returns no text. Each result gives the caller the extracted text
 * and enough signals to explain a refusal without inventing image contents.
 */

export interface PageText {
  /** 1-based page number. */
  page: number;
  /** Text items joined with newlines, in content order. */
  text: string;
  /** Non-whitespace character count — drives the unreadable-page check. */
  charCount: number;
  /** Image present on a low-text page; image inspection is skipped otherwise. */
  hasImage: boolean;
  /** Page-specific PDF failure; other pages can still be processed. */
  readError: string | null;
}

interface PdfJsPage {
  getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
  getOperatorList(): Promise<{ fnArray: number[] }>;
}

/** A low-text screening threshold, not a confidence score or proof of a valid table. */
export const MIN_READABLE_CHARS = 20;

/** Open once, then contain text-reading failures to the affected page. */
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
      // Opening the file can fail as a whole; opening a later page should not
      // discard text already recovered from earlier pages.
      let page: PdfJsPage;
      try {
        page = (await doc.getPage(n)) as unknown as PdfJsPage;
      } catch (error) {
        pages.push({ page: n, text: "", charCount: 0, hasImage: false, readError: error instanceof Error ? error.message : "Could not open page." });
        continue;
      }
      let text = "";
      let hasImage = false;
      let readError: string | null = null;
      try {
        const content = await page.getTextContent();
        // Preserve item order and characters here. parsePage later keeps
        // substrings from this stream as evidence for individual values.
        text = content.items
          .map((item) => (typeof item.str === "string" ? item.str : ""))
          .join("\n");
      } catch (error) {
        readError = error instanceof Error ? error.message : "Could not read page text.";
      }
      const charCount = text.replace(/\s/g, "").length;
      // Inspect images only when text is too short to parse. An image with
      // zero text explains SCANNED_NO_TEXT; a few text characters still get
      // UNREADABLE_PAGE because we cannot claim the page has no text layer.
      if (!readError && charCount < MIN_READABLE_CHARS) {
        try {
          const ops = await page.getOperatorList();
          const OPS = (pdfjs as unknown as { OPS: Record<string, number> }).OPS;
          hasImage =
            ops.fnArray.includes(OPS.paintImageXObject) ||
            ops.fnArray.includes(OPS.paintInlineImageXObject) ||
            ops.fnArray.includes(OPS.paintImageXObjectRepeat);
        } catch (error) {
          readError = error instanceof Error ? error.message : "Could not inspect page images.";
        }
      }
      pages.push({
        page: n,
        text,
        charCount,
        hasImage,
        readError,
      });
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}
