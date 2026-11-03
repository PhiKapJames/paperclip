import { describe, expect, it, vi, afterEach } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { createPromptContextFixture } from "@paperclipai/adapter-utils/test-fixtures/prompt-context";
import {
  approvalChoiceIds,
  buildApprovalInteractionBody,
  createApprovalInteraction,
  execute,
  extractApprovalRequest,
  extractPendingApproval,
  hermesApprovalKey,
  postApproval,
  resolveHermesApprovalChoice,
  type HermesApprovalChoice,
  mapFinalResultForTest,
  parseSseFramesForTest,
  resolveSessionKey,
} from "./execute.js";
import { testEnvironment } from "./test.js";

function makeCtx(config: Record<string, unknown>): AdapterExecutionContext {
  return {
    runId: "pc-run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes",
      adapterType: "hermes_gateway",
      adapterConfig: config,
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config,
    context: {
      issueId: "issue-1",
      wakeReason: "manual",
      paperclipWake: {
        issue: { identifier: "PAP-1", title: "Do the thing" },
      },
    },
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
  };
}

function sseStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveSessionKey", () => {
  it("derives issue-scoped session keys by default", () => {
    expect(
      resolveSessionKey({
        strategy: "issue",
        companyId: "company-1",
        agentId: "agent-1",
        runId: "run-1",
        issueId: "issue-1",
      }),
    ).toBe("paperclip:company:company-1:agent:agent-1:issue:issue-1");
  });

  it("omits the session key for none strategy", () => {
    expect(
      resolveSessionKey({
        strategy: "none",
        companyId: "company-1",
        agentId: "agent-1",
        runId: "run-1",
        issueId: "issue-1",
      }),
    ).toBeNull();
  });
});

describe("parseSseFramesForTest", () => {
  it("parses event and data lines while preserving partial frames", () => {
    const parsed = parseSseFramesForTest("event: message.delta\ndata: {\"delta\":\"hi\"}\n\n:data\ndata: later");
    expect(parsed.frames).toEqual([{ event: "message.delta", data: "{\"delta\":\"hi\"}" }]);
    expect(parsed.rest).toBe(":data\ndata: later");
  });
});

describe("extractApprovalRequest", () => {
  const cases: Array<[string, unknown, string | null]> = [
    ["canonical approval.request frame", {
      event: "approval.request",
      data: { request_id: "req-1", command: "rm -rf /tmp/x", reason: "destructive" },
    }, "req-1"],
    ["camelCase request id", { event: "approval.request", data: { requestId: "req-2" } }, "req-2"],
    ["nested under data.data", { event: "approval.request", data: { data: { request_id: "req-3" } } }, "req-3"],
    ["nested under payload", { event: "approval.request", data: { payload: { request_id: "req-4" } } }, "req-4"],
    ["event name carried in the payload", {
      data: { event: "approval.request", request_id: "req-5" },
    }, "req-5"],
    ["missing request id", { event: "approval.request", data: { command: "ls" } }, null],
    ["a non-approval event", { event: "token", data: { text: "hi" } }, null],
    ["blank request id", { event: "approval.request", data: { request_id: "   " } }, null],
  ]

  it.each(cases)("reads %s", (_name, frame, expected) => {
    const result = extractApprovalRequest(frame)
    if (expected === null) {
      expect(result).toBeNull()
      return
    }
    expect(result?.requestId).toBe(expected)
  })

  it("carries the command and reason for the human-facing card", () => {
    expect(extractApprovalRequest({
      event: "approval.request",
      data: { request_id: "req-9", command: "DROP TABLE users", reason: "irreversible" },
    })).toEqual({
      requestId: "req-9",
      command: "DROP TABLE users",
      reason: "irreversible",
      allowed: ["once", "deny"],
    })
  })

  it("leaves command and reason null when Hermes omits them", () => {
    expect(extractApprovalRequest({ event: "approval.request", data: { request_id: "req-10" } }))
      .toEqual({ requestId: "req-10", command: null, reason: null, allowed: ["once", "deny"] })
  })

  it("keeps only the choices the request advertises", () => {
    expect(extractApprovalRequest({
      event: "approval.request",
      data: { request_id: "req-11", allowed_choices: ["once", "session", "always", "deny"] },
    })?.allowed).toEqual(["once", "session", "always", "deny"])
  })
})

describe("approvalChoiceIds", () => {
  const cases: Array<[string, unknown, HermesApprovalChoice[]]> = [
    ["no advertisement", undefined, ["once", "deny"]],
    ["a non-list advertisement", "once", ["once", "deny"]],
    ["a list of junk", [1, null, "nope"], ["once", "deny"]],
    ["an empty list", [], ["once", "deny"]],
    ["deny only", ["deny"], ["once", "deny"]],
    ["an advertised subset", ["once", "session", "deny"], ["once", "session", "deny"]],
    ["all four", ["once", "session", "always", "deny"], ["once", "session", "always", "deny"]],
  ]

  it.each(cases)("advertised %s offers %j", (_name, advertised, expected) => {
    expect(approvalChoiceIds(advertised)).toEqual(expected)
  })

  it("never drops deny", () => {
    expect(approvalChoiceIds(["once", "always"])).toEqual(["once", "always", "deny"])
  })
})

describe("extractPendingApproval", () => {
  const cases: Array<[string, unknown, string | null]> = [
    ["top-level request_id", { status: "waiting_for_approval", request_id: "req-1" }, "req-1"],
    ["camelCase", { status: "waiting_for_approval", requestId: "req-2" }, "req-2"],
    ["nested under approvals", { approvals: { pending: [{ request_id: "req-3" }] } }, "req-3"],
    ["nested under data", { data: { status: "waiting_for_approval", request_id: "req-4" } }, "req-4"],
    ["a run that is not waiting", { status: "completed", output: "done" }, null],
    ["waiting but no request id exposed", { status: "waiting_for_approval" }, null],
  ]

  it.each(cases)("reads %s", (_name, record, expected) => {
    const result = extractPendingApproval(record)
    if (expected === null) {
      expect(result).toBeNull()
      return
    }
    expect(result?.requestId).toBe(expected)
  })
})

