# Insta Quote AI — Take-Home Assessment

**[Live demo](https://insta-quote-assessment.vercel.app)** · **[Repository](https://github.com/callmev1nc/insta-quote-assessment)**

A small PDF-to-JSON service and upload page for the six supplied invoices, packing lists and delivery dockets. The central rule is that an extracted quantity or amount must retain its printed text and page. If a row, page or total cannot be read safely, the API returns a specific refusal and the page shows it in plain language.

## Run and review

```bash
npm ci
npm run dev       # http://localhost:3000
npm test          # fixture, failure-rule, API and rendered-UI checks
npm run lint
npm run build
```

```bash
curl -F "file=@fixtures/IB-56088.pdf" http://localhost:3000/api/extract
```

The demo page has one-click examples for a clean invoice, a scanned page, and a conflicting carton count. All six original PDFs are in `fixtures/` for local and API review.

## What the API returns

`POST /api/extract` accepts a multipart field named `file`. A readable PDF returns `ok: true` with `lineItems`, `totals`, `refusals`, `pageResults`, and document metadata. Partial extraction is still a successful HTTP response: safe rows are kept, and the refused parts are explained separately. Invalid uploads return structured JSON with `ok: false`, a plain-language reason, and an appropriate 400/413/422 status.

Each extracted numeric field has a parsed `value`, a printed `raw` string, and `evidence: { page, sourceText }`. Metadata that contains numbers, such as document dates and job references, has its own evidence. A refusal has a reason code, a plain message, its scope and page, and zero or more exact `sources`. A conflict supplies both source statements. Page results distinguish `ok`, `partial`, and `refused`.

The service reads each page with `pdfjs-dist`. It parses only the supported Ironbark table shape: code, description, quantity, unit or weight, unit price, and optional amount. It keeps the original PDF text spans instead of rebuilding a plausible quote. It validates printed line amounts and totals against sourced rows. When a row is damaged, it resumes only at another clear code boundary, keeps other valid rows, reports the damaged block, and withholds totals that might omit it. A failed page is contained so other pages can survive.

The upload limit is **4 MiB**. This leaves room for multipart framing under [Vercel's 4.5 MB function request limit](https://vercel.com/docs/functions/limitations); the deployed platform may still reject a request before application code sees it. The page explains that HTTP rejection if it happens.

## Supplied PDF results

| File | Expected result |
| --- | --- |
| `IB-55871.pdf` | Four sourced lines and verified subtotal, GST and total; no refusals. |
| `IB-55902.pdf` | Image-only page refused; no invented line items. |
| `IB-56010.pdf` | Four sourced quantities and prices; ambiguous weights, conversion and absent totals are called out. |
| `IB-56088.pdf` | Three lines and the printed $2,050.00 total survive; conflicting 9- and 11-carton statements are refused with both sources. |
| `IB-56150.pdf` | Four lines, subtotal and GST survive; the printed total is refused because it disagrees with the sourced line arithmetic. |
| `IB-STMT47.pdf` | Twenty-one lines survive across seven readable pages; scanned page 4 and a combined total are refused. |

## The three assessment questions

### What was the hardest decision, and why did I choose that way?

The hardest decision was what to do when only part of a document is trustworthy. Refusing the whole file would hide useful, provable lines; showing a total after silently skipping one row would be dangerous. I chose to keep individually sourced rows and refuse the damaged row and any total that depends on it. The eight-page statement tests this boundary: page 4 is scanned, but readable lines from the other pages still reach the user. The parser is deliberately strict about the layout, so an unfamiliar supplier's PDF gets an explicit refusal rather than a plausible-looking guess.

### Where am I not confident?

- **Other suppliers and visual layouts.** The parser follows the supplied Ironbark table structure and PDF text order, not table geometry. Multi-line descriptions, rotated tables, unusual codes or a different text order may be refused or misgrouped. I have not established reliable recall on unrelated PDFs.
- **Scans.** Image-only pages are refused because there is no OCR. A scan with an inaccurate text layer is harder: text may exist but still be wrong. Evidence shows where a value came from, not that the source document itself is correct.
- **Validation boundaries.** Arithmetic uses JavaScript numbers with small currency tolerances, not a decimal library. GST percentage is checked when printed, and this is not a general tax engine. The service does not verify units beyond a small known set or offer human correction.
- **Deployment size.** The six provided PDFs are small. I have not benchmarked large, complex PDFs or production concurrency.

### What would I do with three more days?

1. Add OCR for scanned pages with confidence and human review, keeping low-confidence text on the refusal path.
2. Use PDF text coordinates to recognize tables across several supplier layouts, then evaluate precision and refusals on a larger, labelled document set.
3. Add a review workflow where a user can inspect highlighted source regions, accept or correct refused values, and retain an audit trail; add browser tests for the full upload-to-screen path.

## AI use

I used AI coding agents to draft and refine the parser, refusal rules, tests, and UI. I checked the behavior against all six PDFs and targeted malformed-input tests, then ran the test suite, lint and production build. **Extraction at runtime is deterministic; it does not call an LLM or invent missing quantities.** The README describes the observed coverage and limits rather than treating agent-written code as proof that arbitrary PDFs work.
