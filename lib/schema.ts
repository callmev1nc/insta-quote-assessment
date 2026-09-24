import { z } from "zod";

/**
 * Shared contracts for Part A (POST /api/extract) and Part B (the upload page).
 *
 * Design rule behind every schema here: a number is only allowed into the
 * output if it carries `evidence` — the 1-based page and the exact source
 * text it was read from. Refusing is a first-class result, never an error.
 */

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export const EvidenceSchema = z.object({
  /** 1-based page number the value was read from. */
  page: z.number().int().min(1),
  /** Exact source text the value was read from (verbatim substring). */
  sourceText: z.string().min(1),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/** A number that can point at where it came from. */
export const TracedNumberSchema = z.object({
  value: z.number().finite(),
  /** Raw characters as printed, e.g. "$1,248.00" or "2,000". */
  raw: z.string().min(1),
  evidence: EvidenceSchema,
}).refine((number) => number.evidence.sourceText.includes(number.raw), {
  message: "A numeric value must include its raw text in its evidence.",
});
export type TracedNumber = z.infer<typeof TracedNumberSchema>;

// ---------------------------------------------------------------------------
// Line items
// ---------------------------------------------------------------------------

export const LineItemSchema = z.object({
  code: z.string().min(1),
  codeEvidence: EvidenceSchema,
  description: z.string().min(1),
  descriptionEvidence: EvidenceSchema,
  quantity: TracedNumberSchema,
  /** Raw unit/weight cell as printed, e.g. "box" or "640g total". */
  unit: z.string().min(1),
  unitEvidence: EvidenceSchema,
  unitPrice: TracedNumberSchema,
  /** Absent when the document prints no Amount column (never computed). */
  amount: TracedNumberSchema.nullable(),
  /** Full verbatim block this item was parsed from. */
  blockEvidence: EvidenceSchema,
});
export type LineItem = z.infer<typeof LineItemSchema>;

export const TotalsSchema = z.object({
  subtotal: TracedNumberSchema.nullable(),
  gst: TracedNumberSchema.nullable(),
  total: TracedNumberSchema.nullable(),
});
export type Totals = z.infer<typeof TotalsSchema>;

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

export const RefusalReasonSchema = z.enum([
  "SCANNED_NO_TEXT", // page is an image/scan: no extractable text at all
  "UNREADABLE_PAGE", // page yielded too little text to parse safely
  "AMBIGUOUS_UNIT", // unit/weight column cannot be interpreted (e.g. Weight, mixed g/kg)
  "UNIT_CONVERSION_REFUSED", // would need g<->kg or per-unit normalisation: not done
  "ARITHMETIC_MISMATCH", // printed total disagrees with recomputation
  "CONFLICTING_SOURCES", // two statements in one file disagree (e.g. 9 vs 11 cartons)
  "MIXED_DOCUMENT_TYPES", // statement bundles invoices+credit+freight: no grand total
  "MISSING_TOTAL", // document prints no total to extract
  "PDF_UNREADABLE", // file could not be opened as a PDF at all
  "NOT_A_PDF", // upload failed magic-byte validation
  "FILE_TOO_LARGE", // over the configured upload limit
  "UNSUPPORTED_LAYOUT", // readable page, but no supported table was found
  "UNPARSED_ROW", // a table row could not be read safely
  "PAGE_READ_FAILED", // one PDF page failed while other pages may survive
  "MULTI_PAGE_TOTAL_REFUSED", // no safe aggregate across several pages
  "UNVERIFIED_TOTAL", // printed total is malformed or depends on refused values
]);
export type RefusalReason = z.infer<typeof RefusalReasonSchema>;

export const RefusalSchema = z.object({
  /** What was refused: a single line, a page, a total, or the whole document. */
  scope: z.enum(["line", "page", "total", "document", "field"]),
  reasonCode: RefusalReasonSchema,
  /** Technical reason, for logs and debugging. */
  message: z.string().min(1),
  /** Plain-language reason, shown verbatim in the UI. No jargon. */
  plainMessage: z.string().min(1),
  page: z.number().int().min(1).nullable(),
  /** Verbatim, page-specific sources involved in the refusal. */
  sources: z.array(EvidenceSchema),
});
export type Refusal = z.infer<typeof RefusalSchema>;

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export const PageResultSchema = z.object({
  page: z.number().int().min(1),
  status: z.enum(["ok", "partial", "refused"]),
  itemCount: z.number().int().min(0),
});
export type PageResult = z.infer<typeof PageResultSchema>;

export const DocumentMetaSchema = z.object({
  docNo: z.string().nullable(),
  docNoEvidence: EvidenceSchema.nullable(),
  date: z.string().nullable(),
  dateEvidence: EvidenceSchema.nullable(),
  billTo: z.string().nullable(),
  billToEvidence: EvidenceSchema.nullable(),
  jobRef: z.string().nullable(),
  jobRefEvidence: EvidenceSchema.nullable(),
});
export type DocumentMeta = z.infer<typeof DocumentMetaSchema>;

const SuccessEnvelopeSchema = z.object({
  ok: z.literal(true),
  fileName: z.string(),
  document: DocumentMetaSchema,
  lineItems: z.array(LineItemSchema),
  totals: TotalsSchema.nullable(),
  refusals: z.array(RefusalSchema),
  pageResults: z.array(PageResultSchema),
});

const ErrorEnvelopeSchema = z.object({
  ok: z.literal(false),
  fileName: z.string().nullable(),
  error: z.object({
    code: RefusalReasonSchema,
    /** Technical reason. */
    message: z.string(),
    /** Plain-language reason. The UI shows this verbatim — never a generic string. */
    plainMessage: z.string(),
  }),
  refusals: z.array(RefusalSchema),
});

export const EnvelopeSchema = z.union([
  SuccessEnvelopeSchema,
  ErrorEnvelopeSchema,
]);
export type Envelope = z.infer<typeof EnvelopeSchema>;