describe("resolveHermesApprovalChoice", () => {
  const answered = (answers: unknown, result: Record<string, unknown> = {}) => ({
    status: "answered",
    result: { version: 1, answers, ...result },
  })

  const cases: Array<[string, unknown, HermesApprovalChoice]> = [
    ["once", answered([{ questionId: "decision", optionIds: ["once"] }]), "once"],
    ["session", answered([{ questionId: "decision", optionIds: ["session"] }]), "session"],
    ["always", answered([{ questionId: "decision", optionIds: ["always"] }]), "always"],
    ["deny", answered([{ questionId: "decision", optionIds: ["deny"] }]), "deny"],
    ["the record-shaped answer map", answered({ decision: { selectedOptionIds: ["session"] } }), "session"],
    ["an unknown option id", answered([{ questionId: "decision", optionIds: ["maybe"] }]), "deny"],
    ["two selected options", answered([{ questionId: "decision", optionIds: ["once", "always"] }]), "deny"],
    ["an empty selection", answered([{ questionId: "decision", optionIds: [] }]), "deny"],
    ["free text instead of an option", answered([{ questionId: "decision", optionIds: [], otherText: "go ahead" }]), "deny"],
    ["free text alongside an option", answered([{ questionId: "decision", optionIds: ["once"], otherText: "but carefully" }]), "deny"],
    ["an answer for another question", answered([{ questionId: "other", optionIds: ["once"] }]), "deny"],
    ["no answers", answered([]), "deny"],
    ["a cancelled answer", answered([{ questionId: "decision", optionIds: ["once"] }], { cancelled: true }), "deny"],
    ["a superseded question", answered([{ questionId: "decision", optionIds: ["once"] }], { expirationReason: "superseded_by_comment" }), "deny"],
    ["still pending", { status: "pending", result: null }, "deny"],
    ["cancelled", { status: "cancelled", result: {} }, "deny"],
    ["expired", { status: "expired", result: {} }, "deny"],
    ["rejected", { status: "rejected", result: {} }, "deny"],
    ["failed", { status: "failed", result: {} }, "deny"],
    ["answered with no result", { status: "answered", result: null }, "deny"],
    ["a malformed answer entry", answered([{ questionId: "decision", optionIds: "once" }]), "deny"],
    ["answers is not a container", "yes", "deny"],
    ["null", null, "deny"],
  ]

  it.each(cases)("maps %s to the safe choice", (_name, interaction, expected) => {
    expect(resolveHermesApprovalChoice(interaction)).toBe(expected)
  })
})

describe("hermesApprovalKey", () => {
  it("namespaces the run and approval request ids", () => {
    expect(hermesApprovalKey("pc-run-1", "apr-1")).toBe("hermes-approval:pc-run-1:apr-1")
  })

  it("refuses a key longer than the interaction validator allows rather than truncating it", () => {
    expect(hermesApprovalKey("r".repeat(250), "apr-1")).toBeNull()
  })

  it("accepts a key of exactly the 255-char limit", () => {
    const prefix = "hermes-approval:"
    const runId = "r".repeat(255 - prefix.length - 1 - 1)
    expect(hermesApprovalKey(runId, "a")).toHaveLength(255)
    expect(hermesApprovalKey(runId, "a")).not.toBeNull()
  })
})

describe("buildApprovalInteractionBody", () => {
  it("asks one single-choice question carrying only once/deny by default", () => {
    const body = buildApprovalInteractionBody({
      key: "hermes-approval:run_7:req-1",
      requestId: "req-1",
      command: "apt-get install -y curl",
      reason: "needs a download tool",
    }) as {
      kind: string;
      idempotencyKey: string;
      title: string;
      summary: string;
      resolverPolicy: string;
      continuationPolicy: string;
      payload: {
        version: number;
        supersedeOnUserComment: boolean;
        runtimeRequestId: string;
        questions: Array<Record<string, any>>;
      };
    };
    expect(body.kind).toBe("ask_user_questions");
    expect(body.idempotencyKey).toBe("hermes-approval:run_7:req-1");
    // Must be answered by a human, and answering must not wake a second agent run.
    expect(body.resolverPolicy).toBe("human_only");
    expect(body.continuationPolicy).toBe("none");
    expect(body.payload.supersedeOnUserComment).toBe(false);
    expect(body.payload.version).toBe(1);
    expect(body.payload.runtimeRequestId).toBe("req-1");
    expect(body.payload.questions).toHaveLength(1);
    const question = body.payload.questions[0];
    expect(question.selectionMode).toBe("single");
    expect(question.id).toBe("decision");
    expect(question.allowOther).toBe(false);
    expect((question.options as Array<Record<string, any>>).map((o) => o.id)).toEqual([
      "once",
      "deny",
    ]);
    expect(body.summary).toContain("apt-get install -y curl");
    expect(body.summary).toContain("needs a download tool");
    expect(body.payload.questions[0].prompt).toContain("apt-get install -y curl");
  });

  it("offers the pattern choices Hermes advertises on the request", () => {
    const body = buildApprovalInteractionBody({
      key: "hermes-approval:run_7:req-1",
      requestId: "req-1",
      command: "kubectl delete pod web-1",
      reason: null,
      allowed: ["once", "session", "always", "deny"],
    }) as { payload: { questions: Array<{ options: Array<Record<string, any>> }> } };
    const options = body.payload.questions[0].options;
    expect(options.map((o) => o.id)).toEqual(["once", "session", "always", "deny"]);
    // Nothing may promise more than Hermes actually does.
    expect(options.find((o) => o.id === "session")?.label).toBe("Allow for this run");
    expect(options.find((o) => o.id === "session")?.description).toContain("this run");
    expect(options.find((o) => o.id === "always")?.description).toContain("Hermes stores");
  });

  it("keeps a long or control-character command inside the server's field limits", () => {
    // Limits from packages/shared ask_user_questions validators: title 240,
    // summary 1000, question prompt 4000.
    const body = buildApprovalInteractionBody({
      key: "hermes-approval:run_7:req-1",
      requestId: "req-1",
      command: `echo ${"a".repeat(20000)}\u001b[2J`,
      reason: "r".repeat(20000),
    }) as { title: string; summary: string; payload: { questions: Array<{ prompt: string }> } };
    expect(body.title.length).toBeLessThanOrEqual(240);
    expect(body.summary.length).toBeLessThanOrEqual(1000);
    expect(body.payload.questions[0].prompt.length).toBeLessThanOrEqual(4000);
    expect(body.summary).not.toContain("\u001b");
  });

  it("still asks something when Hermes sends no command or reason", () => {
    const body = buildApprovalInteractionBody({ key: "k", requestId: "req-1", command: null, reason: null }) as {
      summary: string;
      payload: { questions: Array<{ prompt: string }> };
    };
    expect(body.summary).toContain("did not say");
    expect(body.payload.questions[0].prompt.length).toBeGreaterThan(0);
  });
});

