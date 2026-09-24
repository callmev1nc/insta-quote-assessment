import React from "react";
import type { Envelope, Evidence as SourceEvidence, LineItem, Refusal, TracedNumber } from "@/lib/schema";

export function ResultView({ envelope }: { envelope: Envelope }) {
  if (!envelope.ok) {
    return (
      <section className="result-stack" aria-label="Extraction result">
        <div className="failure-panel" role="alert">
          <span className="eyebrow">Document not read</span>
          <h2>{envelope.fileName ?? "This upload"}</h2>
          <p>{envelope.error.plainMessage}</p>
          <details className="technical-detail">
            <summary>Technical detail</summary>
            <p>{envelope.error.code}: {envelope.error.message}</p>
          </details>
        </div>
      </section>
    );
  }

  const { document, lineItems, totals, refusals, pageResults } = envelope;
  const pagesRead = pageResults.filter((page) => page.status !== "refused").length;
  const verifiedTotals = totals && [totals.subtotal, totals.gst, totals.total].some(Boolean);

  return (
    <section className="result-stack" aria-label="Extraction result">
      <div className="result-overview panel">
        <div className="result-heading">
          <div>
            <span className="eyebrow">Extraction result</span>
            <h2 className="file-heading">{envelope.fileName}</h2>
          </div>
          <span className={`status-badge ${refusals.length ? "status-review" : "status-clear"}`}>
            {refusals.length ? "Needs review" : "Fully read"}
          </span>
        </div>
        <div className="stats-grid" aria-label="Result summary">
          <div><strong>{lineItems.length}</strong><span>lines extracted</span></div>
          <div><strong>{pagesRead} / {pageResults.length}</strong><span>pages read</span></div>
          <div><strong>{refusals.length}</strong><span>review notes</span></div>
        </div>
        <div className="page-strip" aria-label="Page status">
          {pageResults.map((page) => (
            <span key={page.page} className={`page-chip page-${page.status}`}>
              Page {page.page} <span>·</span> {page.status === "ok" ? "read" : page.status === "partial" ? "partly read" : "not read"}
            </span>
          ))}
        </div>
        {[document.docNo, document.date, document.billTo, document.jobRef].some(Boolean) && (
          <div className="metadata-grid">
            <Metadata label="Document" value={document.docNo} evidence={document.docNoEvidence} />
            <Metadata label="Date" value={document.date} evidence={document.dateEvidence} />
            <Metadata label="Bill to" value={document.billTo} evidence={document.billToEvidence} />
            <Metadata label="Job ref" value={document.jobRef} evidence={document.jobRefEvidence} />
          </div>
        )}
      </div>

      <RefusalList refusals={refusals} />

      <div className="panel items-panel">
        <div className="section-heading">
          <div>
            <span className="eyebrow">What we could read</span>
            <h2>Line items</h2>
          </div>
          <span className="section-count">{lineItems.length} found</span>
        </div>
        {lineItems.length ? (
          <div className="table-scroll">
            <p className="table-hint">Swipe sideways to see quantities, prices and evidence →</p>
            <table className="items-table">
              <thead>
                <tr><th>Page</th><th>Code</th><th>Description</th><th>Qty</th><th>Unit</th><th>Unit price</th><th>Amount</th><th>Evidence</th></tr>
              </thead>
              <tbody>
                {lineItems.map((item, index) => <ItemRow key={`${item.blockEvidence.page}-${item.code}-${index}`} item={item} />)}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty-note">No line items could be read safely from this file. Check the review notes above for the reason.</p>
        )}
      </div>

      {verifiedTotals && totals && (
        <div className="panel totals-panel">
          <div className="section-heading">
            <div><span className="eyebrow">Printed and checked</span><h2>Totals</h2></div>
          </div>
          <div className="totals-grid">
            <Total label="Subtotal" value={totals.subtotal} />
            <Total label="GST" value={totals.gst} />
            <Total label="Total" value={totals.total} />
          </div>
        </div>
      )}
    </section>
  );
}

function Metadata({ label, value, evidence }: { label: string; value: string | null; evidence: SourceEvidence | null }) {
  if (!value) return null;
  return (
    <div className="metadata-field">
      <span>{label}</span>
      <strong>{value}</strong>
      {evidence && <SourceDisclosure sources={[evidence]} label="View source" />}
    </div>
  );
}

function RefusalList({ refusals }: { refusals: Refusal[] }) {
  if (!refusals.length) return null;
  return (
    <section className="review-section" aria-labelledby="review-heading">
      <div className="section-heading">
        <div><span className="eyebrow">Needs a person to check</span><h2 id="review-heading">Review notes</h2></div>
        <span className="section-count review-count">{refusals.length}</span>
      </div>
      <div className="review-list">
        {refusals.map((refusal, index) => (
          <article className="review-card" key={`${refusal.reasonCode}-${refusal.page ?? "document"}-${index}`}>
            <div className="review-icon" aria-hidden="true">!</div>
            <div>
              <div className="review-meta">{refusal.page ? `Page ${refusal.page}` : "Whole document"} · {refusal.scope}</div>
              <p>{refusal.plainMessage}</p>
              <details className="technical-detail">
                <summary>Source and technical detail</summary>
                <p><code>{refusal.reasonCode}</code> · {refusal.message}</p>
                {refusal.sources.map((source, sourceIndex) => (
                  <div className="quoted-source" key={`${source.page}-${sourceIndex}`}>
                    <span>Page {source.page}</span><pre>{source.sourceText}</pre>
                  </div>
                ))}
              </details>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function ItemRow({ item }: { item: LineItem }) {
  return (
    <tr>
      <td><span className="page-number">{item.blockEvidence.page}</span></td>
      <td><code className="item-code">{item.code}</code></td>
      <td className="description-cell">{item.description}</td>
      <td className="number-cell">{item.quantity.raw}</td>
      <td>{item.unit}</td>
      <td className="number-cell">{item.unitPrice.raw}</td>
      <td className="number-cell">{item.amount?.raw ?? <span className="refused-value">Not shown</span>}</td>
      <td>
        <details className="source-disclosure row-source">
          <summary>View source</summary>
          <div className="source-content">
            <span className="source-page">Page {item.blockEvidence.page} · exact table text</span>
            <pre>{item.blockEvidence.sourceText}</pre>
          </div>
        </details>
      </td>
    </tr>
  );
}

function Total({ label, value }: { label: string; value: TracedNumber | null }) {
  if (!value) return null;
  return (
    <div className="total-field">
      <span>{label}</span>
      <strong>{value.raw}</strong>
      <SourceDisclosure sources={[value.evidence]} label="View source" />
    </div>
  );
}

function SourceDisclosure({ sources, label }: { sources: SourceEvidence[]; label: string }) {
  return (
    <details className="source-disclosure">
      <summary>{label}</summary>
      <div className="source-content">
        {sources.map((source, index) => (
          <div key={`${source.page}-${index}`}>
            <span className="source-page">Page {source.page}</span>
            <pre>{source.sourceText}</pre>
          </div>
        ))}
      </div>
    </details>
  );
}
