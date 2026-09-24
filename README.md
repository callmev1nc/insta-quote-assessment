# Insta Quote AI — Take-Home Assessment

**Live demo:** <https://insta-quote-assessment.vercel.app> (upload any file from `fixtures/`)

**Stack:** TypeScript, Next.js (App Router), pdfjs-dist, zod, Vitest. Single app:
Part A is `POST /api/extract`, Part B is the upload page at `/`.

## Run it

```bash
npm install
npm run dev      # http://localhost:3000
npm test         # 8 refusal-rule tests on the real sample PDFs
npm run build
```

```bash
curl -F "file=@fixtures/IB-56088.pdf" http://localhost:3000/api/extract
```

## How it works

1. `lib/pdf.ts` extracts text per page with pdfjs-dist, plus a `hasImage`
   flag (painted image XObjects) so scans are detectable.
2. `lib/parse.ts` parses the Ironbark table with a strict grammar
   (`CODE / description / qty / unit / unit-price / amount`). A row is emitted
   only if every cell matches; every number keeps its raw text, page, and the
   verbatim source block. No match → no number, never a guess.
3. `lib/extract.ts` runs per-page containment (one bad page can't sink the
   rest) then validation gates: line-amount recomputation, subtotal/GST/total
   recomputation at 15% GST, unit whitelist, carton-count agreement, and
   mixed-statement detection. Failures become refusals quoting both figures.
4. `lib/refusals.ts` gives every refusal a technical `message` and a
   `plainMessage` written for a trade business owner.
5. The API validates its own output against the zod envelope before
   responding; the UI renders items with expandable page+source evidence and
   refusals as amber cards. The strings "an error occurred" and "something
   went wrong" appear nowhere — a test asserts it.

## Behaviour on the six samples

| File | Result |
|---|---|
| `IB-55871` | 4 items, subtotal/GST/total all verified, zero refusals |
| `IB-55902` (image-only scan) | Full refusal `SCANNED_NO_TEXT`, zero items |
| `IB-56010` (Weight column, mixed g/kg, "unconverted") | 4 items with qty+price traced, amounts refused (`AMBIGUOUS_UNIT`, `UNIT_CONVERSION_REFUSED`, `MISSING_TOTAL`) |
| `IB-56088` (9 vs 11 cartons) | 3 items + $2,050 total kept, carton count refused (`CONFLICTING_SOURCES`) |
| `IB-56150` (printed total $1,501.80 vs recomputed $1,460.50) | Subtotal+GST kept, total refused (`ARITHMETIC_MISMATCH`, both figures quoted) |
| `IB-STMT47` (8 pages, page 4 scanned) | 21 items across 7 good pages, page 4 refused alone (`SCANNED_NO_TEXT`), no grand total (`MIXED_DOCUMENT_TYPES`) |

## Three questions

### 1. What was the hardest decision and why did you choose that way?

Whether to attempt OCR / unit normalisation / total "repair" versus refusing.
I chose refusal everywhere, for one reason: the brief's hard rule makes an
invented number the worst possible outcome, and each "helpful" computation
(unit conversion, OCR guess, total fix-up) is exactly where a confident wrong
number is born. A rule-based parser with evidence-or-nothing gives a property
no LLM or OCR pipeline can promise in 5 hours: **every number in the output
is a verbatim substring of the input**, asserted by test. The cost is recall
(scans yield nothing), and I think that's the right trade for quoting, where
a wrong quantity becomes a wrong price.

### 2. Where are you not confident?

- **Layout drift.** The parser targets the Ironbark table grammar
  (`CODE / description / qty / unit / price / amount`). A supplier with a
  two-line description, merged cells, or landscape tables will parse partially
  or not at all. It fails closed (refusals, not guesses), but coverage beyond
  this template is unverified.
- **Scanned pages.** Without an OCR engine I refuse them outright. If a real
  customer sends phone photos of dockets, this service reads nothing — that
  needs Tesseract or a vision model plus a confidence threshold that feeds the
  same refusal path.
- ** GST assumption.** Totals are validated at a flat 15% NZ GST. Mixed-rate
  or GST-free lines would trip `ARITHMETIC_MISMATCH` incorrectly.
- **The `money()` recomputation uses floats** with a $0.01 tolerance — fine
  for invoice magnitudes, not a general decimal story.

### 3. What would you do with three more days?

1. OCR fallback (Tesseract) for image-only pages, with per-word confidence;
   anything under threshold flows into the existing refusal path unchanged.
2. Geometry-aware table parsing (pdfjs text positions, not just content
   order) plus a second supplier template to prove the parser isn't
   over-fitted to Ironbark.
3. Persistence + auth (Supabase, matching your stack): store extractions per
   customer, add a review/override queue for refused pages, and deploy the
   preview per-PR on Vercel.

## AI usage

Built with AI coding agents throughout (per the brief's encouragement):
scaffold, parser, and tests were agent-drafted, then verified by running all
six fixtures through the live endpoint and asserting the refusal matrix in
Vitest. I can walk through any line and explain why it refuses the way it does.