describe("createApprovalInteraction", () => {
  it("posts the card to the issue with the run-scoped agent token", async () => {
    const calls: Array<{ url: string; init: any }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ interaction: { id: "itest_1" } }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }));
    try {
      const result = await createApprovalInteraction({
        paperclipApiUrl: "http://localhost:3100/",
        authToken: "local_agent_jwt",
        runId: "run_7",
        issueId: "iss_1",
        body: { kind: "ask_user_questions" },
        signal: new AbortController().signal,
      });
      expect(result.interactionId).toBe("itest_1");
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("http://localhost:3100/api/issues/iss_1/interactions");
      expect(calls[0].init.method).toBe("POST");
      expect(calls[0].init.headers).toMatchObject({
        Authorization: "Bearer local_agent_jwt",
        "X-Paperclip-Run-Id": "run_7",
      });
      expect(JSON.parse(calls[0].init.body)).toEqual({ kind: "ask_user_questions" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports the status when Paperclip rejects the card", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    })));
    try {
      await expect(createApprovalInteraction({
        paperclipApiUrl: "http://localhost:3100",
        authToken: "bad_token",
        runId: "run_7",
        issueId: "iss_1",
        body: { kind: "ask_user_questions" },
        signal: new AbortController().signal,
      })).rejects.toThrow(/403/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("postApproval", () => {
  const baseInput = {
    baseUrl: new URL("http://127.0.0.1:8642"),
    headers: {
      Authorization: "Bearer hermes-key",
    },
    runId: "run_7",
    key: "hermes-approval:run_7:req-1",
    requestId: "req-1",
    signal: new AbortController().signal,
  };

  async function runWith(status: number) {
    const calls: Array<{ url: string; init: any }> = [];
    const logs: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return new Response(status === 409 ? JSON.stringify({ error: "already resolved" }) : "{}", {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }));
    const onLog = vi.fn(async (_stream: "stdout" | "stderr", chunk: string) => {
      logs.push(chunk);
    });
    try {
      const delivered = await postApproval({
        ...baseInput,
        choice: "once",
        onLog,
      });
      return { calls, logs, delivered };
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it("posts the exact board choice and request id to the run approval endpoint", async () => {
    const { calls, delivered } = await runWith(200);
    expect(delivered).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:8642/v1/runs/run_7/approval");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body)).toEqual({ choice: "once", request_id: "req-1" });
    // The answer must be idempotent on Hermes' side too, so a retry cannot
    // answer a later request under the same key.
    expect(calls[0].init.headers["Idempotency-Key"]).toBe("hermes-approval:run_7:req-1");
  });

  it("treats a 409 already-resolved answer as delivered and never retries", async () => {
    const { calls, logs, delivered } = await runWith(409);
    expect(delivered).toBe(true);
    expect(calls).toHaveLength(1);
    expect(logs.join("")).toContain("already resolved");
  });

  it("reports an undelivered answer without throwing so the SSE stream survives", async () => {
    const { logs, delivered } = await runWith(500);
    expect(delivered).toBe(false);
    expect(logs.join("")).toContain("HTTP 500");
  });
});

describe("execute", () => {
  it("rejects remote plain HTTP unless the unsafe dev escape hatch is enabled", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ run_id: "unexpected" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeCtx({
      apiBaseUrl: "http://192.168.1.25:8642",
      apiKey: "secret-key",
    }));

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_plain_http_remote_denied");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports dispatch before starting the remote run create request", async () => {
    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
    });
    const onDispatch = vi.fn();
    ctx.onDispatch = onDispatch;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        expect(onDispatch).toHaveBeenCalledTimes(1);
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(
          sseStream(["event: run.completed", "data: {\"status\":\"completed\",\"output\":\"done\"}", ""].join("\n")),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(onDispatch).toHaveBeenCalledTimes(1);
  });

  it("constructs POST /v1/runs with auth, idempotency, and Hermes session headers", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(
          sseStream(
            [
              "event: message.delta",
              "data: {\"delta\":\"done\"}",
              "",
              "event: run.completed",
              "data: {\"status\":\"completed\",\"output\":\"done\",\"session_id\":\"session-1\",\"usage\":{\"input_tokens\":3,\"output_tokens\":2},\"model\":\"hermes-agent\"}",
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
    }));

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("done");
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2 });

    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const createCall = calls.find(([input]) => String(input).endsWith("/v1/runs"));
    expect(createCall).toBeTruthy();
    const init = createCall?.[1] as RequestInit;
    expect(init.headers).toMatchObject({
      Authorization: "Bearer secret-key",
      "Content-Type": "application/json",
      "Idempotency-Key": "pc-run-1",
      "X-Hermes-Session-Key": "paperclip:company:company-1:agent:agent-1:issue:issue-1",
    });
    const body = JSON.parse(String(init.body));
    expect(body.input).toContain("Do the thing");
    expect(body.session_id).toBe("paperclip:company:company-1:agent:agent-1:issue:issue-1");
  });

  it.each([false, true])("preserves chat handoff policy on gateway turns (resumed=%s)", async (resumed) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).endsWith("/v1/runs")
        ? { run_id: "run-hermes-1", status: "started" }
        : { status: "completed", output: "done" },
    ), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    ctx.config.payloadTemplate = { input: "Custom gateway instruction." };
    const directive = "Chat directive: clarify goals and hand plans off to project tasks.";
    ctx.context = {
      conversationMode: true,
      issueId: "issue-1",
      paperclipTaskMarkdown: directive,
      paperclipTaskMarkdownCompact: directive,
      paperclipWake: {
        reason: "issue_commented",
        issue: { id: "issue-1", workMode: "planning", status: "in_progress" },
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
      },
    };
    if (resumed) ctx.runtime.sessionId = "prior-session";
    await execute(ctx);
    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const call = calls.find(([input]) => String(input).endsWith("/v1/runs"));
    const prompt = JSON.parse(String(call?.[1]?.body)).input as string;
    expect(prompt).toContain("Custom gateway instruction.");
    expect(prompt).toContain(directive);
    expect(prompt).not.toContain("Execution contract:");
    expect(prompt).not.toContain("clear final disposition");
    expect(prompt).not.toContain("Create child issues");
  });

  it("sends the task brief once on fresh runs and compacts it on stable-session resumes", async () => {
    const description = "Update launch-card.svg and change the CTA to Try Team free.";
    const fullTaskMarkdown = [
      "Paperclip task context:",
      '- Issue: "PAP-1"',
      "",
      "Issue description:",
      "```text",
      description,
      "```",
    ].join("\n");
    const compactTaskMarkdown = ["Paperclip task context:", '- Issue: "PAP-1"'].join("\n");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const wakeContext = (reason: string) => ({
      issueId: "issue-1",
      wakeReason: reason,
      paperclipTaskMarkdown: fullTaskMarkdown,
      paperclipTaskMarkdownCompact: compactTaskMarkdown,
      paperclipWake: {
        reason,
        issue: {
          id: "issue-1",
          identifier: "PAP-1",
          title: "Do the thing",
          description,
          descriptionTruncated: false,
          status: "in_progress",
        },
        commentWindow: { requestedCount: 0, includedCount: 0, missingCount: 0 },
        comments: [],
        fallbackFetchNeeded: false,
      },
    });

    const freshCtx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    freshCtx.context = wakeContext("issue_assigned");
    await execute(freshCtx);

    const resumeCtx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    resumeCtx.context = wakeContext("issue_commented");
    resumeCtx.runtime = {
      sessionId: "session-1",
      sessionParams: null,
      sessionDisplayId: "session-1",
      taskKey: "PAP-1",
    };
    await execute(resumeCtx);

    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const runBodies = calls
      .filter(([input]) => String(input).endsWith("/v1/runs"))
      .map(([, init]) => JSON.parse(String(init?.body)) as { input: string });
    expect(runBodies).toHaveLength(2);
    // Fresh run: brief exactly once (task markdown only; wake-prompt copy suppressed).
    expect(runBodies[0]!.input.split(description)).toHaveLength(2);
    // Stable-session resume: compact task markdown, no re-sent brief.
    expect(runBodies[1]!.input).toContain("Paperclip task context:");
    expect(runBodies[1]!.input).not.toContain(description);
  });

  it.each([false, true])("delivers the shared assignment and ordered comments at the HTTP boundary (resumed=%s)", async (resumed) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "completed", output: "done" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
      payloadTemplate: { input: "Custom gateway instruction." },
    });
    const promptContext = createPromptContextFixture();
    ctx.context = { ...promptContext, conversationMode: true };
    if (resumed) ctx.runtime.sessionId = "prior-session";

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const runCall = calls.find(([input]) => String(input).endsWith("/v1/runs"));
    const input = JSON.parse(String(runCall?.[1]?.body)).input as string;
    expect(input).toContain("Custom gateway instruction.");
    expect(input.indexOf("Append the same ledger entry.")).toBeGreaterThanOrEqual(0);
    expect(input.indexOf("Append the same ledger entry.")).toBeLessThan(input.indexOf("Change the final scope to the launch checklist."));
    expect(input.split("Append the same ledger entry.")).toHaveLength(3);
    expect(input).not.toContain("Structured wake payload JSON:");
    expect(input.split("Keep this deliberate repetition. Keep this deliberate repetition.")).toHaveLength(2);
    const continuationHeading = "## Current request and continuation context";
    const continuationStart = input.indexOf(continuationHeading);
    const fencedStart = input.indexOf("```text\n", continuationStart);
    const fencedEnd = input.indexOf("\n```", fencedStart + "```text\n".length);
    expect(continuationStart).toBeGreaterThanOrEqual(0);
    expect(fencedStart).toBeGreaterThan(continuationStart);
    expect(fencedEnd).toBeGreaterThan(fencedStart);
    const continuation = JSON.parse(input.slice(
      fencedStart + "```text\n".length,
      fencedEnd,
    )) as Record<string, unknown>;
    expect(continuation.objectiveSource).toEqual(promptContext.executionContinuation.objectiveSource);
    if (resumed) {
      expect(input).toContain("## Compact assignment");
      expect(continuation.objective).toBe("Keep this deliberate repetition. Keep this deliberate repetition.");
    } else {
      expect(continuation).not.toHaveProperty("objective");
    }
  });

  it("routes a bare Hermes dashboard URL on port 9119 through the API prefix", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "http://127.0.0.1:9119/api/v1/runs") {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url === "http://127.0.0.1:9119/api/v1/runs/run-hermes-1/events") {
        return new Response(
          sseStream(
            [
              "event: run.completed",
              "data: {\"status\":\"completed\",\"output\":\"done\"}",
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:9119",
      apiKey: "secret-key",
      timeoutSec: 5,
    });
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(ctx.onMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        commandArgs: ["http://127.0.0.1:9119/api/v1/runs"],
      }),
    );
    expect((ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) => String(line)).join("\n"))
      .toContain("creating run at http://127.0.0.1:9119/api/v1/runs");
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(
      expect.arrayContaining([
        "http://127.0.0.1:9119/api/v1/runs",
        "http://127.0.0.1:9119/api/v1/runs/run-hermes-1/events",
      ]),
    );
  });

  it("renders current wake comments once when the gateway task brief owns them", async () => {
    const commentBody = "Keep this current comment exactly once.";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key" });
    ctx.context = {
      issueId: "issue-1",
      paperclipTaskMarkdown: [
        "Paperclip task context:",
        '- Issue: "PAP-1"',
      ].join("\n"),
      paperclipTurnContext: {
        version: 1,
        assignment: { owner: "task_markdown" },
        events: { owner: "wake_prompt", comments: [{ id: "comment-1", revision: "rev-1" }] },
      },
      paperclipWake: {
        reason: "issue_commented",
        issue: { id: "issue-1", identifier: "PAP-1", title: "Do the thing", status: "in_progress" },
        commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 },
        comments: [{ id: "comment-1", body: commentBody }],
        fallbackFetchNeeded: false,
      },
    };

    await execute(ctx);
    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const runCall = calls.find(([input]) => String(input).endsWith("/v1/runs"));
    const prompt = JSON.parse(String(runCall?.[1]?.body)).input as string;
    expect(prompt.split(commentBody)).toHaveLength(2);
  });

  it("routes the default Hermes dashboard chat URL on port 9119 through the API prefix", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "http://127.0.0.1:9119/api/v1/runs") {
        return new Response(JSON.stringify({ run_id: "run-hermes-chat", status: "started" }), { status: 200 });
      }
      if (url === "http://127.0.0.1:9119/api/v1/runs/run-hermes-chat/events") {
        return new Response(
          sseStream(
            [
              "event: run.completed",
              "data: {\"status\":\"completed\",\"output\":\"done\"}",
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:9119/chat",
      apiKey: "secret-key",
      timeoutSec: 5,
    });
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(ctx.onMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        commandArgs: ["http://127.0.0.1:9119/api/v1/runs"],
      }),
    );
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(
      expect.arrayContaining([
        "http://127.0.0.1:9119/api/v1/runs",
        "http://127.0.0.1:9119/api/v1/runs/run-hermes-chat/events",
      ]),
    );
  });

  it("redacts echoed auth material from stream logs and summaries", async () => {
    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(
          sseStream(
            [
              "event: message.delta",
              "data: {\"delta\":\"Authorization: Bearer secret-key\\nX-Hermes-Session-Key: paperclip:company:company-1:agent:agent-1:issue:issue-1\"}",
              "",
              "event: run.completed",
              "data: {\"status\":\"completed\",\"output\":\"Authorization: Bearer secret-key\\nraw key secret-key\\nX-Hermes-Session-Key: paperclip:company:company-1:agent:agent-1:issue:issue-1\"}",
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(ctx);
    const logText = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) => String(line)).join("\n");

    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("Bearer [redacted]");
    expect(result.summary).toContain("raw key [redacted len=10]");
    expect(result.summary).toContain("X-Hermes-Session-Key: [redacted]");
    expect(result.summary).not.toContain("secret-key");
    expect(result.summary).not.toContain("paperclip:company:company-1:agent:agent-1:issue:issue-1");
    expect(result.resultJson?.output).toBe(result.summary);
    expect(logText).toContain("Bearer [redacted]");
    expect(logText).toContain("X-Hermes-Session-Key: [redacted]");
    expect(logText).not.toContain("secret-key");
    expect(logText).not.toContain("paperclip:company:company-1:agent:agent-1:issue:issue-1");
  });

  it("redacts agent-scoped Paperclip session keys from logs and public result metadata", async () => {
    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      sessionKeyStrategy: "agent",
      timeoutSec: 5,
    });
    const agentSessionKey = "paperclip:company:company-1:agent:agent-1";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(
          sseStream(
            [
              "event: message.delta",
              `data: {"delta":"session ${agentSessionKey}"}`,
              "",
              "event: run.completed",
              `data: {"status":"completed","output":"session ${agentSessionKey}","session_id":"${agentSessionKey}"}`,
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(ctx);
    const logText = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) => String(line)).join("\n");

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("session [redacted-session-key]");
    expect(result.sessionId).toBe("[redacted-session-key]");
    expect(result.sessionDisplayId).toBe("[redacted-session-key]");
    expect(result.resultJson?.session_id).toBe("[redacted-session-key]");
    expect(result.sessionParams).toEqual({
      hermesRunId: "run-hermes-1",
      strategy: "agent",
    });
    expect(logText).toContain("[redacted-session-key]");
    expect(logText).not.toContain(agentSessionKey);
  });

  it("falls back to polling when SSE is unavailable", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response("no stream", { status: 503 });
      }
      return new Response(JSON.stringify({
        status: "completed",
        output: "polled done",
        session_id: "session-polled",
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
      pollIntervalMs: 250,
    }));

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("polled done");
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/v1/runs/run-hermes-1"))).toBe(true);
  });

  it("maps HTTP auth failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "bad key" }), { status: 401 })));
    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
    }));
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_auth_failed");
    expect(result.errorMessage).toContain("Check adapterConfig.apiKey matches the Hermes API_SERVER_KEY");
  });

  it("includes network causes in connection failure messages", async () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND host.docker.internal"), { code: "ENOTFOUND" });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw Object.assign(new Error("fetch failed"), { cause });
    }));

    const result = await execute(makeCtx({
      apiBaseUrl: "http://host.docker.internal:8642",
      apiKey: "secret-key",
      dangerouslyAllowInsecureRemoteHttp: true,
    }));

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_connect_failed");
    expect(result.errorMessage).toContain("ENOTFOUND");
    expect(result.errorMessage).toContain("host.docker.internal");
  });

  it.each([
    ["http://127.0.0.1:8642", { code: "ECONNREFUSED", syscall: "connect", address: "127.0.0.1", port: 8642 }],
    ["http://[::1]:8642", { code: "ECONNREFUSED", syscall: "connect", address: "::1", port: 8642 }],
    ["http://localhost:8642", { code: "ECONNREFUSED", errors: [
      { code: "ECONNREFUSED", syscall: "connect", address: "::1", port: 8642 },
      { code: "ECONNREFUSED", syscall: "connect", address: "127.0.0.1", port: 8642 },
    ] }],
    ["https://localhost", { code: "ECONNREFUSED", syscall: "connect", address: "127.0.0.1", port: 443 }],
    ["http://localhost", { code: "ECONNREFUSED", syscall: "connect", address: "127.0.0.1", port: 80 }],
  ])("explains the server-side loopback gateway at %s without claiming non-dispatch", async (apiBaseUrl, cause) => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      throw Object.assign(new Error("fetch failed"), { cause });
    });
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx({ apiBaseUrl, apiKey: "gateway-private-key" });
    ctx.onDispatch = vi.fn();
    const result = await execute(ctx);

    expect(result.errorMessage).toContain("refers to the Paperclip server, not an agent sandbox");
    expect(result.errorMessage).toContain("adapterConfig.apiBaseUrl");
    expect(result.errorMessage).toContain("hermes_local");
    expect(result.errorMessage).not.toContain("gateway-private-key");
    expect(result.errorMeta).toEqual({ category: "gateway_loopback_connection_refused", phase: "create_run" });
    expect(result).toMatchObject({ exitCode: 1, signal: null, timedOut: false,
      errorCode: "hermes_gateway_connect_failed", errorFamily: "transient_upstream", retryNotBefore: null });
    expect(result.executionRecovery).toBeUndefined();
    expect(result.resultJson).toEqual({ connectionFailure: {
      schemaVersion: 1, provider: "hermes_gateway", operation: "create_run", reason: "connection_refused",
    } });
    expect(ctx.onDispatch).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBeUndefined();
  });

  it.each([
    ["https://gateway.example.test:8642", { code: "ECONNREFUSED", syscall: "connect", address: "127.0.0.1", port: 8642 }],
    ["http://localhost:8642", { code: "ECONNREFUSED", syscall: "connect", address: "192.0.2.1", port: 8642 }],
    ["http://localhost:8642", { code: "ECONNREFUSED", syscall: "connect", address: "127.0.0.1", port: 9000 }],
    ["http://127.0.0.2:8642", { code: "ECONNREFUSED", syscall: "connect", address: "127.0.0.1", port: 8642 }],
    ["http://localhost:8642", { code: "ETIMEDOUT", syscall: "connect", address: "127.0.0.1", port: 8642 }],
    ["http://localhost:8642", { code: "EHOSTUNREACH", syscall: "connect", address: "127.0.0.1", port: 8642 }],
    ["http://localhost:8642", { code: "ECONNREFUSED", address: "127.0.0.1", port: 8642 }],
    ["http://localhost:8642", { message: "ECONNREFUSED connect 127.0.0.1:8642" }],
    ["http://localhost:8642", { code: "ECONNREFUSED", errors: [] }],
    ["http://localhost:8642", { code: "ECONNREFUSED", errors: [
      { code: "ECONNREFUSED", syscall: "connect", address: "127.0.0.1", port: 8642 },
      { code: "ETIMEDOUT", syscall: "connect", address: "::1", port: 8642 },
    ] }],
  ])("keeps ambiguous or nonmatching transport errors generic at %s", async (apiBaseUrl, cause) => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw Object.assign(new Error("fetch failed"), { cause }); }));
    const result = await execute(makeCtx({ apiBaseUrl, apiKey: "secret-key" }));
    expect(result.errorCode).toBe("hermes_gateway_connect_failed");
    expect(result.errorMessage).not.toContain("refers to the Paperclip server");
    expect(result.errorMeta).toEqual({});
    expect(result.executionRecovery).toBeUndefined();
  });

  it("does not infer loopback refusal from an HTTP provider response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      code: "ECONNREFUSED", syscall: "connect", address: "127.0.0.1", port: 8642,
    }), { status: 503 })));
    const result = await execute(makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key" }));
    expect(result.errorCode).toBe("hermes_gateway_upstream_error");
    expect(result.errorMeta?.category).toBeUndefined();
    expect(result.errorMessage).not.toContain("refers to the Paperclip server");
    expect(result.executionRecovery).toBeUndefined();
  });

  it("redacts echoed auth material from HTTP error payloads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            message: "Authorization rejected: Bearer secret-key raw secret-key",
            detail: "X-Hermes-Session-Key: paperclip:company:company-1:agent:agent-1:issue:issue-1",
            nested: {
              note: "session paperclip:company:company-1:agent:agent-1",
            },
          }),
          { status: 401 },
        )),
    );

    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
    }));

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_auth_failed");
    expect(result.errorMeta?.body).toEqual({
      message: "Authorization rejected: Bearer [redacted] raw [redacted len=10]",
      detail: "X-Hermes-Session-Key: [redacted]",
      nested: {
        note: "session [redacted-session-key]",
      },
    });
    expect(result.errorMessage).not.toContain("secret-key");
    expect(result.errorMessage).not.toContain("paperclip:company:company-1:agent:agent-1:issue:issue-1");
  });

  it("calls stop on timeout", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-slow", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Promise<Response>(() => {});
      }
      if (url.endsWith("/stop")) {
        return new Response(JSON.stringify({ status: "stopping" }), { status: 200 });
      }
      if (init?.method === "GET") {
        return new Response(JSON.stringify({ status: "cancelled", last_event: "run.cancelled" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "running" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 0.001,
    }));

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("hermes_gateway_timeout");
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/stop"))).toBe(true);
  });
});

