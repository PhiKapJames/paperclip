import { describe, expect, it, vi, afterEach } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { createPromptContextFixture } from "@paperclipai/adapter-utils/test-fixtures/prompt-context";
import {
  buildApprovalInteractionBody,
  createApprovalInteraction,
  execute,
  extractApprovalRequest,
  extractPendingApproval,
  hermesApprovalKey,
  postApproval,
  resolveHermesApprovalChoice,
  type HermesApprovalChoice,
  type HermesApprovalRequest,
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
      binding: { protocol: "legacy" },
      command: "DROP TABLE users",
      reason: "irreversible",
      allowed: ["once", "deny"],
    })
  })

  it("leaves command and reason null when Hermes omits them", () => {
    expect(extractApprovalRequest({ event: "approval.request", data: { request_id: "req-10" } }))
      .toEqual({ requestId: "req-10", binding: { protocol: "legacy" }, command: null, reason: null, allowed: ["once", "deny"] })
  })

  it("keeps only the choices the request advertises", () => {
    expect(extractApprovalRequest({
      event: "approval.request",
      data: { request_id: "req-11", allowed_choices: ["once", "session", "always", "deny"] },
    })?.allowed).toEqual(["once", "session", "always", "deny"])
  })

  // Session-authority wire format pinned to upstream Hermes
  // 7b55a7c2363610cb3622f87ed66dcea18720bde6 (session_pending_controls.py
  // `PendingControls.register`): kind "approval", prompt_id + int
  // execution_generation, canonical `choices`, `description` as the reason.
  it("parses a session-authority prompt with its execution generation", () => {
    expect(extractApprovalRequest({
      event: "approval.request",
      data: {
        kind: "approval",
        prompt_id: "prompt-1",
        execution_generation: 7,
        command: "rm -rf /var/tmp/scratch",
        description: "Deleting the scratch directory",
        choices: ["once", "session", "always", "deny"],
        timeout_s: 300,
      },
    })).toEqual({
      requestId: "prompt-1",
      binding: { protocol: "session_authority", executionGeneration: 7 },
      command: "rm -rf /var/tmp/scratch",
      reason: "Deleting the scratch directory",
      allowed: ["once", "session", "always", "deny"],
    })
  })

  it.each([
    ["absent", undefined],
    ["a string", "7"],
    ["not an integer", 7.5],
    ["negative", -1],
  ])("drops a session-authority prompt whose generation is %s", (_name, generation) => {
    // Replying without the exact generation answers `stale_generation` upstream,
    // so an unbound prompt must never reach the board.
    const data: Record<string, unknown> = { kind: "approval", prompt_id: "prompt-1" }
    if (generation !== undefined) data.execution_generation = generation
    expect(extractApprovalRequest({ event: "approval.request", data })).toBeNull()
  })

  it("treats a legacy request_id prompt as legacy even with a generation alongside", () => {
    // Upstream `_approval_request_event` (api_server.py) replies with only
    // {choice, request_id}; an accompanying generation is not part of the reply.
    expect(extractApprovalRequest({
      event: "approval.request",
      data: { request_id: "req-12", execution_generation: 3 },
    })?.binding).toEqual({ protocol: "legacy" })
  })

  it("never widens the canonical choices ladder with an alias", () => {
    const request = extractApprovalRequest({
      event: "approval.request",
      data: {
        request_id: "req-13",
        choices: ["once", "deny"],
        allowed_choices: ["once", "session", "always", "deny"],
      },
    })
    expect(request?.allowed).toEqual(["once", "deny"])
  })

  it("always keeps deny in the advertised ladder", () => {
    const request = extractApprovalRequest({
      event: "approval.request",
      data: { request_id: "req-14", choices: ["once", "session"] },
    })
    expect(request?.allowed).toEqual(["once", "session", "deny"])
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

  // `pending_controls` in the run_projection snapshot, pinned to upstream
  // Hermes 7b55a7c2363610cb3622f87ed66dcea18720bde6: the projection drops
  // controls whose generation differs from the row's execution_generation.
  it("recovers a session-authority prompt from pending_controls", () => {
    expect(extractPendingApproval({
      status: "waiting_for_approval",
      run_id: "run-1",
      execution_generation: 7,
      pending_controls: [
        { kind: "approval", prompt_id: "prompt-9", command: "rm -rf /var/tmp", description: "clear scratch", choices: ["once", "deny"] },
      ],
    })).toEqual({
      requestId: "prompt-9",
      binding: { protocol: "session_authority", executionGeneration: 7 },
      command: "rm -rf /var/tmp",
      reason: "clear scratch",
      allowed: ["once", "deny"],
    })
  })

  it("drops a pending control whose generation does not match the snapshot", () => {
    expect(extractPendingApproval({
      status: "waiting_for_approval",
      execution_generation: 8,
      pending_controls: [
        { kind: "approval", prompt_id: "prompt-9", execution_generation: 7, choices: ["once", "deny"] },
      ],
    })).toBeNull()
  })

  it("ignores pending controls that are not approvals", () => {
    expect(extractPendingApproval({
      status: "waiting_for_approval",
      execution_generation: 8,
      pending_controls: [
        { kind: "question", prompt_id: "prompt-1", choices: ["once", "deny"] },
      ],
    })).toBeNull()
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

// R1 (finding #2): the approval card must be a `request_checkbox_confirmation`
// with the exact qualified candidate mapping — human-only resolver, no agent
// continuation wakeup, exactly-one selection defaulted to deny.
describe("approval confirmation mapping", () => {
  const checkboxBody = (allowed?: HermesApprovalChoice[]) =>
    buildApprovalInteractionBody({
      key: "hermes-approval:run_7:req-1",
      requestId: "req-1",
      command: "apt-get install -y curl",
      reason: "needs a download tool",
      allowed,
    }) as Record<string, any>

  it("requests a checkbox confirmation with the qualified candidate policy", () => {
    const body = checkboxBody()
    expect(body.kind).toBe("request_checkbox_confirmation")
    expect(body.idempotencyKey).toBe("hermes-approval:run_7:req-1")
    expect(body.resolverPolicy).toBe("human_only")
    expect(body.continuationPolicy).toBe("none")
    expect(body.supersedeOnUserComment ?? body.payload.supersedeOnUserComment).toBe(false)
  })

  it("carries a min-one max-one selection defaulted to deny", () => {
    const { payload } = checkboxBody()
    expect(payload.version).toBe(1)
    expect(payload.minSelected).toBe(1)
    expect(payload.maxSelected).toBe(1)
    expect(payload.defaultSelectedOptionIds).toEqual(["deny"])
    expect(payload.acceptLabel).toBe("Submit decision")
    expect(payload.rejectLabel).toBe("Deny")
    expect(payload.supersedeOnUserComment).toBe(false)
    // A checkbox card has no question set; a stray `questions` array would be
    // stripped by the validator and hide the real problem.
    expect(payload.questions).toBeUndefined()
  })

  it("offers the advertised choices with deny last and bounded option fields", () => {
    const { payload } = checkboxBody(["once", "session", "always", "deny"])
    expect(payload.options.map((option: { id: string }) => option.id)).toEqual([
      "once",
      "session",
      "always",
      "deny",
    ])
    for (const option of payload.options) {
      expect(typeof option.label).toBe("string")
      expect(option.label.length).toBeGreaterThan(0)
      expect(option.label.length).toBeLessThanOrEqual(120)
      expect(typeof option.description).toBe("string")
      expect(option.description.length).toBeLessThanOrEqual(500)
    }
  })

  it("defaults the offered choices to once/deny", () => {
    const { payload } = checkboxBody()
    expect(payload.options.map((option: { id: string }) => option.id)).toEqual(["once", "deny"])
  })

  it("bounds the prompt to 1000 chars and puts the detail in detailsMarkdown", () => {
    const body = buildApprovalInteractionBody({
      key: "k",
      requestId: "req-1",
      command: "x".repeat(5000),
      reason: null,
    }) as Record<string, any>
    const { title, summary, payload } = body
    expect(title.length).toBeLessThanOrEqual(240)
    expect(summary.length).toBeLessThanOrEqual(1000)
    expect(typeof payload.prompt).toBe("string")
    expect(payload.prompt.length).toBeGreaterThan(0)
    expect(payload.prompt.length).toBeLessThanOrEqual(1000)
    expect(typeof payload.detailsMarkdown).toBe("string")
    expect(payload.detailsMarkdown.length).toBeLessThanOrEqual(20000)
    expect(payload.detailsMarkdown).toContain("Command:")
  })

  it("says what happened when Hermes gave no command", () => {
    const { payload } = buildApprovalInteractionBody({
      key: "k",
      requestId: "req-9",
      command: null,
      reason: null,
    }) as Record<string, any>
    expect(payload.detailsMarkdown).toContain("Hermes did not say what it wants to run.")
    expect(payload.detailsMarkdown).not.toContain("undefined")
  })

  const accepted = (selectedOptionIds: unknown) => ({
    status: "accepted",
    result: { version: 1, outcome: "accepted", selectedOptionIds },
  })
  const resolveCases: Array<[string, unknown, HermesApprovalChoice]> = [
    ["an accepted once", accepted(["once"]), "once"],
    ["an accepted session", accepted(["session"]), "session"],
    ["an accepted always", accepted(["always"]), "always"],
    ["an accepted deny", accepted(["deny"]), "deny"],
    ["an accepted card with no selection", accepted([]), "deny"],
    ["an accepted card with two selections", accepted(["once", "session"]), "deny"],
    ["an accepted card with an unknown id", accepted(["maybe"]), "deny"],
    ["an accepted card with a non-string id", accepted([1]), "deny"],
    ["an accepted card without selectedOptionIds", { status: "accepted", result: { version: 1, outcome: "accepted" } }, "deny"],
    [
      "an accepted card whose outcome is not accepted",
      { status: "accepted", result: { version: 1, outcome: "superseded_by_comment", selectedOptionIds: ["once"] } },
      "deny",
    ],
    ["a rejected confirmation", { status: "rejected", result: { version: 1, outcome: "rejected" } }, "deny"],
    ["a superseded confirmation", { status: "superseded_by_comment", result: null }, "deny"],
    ["a withdrawn confirmation", { status: "withdrawn", result: null }, "deny"],
    ["a closed-issue confirmation", { status: "issue_closed", result: null }, "deny"],
    ["a still-pending confirmation", { status: "pending", result: null }, "deny"],
    ["an accepted confirmation with no result", { status: "accepted", result: null }, "deny"],
  ]

  it.each(resolveCases)("maps %s fail-closed", (_name, interaction, expected) => {
    expect(resolveHermesApprovalChoice(interaction)).toBe(expected)
  })

  it("keeps mapping legacy ask_user_questions answers", () => {
    expect(
      resolveHermesApprovalChoice({
        status: "answered",
        result: { version: 1, answers: [{ questionId: "decision", optionIds: ["once"] }] },
      }),
    ).toBe("once")
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

  it("binds a session-authority key to its execution generation", () => {
    expect(hermesApprovalKey("pc-run-1", "prompt-9", 7)).toBe("hermes-approval:pc-run-1:prompt-9:g7")
  })

  it("gives every generation of the same prompt a distinct key", () => {
    // A prompt re-registered at a newer generation must get a fresh card,
    // otherwise the old answered interaction would be reused as consent.
    expect(hermesApprovalKey("pc-run-1", "prompt-9", 7)).not.toBe(hermesApprovalKey("pc-run-1", "prompt-9", 8))
    expect(hermesApprovalKey("pc-run-1", "prompt-9")).not.toBe(hermesApprovalKey("pc-run-1", "prompt-9", 7))
  })

  it("refuses an over-long key once the generation suffix is added", () => {
    const prefix = "hermes-approval:"
    const runId = "r".repeat(255 - prefix.length - 1 - 1)
    expect(hermesApprovalKey(runId, "a", 7)).toBeNull()
  })
})

describe("buildApprovalInteractionBody", () => {
  it("asks a min-one checkbox confirmation carrying only once/deny by default", () => {
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
        minSelected: number;
        maxSelected: number;
        defaultSelectedOptionIds: string[];
        options: Array<Record<string, any>>;
        detailsMarkdown: string;
      };
    };
    expect(body.kind).toBe("request_checkbox_confirmation");
    expect(body.idempotencyKey).toBe("hermes-approval:run_7:req-1");
    // Must be answered by a human, and answering must not wake a second agent run.
    expect(body.resolverPolicy).toBe("human_only");
    expect(body.continuationPolicy).toBe("none");
    expect(body.payload.supersedeOnUserComment).toBe(false);
    expect(body.payload.version).toBe(1);
    expect(body.payload.minSelected).toBe(1);
    expect(body.payload.maxSelected).toBe(1);
    expect(body.payload.defaultSelectedOptionIds).toEqual(["deny"]);
    expect(body.payload.options.map((o) => o.id)).toEqual(["once", "deny"]);
    expect(body.summary).toContain("apt-get install -y curl");
    expect(body.summary).toContain("needs a download tool");
    expect(body.payload.detailsMarkdown).toContain("apt-get install -y curl");
  });

  it("offers the pattern choices Hermes advertises on the request", () => {
    const body = buildApprovalInteractionBody({
      key: "hermes-approval:run_7:req-1",
      requestId: "req-1",
      command: "kubectl delete pod web-1",
      reason: null,
      allowed: ["once", "session", "always", "deny"],
    }) as { payload: { options: Array<Record<string, any>> } };
    const options = body.payload.options;
    expect(options.map((o) => o.id)).toEqual(["once", "session", "always", "deny"]);
    // Nothing may promise more than Hermes actually does.
    expect(options.find((o) => o.id === "session")?.label).toBe("Allow for this run");
    expect(options.find((o) => o.id === "session")?.description).toContain("this run");
    expect(options.find((o) => o.id === "always")?.description).toContain("Hermes stores");
  });

  it("keeps a long or control-character command inside the server's field limits", () => {
    // Limits from packages/shared request_checkbox_confirmation validators:
    // title 240, summary 1000, detailsMarkdown 20000. Control characters are
    // stripped before any length bound is applied.
    const body = buildApprovalInteractionBody({
      key: "hermes-approval:run_7:req-1",
      requestId: "req-1",
      command: `echo ${"a".repeat(900)}\u001b[2J`,
      reason: "r".repeat(500),
    }) as { title: string; summary: string; payload: { detailsMarkdown: string } };
    expect(body.title.length).toBeLessThanOrEqual(240);
    expect(body.summary.length).toBeLessThanOrEqual(1000);
    expect(body.payload.detailsMarkdown.length).toBeLessThanOrEqual(20000);
    expect(body.summary).not.toContain("\u001b");
    expect(body.payload.detailsMarkdown).not.toContain("\u001b");
    // The human still sees the whole command inside the fence.
    expect(body.payload.detailsMarkdown).toContain("a".repeat(900));
  });

  it("refuses the card instead of truncating an over-long command", () => {
    // A command the human cannot fully see must never be half-shown: the
    // builder refuses, and the bridge denies without creating a card.
    const body = buildApprovalInteractionBody({
      key: "hermes-approval:run_7:req-1",
      requestId: "req-1",
      command: `echo ${"a".repeat(20000)}`,
      reason: null,
    }) as Record<string, unknown>;
    expect(body.refused).toBe(true);
    expect(body.payload).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("a".repeat(100));
  });

  it("still asks something when Hermes sends no command or reason", () => {
    const body = buildApprovalInteractionBody({ key: "k", requestId: "req-1", command: null, reason: null }) as {
      summary: string;
      payload: { prompt: string; detailsMarkdown: string };
    };
    expect(body.summary).toContain("did not say");
    expect(body.payload.detailsMarkdown).toContain("did not say");
    expect(body.payload.prompt.length).toBeGreaterThan(0);
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
  const baseRequest = {
    requestId: "req-1",
    binding: { protocol: "legacy" } as const,
    command: null,
    reason: null,
    allowed: ["once", "deny"] as HermesApprovalChoice[],
  };
  const baseInput = {
    baseUrl: new URL("http://127.0.0.1:8642"),
    headers: {
      Authorization: "Bearer hermes-key",
    },
    runId: "run_7",
    key: "hermes-approval:run_7:req-1",
    request: baseRequest,
    signal: new AbortController().signal,
  };

  async function runWith(status: number, request: HermesApprovalRequest = baseRequest) {
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
        request,
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

  it("replies to a session-authority prompt with its exact execution generation", async () => {
    // Upstream 7b55a7c236 `respond_run` accepts exactly
    // {request_id, execution_generation, choice} for an authority prompt and
    // answers `stale_generation` for anything else.
    const { calls } = await runWith(200, {
      ...baseRequest,
      binding: { protocol: "session_authority", executionGeneration: 7 },
    });
    expect(JSON.parse(calls[0].init.body)).toEqual({
      choice: "once",
      request_id: "req-1",
      execution_generation: 7,
    });
  });

  it("never sends a generation for a legacy request_id prompt", async () => {
    const { calls } = await runWith(200, { ...baseRequest });
    expect(JSON.parse(calls[0].init.body)).not.toHaveProperty("execution_generation");
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

function approvalAnswer(interactionId: string, selectedOptionIds: string[]) {
  return {
    interactions: [{
      id: interactionId,
      idempotencyKey: hermesApprovalKey("pc-run-1", "approval-1"),
      kind: "request_checkbox_confirmation",
      status: "accepted",
      result: { version: 1, outcome: "accepted", selectedOptionIds },
    }],
  };
}

const PENDING_INTERACTION = {
  interactions: [{ id: "int-1", kind: "request_checkbox_confirmation", status: "pending" }],
};

/**
 * Fetch fake for the approval bridge. `interactions` is what the Paperclip poll returns on
 * each read, so a test can hold a card open and then answer it.
 */
function stubApprovalFetch(options: {
  interactions?: () => unknown;
  approvalStatus?: number;
  events?: string[];
  /** Index in `events` where the stream stalls until the adapter has answered the approval. */
  holdEventsUntilApproved?: number;
  /** HTTP status the fake Paperclip returns when the adapter tries to create the card. */
  createStatus?: number;
  /** Body of GET /v1/runs/{id}; a test can script re-discovery of a pending approval here. */
  status?: (observed: { approvals: number }) => unknown;
  /** How many approval POSTs release a held event stream (default 1). */
  holdUntilApprovedCount?: number;
  /** When true the POST to /approval never resolves; it rejects when its signal aborts. */
  holdApprovalPost?: boolean;
  /** Resolve the POST to /approval only after this many ms (rejects on abort). */
  holdPostMs?: number;
  /** Written instead of the remaining events once an approval has been observed. */
  resumption?: { eventsAfterApproval?: string[] };
  /** When true the resumption stream stalls again at its second approval event until two answers land. */
  holdSecondApproval?: boolean;
  /** Body of POST /v1/runs/{id}/stop; when set, later status reads report `stopped`. */
  stop?: () => unknown;
  /** When true, POST /v1/runs/{id}/stop answers 500 (the adapter must still settle). */
  stopStatus?: number;
}) {
  const approvals: Array<Record<string, unknown>> = [];
  const createdInteractions: Array<Record<string, unknown>> = [];
  const stops: Array<Record<string, unknown>> = [];
  const counts = { statusReads: 0, interactionReads: 0 };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (method === "POST" && url.endsWith("/v1/runs")) {
      return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
    }
    if (method === "POST" && url.endsWith("/interactions")) {
      createdInteractions.push({ url, headers: { ...(init?.headers as Record<string, string>) }, body });
      // A card that cannot be created must never be followed by an answer poll.
      if (options.createStatus !== undefined && options.createStatus >= 300) {
        return new Response(JSON.stringify({ error: "card refused" }), { status: options.createStatus });
      }
      return new Response(JSON.stringify({ interaction: { id: "int-1" } }), { status: 201 });
    }
    if (method === "GET" && url.includes("/interactions")) {
      counts.interactionReads += 1;
      return new Response(JSON.stringify(options.interactions ? options.interactions() : PENDING_INTERACTION), { status: 200 });
    }
    if (method === "POST" && url.endsWith("/approval")) {
      approvals.push({ url, headers: { ...(init?.headers as Record<string, string>) }, body });
      if (options.holdApprovalPost) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("approval post stalled")));
        });
      }
      if (options.holdPostMs !== undefined) {
        // Hold the answer for holdPostMs; aborting resolves it as refused,
        // which lets a test cancel exactly while the answer is in flight.
        return new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(new Response(JSON.stringify({}), { status: 200 })), options.holdPostMs);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("approval post stalled"));
          });
        });
      }
      return new Response(JSON.stringify({}), { status: options.approvalStatus ?? 200 });
    }
    if (method === "POST" && url.endsWith("/stop")) {
      stops.push({ url });
      if (options.stopStatus !== undefined && options.stopStatus >= 300) {
        return new Response(JSON.stringify({ error: "stop refused" }), { status: options.stopStatus });
      }
      return new Response(JSON.stringify(options.stop ? options.stop() : { run_id: "run-hermes-1", status: "stopping" }), { status: 200 });
    }
    if (url.endsWith("/events")) {
      const events = options.events ?? [];
      const hold = options.holdEventsUntilApproved;
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder();
          const write = (lines: string[]) => {
            for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`));
          };
          write(hold === undefined ? events : events.slice(0, hold));
          if (hold !== undefined) {
            // Hermes really does block the run while an approval is pending: nothing more is
            // streamed until the adapter answers, so observation must stay live meanwhile.
            const waitFor = async (needed: number) => {
              const until = Date.now() + 5_000;
              while (approvals.length < needed && Date.now() < until) {
                await new Promise((resolve) => setTimeout(resolve, 5));
              }
              return approvals.length >= needed;
            };
            const res = options.resumption?.eventsAfterApproval;
            if (!(await waitFor(options.holdUntilApprovedCount ?? 1))) {
              // The answer never arrived in the fake's window; release like a dropped stream.
              write(events.slice(hold));
            } else if (options.holdSecondApproval && res) {
              // Model the stream stalling again at the second approval request: everything up
              // to the terminal event is written, then the stream waits for that answer.
              const split = res.findIndex((line) => line.startsWith("event: run.completed")
                || line.startsWith("event: run.failed")
                || line.startsWith("event: run.cancelled"));
              if (split === -1) write(res);
              else {
                write(res.slice(0, split));
                if (await waitFor(2)) write(res.slice(split));
              }
            } else {
              write(res || events.slice(hold));
            }
          }
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    counts.statusReads += 1;
    // Once /stop was accepted, status reads report the stopped run so the
    // adapter's bounded terminal observation completes (mirrors Hermes).
    if (stops.length > 0 && options.stopStatus === undefined) {
      return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "cancelled" }), { status: 200 });
    }
    return new Response(JSON.stringify(options.status ? options.status({ approvals: approvals.length }) : { status: "running" }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    approvals,
    createdInteractions,
    stops,
    get statusReads() {
      return counts.statusReads;
    },
    get interactionReads() {
      return counts.interactionReads;
    },
  };
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
      // Hermes blocks the run while an approval is pending, so the terminal event can only
      // arrive after the answer.
      holdEventsUntilApproved: 3,
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
      kind: "request_checkbox_confirmation",
      idempotencyKey: hermesApprovalKey("pc-run-1", "approval-1"),
      resolverPolicy: "human_only",
      continuationPolicy: "none",
    });
    // The request advertises no choice list, so only the always-valid choices appear.
    expect(cardBody.payload.options.map((option: { id: string }) => option.id))
      .toEqual(["once", "deny"]);
    expect(cardBody.payload.detailsMarkdown).toContain("Deleting the scratch directory");

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
      // Hermes blocks while an approval is pending: the terminal event follows the answer.
      holdEventsUntilApproved: 3,
    });

    const result = await execute(makeApprovalCtx({ headlessApprovalPolicy: "bridge" }));

    expect(result.exitCode).toBe(0);
    const cardBody = stub.createdInteractions[0].body as Record<string, any>;
    expect(cardBody.payload.options.map((option: { id: string }) => option.id))
      .toEqual(["once", "session", "always", "deny"]);
    expect(stub.approvals[0]).toMatchObject({
      body: { choice: "session", request_id: "approval-1" },
    });
  });

  it("forwards a human deny and fails the run without a connection failure", async () => {
    const stub = stubApprovalFetch({
      interactions: () => approvalAnswer("int-1", ["deny"]),
      events: [...APPROVAL_REQUEST_EVENT, "event: run.completed", 'data: {"status":"completed","output":"done"}', ""],
      holdEventsUntilApproved: 3,
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

    // R4: with no budget left there is no card and not even a first read.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(polls).toBe(0);
    expect(stub.createdInteractions).toHaveLength(0);
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
      const isStop = (init?.method ?? "GET").toUpperCase() === "POST" && url.endsWith("/stop");
      // Status reads keep reporting the pending approval (so the recovery path
      // stays exercised); /stop and its observation go to the base fake, which
      // reports the run cancelled after a stop — like Hermes.
      if (url.endsWith("/v1/runs/run-hermes-1") && !isStop) {
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

describe("hermes_gateway approval lifecycle", () => {
  const approvalError = (result: { errorCode?: string | null }, code: string) => result.errorCode === code;

  /** An approval ctx with every onLog line captured, for tests that assert what the run reported. */
  function loggedApprovalCtx(config: Record<string, unknown>) {
    const logs: string[] = [];
    const ctx = makeApprovalCtx(config);
    const inner = ctx.onLog;
    ctx.onLog = (stream: "stdout" | "stderr", chunk: string) => {
      logs.push(chunk);
      return inner(stream, chunk);
    };
    return { ctx, logs };
  }

  it("keeps reading run status while a card waits, and reports no failure when the run completes", async () => {
    let polls = 0;
    const stub = stubApprovalFetch({
      interactions: () => {
        polls += 1;
        return polls < 3 ? PENDING_INTERACTION : approvalAnswer("int-1", ["once"]);
      },
      events: [...APPROVAL_REQUEST_EVENT, "event: run.completed", 'data: {"status":"completed","output":"done"}', ""],
      holdEventsUntilApproved: 3,
    });
    const { ctx, logs } = loggedApprovalCtx({ headlessApprovalPolicy: "bridge", pollIntervalMs: 250 });

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("done");
    expect(result.errorMessage).toBeUndefined();
    // The bridge never blocks observation: the run view keeps being polled while the
    // human decides, so a terminal event arriving later is still acted on.
    expect(stub.statusReads).toBeGreaterThanOrEqual(2);
    expect(stub.interactionReads).toBeGreaterThanOrEqual(3);
    expect(logs.some((line) => line.includes("waiting for a human decision"))).toBe(true);
  });

  it("terminates the run when the stream completes while a card is still pending, after denying the command", { timeout: 20_000 }, async () => {
    const stub = stubApprovalFetch({
      interactions: () => PENDING_INTERACTION,
      events: [...APPROVAL_REQUEST_EVENT, "event: run.completed", 'data: {"status":"completed","output":"done"}', ""],
      holdEventsUntilApproved: 3,
    });
    const { ctx, logs } = loggedApprovalCtx({ headlessApprovalPolicy: "bridge" });

    const result = await execute(ctx);

    // The gateway says the run is finished; Paperclip must not wait for the card.
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("done");
    // Denying an unanswered request is still attempted before this run settles.
    expect(stub.approvals).toHaveLength(1);
    expect(stub.approvals[0].body).toMatchObject({ choice: "deny", request_id: "approval-1" });
    expect(logs.some((line) => line.includes("unanswered approval denied"))).toBe(true);
  });

  it("fails the run with bridge_failed rather than a connection failure when no card can be created", async () => {
    const stub = stubApprovalFetch({
      createStatus: 403,
      events: [...APPROVAL_REQUEST_EVENT],
      holdEventsUntilApproved: 3,
    });

    const result = await execute(makeApprovalCtx({ headlessApprovalPolicy: "bridge" }));

    // A rejected card is an approval failure, not a gateway connection failure.
    expect(approvalError(result, "hermes_gateway_approval_bridge_failed")).toBe(true);
    expect((result.resultJson as Record<string, any> | undefined)?.connectionFailure).toBeUndefined();
    // Hermes is refused, and Paperclip is never polled for an answer that cannot arrive.
    expect(stub.approvals).toHaveLength(1);
    expect(stub.approvals[0].body).toMatchObject({ choice: "deny" });
    expect(stub.interactionReads).toBe(0);
  });

  it("fails the run with bridge_failed when Hermes refuses the approval answer", async () => {
    const stub = stubApprovalFetch({
      approvalStatus: 500,
      interactions: () => approvalAnswer("int-1", ["once"]),
      events: [...APPROVAL_REQUEST_EVENT],
      holdEventsUntilApproved: 3,
    });

    const result = await execute(makeApprovalCtx({ headlessApprovalPolicy: "bridge" }));

    // The human answered, but Hermes never accepted the answer.
    expect(approvalError(result, "hermes_gateway_approval_bridge_failed")).toBe(true);
    expect(stub.createdInteractions).toHaveLength(1);
    // The human answer was attempted, then the run fails closed with a deny.
    expect(stub.approvals.map((entry) => (entry.body as Record<string, any>).choice)).toEqual(["once", "deny"]);
  });

  it("refuses a second approval request when the bridge is already busy", async () => {
    const second = 'event: approval.request\ndata: {"request_id":"approval-2","command":"rm -rf /srv/other","sandbox":"docker","reason":"second request"}\n';
    const stub = stubApprovalFetch({
      interactions: () => PENDING_INTERACTION,
      events: [
        ...APPROVAL_REQUEST_EVENT,
        second,
        "event: run.completed",
        'data: {"status":"completed","output":"done"}',
        "",
      ],
      holdEventsUntilApproved: 4,
    });

    const result = await execute(makeApprovalCtx({ headlessApprovalPolicy: "bridge" }));

    // Only the first request can be bridged; the second is refused instead of queued.
    expect(stub.createdInteractions).toHaveLength(1);
    const denials = stub.approvals.filter((entry) => (entry.body as Record<string, any>).choice === "deny");
    // The refused request is denied immediately; the still-unanswered first one is
    // denied too as the run settles.
    expect(denials.map((entry) => (entry.body as Record<string, any>).request_id)).toContain("approval-2");
    expect(result.exitCode).not.toBe(0);
    expect(approvalError(result, "hermes_gateway_approval_bridge_failed")).toBe(true);
  });

  it("never raises a second card or sends a second approval when the stream is re-read", async () => {
    let polls = 0;
    const stub = stubApprovalFetch({
      interactions: () => {
        polls += 1;
        return polls < 3 ? PENDING_INTERACTION : approvalAnswer("int-1", ["once"]);
      },
      // The run status keeps publishing the pending approval, so status polling
      // re-discovers the same request over and over during the human wait.
      status: ({ approvals }) =>
        approvals === 0
          ? {
              status: "running",
              pending_approval: {
                request_id: "approval-1",
                command: "rm -rf /srv/app/cache",
                sandbox: "docker",
                reason: "still waiting",
              },
            }
          : { status: "running" },
      events: [...APPROVAL_REQUEST_EVENT, "event: run.completed", 'data: {"status":"completed","output":"done"}', ""],
      holdEventsUntilApproved: 3,
    });

    const result = await execute(makeApprovalCtx({ headlessApprovalPolicy: "bridge", pollIntervalMs: 250 }));

    expect(result.exitCode).toBe(0);
    // Run status re-discovered the same request repeatedly, yet only one card and
    // one forwarded answer exist because the request is identified by its binding.
    expect(stub.statusReads).toBeGreaterThanOrEqual(3);
    expect(stub.createdInteractions).toHaveLength(1);
    expect(stub.approvals).toHaveLength(1);
  });

  it("bridges a second approval request after the first one is answered", { timeout: 20_000 }, async () => {
    const second = 'event: approval.request\ndata: {"request_id":"approval-2","command":"rm -rf /srv/other","sandbox":"docker","reason":"second request"}\n';
    const stub = stubApprovalFetch({
      interactions: () => approvalAnswer("int-1", ["once"]),
      events: [...APPROVAL_REQUEST_EVENT],
      holdEventsUntilApproved: 3,
      // Hermes blocks again while the second approval is pending, so the
      // terminal event only arrives after both answers.
      holdSecondApproval: true,
      // Hermes only resumes the stream once the first approval is answered; the
      // second request appears after that point.
      resumption: {
        eventsAfterApproval: [
          "event: run.output",
          'data: {"text":"first approved"}',
          "",
          second,
          "event: run.completed",
          'data: {"status":"completed","output":"done"}',
          "",
        ],
      },
    });

    const result = await execute(makeApprovalCtx({ headlessApprovalPolicy: "bridge" }));

    expect(result.exitCode).toBe(0);
    expect(stub.createdInteractions).toHaveLength(2);
    const forwarded = stub.approvals.map((entry) => entry.body as Record<string, any>);
    expect(forwarded).toEqual([
      expect.objectContaining({ choice: "once", request_id: "approval-1" }),
      expect.objectContaining({ choice: "once", request_id: "approval-2" }),
    ]);
  });

  it("uses the new session generation as the approval identity after a resume", { timeout: 20_000 }, async () => {
    const stub = stubApprovalFetch({
      interactions: () => approvalAnswer("int-1", ["once"]),
      // Once the first approval is answered, the run status publishes the same
      // session-authority prompt at a new execution generation: that is a new
      // approval, not a replay of the answered one.
      status: ({ approvals }) =>
        approvals >= 2
          ? { status: "completed", output: "done" }
          : approvals === 1
          ? {
              status: "running",
              execution_generation: 2,
              pending_controls: [
                {
                  kind: "approval",
                  prompt_id: "approval-1",
                  execution_generation: 2,
                  command: "rm -rf /srv/app/cache",
                  sandbox: "docker",
                  reason: "out-of-band approval",
                },
              ],
            }
          : { status: "running" },
      events: [...APPROVAL_REQUEST_EVENT],
      holdEventsUntilApproved: 3,
      holdUntilApprovedCount: 2,
    });

    const result = await execute(makeApprovalCtx({ headlessApprovalPolicy: "bridge", pollIntervalMs: 250 }));

    expect(result.exitCode).toBe(0);
    // A new execution generation is a new approval, so it gets its own card rather
    // than being merged into the already answered request.
    expect(stub.createdInteractions.length).toBeGreaterThanOrEqual(2);
    const keys = stub.createdInteractions.map((entry) => (entry.body as Record<string, any>).idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(String(keys[1])).toContain(":g2");
  });

  it("reports an honest failure when approval cleanup cannot settle within its window", { timeout: 40_000 }, async () => {
    // The approval deadline expires with no human answer, and even the required
    // denial stalls until its own bounded cleanup window fires.
    stubApprovalFetch({
      interactions: () => PENDING_INTERACTION,
      holdApprovalPost: true,
      events: [...APPROVAL_REQUEST_EVENT],
    });

    // approvalTimeoutSec clamps to a minimum of 15s; the stalled denial gets the
    // 10s cleanup window. The run must settle on those, not the whole-run timeout.
    const result = await execute(
      makeApprovalCtx({ headlessApprovalPolicy: "bridge", approvalTimeoutSec: 15, timeoutSec: 30 }),
    );

    // An unanswered approval is reported as an approval failure, never a connection failure.
    expect(approvalError(result, "hermes_gateway_approval_timeout")).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it("reports the expired approval as an unanswered timeout rather than a human decision", async () => {
    const stub = stubApprovalFetch({
      interactions: () => ({
        interaction: { id: "int-1", status: "pending" },
        interactions: [{ id: "int-1", kind: "request_checkbox_confirmation", status: "expired", payload: {} }],
      }),
      events: [...APPROVAL_REQUEST_EVENT],
      holdEventsUntilApproved: 3,
    });

    const result = await execute(makeApprovalCtx({ headlessApprovalPolicy: "bridge" }));

    // Nobody answered, so this is the same outcome as never answering.
    expect(approvalError(result, "hermes_gateway_approval_timeout")).toBe(true);
    expect(stub.approvals).toHaveLength(1);
    expect(stub.approvals[0].body).toMatchObject({ choice: "deny" });
  });

  it("reports a card rejected for a duplicate key as an approval failure, not a connection failure", async () => {
    const stub = stubApprovalFetch({
      createStatus: 409,
      events: [...APPROVAL_REQUEST_EVENT],
      holdEventsUntilApproved: 3,
    });

    const result = await execute(makeApprovalCtx({ headlessApprovalPolicy: "bridge" }));

    expect(approvalError(result, "hermes_gateway_approval_bridge_failed")).toBe(true);
    expect(stub.approvals).toHaveLength(1);
    expect(stub.createdInteractions).toHaveLength(1);
  });

  it("keeps the human's own answer when the card is already resolved", async () => {
    const stub = stubApprovalFetch({
      interactions: () => ({
        interactions: [
          {
            id: "int-1",
            idempotencyKey: hermesApprovalKey("pc-run-1", "approval-1"),
            kind: "request_checkbox_confirmation",
            status: "accepted",
            result: { version: 1, outcome: "accepted", selectedOptionIds: ["once"] },
          },
        ],
      }),
      events: [...APPROVAL_REQUEST_EVENT, "event: run.completed", 'data: {"status":"completed","output":"done"}', ""],
      holdEventsUntilApproved: 3,
    });

    const result = await execute(makeApprovalCtx({ headlessApprovalPolicy: "bridge" }));

    expect(result.exitCode).toBe(0);
    expect(stub.approvals).toHaveLength(1);
    expect(stub.approvals[0].body).toMatchObject({ choice: "once", request_id: "approval-1" });
  });

  it("never reports an approval problem as a gateway connection failure", { timeout: 30_000 }, async () => {
    // A real approval request, but this run has no Paperclip access token to raise a card with.
    stubApprovalFetch({ events: [...APPROVAL_REQUEST_EVENT] });
    const noTokenCtx = { ...makeApprovalCtx({ headlessApprovalPolicy: "bridge" }) };
    delete (noTokenCtx as any).authToken;
    const noTokenRun = await execute(noTokenCtx);
    expect(approvalError(noTokenRun, "hermes_gateway_approval_unconfigured")).toBe(true);
    expect(noTokenRun.exitCode).not.toBe(0);

    // An approval event with no request id cannot be answered by a human.
    const stub = stubApprovalFetch({
      events: [
        "event: approval.request",
        'data: {"command":"rm -rf /srv/app/cache","reason":"missing id"}',
        "",
      ],
    });
    const unparseable = await execute(makeApprovalCtx({ headlessApprovalPolicy: "bridge" }));
    expect(approvalError(unparseable, "hermes_gateway_approval_unparseable")).toBe(true);
    expect(stub.createdInteractions).toHaveLength(0);

    // A gateway credential problem is still reported as a configuration failure.
    const missingKey = await execute(makeApprovalCtx({ headlessApprovalPolicy: "bridge", apiKey: undefined as any }));
    expect(missingKey.errorMessage).toContain("apiKey");
  });

});
describe("hermes_gateway approval error message", () => {
  // R6 (finding #9): the final result preserves the concrete terminal approval
  // explanation through the shared redaction path instead of replacing it with
  // a generic "Hermes run failed".

  it("explains that no Paperclip access token exists to raise a card with", async () => {
    stubApprovalFetch({ events: [...APPROVAL_REQUEST_EVENT] });
    const ctx = { ...makeApprovalCtx({ headlessApprovalPolicy: "bridge" }) };
    delete (ctx as any).authToken;

    const result = await execute(ctx);

    expect(result.errorCode).toBe("hermes_gateway_approval_unconfigured");
    expect(result.errorMessage).toContain("Paperclip API URL, a run access token");
  });

  it("explains that Paperclip rejected the approval card, with the HTTP status", async () => {
    stubApprovalFetch({ createStatus: 403, events: [...APPROVAL_REQUEST_EVENT], holdEventsUntilApproved: 3 });

    const result = await execute(makeApprovalCtx({ headlessApprovalPolicy: "bridge" }));

    expect(result.errorCode).toBe("hermes_gateway_approval_bridge_failed");
    expect(result.errorMessage).toContain("Paperclip rejected the approval request (HTTP 403)");
  });

  it("explains that no human decision arrived when the approval wait ends unanswered", { timeout: 40_000 }, async () => {
    stubApprovalFetch({ interactions: () => PENDING_INTERACTION, events: [...APPROVAL_REQUEST_EVENT] });

    const result = await execute(makeApprovalCtx({ headlessApprovalPolicy: "bridge", approvalTimeoutSec: 15 }));

    expect(result.errorCode).toBe("hermes_gateway_approval_timeout");
    expect(result.errorMessage).toContain("no human decision was received");
  });
});

describe("hermes_gateway approval deadline", () => {
  // R4 (§11): one absolute approval deadline covers every awaited call — the
  // card POST, every status read, the JSON body, and the answer POST — so a
  // stalled HTTP call can never hold the run past its own budget. A reply
  // that arrives after the deadline is never forwarded to Hermes.

  const stalled = (signal: AbortSignal | undefined, ms: number): Promise<Response> =>
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error("watchdog: never aborted")), ms);
      signal?.addEventListener("abort", () => reject(new Error("aborted-by-deadline")));
    });

  const pendingResponse = () => ({
    status: 200,
    ok: true,
    json: async () => ({ interactions: [{ id: "int-1", kind: "request_checkbox_confirmation", status: "pending" }] }),
  }) as unknown as Response;

  const deadlineFetch = (behaviour: {
    create?: (signal: AbortSignal | undefined) => Promise<Response>;
    read?: (signal: AbortSignal | undefined) => Promise<Response>;
  }) => {
    const base = stubApprovalFetch({ events: APPROVAL_REQUEST_EVENT });
    const calls = { base, creates: 0, reads: 0, approvals: [] as Array<Record<string, unknown>> };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const signal = init?.signal ?? undefined;
      if (url.endsWith("/approval")) {
        calls.approvals.push(JSON.parse(String(init?.body)));
        return { status: 200, ok: true, json: async () => ({ ok: true }) } as Response;
      }
      if (url.includes("/interactions") && (init?.method ?? "GET") === "POST") {
        calls.creates += 1;
        if (behaviour.create) return behaviour.create(signal);
        return { status: 201, ok: true, json: async () => ({ interaction: { id: "int-1" } }) } as Response;
      }
      if (url.includes("/interactions")) {
        calls.reads += 1;
        if (behaviour.read) return behaviour.read(signal);
        return pendingResponse();
      }
      return base.fetchMock(input as never, init as never);
    }));
    return calls;
  };

  it("stops waiting as soon as the operator cancels, and still denies the Hermes command", async () => {
    const calls = deadlineFetch({ create: (signal) => stalled(signal, 8_000) });
    const ctx = makeApprovalCtx({ headlessApprovalPolicy: "bridge" });
    const controller = new AbortController();
    ctx.signal = controller.signal;
    setTimeout(() => controller.abort(), 150);

    const started = Date.now();
    const result = await execute(ctx);

    // The stalled card POST must not hold the run for its full 8s stall.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(calls.approvals).toHaveLength(1);
    expect(calls.approvals[0]).toMatchObject({ choice: "deny", request_id: "approval-1" });
    expect(result.exitCode).toBe(1);
  });

  it("aborts a stalled approval read at the run deadline instead of hanging", async () => {
    // The run itself only has 4s, so the approval deadline is already gone;
    // a hanging GET must be cut off there rather than at the 9s watchdog.
    const calls = deadlineFetch({ read: (signal) => stalled(signal, 9_000) });
    const started = Date.now();
    const result = await execute(makeApprovalCtx({ headlessApprovalPolicy: "bridge", timeoutSec: 12 }));

    expect(Date.now() - started).toBeLessThan(6_000);
    expect(calls.reads).toBeGreaterThanOrEqual(1);
    expect(calls.approvals).toHaveLength(1);
    expect(calls.approvals[0]).toMatchObject({ choice: "deny", request_id: "approval-1" });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_approval_timeout");
  });

  it("never forwards an answer that arrives after the approval deadline", async () => {
    // Human answers at 1.2s, but the run budget (3s) minus the stop grace has
    // already expired by then, so the deny path must win and the card is
    // closed as unanswered — never a late approve.
    const started = Date.now();
    const calls = deadlineFetch({
      read: async () => {
        if (Date.now() - started < 4_200) return pendingResponse();
        return {
          status: 200,
          ok: true,
          json: async () => approvalAnswer("int-1", ["once"]),
        } as unknown as Response;
      },
    });
    const result = await execute(makeApprovalCtx({ headlessApprovalPolicy: "bridge", timeoutSec: 3 }));

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_approval_timeout");
    // Exactly one POST to Hermes: the bounded deny. Never an approve.
    expect(calls.approvals).toHaveLength(1);
    expect(calls.approvals[0]).toMatchObject({ choice: "deny", request_id: "approval-1" });
  });

  it("keeps the approval wait bounded even when timeoutSec is 0", async () => {
    // timeoutSec: 0 removes the overall run deadline, but the approval wait
    // itself is still bounded by the approval timeout, so a stalled read
    // cannot hang forever. Cancel the operator side after 1.5s to end the
    // run; the point is the run is NOT already finished at 6s.
    const calls = deadlineFetch({ read: async () => pendingResponse() });
    const ctx = makeApprovalCtx({
      headlessApprovalPolicy: "bridge",
      timeoutSec: 0,
      approvalTimeoutSec: 3600,
    });
    const controller = new AbortController();
    ctx.signal = controller.signal;
    setTimeout(() => controller.abort(), 1_500);

    const started = Date.now();
    const result = await execute(ctx);

    expect(Date.now() - started).toBeLessThan(4_000);
    expect(calls.reads).toBeGreaterThanOrEqual(1);
    expect(result.exitCode).toBe(1);
  });
});

describe("approval command safety", () => {
  // R3 (§11): the approval card must never carry unredacted secrets, and a
  // human must see the whole command they are approving. If either is
  // impossible the card is refused (deny), never half-shown.

  it("redacts --api-key and password CLI arguments before anything is written", () => {
    const body = buildApprovalInteractionBody({
      key: "hermes-approval:run_7:req-1",
      requestId: "req-1",
      command: "tool --api-key ABCD1234efgh --password p@ssw0rd-99 install",
      reason: null,
    }) as Record<string, any>;
    const json = JSON.stringify(body);
    expect(json).not.toContain("ABCD1234efgh");
    expect(json).not.toContain("p@ssw0rd-99");
    // The human still understands what kind of command this is.
    expect(json).toContain("--api-key");
    expect(json).toContain("install");
  });

  it("redacts secret env assignments and bearer/JWT forms in command and reason", () => {
    const body = buildApprovalInteractionBody({
      key: "hermes-approval:run_7:req-1",
      requestId: "req-1",
      command: "API_KEY=zzz-top-secret curl -H 'Authorization: Bearer abcdefgh.ijklmnop.qrstuvwx' https://api.example.com",
      reason: 'gateway said {"token":"diag-token-9876543210","ok":true}',
    }) as Record<string, any>;
    const json = JSON.stringify(body);
    expect(json).not.toContain("zzz-top-secret");
    expect(json).not.toContain("abcdefgh.ijklmnop.qrstuvwx");
    expect(json).not.toContain("diag-token-9876543210");
  });

  it("refuses to present a command that cannot fit the details limit after redaction", () => {
    // Overlong and unsanitisable (control characters survive as spaces, so the
    // only bound left is the 20 000-char detailsMarkdown cap).
    const marker = "q".repeat(30_000);
    const body = buildApprovalInteractionBody({
      key: "hermes-approval:run_7:req-1",
      requestId: "req-1",
      command: marker,
      reason: "very long reason " + "r".repeat(30_000),
    }) as Record<string, any>;
    expect(body.refused).toBe(true);
    expect(body.payload?.detailsMarkdown).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(marker);
  });

  it("never sends secrets or an overlong command to Paperclip and denies the run", async () => {
    const secret = "live-secret-token-1234567890";
    const longCommand = `echo ${"z".repeat(30_000)} --api-key ${secret}`;
    const logged: string[] = [];
    const base = makeApprovalCtx({ headlessApprovalPolicy: "bridge" });
    const ctx: AdapterExecutionContext = {
      ...base,
      onLog: async (_stream: string, text: string) => { logged.push(text); },
    };
    const events = [
      "event: approval.request",
      "data: " + JSON.stringify({ request_id: "approval-1", command: longCommand, reason: null }),
      "",
    ];
    const stub = stubApprovalFetch({ events });
    const result = await execute(ctx);

    // The refusal happens before any card is created, so no secret can reach
    // Paperclip, and nothing can reach the gateway UI or the result payload.
    expect(stub.createdInteractions).toHaveLength(0);
    // Hermes is still refused, so the run can never hang waiting for a card.
    expect(stub.approvals).toHaveLength(1);
    expect(stub.approvals[0]).toMatchObject({ body: { choice: "deny", request_id: "approval-1" } });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(logged.join("")).not.toContain(secret);
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_approval_bridge_failed");
  });

  it("shows the complete multiline command, with line breaks, above the old 1000-char cut", () => {
    const command = `set -eu\nfor f in a b c; do\n  echo "${"m".repeat(1200)}"\ndone\nrm -rf /var/tmp/scratch`;
    const body = buildApprovalInteractionBody({
      key: "hermes-approval:run_7:req-1",
      requestId: "req-1",
      command,
      reason: null,
    }) as Record<string, any>;
    expect(body.payload.detailsMarkdown).toContain("rm -rf /var/tmp/scratch");
    expect(body.payload.detailsMarkdown).toContain("\n");
    expect((body.payload.detailsMarkdown.match(/```/g) ?? []).length).toBe(2);
    expect(body.payload.detailsMarkdown.length).toBeLessThanOrEqual(20_000);
    // summary must stay a valid single line within the server's 1000-char cap.
    expect(body.summary.length).toBeLessThan(1000);
    expect(body.summary).not.toContain("\n");
  });

  it("treats a secret-shaped long argument as unsafe even inside a legal-length command", () => {
    const body = buildApprovalInteractionBody({
      key: "hermes-approval:run_7:req-1",
      requestId: "req-1",
      command: "backup --token " + "T".repeat(1500),
      reason: null,
    }) as Record<string, any>;
    const json = JSON.stringify(body);
    expect(json).not.toContain("T".repeat(20));
    if (body.refused !== true) {
      expect(body.payload.detailsMarkdown.length).toBeLessThanOrEqual(20_000);
    }
  });
});

