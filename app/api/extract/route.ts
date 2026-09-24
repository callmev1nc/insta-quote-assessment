import { NextResponse } from "next/server";
import { extractDocument } from "../../../lib/extract";
import { MAX_PDF_BYTES, MAX_PDF_LABEL } from "../../../lib/limits";
import { EnvelopeSchema, type Envelope, type RefusalReason } from "../../../lib/schema";

export const runtime = "nodejs";

function fail(
  fileName: string | null,
  code: Extract<RefusalReason, "NOT_A_PDF" | "FILE_TOO_LARGE" | "PDF_UNREADABLE">,
  message: string,
  plainMessage: string,
  status: number,
): NextResponse {
  const envelope: Envelope = {
    ok: false,
    fileName,
    error: { code, message, plainMessage },
    refusals: [
      {
        scope: "document",
        reasonCode: code,
        message,
        plainMessage,
        page: null,
        sources: [],
      },
    ],
  };
  return NextResponse.json(envelope, { status });
}

export async function POST(request: Request): Promise<NextResponse> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail(
      null,
      "NOT_A_PDF",
      "Request body is not multipart form data.",
      "We couldn't read your upload request. Please try choosing the file again.",
      400,
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return fail(
      null,
      "NOT_A_PDF",
      "No file field in upload.",
      "No file was attached. Please choose a PDF and try again.",
      400,
    );
  }
  if (file.size > MAX_PDF_BYTES) {
    return fail(
      file.name,
      "FILE_TOO_LARGE",
      `Upload is ${file.size} bytes; limit is ${MAX_PDF_BYTES}.`,
      `That file is too big (limit ${MAX_PDF_LABEL}). Please try a smaller PDF.`,
      413,
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  // The signature check catches mislabeled uploads quickly. pdfjs still has
  // to open the file; a PDF header alone does not prove it is readable.
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    return fail(
      file.name,
      "NOT_A_PDF",
      "Magic bytes are not %PDF-.",
      "That doesn't look like a PDF file. Please upload a PDF invoice or docket.",
      400,
    );
  }

  const envelope = await extractDocument(bytes, file.name);
  // Validate our own output before it leaves the route. The schema requires
  // each numeric raw value to appear inside its evidence text; fixture tests
  // additionally check that the evidence text came from the cited PDF page.
  const checked = EnvelopeSchema.safeParse(envelope);
  if (!checked.success) {
    return fail(
      file.name,
      "PDF_UNREADABLE",
      `Internal contract violation: ${checked.error.message}`,
      "We hit an internal problem reading this file, so we're showing nothing rather than risk a wrong number. Please try again or contact support.",
      500,
    );
  }
  return NextResponse.json(checked.data, { status: checked.data.ok ? 200 : 422 });
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    {
      usage: "POST multipart/form-data with a 'file' field (PDF) to this URL.",
    },
    { status: 200 },
  );
}