describe("gateway connection failure reporting", () => {
  const config = { apiBaseUrl: "https://gateway.example.test", apiKey: "gateway-private-key" };
  const marker = (operation: string, reason: string) => ({
    schemaVersion: 1, provider: "hermes_gateway", operation, reason,
  });

  it.each([
    [{}, "api_base_url_missing", "endpoint_missing"],
    [{ apiBaseUrl: "not a URL" }, "api_base_url_invalid", "endpoint_invalid"],
    [{ apiBaseUrl: "ftp://gateway.example.test" }, "api_base_url_invalid", "endpoint_invalid"],
    [{ apiBaseUrl: "http://gateway.example.test" }, "plain_http_remote_denied", "insecure_transport"],
    [{ apiBaseUrl: config.apiBaseUrl }, "api_key_missing", "credentials_missing"],
  ])("classifies configuration failure %s without dispatch", async (settings, code, reason) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx(settings);
    ctx.onDispatch = vi.fn();
    const result = await execute(ctx);
    expect(result).toMatchObject({ exitCode: 1, signal: null, timedOut: false,
      errorCode: `hermes_gateway_${code}`, resultJson: { connectionFailure: marker("configuration", reason) } });
    expect(result.errorMessage).toBeTruthy();
    expect(ctx.onDispatch).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, "auth_failed", "authentication_failed", null],
    [403, "auth_failed", "authentication_failed", null],
    [404, "runs_unsupported", "endpoint_not_found", null],
    [429, "rate_limited", "rate_limited", "transient_upstream"],
    [500, "upstream_error", "remote_unavailable", "transient_upstream"],
    [503, "upstream_error", "remote_unavailable", "transient_upstream"],
    [599, "upstream_error", "remote_unavailable", "transient_upstream"],
  ])("classifies HTTP %i without changing retry or dispatch behavior", async (status, code, reason, errorFamily) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ detail: "remote failure" }), {
      status, headers: { "retry-after": "7" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx(config);
    ctx.onDispatch = vi.fn();
    const result = await execute(ctx);
    expect(result).toMatchObject({ exitCode: 1, signal: null, timedOut: false,
      errorCode: `hermes_gateway_${code}`, errorFamily, retryNotBefore: "7",
      errorMeta: { status, body: { detail: "remote failure" } },
      resultJson: { connectionFailure: marker("create_run", reason) } });
    expect(result.errorMessage).toContain(`Hermes gateway HTTP ${status}`);
    expect(result.executionRecovery).toBeUndefined();
    expect(ctx.onDispatch).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(Object.keys(result.resultJson ?? {})).toEqual(["connectionFailure"]);
  });

  it.each([
    ["ECONNREFUSED", "connection_refused"], ["ENOTFOUND", "dns_failure"], ["EAI_AGAIN", "dns_failure"],
    ["EHOSTUNREACH", "network_unreachable"], ["ENETUNREACH", "network_unreachable"],
    ["ECONNRESET", "connection_reset"], ["EPIPE", "connection_reset"], ["UND_ERR_SOCKET", "connection_reset"],
    ["ETIMEDOUT", "connection_timeout"], ["UND_ERR_CONNECT_TIMEOUT", "connection_timeout"],
    ["UND_ERR_HEADERS_TIMEOUT", "connection_timeout"], ["UND_ERR_BODY_TIMEOUT", "connection_timeout"],
    ["CERT_HAS_EXPIRED", "tls_failure"], ["CERT_NOT_YET_VALID", "tls_failure"],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "tls_failure"], ["SELF_SIGNED_CERT_IN_CHAIN", "tls_failure"],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "tls_failure"], ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "tls_failure"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "tls_failure"],
  ])("classifies structured fetch cause %s", async (code, reason) => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("external transport failed"), { code }) });
    }));
    const result = await execute(makeCtx(config));
    expect(result).toMatchObject({ exitCode: 1, signal: null, timedOut: false,
      errorCode: "hermes_gateway_connect_failed", errorFamily: "transient_upstream", retryNotBefore: null,
      resultJson: { connectionFailure: marker("create_run", reason) } });
    expect(result.errorMessage).toContain(code);
    expect(result.executionRecovery).toBeUndefined();
  });

  it("classifies a network failure reading the create response without rewriting its error", async () => {
    const response = new Response("unread");
    vi.spyOn(response, "text").mockRejectedValue(new TypeError("terminated", { cause: { code: "UND_ERR_SOCKET" } }));
    vi.stubGlobal("fetch", vi.fn(async () => response));
    const result = await execute(makeCtx(config));
    expect(result).toMatchObject({ exitCode: 1, signal: null, timedOut: false,
      errorCode: "hermes_gateway_protocol_error", errorFamily: null, errorMessage: "terminated",
      resultJson: { connectionFailure: marker("create_run", "connection_reset") } });
    expect(result.executionRecovery).toBeUndefined();
  });

  it("requires every aggregate member to prove the same external failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed", { cause: {
      code: "ECONNREFUSED", errors: [{ code: "ECONNREFUSED" }, { code: "ECONNREFUSED" }],
    } }); }));
    const result = await execute(makeCtx(config));
    expect(result.resultJson).toEqual({ connectionFailure: marker("create_run", "connection_refused") });
  });

  it.each([
    undefined, { message: "ECONNREFUSED" }, { code: "ERR_INTERNAL_ASSERTION" }, { code: "toString" },
    { code: "ECONNREFUSED", errors: [] }, { code: "ECONNREFUSED", errors: "invalid" },
    { code: "ECONNREFUSED", errors: Array.from({ length: 9 }, () => ({ code: "ECONNREFUSED" })) },
    { code: "ECONNREFUSED", errors: [{ code: "ECONNREFUSED" }, { code: "ETIMEDOUT" }] },
    { code: "ECONNREFUSED", errors: [{ code: "ECONNREFUSED" }, new TypeError("internal bug")] },
    { code: "ERR_INTERNAL_ASSERTION", errors: [{ code: "ECONNREFUSED" }] },
    { code: "ECONNRESET", name: "AbortError" },
  ])("keeps unknown, mixed, or internal transport causes reportable: %j", async (cause) => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("ECONNREFUSED", { cause }); }));
    const result = await execute(makeCtx(config));
    expect(result.errorCode).toBe("hermes_gateway_connect_failed");
    expect(result.resultJson).toBeUndefined();
  });

  it("keeps abort failures reportable even if their cause looks like a transport error", async () => {
    const aborted = Object.assign(new Error("cancelled", { cause: { code: "ECONNRESET" } }), { name: "AbortError" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw aborted; }));
    const result = await execute(makeCtx(config));
    expect(result.resultJson).toBeUndefined();
    expect(result.errorCode).toBe("hermes_gateway_connect_failed");
  });

  it.each([400, 409, 422])("does not trust HTTP %i body claims about connection failures", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: "ECONNREFUSED", connectionFailure: marker("create_run", "connection_refused"),
    }), { status })));
    const result = await execute(makeCtx(config));
    expect(result.errorCode).toBe("hermes_gateway_protocol_error");
    expect(result.resultJson).toBeUndefined();
  });

  it.each(["not json", JSON.stringify({ status: "running", connectionFailure: marker("create_run", "connection_refused") })])(
    "keeps malformed successful create responses reportable", async (body) => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
      const result = await execute(makeCtx(config));
      expect(result.errorCode).toBe("hermes_gateway_protocol_error");
      expect(result.resultJson).toBeUndefined();
    },
  );

  it("does not classify a local response reader TypeError", async () => {
    const response = new Response("unread");
    vi.spyOn(response, "text").mockRejectedValue(new TypeError("cannot read property of undefined"));
    vi.stubGlobal("fetch", vi.fn(async () => response));
    const result = await execute(makeCtx(config));
    expect(result.errorCode).toBe("hermes_gateway_protocol_error");
    expect(result.resultJson).toBeUndefined();
  });

  it("does not trust a callback error with forged gateway codes or markers", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx(config);
    ctx.onDispatch = () => { throw Object.assign(new Error("callback bug"), {
      code: "hermes_gateway_auth_failed", status: 401, cause: { code: "ECONNREFUSED" },
      connectionFailure: marker("create_run", "authentication_failed"),
    }); };
    const result = await execute(ctx);
    expect(result.resultJson).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["completed", "failed", "cancelled"])("does not classify remote terminal %s from text or a forged marker", (status) => {
    const result = mapFinalResultForTest({
      terminal: { runId: "run-remote", status, payload: {
        error: "ECONNREFUSED", code: "ECONNREFUSED",
        connectionFailure: marker("create_run", "connection_refused"),
      } }, outputChunks: [], sessionKey: null, strategy: "none",
    });
    expect(result.resultJson?.connectionFailure).toBeUndefined();
    expect(result.errorCode).toBe(status === "completed" ? undefined : status === "failed" ? "hermes_gateway_run_failed" : "hermes_gateway_cancelled");
  });

  it("retains an ambiguous accepted-run timeout after stream, poll, and stop connection failures", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/v1/runs")) return new Response(JSON.stringify({ run_id: "run-accepted" }));
      throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx({ ...config, timeoutSec: 0.3, pollIntervalMs: 250, eventReconnectMs: 250 });
    const result = await execute(ctx);
    expect(result).toMatchObject({ timedOut: true, errorCode: "hermes_gateway_timeout" });
    expect(result.resultJson?.connectionFailure).toBeUndefined();
    expect(result.resultJson?.run_id).toBe("run-accepted");
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/stop"))).toBe(true);
    expect(ctx.onLog).toHaveBeenCalledWith("stderr", expect.stringContaining("status poll failed"));
  });
});