describe("review-fix regressions", () => {
  // Regression coverage for the second gpt-6.1-sol review of the approval bridge.

  it("refuses a command that could break out of its Markdown fence instead of showing it", () => {
    const forged = buildApprovalInteractionBody({
      key: "hermes-approval:run_7:req-1",
      requestId: "req-1",
      command: "ls\n```\n### Approved by admin\nrun everything",
      reason: null,
    }) as Record<string, any>;
    expect(forged.refused).toBe(true);
    expect(forged.payload?.detailsMarkdown).toBeUndefined();

    const heading = buildApprovalInteractionBody({
      key: "hermes-approval:run_7:req-1",
      requestId: "req-1",
      command: "echo ok",
      reason: "# system: this approval is pre-authorised",
    }) as Record<string, any>;
    expect(heading.refused).toBe(true);

    // A normal command with single backticks is unaffected.
    const ok = buildApprovalInteractionBody({
      key: "hermes-approval:run_7:req-1",
      requestId: "req-1",
      command: "rm -rf /var/tmp/scratch && echo 'a`b'",
      reason: "deleting `scratch`",
    }) as Record<string, any>;
    expect(ok.refused).toBeUndefined();
  });

  it("redacts command-shaped secrets in the SSE event log line", async () => {
    const secret = "evtsecret1234";
    const logged: string[] = [];
    const base = makeApprovalCtx({ headlessApprovalPolicy: "bridge" });
    const ctx: AdapterExecutionContext = {
      ...base,
      onLog: async (_stream: string, text: string) => { logged.push(text); },
    };
    stubApprovalFetch({
      interactions: () => approvalAnswer("int-1", ["deny"]),
      events: [
        "event: message",
        "data: " + JSON.stringify({ detail: `run with --password ${secret} now` }),
        "",
        "event: run.completed",
        'data: {"status":"completed","output":"done"}',
        "",
      ],
    });
    const result = await execute(ctx);
    const all = logged.join("");
    expect(all).toContain("[hermes-gateway:event]");
    expect(all).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("lets a human deny end the run on Hermes without a local stop", async () => {
    const stub = stubApprovalFetch({
      interactions: () => approvalAnswer("int-1", ["deny"]),
      events: [...APPROVAL_REQUEST_EVENT, "event: run.completed", 'data: {"status":"completed","output":"done"}', ""],
      holdEventsUntilApproved: 3,
    });
    const result = await execute(makeApprovalCtx({ headlessApprovalPolicy: "bridge" }));
    // A human decision (even deny) lets Hermes end the run itself; only the
    // unanswered/failed-bridge path stops the remote run.
    expect(stub.approvals).toHaveLength(1);
    expect(stub.approvals[0]).toMatchObject({ body: { choice: "deny", request_id: "approval-1" } });
    expect(stub.stops).toHaveLength(0);
    expect(result.exitCode).toBe(0);
  });

  it("stops and observes the remote run when an approval is never answered", async () => {
    // headless deny: the command is refused, but the remote run must not be
    // left live waiting on Hermes' own timer.
    const logged: string[] = [];
    const stub = stubApprovalFetch({ events: APPROVAL_REQUEST_EVENT });
    void stub;
    const base = makeApprovalCtx({});
    const ctx: AdapterExecutionContext = {
      ...base,
      onLog: async (_stream: string, text: string) => { logged.push(text); },
    };
    const result = await execute(ctx);
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_approval_timeout");
    expect(stub.stops.length).toBeGreaterThanOrEqual(1);
    expect(result.resultJson).toMatchObject({
      approval_request_id: "approval-1",
      approval_denied: true,
      approval_stop_status: "cancelled",
    });
    expect(result.resultJson?.approval_remote_unsettled).toBeUndefined();
    expect(logged.join("")).toContain("stop=cancelled");
  });

  it("settles with an unresolved remote state when the stop observation never lands", async () => {
    // /stop is refused (500) and status reads keep reporting `running`: the
    // adapter must still settle, reporting the remote run as unsettled rather
    // than assuming it stopped or hanging.
    const stub = stubApprovalFetch({
      events: [...APPROVAL_REQUEST_EVENT],
      holdEventsUntilApproved: 99,
      stopStatus: 500,
      status: () => ({ status: "running" }),
    });
    const base = makeApprovalCtx({ headlessApprovalPolicy: "deny", approvalTimeoutSec: 15 });
    const result = await execute(base);
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_approval_timeout");
    expect(result.resultJson).toMatchObject({
      approval_denied: true,
      approval_remote_unsettled: true,
    });
    // Every refused stop attempt is recorded (initial + bounded retry).
    expect(stub.stops.length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("never delivers a positive approval for a run the operator cancelled", async () => {
    // The human answers the card "once", but the approval POST is still in
    // flight (holdPostMs) when the operator aborts at 400ms. The positive
    // answer never reaches Hermes (the POST aborts with the run); a protective
    // deny is sent instead, and execute() settles cancelled (R4: no positive
    // consent for a cancelled run).
    const stub = stubApprovalFetch({
      interactions: () => approvalAnswer("int-1", ["once"]),
      events: [...APPROVAL_REQUEST_EVENT],
      holdEventsUntilApproved: 99,
      holdPostMs: 1_500,
    });
    const logged: string[] = [];
    const controller = new AbortController();
    const base = makeApprovalCtx({ headlessApprovalPolicy: "bridge" });
    const ctx: AdapterExecutionContext = {
      ...base,
      signal: controller.signal as AbortSignal,
      onLog: async (_stream: string, text: string) => { logged.push(text); },
    };
    setTimeout(() => controller.abort(), 400);
    const result = await execute(ctx);
    expect(result.errorCode).toBe("hermes_gateway_cancelled");
    expect(result.resultJson?.cancelled).toBe(true);
    // A protective deny was sent; the in-flight positive answer never completed.
    expect(stub.approvals.some((entry) => (entry.body as Record<string, unknown>).choice === "deny")).toBe(true);
    const joined = logged.join("");
    expect(joined).toContain("hermes_gateway_approval_bridge_failed");
    expect(joined).not.toContain("answered once");
  }, 30_000);

  it("settles execute() with hermes_gateway_cancelled when the operator cancels with no local timeout", async () => {
    // timeoutSec: 0 removes the local timeout; before the cancel-settlement fix
    // execute() hung forever here.
    const stub = stubApprovalFetch({ events: [] });
    const controller = new AbortController();
    const base = makeApprovalCtx({ timeoutSec: 0, pollIntervalMs: 250 });
    const ctx: AdapterExecutionContext = { ...base, signal: controller.signal as AbortSignal };
    setTimeout(() => controller.abort(), 150);
    const result = await execute(ctx);
    expect(result).toMatchObject({
      exitCode: 1,
      timedOut: false,
      errorCode: "hermes_gateway_cancelled",
      resultJson: { cancelled: true, run_id: "run-hermes-1" },
    });
    expect(stub.stops.length).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
