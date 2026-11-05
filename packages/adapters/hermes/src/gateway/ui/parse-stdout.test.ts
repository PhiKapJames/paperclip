import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { parseHermesGatewayStdoutLine } from "./parse-stdout.js";

const TS = "2026-07-08T12:00:00.000Z";

function eventLine(eventName: string, data: unknown): string {
  return `[hermes-gateway:event] run=run-123 event=${eventName} data=${JSON.stringify(data)}`;
}

describe("parseHermesGatewayStdoutLine — reasoning.available payload extraction", () => {
  // This is the assertion that FAILS on the old hardcoded-placeholder code
  // and PASSES once the real reasoning text is extracted from `data`.
  it("uses the real reasoning text from data.text instead of the hardcoded placeholder", () => {
    const result = parseHermesGatewayStdoutLine(
      eventLine("reasoning.available", { text: "Considering three approaches to the cache invalidation bug." }),
      TS,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: "thinking",
      ts: TS,
      text: "Considering three approaches to the cache invalidation bug.",
    });
    expect(result[0]).not.toHaveProperty("text", "Hermes reasoning available");
  });

  it("uses the real reasoning text from data.summary", () => {
    const result = parseHermesGatewayStdoutLine(
      eventLine("reasoning.available", { summary: "Weighing tradeoffs between two refactor strategies." }),
      TS,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: "thinking",
      ts: TS,
      text: "Weighing tradeoffs between two refactor strategies.",
    });
  });

  it("recurses one level into a nested data.data record to find the reasoning text", () => {
    const result = parseHermesGatewayStdoutLine(
      eventLine("reasoning.available", { data: { text: "Nested reasoning payload from gateway wrapper." } }),
      TS,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: "thinking",
      ts: TS,
      text: "Nested reasoning payload from gateway wrapper.",
    });
  });

  it("recurses one level into a nested data.payload record to find the reasoning text", () => {
    const result = parseHermesGatewayStdoutLine(
      eventLine("reasoning.available", { payload: { reasoning: "Nested via payload wrapper instead of data." } }),
      TS,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: "thinking",
      ts: TS,
      text: "Nested via payload wrapper instead of data.",
    });
  });

  it("falls back to the placeholder when data has no recognizable text field (preserves bare-signal behavior)", () => {
    const result = parseHermesGatewayStdoutLine(
      eventLine("reasoning.available", { unrelatedField: 42 }),
      TS,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: "thinking", ts: TS, text: "Hermes reasoning available" });
  });

  it("falls back to the placeholder when data is entirely absent/unparseable", () => {
    const result = parseHermesGatewayStdoutLine(
      "[hermes-gateway:event] run=run-123 event=reasoning.available data=not-json",
      TS,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: "thinking", ts: TS, text: "Hermes reasoning available" });
  });
});

describe("parseHermesGatewayStdoutLine — regression guards for unrelated handlers", () => {
  it("still yields an assistant delta part for message.delta", () => {
    const result = parseHermesGatewayStdoutLine(
      eventLine("message.delta", { delta: "Hello there" }),
      TS,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: "assistant", ts: TS, text: "Hello there", delta: true });
  });

  it("still yields a stdout part for a plain non-event line", () => {
    const result = parseHermesGatewayStdoutLine("just a plain line of output", TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: "stdout", ts: TS, text: "just a plain line of output" });
  });

  it("renders the approval bridge line as a system message without the brackets", () => {
    const result = parseHermesGatewayStdoutLine(
      "[hermes-gateway:approval run=run-1 request=approval-1 waiting for a human decision]",
      TS,
    );
    expect(result).toEqual([{ kind: "system", ts: TS, text: "Hermes approval: run=run-1 request=approval-1 waiting for a human decision" }]);
  });

  it("renders the approval decision line", () => {
    const result = parseHermesGatewayStdoutLine(
      "[hermes-gateway:approval run=run-1 request=approval-1 decision=once]",
      TS,
    );
    expect(result).toEqual([{ kind: "system", ts: TS, text: "Hermes approval: run=run-1 request=approval-1 decision=once" }]);
  });
});

describe("gateway approval markers — TypeScript and CommonJS parser parity", () => {
  // R6 (finding #10): the published CommonJS parser must render the same
  // approval bridge lines as the TypeScript parser.
  const cjsParser = createRequire(import.meta.url)("../../../gateway-ui-parser.cjs") as {
    parseStdoutLine: (line: string, ts: string) => Array<Record<string, unknown>>;
  };

  const markerLines = [
    "[hermes-gateway:approval run=run-1 request=approval-1 waiting for a human decision]",
    "[hermes-gateway:approval run=run-1 request=approval-1 card=int-1]",
    "[hermes-gateway:approval run=run-1 request=approval-1 decision=once]",
    "[hermes-gateway:approval run=run-1 request=approval-1 hermes_gateway_approval_bridge_failed]",
    "[hermes-gateway:approval] request approval-1 already resolved (HTTP 409)",
  ];

  it.each(markerLines)("renders %s identically in both parsers", (line) => {
    expect(cjsParser.parseStdoutLine(line, TS)).toEqual(parseHermesGatewayStdoutLine(line, TS));
  });

  it("keeps ordinary event and stdout parsing identical", () => {
    for (const line of [
      eventLine("message.delta", { delta: "hello" }),
      eventLine("run.failed", { error: "boom" }),
      "[hermes-gateway] run created: run-1",
      "plain stdout",
    ]) {
      expect(cjsParser.parseStdoutLine(line, TS)).toEqual(parseHermesGatewayStdoutLine(line, TS));
    }
  });
});