describe("testEnvironment", () => {
  it("fails remote plain HTTP before probing health", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://hermes.example:8642",
        apiKey: "secret-key",
      },
    });

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_plain_http_remote_denied",
          level: "error",
        }),
      ]),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows remote plain HTTP only with the unsafe dev escape hatch", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://hermes.example:8642",
        apiKey: "secret-key",
        dangerouslyAllowInsecureRemoteHttp: true,
      },
    });

    expect(result.status).toBe("warn");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_plain_http_remote_unsafe_allowed",
          level: "warn",
        }),
        expect.objectContaining({
          code: "hermes_gateway_health_ok",
        }),
      ]),
    );
    expect(fetchMock).toHaveBeenCalled();
  });

  it("fails test environment checks when Hermes health is unreachable", async () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND host.docker.internal"), { code: "ENOTFOUND" });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw Object.assign(new Error("fetch failed"), { cause });
    }));

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://host.docker.internal:8642",
        apiKey: "secret-key",
        dangerouslyAllowInsecureRemoteHttp: true,
      },
    });

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_health_unreachable",
          level: "error",
          detail: expect.stringContaining("ENOTFOUND"),
        }),
      ]),
    );
  });

  it("fails test environment checks when Hermes health returns a non-ok status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad key", { status: 401 })));

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://127.0.0.1:8642",
        apiKey: "wrong-key",
      },
    });

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_health_failed",
          level: "error",
          message: "Hermes Gateway health endpoint returned HTTP 401.",
        }),
      ]),
    );
  });

  it("tests a bare Hermes dashboard URL on port 9119 through the API prefix", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://127.0.0.1:9119",
        apiKey: "secret-key",
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_dashboard_root_mapped",
          level: "info",
          message: "Default Hermes dashboard root mapped to API base http://127.0.0.1:9119/api.",
          hint: expect.stringContaining("/api/v1/runs"),
        }),
      ]),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9119/api/health",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("tests a Hermes dashboard chat URL on port 9119 through the API prefix", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://127.0.0.1:9119/chat",
        apiKey: "secret-key",
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_dashboard_root_mapped",
          level: "info",
          message: "Default Hermes dashboard root mapped to API base http://127.0.0.1:9119/api.",
        }),
      ]),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9119/api/health",
      expect.objectContaining({ method: "GET" }),
    );
  });
});

