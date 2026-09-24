"use client";

import { useCallback, useRef, useState } from "react";
import { EnvelopeSchema, type Envelope, type Refusal } from "@/lib/schema";

type Status = "idle" | "uploading" | "done" | "transport-error";

function money(n: number): string {
  return `$${n.toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function Home() {
  const [status, setStatus] = useState<Status>("idle");
  const [envelope, setEnvelope] = useState<Envelope | null>(null);
  const [transportMessage, setTransportMessage] = useState<string>("");
  const [dragging, setDragging] = useState(false);
  const [fileLabel, setFileLabel] = useState<string>("");
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = useCallback(async (file: File) => {
    setStatus("uploading");
    setEnvelope(null);
    setTransportMessage("");
    setFileLabel(file.name);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/extract", { method: "POST", body: form });
      const json: unknown = await res.json();
      const parsed = EnvelopeSchema.safeParse(json);
      if (!parsed.success) {
        setStatus("transport-error");
        setTransportMessage(
          "The server answered in a format this page doesn't recognise. " +
            "Nothing is shown rather than risk displaying a wrong number. " +
            `Technical detail: ${parsed.error.issues[0]?.message ?? "schema mismatch"}.`,
        );
        return;
      }
      setEnvelope(parsed.data);
      setStatus("done");
    } catch (err) {
      // Transport failure: say exactly what happened, not "an error occurred".
      setStatus("transport-error");
      setTransportMessage(
        err instanceof Error
          ? `Upload failed before the file could be read: ${err.message}. Check your connection and try again.`
          : "Upload failed before the file could be read for an unknown reason. Please try again.",
      );
    }
  }, []);

  const onFiles = useCallback(
    (files: FileList | null) => {
      if (files && files[0]) void upload(files[0]);
    },
    [upload],
  );

  return (
    <main>
      <h1>Insta Quote AI — document reader</h1>
      <p className="muted">
        Upload a PDF invoice, packing list or delivery docket. Every number
        shown names the page and exact text it came from. Anything the reader
        can&apos;t stand behind appears below as a plain-English refusal —
        never a guess, never &ldquo;an error occurred&rdquo;.
      </p>

      <div
        className={`dropzone${dragging ? " dragging" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          onFiles(e.dataTransfer.files);
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          disabled={status === "uploading"}
          onChange={(e) => onFiles(e.target.files)}
          aria-label="Choose a PDF file"
        />
        <p className="muted">…or drag a PDF onto this box.</p>
      </div>

      {status === "uploading" && (
        <div className="card" role="status" aria-live="polite">
          Reading <strong>{fileLabel}</strong> — extracting text page by page…
        </div>
      )}

      {status === "transport-error" && (
        <div className="error-panel" role="alert">
          <strong>Couldn&apos;t read that file.</strong>
          <p>{transportMessage}</p>
        </div>
      )}

      {status === "done" && envelope && <Result envelope={envelope} />}
    </main>
  );
}

function Result({ envelope }: { envelope: Envelope }) {
  if (!envelope.ok) {
    return (
      <>
        <div className="error-panel" role="alert">
          <strong>Couldn&apos;t extract this file.</strong>
          <p>{envelope.error.plainMessage}</p>
          <p className="muted">Technical code: {envelope.error.code}</p>
        </div>
        <Refusals
          refusals={envelope.refusals}
          title="What we can tell you"
        />
      </>
    );
  }

  const { document, lineItems, totals, refusals, pageResults } = envelope;
  return (
    <>
      <div className="card">
        <h2>
          {envelope.fileName}
          {refusals.length === 0 ? (
            <span className="ok-pill">fully read</span>
          ) : (
            <span className="warn-pill">
              partly read · {refusals.length} refusal
              {refusals.length === 1 ? "" : "s"}
            </span>
          )}
        </h2>
        <p className="muted">
          {[document.docNo, document.date, document.billTo, document.jobRef]
            .filter(Boolean)
            .join(" · ") || "No document header found."}
        </p>
        <p className="muted">
          {pageResults.map((p) => (
            <span key={p.page}>
              Page {p.page}: {p.status === "ok" ? `${p.itemCount} items` : "refused"}
              {" · "}
            </span>
          ))}
        </p>
      </div>

      {lineItems.length > 0 && (
        <div className="card">
          <h2>Line items ({lineItems.length})</h2>
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Description</th>
                <th>Qty</th>
                <th>Unit</th>
                <th>Unit price</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {lineItems.map((item, idx) => (
                <tr key={`${item.code}-${idx}`}>
                  <td>
                    <code>{item.code}</code>
                    <Evidence
                      page={item.codeEvidence.page}
                      sourceText={item.codeEvidence.sourceText}
                    />
                  </td>
                  <td>{item.description}</td>
                  <td>
                    {item.quantity.value.toLocaleString()}
                    <Evidence
                      page={item.quantity.evidence.page}
                      sourceText={item.quantity.evidence.sourceText}
                    />
                  </td>
                  <td>
                    {item.unit}
                    <Evidence
                      page={item.unitEvidence.page}
                      sourceText={item.unitEvidence.sourceText}
                    />
                  </td>
                  <td>
                    {money(item.unitPrice.value)}
                    <Evidence
                      page={item.unitPrice.evidence.page}
                      sourceText={item.unitPrice.evidence.sourceText}
                    />
                  </td>
                  <td>
                    {item.amount ? (
                      <>
                        {money(item.amount.value)}
                        <Evidence
                          page={item.amount.evidence.page}
                          sourceText={item.amount.evidence.sourceText}
                        />
                      </>
                    ) : (
                      <span className="muted">not shown — see refusals</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totals && (
        <div className="card">
          <h2>Totals</h2>
          <table>
            <tbody>
              <TotalRow label="Subtotal" value={totals.subtotal} />
              <TotalRow label="GST" value={totals.gst} />
              <TotalRow label="Total" value={totals.total} />
            </tbody>
          </table>
        </div>
      )}

      <Refusals refusals={refusals} title="Refusals — read these, not skipped" />
    </>
  );
}

function TotalRow({
  label,
  value,
}: {
  label: string;
  value: { value: number; raw: string; evidence: { page: number; sourceText: string } } | null;
}) {
  return (
    <tr>
      <td>
        <strong>{label}</strong>
      </td>
      <td>
        {value ? (
          <>
            {money(value.value)}
            <Evidence page={value.evidence.page} sourceText={value.evidence.sourceText} />
          </>
        ) : (
          <span className="muted">refused — see below</span>
        )}
      </td>
    </tr>
  );
}

function Evidence({ page, sourceText }: { page: number; sourceText: string }) {
  return (
    <details className="evidence">
      <summary>page {page} · source</summary>
      <pre>{sourceText}</pre>
    </details>
  );
}

function Refusals({
  refusals,
  title,
}: {
  refusals: Refusal[];
  title: string;
}) {
  const list = refusals;
  if (list.length === 0) return null;
  return (
    <div>
      <h2>{title}</h2>
      {list.map((r, idx) => (
        <div className="refusal" key={idx} role="note">
          <div className="code">
            {r.reasonCode}
            {r.page !== null ? ` · page ${r.page}` : ""}
          </div>
          <p>{r.plainMessage}</p>
          {r.sources.map((source, index) => (
            <Evidence key={index} page={source.page} sourceText={source.sourceText} />
          ))}
        </div>
      ))}
    </div>
  );
}
