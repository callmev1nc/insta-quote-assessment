"use client";

import { useCallback, useRef, useState } from "react";
import { EnvelopeSchema, type Envelope } from "@/lib/schema";
import { MAX_PDF_BYTES, MAX_PDF_LABEL } from "@/lib/limits";
import { ResultView } from "./result-view";

type Status = "idle" | "loading" | "done" | "transport-error";

const samples = [
  { name: "Clean invoice", detail: "All values traced", file: "IB-55871.pdf" },
  { name: "Scanned page", detail: "Nothing guessed", file: "IB-55902.pdf" },
  { name: "Conflicting counts", detail: "Disagreement shown", file: "IB-56088.pdf" },
] as const;

export default function Home() {
  const [status, setStatus] = useState<Status>("idle");
  const [envelope, setEnvelope] = useState<Envelope | null>(null);
  const [transportMessage, setTransportMessage] = useState("");
  const [fileLabel, setFileLabel] = useState("");
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = useCallback(async (file: File) => {
    setStatus("loading");
    setEnvelope(null);
    setTransportMessage("");
    setFileLabel(file.name);

    if (file.size > MAX_PDF_BYTES) {
      setTransportMessage(`That file is too big for this demo (limit ${MAX_PDF_LABEL}). Please choose a smaller PDF.`);
      setStatus("transport-error");
      return;
    }

    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/extract", { method: "POST", body: form });
      // The platform can reject an upload before our route runs. Such a reply
      // has no structured refusals, so show its actual HTTP status here.
      if (!response.headers.get("content-type")?.includes("application/json")) {
        setTransportMessage(
          response.status === 413
            ? "The server rejected this upload because it is too large for the deployed service. Choose a smaller PDF."
            : `The server returned HTTP ${response.status}${response.statusText ? ` (${response.statusText})` : ""} without extraction details. Please try again or check the deployment.`,
        );
        setStatus("transport-error");
        return;
      }

      const body: unknown = await response.json();
      // A valid API envelope may contain a refusal even with a non-2xx status.
      // Keep it intact for ResultView instead of replacing it with a generic
      // network error. An invalid envelope is unsafe to display as a result.
      const parsed = EnvelopeSchema.safeParse(body);
      if (!parsed.success) {
        setTransportMessage(
          `The server returned HTTP ${response.status}, but its response did not match the extraction contract: ${parsed.error.issues[0]?.message ?? "unknown schema difference"}. Nothing from this response is shown.`,
        );
        setStatus("transport-error");
        return;
      }
      if (!response.ok && parsed.data.ok) {
        setTransportMessage(`The server returned HTTP ${response.status} alongside a success result, so this page cannot tell whether the extraction completed safely.`);
        setStatus("transport-error");
        return;
      }
      setEnvelope(parsed.data);
      setStatus("done");
    } catch (error) {
      setTransportMessage(
        error instanceof Error
          ? `The upload could not reach or read the server response: ${error.message}. Check your connection and try again.`
          : "The upload stopped before the server returned a response. Check your connection and try again.",
      );
      setStatus("transport-error");
    }
  }, []);

  const onFiles = useCallback((files: FileList | null) => {
    if (status === "loading" || !files?.[0]) return;
    void upload(files[0]);
  }, [status, upload]);

  const loadSample = useCallback(async (fileName: string) => {
    if (status === "loading") return;
    setStatus("loading");
    setEnvelope(null);
    setTransportMessage("");
    setFileLabel(fileName);
    try {
      const response = await fetch(`/samples/${fileName}`);
      if (!response.ok) throw new Error(`sample file returned HTTP ${response.status}`);
      // Examples use the exact same upload/API path as a user-selected PDF.
      const file = new File([await response.blob()], fileName, { type: "application/pdf" });
      await upload(file);
    } catch (error) {
      setTransportMessage(`The example could not be loaded: ${error instanceof Error ? error.message : "no response"}. You can still upload your own PDF.`);
      setStatus("transport-error");
    }
  }, [status, upload]);

  return (
    <div className="site-shell">
      <header className="site-header">
        <div className="brand"><span className="brand-mark">IQ</span><span>Insta Quote <strong>AI</strong></span></div>
        <span className="header-label">Document reader · Assessment</span>
      </header>

      <main>
        <section className="hero" aria-labelledby="page-title">
          <div className="hero-copy">
            <span className="eyebrow hero-eyebrow"><span className="eyebrow-dot" /> Evidence-led extraction</span>
            <h1 id="page-title">Know what the document says.<br /><em>Know what it doesn&apos;t.</em></h1>
            <p>Upload an invoice, packing list or delivery docket. See the line items we can trace to the PDF, plus clear notes for anything we cannot read safely.</p>
            <div className="hero-points"><span>Page-level sources</span><span>Clear refusals</span><span>No guessed quantities</span></div>
          </div>
          <div className="upload-panel">
            <div className="upload-panel-heading"><span className="eyebrow">Start here</span><h2>Read a PDF</h2><p>Your file is checked page by page.</p></div>
            <div
              className={`dropzone${dragging ? " dragging" : ""}${status === "loading" ? " busy" : ""}`}
              onDragOver={(event) => { event.preventDefault(); if (status !== "loading") setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => { event.preventDefault(); setDragging(false); onFiles(event.dataTransfer.files); }}
              aria-busy={status === "loading"}
            >
              <div className="upload-icon" aria-hidden="true">↑</div>
              <strong>Drop your PDF here</strong>
              <span>or choose a file from your device</span>
              <input
                ref={inputRef}
                className="visually-hidden"
                type="file"
                accept="application/pdf,.pdf"
                disabled={status === "loading"}
                aria-label="Choose a PDF file"
                onChange={(event) => { onFiles(event.target.files); event.target.value = ""; }}
              />
              <button type="button" className="primary-button" disabled={status === "loading"} onClick={() => inputRef.current?.click()}>Choose PDF</button>
              <small>PDF files up to {MAX_PDF_LABEL}</small>
            </div>
            <div className="samples-heading"><span>Try an example</span><span>Provided assessment files</span></div>
            <div className="sample-grid">
              {samples.map((sample) => (
                <button className="sample-button" type="button" key={sample.file} disabled={status === "loading"} onClick={() => void loadSample(sample.file)}>
                  <strong>{sample.name}</strong><span>{sample.detail}</span>
                </button>
              ))}
            </div>
          </div>
        </section>

        {status === "loading" && (
          <div className="loading-panel" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            <div><strong>Reading {fileLabel}</strong><p>Checking each page and its source text. This can take a moment.</p></div>
          </div>
        )}
        {status === "transport-error" && (
          <div className="failure-panel transport-failure" role="alert">
            <span className="eyebrow">Upload stopped</span>
            <h2>We couldn&apos;t show a result</h2>
            <p>{transportMessage}</p>
          </div>
        )}
        {status === "done" && envelope && <ResultView envelope={envelope} />}
      </main>

      <footer className="site-footer"><span>Insta Quote AI · Take-home assessment</span><span>Every shown value has a source. Uncertain values stay out.</span></footer>
    </div>
  );
}
