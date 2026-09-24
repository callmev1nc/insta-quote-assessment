import { readFile } from "node:fs/promises";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ResultView } from "../app/result-view";
import { extractDocument } from "../lib/extract";

async function renderFixture(name: string): Promise<string> {
  const buffer = await readFile(join(process.cwd(), "fixtures", name));
  const result = await extractDocument(buffer, name);
  return renderToStaticMarkup(<ResultView envelope={result} />);
}

describe("refusals reaching the page", () => {
  it("shows the scan refusal in plain language before the empty line-item table", async () => {
    const html = await renderFixture("IB-55902.pdf");
    expect(html).toContain("You may be able to read page 1 on screen");
    expect(html).toContain("no selectable text");
    expect(html).toContain("No line items could be read safely");
    expect(html.indexOf("You may be able to read page 1 on screen")).toBeLessThan(html.indexOf("Line items"));
  });

  it("shows both conflicting carton statements with their exact source text", async () => {
    const html = await renderFixture("IB-56088.pdf");
    expect(html).toContain("The document says two different things about the carton count");
    expect(html).toContain("9 cartons dispatched");
    expect(html).toContain("11 cartons picked and loaded");
    expect(html).toContain("$2,050.00");
  });
});