describe("mapFinalResultForTest", () => {
  it("maps failed statuses into adapter errors", () => {
    const result = mapFinalResultForTest({
      terminal: {
        runId: "run-1",
        status: "failed",
        payload: { status: "failed", error: "boom" },
      },
      outputChunks: [],
      sessionKey: "session-key",
      strategy: "issue",
    });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_run_failed");
    expect(result.errorMessage).toBe("boom");
  });
});

// ---------------------------------------------------------------------------
// Human-in-the-loop approval bridge (hermes_gateway).
//
// Two HTTP surfaces are faked here: the Hermes gateway (run create, SSE,
// POST /v1/runs/{id}/approval) and the Paperclip control plane (the issue-thread
// interaction the human answers). Every case asserts the exact choice forwarded to
// Hermes, because the whole point of the bridge is that a human decides.
// ---------------------------------------------------------------------------

const APPROVAL_REQUEST_EVENT = [
  "event: approval.request",
  "data: " + JSON.stringify({
    request_id: "approval-1",
    command: "rm -rf /var/tmp/scratch",
    reason: "Deleting the scratch directory",
  }),
  "",
];

function approvalAnswer(interactionId: string, optionIds: string[]) {
  return {
    interactions: [{
      id: interactionId,
      idempotencyKey: hermesApprovalKey("pc-run-1", "approval-1"),
      kind: "ask_user_questions",
      status: "answered",
      result: { version: 1, answers: [{ questionId: "decision", optionIds }] },
    }],
  };
}

const PENDING_INTERACTION = { interactions: [{ id: "int-1", kind: "ask_user_questions", status: "pending" }] };

/**
 * Fetch fake for the approval bridge. `interactions` is what the Paperclip poll returns on
 * each read, so a test can hold a card open and then answer it.
 */
function stubApprovalFetch(options: {
  interactions?: () => unknown;
  approvalStatus?: number;
  events?: string[];
}) {
  const approvals: Array<Record<string, unknown>> = [];
  const createdInteractions: Array<Record<string, unknown>> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (method === "POST" && url.endsWith("/v1/runs")) {
      return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
    }
    if (method === "POST" && url.endsWith("/interactions")) {
      createdInteractions.push({ url, headers: { ...(init?.headers as Record<string, string>) }, body });
      return new Response(JSON.stringify({ interaction: { id: "int-1" } }), { status: 201 });
    }
    if (method === "GET" && url.includes("/interactions")) {
      return new Response(JSON.stringify(options.interactions ? options.interactions() : PENDING_INTERACTION), { status: 200 });
    }
    if (method === "POST" && url.endsWith("/approval")) {
      approvals.push({ url, headers: { ...(init?.headers as Record<string, string>) }, body });
      return new Response(JSON.stringify({}), { status: options.approvalStatus ?? 200 });
    }
    if (url.endsWith("/events")) {
      return new Response(sseStream((options.events ?? []).join("\n")), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response(JSON.stringify({ status: "running" }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, approvals, createdInteractions };
}

function makeApprovalCtx(config: Record<string, unknown>): AdapterExecutionContext {
  const ctx = makeCtx({
    apiBaseUrl: "http://127.0.0.1:8642",
    apiKey: "secret-key",
    timeoutSec: 60,
    paperclipApiUrl: "http://localhost:3100",
    ...config,
  });
  ctx.authToken = "local-agent-jwt";
  return ctx;
}

describe("hermes_gateway approval bridge", () => {
  it("posts the card and forwards the human approve choice to Hermes", async () => {
    let polls = 0;
    const stub = stubApprovalFetch({
      interactions: () => {
        polls += 1;
        return polls < 2 ? PENDING_INTERACTION : approvalAnswer("int-1", ["once"]);
      },
      events: [...APPROVAL_REQUEST_EVENT, "event: run.completed", 'data: {"status":"completed","output":"done"}', ""],
    });

    const result = await execute(makeApprovalCtx({ headlessApprovalPolicy: "bridge" }));

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("done");

    expect(stub.createdInteractions).toHaveLength(1);
    const card = stub.createdInteractions[0];
    expect(card.url).toBe("http://localhost:3100/api/issues/issue-1/interactions");
    expect(card.headers).toMatchObject({
      Authorization: "Bearer local-agent-jwt",
      "X-Paperclip-Run-Id": "pc-run-1",
    });
    const cardBody = card.body as Record<string, any>;
    expect(cardBody).toMatchObject({
      kind: "ask_user_questions",
      idempotencyKey: hermesApprovalKey("pc-run-1", "approval-1"),
      resolverPolicy: "human_only",
      continuationPolicy: "none",
    });
    // The request advertises no choice list, so only the always-valid choices appear.
    expect(cardBody.payload.questions[0].options.map((option: { id: string }) => option.id))
      .toEqual(["once", "deny"]);
    expect(cardBody.payload.questions[0].prompt).toContain("Deleting the scratch directory");

    expect(stub.approvals).toHaveLength(1);
    expect(stub.approvals[0]).toMatchObject({
      url: "http://127.0.0.1:8642/v1/runs/run-hermes-1/approval",
      body: { choice: "once", request_id: "approval-1" },
    });
  });

  it("offers and forwards the pattern choices a request advertises", async () => {
    const stub = stubApprovalFetch({
      interactions: () => approvalAnswer("int-1", ["session"]),
      events: [
        "event: approval.request",
        "data: " + JSON.stringify({
          request_id: "approval-1",
          command: "rm -rf /var/tmp/scratch",
          reason: "Deleting the scratch directory",
          allowed_choices: ["once", "session", "always", "deny"],
        }),
        "",
        "event: run.completed",
        'data: {"status":"completed","output":"done"}',
        "",
      ],
    });

    const result = await execute(makeApprovalCtx({ headlessApprovalPolicy: "bridge" }));

    expect(result.exitCode).toBe(0);
    const cardBody = stub.createdInteractions[0].body as Record<string, any>;
    expect(cardBody.payload.questions[0].options.map((option: { id: string }) => option.id))
      .toEqual(["once", "session", "always", "deny"]);
    expect(stub.approvals[0]).toMatchObject({
      body: { choice: "session", request_id: "approval-1" },
    });
  });

  it("forwards a human deny and fails the run without a connection failure", async () => {
    const stub = stubApprovalFetch({
      interactions: () => approvalAnswer("int-1", ["deny"]),
      events: [...APPROVAL_REQUEST_EVENT, "event: run.completed", 'data: {"status":"completed","output":"done"}', ""],
    });

    const result = await execute(makeApprovalCtx({ headlessApprovalPolicy: "bridge" }));

    expect(stub.approvals).toHaveLength(1);
    expect(stub.approvals[0]).toMatchObject({ body: { choice: "deny", request_id: "approval-1" } });
    // Hermes ends the run itself once it is denied; the adapter reports that failure,
    // not a gateway outage.
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("done");
  });

  it("defaults to deny: no card is raised and Hermes is refused at once", async () => {
    const stub = stubApprovalFetch({ events: APPROVAL_REQUEST_EVENT });

    const result = await execute(makeApprovalCtx({}));

    expect(stub.createdInteractions).toHaveLength(0);
    expect(stub.approvals).toHaveLength(1);
    expect(stub.approvals[0]).toMatchObject({ body: { choice: "deny", request_id: "approval-1" } });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_approval_timeout");
  });

  it("fails closed when bridge is configured without a run access token", async () => {
    const stub = stubApprovalFetch({ events: APPROVAL_REQUEST_EVENT });
    const ctx = makeApprovalCtx({ headlessApprovalPolicy: "bridge" });
    delete ctx.authToken;

    const result = await execute(ctx);

    // Without the injected run JWT the card could never be authorized, so nothing is
    // posted and Hermes is refused rather than left waiting.
    expect(stub.createdInteractions).toHaveLength(0);
    expect(stub.approvals).toHaveLength(1);
    expect(stub.approvals[0]).toMatchObject({ body: { choice: "deny", request_id: "approval-1" } });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_approval_unconfigured");
  });

  it("treats a 409 approval answer as already resolved and keeps streaming", async () => {
    const stub = stubApprovalFetch({
      interactions: () => approvalAnswer("int-1", ["once"]),
      approvalStatus: 409,
      events: [...APPROVAL_REQUEST_EVENT, "event: run.completed", 'data: {"status":"completed","output":"done"}', ""],
    });

    const result = await execute(makeApprovalCtx({ headlessApprovalPolicy: "bridge" }));

    expect(stub.approvals).toHaveLength(1);
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("done");
  });

  it("refuses without waiting when the run has no approval budget left", async () => {
    let polls = 0;
    const stub = stubApprovalFetch({
      interactions: () => {
        polls += 1;
        return { interactions: [{ id: "int-1", idempotencyKey: hermesApprovalKey("pc-run-1", "approval-1"), status: "pending" }] };
      },
      events: APPROVAL_REQUEST_EVENT,
    });

    // A 3-second run cannot wait for a human, so the bridge denies on the spot.
    const started = Date.now();
    const result = await execute(makeApprovalCtx({ headlessApprovalPolicy: "bridge", timeoutSec: 3 }));

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(polls).toBe(1);
    expect(stub.createdInteractions).toHaveLength(1);
    expect(stub.approvals).toHaveLength(1);
    expect(stub.approvals[0]).toMatchObject({ body: { choice: "deny", request_id: "approval-1" } });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_approval_timeout");
  });

  it("recovers a pending approval from the run status when SSE never replayed it", async () => {
    const stub = stubApprovalFetch({ events: [] });
    let statusReads = 0;
    const baseFetch = stub.fetchMock;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/runs/run-hermes-1")) {
        statusReads += 1;
        return new Response(JSON.stringify({
          status: "awaiting_approval",
          pending_approval: { request_id: "approval-1", command: "rm -rf /var/tmp/scratch" },
        }), { status: 200 });
      }
      return baseFetch(input as never, init as never);
    }));

    const result = await execute(makeApprovalCtx({ pollIntervalMs: 250 }));

    expect(statusReads).toBeGreaterThan(0);
    expect(stub.approvals).toHaveLength(1);
    expect(stub.approvals[0]).toMatchObject({ body: { choice: "deny", request_id: "approval-1" } });
    expect(result.errorCode).toBe("hermes_gateway_approval_timeout");
  });

  it("never logs the Hermes API key while bridging", async () => {
    const stub = stubApprovalFetch({
      interactions: () => approvalAnswer("int-1", ["once"]),
      events: [...APPROVAL_REQUEST_EVENT, "event: run.completed", 'data: {"status":"completed","output":"done"}', ""],
    });
    const ctx = makeApprovalCtx({ headlessApprovalPolicy: "bridge" });
    const logged: string[] = [];
    ctx.onLog = vi.fn(async (stream: string, chunk: string) => {
      logged.push(chunk);
    });

    await execute(ctx);

    expect(logged.join("")).not.toContain("secret-key");
    expect(logged.join("")).toContain("hermes-gateway:approval");
    expect(stub.approvals).toHaveLength(1);
  });
});
