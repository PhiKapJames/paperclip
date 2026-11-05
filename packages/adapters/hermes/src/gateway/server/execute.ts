import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils";
import { redactCommandText, redactDiagnosticText } from "@paperclipai/adapter-utils";
import type { ConnectionFailure } from "@paperclipai/adapter-utils/connection-failure";
import {
  asNumber,
  asString,
  parseObject,
  readPaperclipIssueWorkModeFromContext,
  selectPaperclipPromptSections,
  isPaperclipRecoveryWakePayload,
  stringifyPaperclipWakePayload,
  paperclipWakeCommentsArePromptOwned,
} from "@paperclipai/adapter-utils/server-utils";
import {
  ADAPTER_TYPE,
  DEFAULT_APPROVAL_TIMEOUT_SEC,
  DEFAULT_EVENT_RECONNECT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TIMEOUT_SEC,
  STOP_GRACE_MS,
} from "../shared/constants.js";
import {
  allowsInsecureRemoteHttp,
  isLoopbackHostname,
  isRemotePlainHttp,
  remotePlainHttpDeniedMessage,
} from "./transport-security.js";

type SessionKeyStrategy = "issue" | "agent" | "run" | "none";

type SseFrame = {
  event: string | null;
  data: string;
};

type HermesHttpError = Error & {
  status?: number;
  code?: string;
  retryNotBefore?: string | null;
  body?: unknown;
  transportCause?: unknown;
};

type TerminalState = {
  runId: string;
  status: string;
  eventName?: string | null;
  payload?: Record<string, unknown> | null;
  output?: string | null;
  /** Overrides the status-derived code; used by the approval path (§5). */
  errorCode?: string | null;
  errorMessage?: string | null;
  /** Approval-path fields merged into `resultJson` (deny landed, stop status). */
  resultExtras?: Record<string, unknown> | null;
};

type ExecutionState = {
  runId: string;
  outputChunks: string[];
  lastEventName: string | null;
  terminal: TerminalState | null;
  resolveTerminal: (state: TerminalState) => void;
  terminalPromise: Promise<TerminalState>;
  /** The one Hermes approval request this run owns, with its tracked bridge (R5). */
  approvalBridge?: ApprovalBridgeEntry | null;
  /** In-flight approval bridges; observed (bounded) before this adapter returns. */
  approvalTasks: Set<Promise<void>>;
};

/** A Hermes approval request this run has taken ownership of, plus its tracked bridge. */
type ApprovalBridgeEntry = {
  requestId: string;
  binding: HermesApprovalBinding;
  choice: HermesApprovalChoice | null;
  /** Assigned synchronously at registration; settles when the human wait ends. */
  task: Promise<void>;
};

type TextRedactor = (value: string) => string;

type GatewayConfigurationFailure = Extract<ConnectionFailure, { provider: "hermes_gateway"; operation: "configuration" }>;
type GatewayRequestFailure = Extract<ConnectionFailure, { provider: "hermes_gateway"; operation: "create_run" }>;

// Only errors observed at our outbound request boundary acquire this provenance.
// A callback or remote payload cannot opt itself out of product error reporting.
const requestConnectionFailures = new WeakMap<Error, GatewayRequestFailure>();
const NETWORK_FAILURE_REASONS: Readonly<Record<string, GatewayRequestFailure["reason"]>> = {
  ECONNREFUSED: "connection_refused",
  ENOTFOUND: "dns_failure",
  EAI_AGAIN: "dns_failure",
  EHOSTUNREACH: "network_unreachable",
  ENETUNREACH: "network_unreachable",
  ECONNRESET: "connection_reset",
  EPIPE: "connection_reset",
  UND_ERR_SOCKET: "connection_reset",
  ETIMEDOUT: "connection_timeout",
  UND_ERR_CONNECT_TIMEOUT: "connection_timeout",
  UND_ERR_HEADERS_TIMEOUT: "connection_timeout",
  UND_ERR_BODY_TIMEOUT: "connection_timeout",
  CERT_HAS_EXPIRED: "tls_failure",
  CERT_NOT_YET_VALID: "tls_failure",
  DEPTH_ZERO_SELF_SIGNED_CERT: "tls_failure",
  SELF_SIGNED_CERT_IN_CHAIN: "tls_failure",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "tls_failure",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "tls_failure",
  ERR_TLS_CERT_ALTNAME_INVALID: "tls_failure",
};

function gatewayConfigurationFailure(reason: GatewayConfigurationFailure["reason"]): GatewayConfigurationFailure {
  return { schemaVersion: 1, provider: "hermes_gateway", operation: "configuration", reason };
}

function networkFailureReason(value: unknown, depth = 0): GatewayRequestFailure["reason"] | null {
  const cause = asRecord(value);
  if (!cause || depth > 2 || cause.name === "AbortError") return null;
  const reason = typeof cause.code === "string" && Object.hasOwn(NETWORK_FAILURE_REASONS, cause.code)
    ? NETWORK_FAILURE_REASONS[cause.code]!
    : null;
  if (cause.code !== undefined && !reason) return null;
  if (cause.errors !== undefined) {
    if (!Array.isArray(cause.errors) || cause.errors.length === 0 || cause.errors.length > 8) return null;
    const reasons = cause.errors.map((error) => networkFailureReason(error, depth + 1));
    const first = reasons[0];
    return first && reasons.every((item) => item === first) && (!reason || reason === first) ? first : null;
  }
  return reason;
}

function rememberNetworkFailure(target: Error, error: unknown): void {
  if (!(error instanceof Error) || error.name === "AbortError") return;
  // Native fetch wraps transport errors in cause. Do not classify an arbitrary
  // TypeError, its text, or remote JSON that happens to name a network error.
  const reason = networkFailureReason(error.cause);
  if (reason) requestConnectionFailures.set(target, {
    schemaVersion: 1, provider: "hermes_gateway", operation: "create_run", reason,
  });
}

function httpFailureReason(status: number): GatewayRequestFailure["reason"] | null {
  if (status === 401 || status === 403) return "authentication_failed";
  if (status === 404) return "endpoint_not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500 && status <= 599) return "remote_unavailable";
  return null;
}

const CRITICAL_HEADERS = new Set([
  "authorization",
  "content-type",
  "accept",
  "idempotency-key",
  "x-hermes-session-key",
]);

const SENSITIVE_KEY_PATTERN =
  /(^|[_-])(auth|authorization|token|secret|password|api[_-]?key|private[_-]?key)([_-]|$)/i;
const BEARER_TOKEN_PATTERN = /Bearer\s+\S+/gi;
const HERMES_SESSION_KEY_HEADER_PATTERN = /(X-Hermes-Session-Key\s*[:=]\s*)([^\s,;]+)/gi;
const PAPERCLIP_SESSION_KEY_PATTERN =
  /\bpaperclip:(?:company:[A-Za-z0-9-]+:agent:[A-Za-z0-9-]+(?::(?:issue|run):[A-Za-z0-9-]+)?|run:[A-Za-z0-9-]+)\b/gi;

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "error",
  "cancelled",
  "canceled",
  "stopped",
  "interrupted",
]);

const FAILURE_STATUSES = new Set(["failed", "error"]);
const CANCELLED_STATUSES = new Set(["cancelled", "canceled", "stopped", "interrupted"]);
const APPROVAL_REQUEST_EVENT = "approval.request";
const APPROVAL_REQUEST_EVENT_ALIASES = new Set([APPROVAL_REQUEST_EVENT, "approval_requested"]);
const MAX_APPROVAL_NESTING = 4;
const DEFAULT_HERMES_DASHBOARD_PORT = "9119";
const HERMES_DASHBOARD_API_PATHS = new Set(["", "/", "/chat"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** The Paperclip base URL the bridge calls back into, or null when the host did not supply one. */
function ctxRuntimeApiUrl(ctx: AdapterExecutionContext): string | null {
  const value = nonEmpty(ctx.config.paperclipApiUrl);
  if (!value) return null;
  // Callers append `/api/...`, so tolerate an operator entering the API root itself.
  return value.replace(/\/+$/, "").replace(/\/api$/, "") || null;
}

function parseNonNegativeNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number.parseFloat(value)
      : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, parsed);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeSessionKeyStrategy(value: unknown): SessionKeyStrategy {
  const raw = asString(value, "issue").trim().toLowerCase();
  if (raw === "agent" || raw === "run" || raw === "none") return raw;
  return "issue";
}

function normalizeBaseUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const normalizedPath = url.pathname.replace(/\/+$/, "") || "/";
    if (
      url.port === DEFAULT_HERMES_DASHBOARD_PORT &&
      HERMES_DASHBOARD_API_PATHS.has(normalizedPath)
    ) {
      url.pathname = "/api";
    } else {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function apiUrl(baseUrl: URL, path: string): string {
  const base = baseUrl.toString().replace(/\/+$/, "");
  return `${base}${path}`;
}

function issueIdFromContext(ctx: AdapterExecutionContext): string | null {
  return nonEmpty(ctx.context.taskId) ?? nonEmpty(ctx.context.issueId);
}

export function resolveSessionKey(input: {
  strategy: SessionKeyStrategy;
  companyId: string;
  agentId: string;
  runId: string;
  issueId: string | null;
}): string | null {
  if (input.strategy === "none") return null;
  if (input.strategy === "agent") {
    return `paperclip:company:${input.companyId}:agent:${input.agentId}`;
  }
  if (input.strategy === "run") {
    return `paperclip:run:${input.runId}`;
  }
  const issuePart = input.issueId ? `issue:${input.issueId}` : `run:${input.runId}`;
  return `paperclip:company:${input.companyId}:agent:${input.agentId}:${issuePart}`;
}

function stringifyForLog(value: unknown, maxChars = 4_000): string {
  const text = JSON.stringify(value);
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

function sanitizeSensitiveText(value: string): string {
  return value
    .replace(BEARER_TOKEN_PATTERN, "Bearer [redacted]")
    .replace(HERMES_SESSION_KEY_HEADER_PATTERN, "$1[redacted]")
    .replace(PAPERCLIP_SESSION_KEY_PATTERN, "[redacted-session-key]");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createTextRedactor(secrets: Array<string | null | undefined>): TextRedactor {
  const exactSecrets = [...new Set(secrets.filter((secret): secret is string => typeof secret === "string" && secret.length >= 4))]
    .sort((a, b) => b.length - a.length)
    .map((secret) => ({
      secret,
      regex: new RegExp(escapeRegExp(secret), "g"),
    }));

  return (value: string) => {
    // Command/secret-pattern redaction runs first so generic `--password X`
    // style material in any logged event or error is gone before it reaches a
    // run log; exact known secrets and bearer/session patterns come after.
    let result = redactDiagnosticText(redactCommandText(value));
    result = sanitizeSensitiveText(result);
    for (const entry of exactSecrets) {
      result = result.replace(entry.regex, `[redacted len=${entry.secret.length}]`);
    }
    return result;
  };
}

function redactForLog(value: unknown, keyPath: string[] = [], depth = 0, redactText: TextRedactor = sanitizeSensitiveText): unknown {
  const key = keyPath[keyPath.length - 1] ?? "";
  if (typeof value === "string") {
    if (SENSITIVE_KEY_PATTERN.test(key)) return `[redacted len=${value.length}]`;
    const sanitized = redactText(value);
    return sanitized.length > 500
      ? `${sanitized.slice(0, 500)}... [truncated ${sanitized.length - 500} chars]`
      : sanitized;
  }
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (depth > 5) return "[array-truncated]";
    return value.slice(0, 40).map((entry, index) => redactForLog(entry, [...keyPath, String(index)], depth + 1, redactText));
  }
  if (typeof value === "object") {
    if (depth > 5) return "[object-truncated]";
    const out: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
      out[entryKey] = redactForLog(entryValue, [...keyPath, entryKey], depth + 1, redactText);
    }
    return out;
  }
  return redactText(String(value));
}

function parseHeaders(value: unknown): Record<string, string> {
  const source =
    typeof value === "string" && value.trim().length > 0
      ? (() => {
          try {
            return JSON.parse(value);
          } catch {
            return {};
          }
        })()
      : value;
  const parsed = parseObject(source);
  const headers: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    const normalized = key.trim();
    if (!normalized || CRITICAL_HEADERS.has(normalized.toLowerCase())) continue;
    if (typeof entry === "string") headers[normalized] = entry;
  }
  return headers;
}

function buildHeaders(input: {
  apiKey: string;
  sessionKey: string | null;
  runId: string;
  extraHeaders: Record<string, string>;
  accept: string;
  contentType?: string;
}): Record<string, string> {
  return {
    ...input.extraHeaders,
    Authorization: `Bearer ${input.apiKey}`,
    Accept: input.accept,
    ...(input.contentType ? { "Content-Type": input.contentType } : {}),
    "Idempotency-Key": input.runId,
    ...(input.sessionKey ? { "X-Hermes-Session-Key": input.sessionKey } : {}),
  };
}

/**
 * Shared idempotency key for one Hermes approval: the same key identifies the
 * Paperclip interaction and the Hermes answer, so a retried answer is the same
 * logical request on both sides. Session-authority prompts can be re-registered
 * under the same `prompt_id` at a newer `execution_generation`, so the
 * generation is part of the key and an old card never answers a new generation.
 * Returns null when the key would exceed the 255-char interaction limit —
 * truncating could collide across requests.
 */
export function hermesApprovalKey(runId: string, requestId: string, executionGeneration?: number): string | null {
  const key = `hermes-approval:${runId}:${requestId}${executionGeneration === undefined ? "" : `:g${executionGeneration}`}`;
  return key.length <= 255 ? key : null;
}

/** Two wire bindings for the same request id: equal only if protocol and generation match. */
function sameApprovalBinding(a: HermesApprovalBinding, b: HermesApprovalBinding): boolean {
  if (a.protocol !== b.protocol) return false;
  return a.protocol === "legacy"
    || (b.protocol === "session_authority" && a.executionGeneration === b.executionGeneration);
}

/** Idempotency key for a request under its wire binding (generation only exists for session authority). */
function approvalKeyFor(runId: string, request: HermesApprovalRequest): string | null {
  return hermesApprovalKey(
    runId,
    request.requestId,
    request.binding.protocol === "session_authority" ? request.binding.executionGeneration : undefined,
  );
}

const ALL_APPROVAL_CHOICES: Array<{ id: HermesApprovalChoice; label: string; description: string }> = [
  { id: "once", label: "Allow once", description: "Approve this command this one time." },
  {
    id: "session",
    label: "Allow for this run",
    description: "Hermes may skip re-asking for matching commands during this run; a later run can ask again.",
  },
  { id: "always", label: "Always allow", description: "Hermes stores this command pattern for future approvals." },
  { id: "deny", label: "Deny", description: "Refuse the command (default)." },
];
// Hermes accepts these two for every approval request; the broader pattern
// choices are offered only when the request itself advertises them.
const DEFAULT_APPROVAL_CHOICE_IDS: HermesApprovalChoice[] = ["once", "deny"];

/**
 * Human-facing approval card (§3.2 / R1 / R3). The command is redacted *here*,
 * before any length bound is applied, so a truncation can never be the thing
 * that removes a secret. The human sees the complete redacted command in
 * `detailsMarkdown` (fenced, newlines preserved). If the redacted content
 * still cannot fit the server's field limits, the card is refused outright
 * (`refused: true`, no payload) and the caller denies — a human is never asked
 * to approve a command they cannot fully see. `human_only` + `none` are the
 * load-bearing fields: only a board user may answer, and answering must not
 * queue a second agent run while this one still holds the issue. The min-one
 * rule forces the default selection to be `deny`.
 */
const APPROVAL_REFUSED_MESSAGE =
  "The Hermes approval request could not be safely presented (content too long); the command was denied.";

export function buildApprovalInteractionBody(input: {
  key: string;
  /** Carried for callers' convenience (log correlation); the card itself never needs it. */
  requestId?: string;
  command: string | null;
  reason: string | null;
  allowed?: HermesApprovalChoice[];
}): Record<string, unknown> {
  const allowed = new Set(input.allowed ?? DEFAULT_APPROVAL_CHOICE_IDS);
  // The redacted command is shown verbatim inside a fenced code block, so tab
  // and newline survive — collapsing "\n" would hide every line but the first
  // from the human being asked to approve. Every other C0/DEL control
  // character is still flattened so nothing forges terminal escapes or blocks.
  const sanitize = (text: string) =>
    redactDiagnosticText(redactCommandText(text)).replace(/[^\P{Cc}\n\t]/gu, " ");
  const command = input.command === null ? null : sanitize(input.command).trim();
  const reason = input.reason === null ? null : sanitize(input.reason).trim();
  const detail = [
    command ? `Command:\n\n\`\`\`\n${command}\n\`\`\`` : "Hermes did not say what it wants to run.",
    reason ? `Reason: ${reason}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
  // A command containing triple backticks could close its own fence and forge
  // extra card content, and a line starting with `#` would render as a heading.
  // Refuse the card outright (the caller then denies) rather than show content
  // whose Markdown boundaries the remote side controls.
  // Indented fences are equally unsafe, but leading whitespace before a heading
  // is harmless, so only the backticks are matched without an anchor.
  const fenceUnsafe =
    (command !== null && command.includes("```")) ||
    /^#{1,6}\s/m.test(command ?? "") ||
    /^#{1,6}\s/m.test(reason ?? "");
  if (fenceUnsafe || detail.length > 20000) {
    // Over the server cap (or unsafe Markdown): refuse rather than truncate or
    // misrender a command a human is being asked to approve. The caller denies
    // and never creates a card.
    return {
      kind: "request_checkbox_confirmation",
      idempotencyKey: input.key,
      title: "Hermes approval requested",
      summary: APPROVAL_REFUSED_MESSAGE,
      refused: true,
    };
  }
  // Only id/label/description are accepted on an option; the default selection
  // is carried by defaultSelectedOptionIds, not a per-option flag.
  const options = ALL_APPROVAL_CHOICES.filter((choice) => allowed.has(choice.id)).map((choice) => ({
    id: choice.id,
    label: choice.label,
    description: choice.description,
  }));
  return {
    kind: "request_checkbox_confirmation",
    idempotencyKey: input.key,
    title: `Hermes approval requested: ${command ?? "unspecified command"}`.replace(/\s+/g, " ").trim().slice(0, 240),
    // `summary` is a one-line preview; the complete redacted command is always in
    // `detailsMarkdown`, which is why this preview may be cut.
    summary: detail.replace(/\s+/g, " ").trim().slice(0, 900),
    resolverPolicy: "human_only",
    continuationPolicy: "none",
    payload: {
      version: 1,
      prompt: "Hermes asked to run a command. Select exactly one decision and submit.",
      supersedeOnUserComment: false,
      options,
      defaultSelectedOptionIds: ["deny"],
      minSelected: 1,
      maxSelected: 1,
      acceptLabel: "Submit decision",
      rejectLabel: "Deny",
      detailsMarkdown: detail,
    },
  };
}

/** POSTs the approval card as the run-scoped agent (§3.1); throws with the status on rejection. */
export async function createApprovalInteraction(input: {
  paperclipApiUrl: string;
  authToken: string;
  runId: string;
  issueId: string;
  body: Record<string, unknown>;
  signal: AbortSignal;
}): Promise<{ interactionId: string | null }> {
  const url = `${input.paperclipApiUrl.replace(/\/+$/, "")}/api/issues/${encodeURIComponent(input.issueId)}/interactions`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.authToken}`,
      "X-Paperclip-Run-Id": input.runId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input.body),
    signal: input.signal,
  });
  if (!response.ok) {
    throw new Error(`Paperclip rejected the approval request (HTTP ${response.status})`);
  }
  const body = await readResponseJson(response).catch(() => null);
  const record = asRecord(body);
  const interaction = asRecord(record?.interaction) ?? record;
  return { interactionId: nonEmpty(interaction?.id) ?? null };
}

/**
 * Answers one Hermes approval (§3.1). Never throws: an answer that Hermes
 * rejects or a gateway that is unreachable must not kill the event stream, and
 * Hermes' own approval timer still denies the command if nothing arrives.
 * A 409 means the request was already resolved (a second answer or the timer
 * won), which is a valid outcome rather than a failure.
 */
export async function postApproval(input: {
  baseUrl: URL;
  headers: Record<string, string>;
  runId: string;
  key: string;
  request: HermesApprovalRequest;
  choice: HermesApprovalChoice;
  signal: AbortSignal;
  onLog: (stream: "stdout" | "stderr", chunk: string) => void | Promise<void>;
}): Promise<boolean> {
  // Session-authority replies must carry exactly {request_id, execution_generation, choice}
  // (api_server.py `respond_run`); legacy replies carry {choice, request_id}.
  const { binding } = input.request;
  const body = binding.protocol === "session_authority"
    ? { choice: input.choice, request_id: input.request.requestId, execution_generation: binding.executionGeneration }
    : { choice: input.choice, request_id: input.request.requestId };
  let response: Response;
  try {
    response = await fetch(apiUrl(input.baseUrl, `/v1/runs/${encodeURIComponent(input.runId)}/approval`), {
      method: "POST",
      headers: { ...input.headers, "Content-Type": "application/json", "Idempotency-Key": input.key },
      body: JSON.stringify(body),
      signal: input.signal,
    });
  } catch (err) {
    if (input.signal.aborted) return false;
    await input.onLog("stderr", `[hermes-gateway:approval] answer could not be sent: ${sanitizeSensitiveText(redactErrorMessage(err))}\n`);
    return false;
  }
  if (response.ok) {
    await input.onLog("stdout", `[hermes-gateway:approval] answered ${input.choice} for ${input.request.requestId}\n`);
    return true;
  }
  if (response.status === 409) {
    await input.onLog("stdout", `[hermes-gateway:approval] request ${input.request.requestId} already resolved (HTTP 409)\n`);
    return true;
  }
  await input.onLog("stderr", `[hermes-gateway:approval] answer rejected (HTTP ${response.status})\n`);
  return false;
}

function buildInput(ctx: AdapterExecutionContext, paperclipApiUrl: string | null): string {
  // Stable session keys (issue/agent strategy) resume the same remote Hermes
  // conversation across runs; a stored session id from a prior run means that
  // conversation already received the task brief, so pick the compact
  // task-context variant under the shared resume rules.
  const sessionKeyStrategy = normalizeSessionKeyStrategy(ctx.config.sessionKeyStrategy);
  const resumedSession =
    (sessionKeyStrategy === "issue" || sessionKeyStrategy === "agent") &&
    Boolean(nonEmpty(ctx.runtime?.sessionId));
  const { taskContextNote: taskMarkdown, wakePrompt } = selectPaperclipPromptSections(ctx.context, {
    resumedSession,
    // Hermes gateway owns the execution contract below; retain the old
    // gateway prompt shape and avoid adding a second contract on resume.
    includeExecutionContract: false,
  });
  const wakePayloadJson = paperclipWakeCommentsArePromptOwned(ctx.context)
    ? null
    : stringifyPaperclipWakePayload(ctx.context.paperclipWake, {
        omitIssueDescription: Boolean(taskMarkdown),
      });
  const sessionHandoff = nonEmpty(ctx.context.paperclipSessionHandoffMarkdown);
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(ctx.context);
  const lines = [
    `You are ${ctx.agent.name}, an AI agent employee in a Paperclip-managed company.`,
    "",
    "Paperclip runtime identity:",
    `- Agent ID: ${ctx.agent.id}`,
    `- Company ID: ${ctx.agent.companyId}`,
    `- Run ID: ${ctx.runId}`,
    ...(paperclipApiUrl ? [`- Paperclip API URL: ${paperclipApiUrl}`] : []),
    ...(issueWorkMode ? [`- Issue work mode: ${issueWorkMode}`] : []),
    "",
    ...(ctx.context.conversationMode === true || isPaperclipRecoveryWakePayload(ctx.context.paperclipWake)
      ? []
      : [
          "Execution contract:",
          "- Take concrete action in this run when the task is actionable.",
          "- Do not stop at a plan unless the issue asks for planning only.",
          "- Leave durable progress and update the issue to a clear final disposition.",
          "- Use X-Paperclip-Run-Id on mutating Paperclip API requests when a Paperclip API key is available.",
          "",
        ]),
    wakePrompt,
    ...(sessionHandoff ? ["", sessionHandoff] : []),
    ...(taskMarkdown ? ["", taskMarkdown] : []),
    ...(wakePayloadJson
      ? [
          "",
          "Structured wake payload JSON:",
          "```json",
          wakePayloadJson,
          "```",
        ]
      : []),
  ];
  return lines.filter((line) => line !== null && line !== undefined).join("\n").trim();
}

function buildRunBody(ctx: AdapterExecutionContext, sessionKey: string | null): Record<string, unknown> {
  const paperclipApiUrl = nonEmpty(ctx.config.paperclipApiUrl);
  const payloadTemplate = parseObject(ctx.config.payloadTemplate);
  const configuredInput = nonEmpty(payloadTemplate.input);
  const input = configuredInput && ctx.context.conversationMode === true
    ? `${configuredInput}\n\n${buildInput(ctx, paperclipApiUrl)}`
    : configuredInput ?? buildInput(ctx, paperclipApiUrl);
  const instructions =
    nonEmpty(ctx.config.instructions) ??
    nonEmpty(payloadTemplate.instructions) ??
    "Follow the Paperclip wake instructions exactly. Do not expose secrets in logs, comments, or final output.";
  return {
    ...payloadTemplate,
    input,
    instructions,
    ...(sessionKey ? { session_id: sessionKey } : {}),
  };
}

async function readResponseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function classifyHttpError(status: number): { code: string; family: AdapterExecutionResult["errorFamily"] | null } {
  if (status === 401 || status === 403) return { code: "hermes_gateway_auth_failed", family: null };
  if (status === 404) return { code: "hermes_gateway_runs_unsupported", family: null };
  if (status === 429) return { code: "hermes_gateway_rate_limited", family: "transient_upstream" };
  if (status >= 500) return { code: "hermes_gateway_upstream_error", family: "transient_upstream" };
  return { code: "hermes_gateway_protocol_error", family: null };
}

function fetchFailureMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? (err as { cause?: unknown }).cause : null;
  if (!cause || typeof cause !== "object") return message;

  const causeRecord = cause as { code?: unknown; message?: unknown };
  const causeMessage = typeof causeRecord.message === "string" ? causeRecord.message : "";
  const causeCode = typeof causeRecord.code === "string" ? causeRecord.code : "";
  if (!causeMessage || causeMessage === message) return causeCode ? `${message} (${causeCode})` : message;
  return causeCode ? `${message} (${causeCode}: ${causeMessage})` : `${message} (${causeMessage})`;
}

async function fetchJson(input: RequestInfo | URL, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (err) {
    const fetchErr = new Error(`Hermes gateway request failed: ${fetchFailureMessage(err)}`) as HermesHttpError;
    fetchErr.code = "hermes_gateway_connect_failed";
    fetchErr.transportCause = err instanceof Error ? err.cause : undefined;
    rememberNetworkFailure(fetchErr, err);
    throw fetchErr;
  }
  let body: unknown;
  try {
    body = await readResponseJson(response);
  } catch (err) {
    if (err instanceof Error) rememberNetworkFailure(err, err);
    throw err;
  }
  if (!response.ok) {
    const classified = classifyHttpError(response.status);
    const err = new Error(`Hermes gateway HTTP ${response.status}`) as HermesHttpError;
    err.status = response.status;
    err.code = classified.code;
    err.retryNotBefore = response.headers.get("retry-after");
    err.body = body;
    const reason = httpFailureReason(response.status);
    if (reason) requestConnectionFailures.set(err, {
      schemaVersion: 1, provider: "hermes_gateway", operation: "create_run", reason,
    });
    throw err;
  }
  return body;
}

function extractRunId(value: unknown): string | null {
  const record = asRecord(value);
  return nonEmpty(record?.run_id) ?? nonEmpty(record?.runId) ?? nonEmpty(record?.id);
}

function eventNameFromData(data: unknown, fallback: string | null): string | null {
  const record = asRecord(data);
  return nonEmpty(record?.event) ?? nonEmpty(record?.type) ?? fallback;
}

function parseJsonData(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return { text: data };
  }
}

export function parseSseFramesForTest(buffer: string): { frames: SseFrame[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const frames: SseFrame[] = [];
  let offset = 0;
  while (true) {
    const idx = normalized.indexOf("\n\n", offset);
    if (idx < 0) break;
    const rawFrame = normalized.slice(offset, idx);
    offset = idx + 2;
    let event: string | null = null;
    const dataLines: string[] = [];
    for (const line of rawFrame.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }
    if (dataLines.length > 0) frames.push({ event, data: dataLines.join("\n") });
  }
  return { frames, rest: normalized.slice(offset) };
}

function createExecutionState(runId: string): ExecutionState {
  let resolveTerminal!: (state: TerminalState) => void;
  const terminalPromise = new Promise<TerminalState>((resolve) => {
    resolveTerminal = resolve;
  });
  return {
    runId,
    outputChunks: [],
    lastEventName: null,
    terminal: null,
    resolveTerminal,
    terminalPromise,
    approvalTasks: new Set(),
  };
}

function markTerminal(state: ExecutionState, terminal: TerminalState): void {
  if (state.terminal) return;
  state.terminal = terminal;
  state.resolveTerminal(terminal);
}

function extractStatus(value: unknown): string | null {
  const record = asRecord(value);
  return nonEmpty(record?.status)?.toLowerCase() ?? null;
}

function extractOutput(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  const direct =
    nonEmpty(record.output) ??
    nonEmpty(record.result) ??
    nonEmpty(record.text) ??
    nonEmpty(record.summary) ??
    nonEmpty(record.message);
  if (direct) return direct;
  const nested = asRecord(record.data) ?? asRecord(record.payload);
  return nested ? extractOutput(nested) : null;
}

/**
 * Which Hermes approval protocol a request uses (§ plan R2). Pinned upstream
 * Hermes 7b55a7c2363610cb3622f87ed66dcea18720bde6.
 * - `legacy`: `approval.request` frames carry `request_id`; the reply body is
 *   `{choice, request_id}` (api_server.py `_approval_request_event`).
 * - `session_authority`: `PendingControls.register` events carry `prompt_id`
 *   plus an int `execution_generation`; the reply body must contain exactly
 *   `{request_id, execution_generation, choice}` — the generation is what
 *   makes a stale reply fail with `stale_generation`
 *   (session_pending_controls.py, api_server.py `respond_run`).
 */
export type HermesApprovalBinding =
  | { protocol: "legacy" }
  | { protocol: "session_authority"; executionGeneration: number };

export type HermesApprovalRequest = {
  requestId: string;
  /** Wire binding: which reply body this request accepts and its replay guard. */
  binding: HermesApprovalBinding;
  command: string | null;
  reason: string | null;
  /** Choices this request permits on the card; never empty, always includes `deny`. */
  allowed: HermesApprovalChoice[];
};

const APPROVAL_WAIT_STATUSES = new Set(["waiting_for_approval", "awaiting_approval", "requires_approval", "pending_approval"]);

/**
 * Reads the canonical `choices` ladder advertised by Hermes (pinned upstream
 * 7b55a7c236: `_approval_event_choices` and `PendingControls.register` both
 * publish `choices`). Aliases are considered ONLY when `choices` is absent,
 * so a canonical ladder is never widened. `once`/`deny` are always present
 * upstream, so the fallback is the minimum ladder, never a wider one.
 */
function parseApprovalChoices(...values: Array<unknown>): HermesApprovalChoice[] {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value)) return ["once", "deny"];
    const parsed: HermesApprovalChoice[] = [];
    for (const entry of value) {
      if (entry === "once" || entry === "session" || entry === "always" || entry === "deny") {
        if (!parsed.includes(entry)) parsed.push(entry);
      }
    }
    if (parsed.length === 0) return ["once", "deny"];
    if (!parsed.includes("deny")) parsed.push("deny");
    return parsed;
  }
  return ["once", "deny"];
}

/** Hermes' session-authority generation must be a non-negative safe int; anything else is unusable. */
function approvalGeneration(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

function approvalFields(record: Record<string, unknown> | null, depth = 0): HermesApprovalRequest | null {
  if (!record || depth > MAX_APPROVAL_NESTING) return null;
  // Session-authority protocol: `prompt_id` + int `execution_generation` only.
  // Never guess or reuse a generation from another frame or control.
  const promptId = nonEmpty(record.prompt_id);
  if (promptId) {
    const generation = approvalGeneration(record.execution_generation);
    if (generation === null) return null;
    return {
      requestId: promptId,
      binding: { protocol: "session_authority", executionGeneration: generation },
      command: nonEmpty(record.command) ?? nonEmpty(record.command_line) ?? nonEmpty(record.cmd),
      reason: nonEmpty(record.reason) ?? nonEmpty(record.description) ?? nonEmpty(record.message),
      allowed: parseApprovalChoices(record.choices, record.allowed_choices, record.allowedChoices),
    };
  }
  // Legacy protocol: `request_id`. An accompanying `execution_generation` is
  // ignored upstream (`_approval_request_event`), so the reply stays legacy.
  const requestId = nonEmpty(record.request_id) ?? nonEmpty(record.requestId);
  if (requestId) {
    return {
      requestId,
      binding: { protocol: "legacy" },
      command: nonEmpty(record.command) ?? nonEmpty(record.command_line) ?? nonEmpty(record.cmd),
      reason: nonEmpty(record.reason) ?? nonEmpty(record.description) ?? nonEmpty(record.message),
      allowed: parseApprovalChoices(record.choices, record.allowed_choices, record.allowedChoices),
    };
  }
  const nested = asRecord(record.data) ?? asRecord(record.payload);
  return nested ? approvalFields(nested, depth + 1) : null;
}

/** Reads an `approval.request` SSE frame (or its parsed payload) for the human approval bridge. */
export function extractApprovalRequest(value: unknown, fallbackEventName: string | null = null): HermesApprovalRequest | null {
  const record = asRecord(value);
  if (!record) return null;
  // The SSE frame name is not repeated inside `data`, so callers pass it as a fallback.
  const eventName = eventNameFromData(record, fallbackEventName);
  const nested = asRecord(record.data) ?? asRecord(record.payload);
  // A frame whose own payload names the approval event is the same frame with
  // the SSE name carried inside `data` instead of on the frame.
  const namesApproval = isApprovalRequestEvent(eventName)
    || isApprovalRequestEvent(eventNameFromData(nested, null));
  // Session-authority registers arrive under the same `approval.request` event
  // name with `kind: "approval"` in the payload (session_pending_controls.py
  // `register`). A frame with none of these markers is some other event and must
  // never reach approvalFields, which accepts any `request_id`/`prompt_id`.
  if (!namesApproval && record.kind !== "approval" && nested?.kind !== "approval") {
    return null;
  }
  return approvalFields(record);
}

export type HermesApprovalChoice = "once" | "session" | "always" | "deny";

/**
 * Maps a resolved Paperclip approval interaction onto a Hermes approval choice.
 * Accepts the checkbox-confirmation result (`status:"accepted"` +
 * `result.outcome` + `result.selectedOptionIds`) and the legacy
 * ask_user_questions `answers` shape.
 * Fail-closed: anything other than exactly one known option resolves to "deny".
 * Never infers consent.
 */
export function resolveHermesApprovalChoice(interaction: unknown): HermesApprovalChoice {
  const record = asRecord(interaction);
  if (!record) return "deny";

  // request_checkbox_confirmation: only an accepted outcome with exactly one
  // known selected option id is a human decision; every other terminal status
  // (rejected, superseded, withdrawn, cancelled, expired, closed) denies.
  if (record.status === "accepted") {
    const result = asRecord(record.result);
    if (!result || result.outcome !== "accepted") return "deny";
    const selected = result.selectedOptionIds;
    if (!Array.isArray(selected) || selected.length !== 1) return "deny";
    const choice = selected[0];
    return choice === "once" || choice === "session" || choice === "always" || choice === "deny"
      ? choice
      : "deny";
  }

  if (record.status !== "answered") return "deny";

  const result = asRecord(record.result);
  if (!result) return "deny";
  if (result.cancelled === true) return "deny";
  if (nonEmpty(result.expirationReason)) return "deny";

  const answers = result.answers;
  if (Array.isArray(answers)) {
    const answer = answers.map(asRecord).find((entry) => entry && entry.questionId === "decision");
    if (!answer) return "deny";
    if (nonEmpty(answer.otherText)) return "deny";
    const optionIds = answer.optionIds;
    if (!Array.isArray(optionIds) || optionIds.length !== 1) return "deny";
    const choice = optionIds[0];
    return choice === "once" || choice === "session" || choice === "always" || choice === "deny"
      ? choice
      : "deny";
  }

  // Tolerate the historical record-shaped answer map.
  const answer = asRecord(asRecord(answers)?.decision);
  if (!answer) return "deny";
  if (nonEmpty(answer.otherText)) return "deny";
  const selected = answer.selectedOptionIds;
  if (!Array.isArray(selected) || selected.length !== 1) return "deny";
  const choice = selected[0];
  return choice === "once" || choice === "session" || choice === "always" || choice === "deny"
    ? choice
    : "deny";
}

/**
 * Tolerant probe of a `GET /v1/runs/{id}` body for an approval still awaiting an answer.
 * Session-authority runs publish `pending_controls` (session_pending_controls.py
 * `project` / api_server.py `run_projection`); each control pairs its own
 * `prompt_id`+`execution_generation` with the snapshot's top-level
 * `execution_generation`, and only controls matching that snapshot generation
 * are still pending.
 */
export function extractPendingApproval(value: unknown): HermesApprovalRequest | null {
  const record = asRecord(value);
  if (!record) return null;
  const nested = asRecord(record.data) ?? asRecord(record.payload);
  const containers = [record, nested].filter((entry): entry is Record<string, unknown> => entry !== null);

  for (const container of containers) {
    const approvals = asRecord(container.approvals) ?? asRecord(container.approval);
    const pending = asRecord(container.pending_approval) ?? asRecord(container.approval_request);
    const single = approvalFields(pending) ?? approvalFields(approvals);
    if (single) return single;
    const controls = container.pending_controls;
    if (Array.isArray(controls)) {
      // Pair each control with the snapshot generation exactly as upstream's
      // projection does; never reuse another control's generation.
      const snapshotGeneration = approvalGeneration(container.execution_generation);
      for (const entry of controls) {
        const control = asRecord(entry);
        if (!control || control.kind !== "approval") continue;
        const generation = approvalGeneration(control.execution_generation) ?? snapshotGeneration;
        if (generation === null) continue;
        if (snapshotGeneration !== null && generation !== snapshotGeneration) continue;
        const found = approvalFields({ ...control, execution_generation: generation });
        if (found) return found;
      }
    }
    const list = approvals?.pending ?? approvals?.requests ?? approvals?.pending_approvals;
    if (Array.isArray(list)) {
      for (const entry of list) {
        const found = approvalFields(asRecord(entry));
        if (found) return found;
      }
    }
  }

  for (const container of containers) {
    const status = extractStatus(container);
    if (status && APPROVAL_WAIT_STATUSES.has(status)) {
      const found = approvalFields(container);
      if (found) return found;
    }
  }
  return null;
}

/** Per-call ceiling for post-settlement status/stop reads, so a stalled
 * connection can never outlive the STOP_GRACE_MS observation window. */
const FINAL_STATUS_READ_TIMEOUT_MS = 3_000;
const APPROVAL_POLL_INTERVAL_MS = 2_000;
const APPROVAL_DENY_MARGIN_MS = STOP_GRACE_MS;
const APPROVAL_BRIDGE_UNAVAILABLE = "hermes_gateway_approval_unconfigured";
const APPROVAL_BRIDGE_FAILED = "hermes_gateway_approval_bridge_failed";
const APPROVAL_TIMED_OUT = "hermes_gateway_approval_timeout";
const APPROVAL_RUN_CANCELLED = "hermes_gateway_cancelled";

/** Why a bridge could not deliver a human answer, when there was no human answer to make. */
type BridgeFailure = { code: string; message: string };

/** An approval event with no request_id: there is nothing a human could answer. */
const APPROVAL_UNPARSEABLE = "hermes_gateway_approval_unparseable";

/** Markers the run view and log scrapers key on (§ plan step 11). */
export const APPROVAL_MARKER = "hermes-gateway:approval";

/** Resolved approval configuration (§4). */
type GatewayApprovalConfig = {
  policy: "deny" | "bridge";
  timeoutMs: number;
  /** Absolute ms timestamp the whole run must be finished by; 0 = no deadline. */
  deadlineMs: number;
};

function isApprovalRequestEvent(eventName: string | null): boolean {
  return eventName !== null && APPROVAL_REQUEST_EVENT_ALIASES.has(eventName);
}

/**
 * Refuse a Hermes approval request and end this Paperclip run with an approval error code.
 * The deny POST is best effort — Hermes may already have resolved or dropped the request.
 */
async function failApproval(
  ctx: AdapterExecutionContext,
  state: ExecutionState,
  approval: HandleEventApproval,
  request: HermesApprovalRequest | null,
  code: string,
  message: string,
  redactText: TextRedactor,
): Promise<void> {
  const requestId = request?.requestId ?? null;
  const key = request ? approvalKeyFor(state.runId, request) : null;
  // An over-cap idempotency key means Hermes can never be told; the log must say
  // so, because the run then settles only on Hermes' own approval timer.
  const denyNote = request && !key ? " deny=skipped" : "";
  let denied = false;
  if (request && key) {
    denied = await postApproval({
      baseUrl: approval.baseUrl,
      headers: approval.headers,
      runId: state.runId,
      key,
      request,
      choice: "deny",
      // The deny must land even after the run signal expired or was aborted (R4).
      signal: cleanupSignal(),
      onLog: ctx.onLog,
    });
  }
  // A deny only refuses the *command*. Hermes may go on with the turn (legacy
  // semantics) or keep the run in `waiting_for_approval` (authority semantics),
  // and an unanswered request must never leave a live run behind just because
  // this Paperclip run reports a failure. Stop it and observe the terminal state
  // within a bounded window; an unsettled remote run stays visible as `unknown`.
  await stopRun({ ctx, baseUrl: approval.baseUrl, headers: approval.headers, runId: state.runId, redactText, retryOnce: true });
  const finalStatus = await fetchFinalStatus({
    baseUrl: approval.baseUrl,
    headers: approval.headers,
    runId: state.runId,
    deadlineMs: STOP_GRACE_MS,
  });
  // The Paperclip run settles here regardless: an unconfirmed stop is reported
  // as `unknown` in stop= and resultJson rather than hanging execute().
  const remoteUnsettled = finalStatus === null || !TERMINAL_STATUSES.has(extractStatus(finalStatus) ?? "");
  const logMessage = redactText(message);
  await ctx.onLog("stderr", `[${APPROVAL_MARKER} run=${state.runId} request=${requestId ?? "unknown"} ${code}${denyNote} stop=${extractStatus(finalStatus) ?? "unknown"}]\n`);
  markTerminal(state, {
    runId: state.runId,
    status: "failed",
    eventName: "approval.request",
    payload: null,
    output: null,
    errorCode: code,
    errorMessage: logMessage,
    resultExtras: {
      approval_request_id: requestId,
      approval_denied: denied,
      approval_stop_status: extractStatus(finalStatus) ?? "unknown",
      ...(remoteUnsettled ? { approval_remote_unsettled: true } : {}),
    },
  });
}

/** Remaining whole milliseconds of the run deadline; null when the run is already out of time. */
function remainingRunMs(deadlineMs: number, nowMs: () => number): number | null {
  const remaining = Math.floor(deadlineMs - nowMs());
  return remaining > 0 ? remaining : null;
}

/**
 * One absolute approval deadline (§3.3, R4): the earlier of the approval timeout and the run
 * deadline minus the margin the run still needs to stop cleanly. Every awaited approval call —
 * the card POST, each status read and its body — is cut off here, so no stalled HTTP call can
 * outlive the budget. `timeoutSec` stays the hard wall; `timeoutSec: 0` removes only the run
 * deadline, never the bound on the approval wait itself.
 */
function approvalDeadlineMs(input: { approvalTimeoutMs: number; deadlineMs: number; nowMs: () => number }): number {
  return Math.min(input.nowMs() + input.approvalTimeoutMs, input.deadlineMs - APPROVAL_DENY_MARGIN_MS);
}

/**
 * Observes tracked approval work for at most STOP_GRACE_MS. True when everything settled;
 * false is the boundary gap (a bridge still in flight), which the caller must report rather
 * than pretend completed.
 *
 * shortcut: the set is snapshotted once, so a bridge registered after this point is not
 * waited on. In practice nothing registers after execute() has aborted, since both the SSE
 * reader and the status poller stop on the run signal.
 */
async function drainApprovalTasks(state: ExecutionState): Promise<boolean> {
  const tasks = [...state.approvalTasks];
  if (tasks.length === 0) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drained = await Promise.race([
    Promise.allSettled(tasks).then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), STOP_GRACE_MS);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return drained;
}

/** Cleanup (the reply to Hermes) gets its own bounded window, never an already-expired signal. */
function cleanupSignal(): AbortSignal {
  return AbortSignal.timeout(STOP_GRACE_MS);
}

/**
 * Polls the Paperclip interaction until a human answers it, the wait budget runs out, or the
 * interaction is cancelled or expired. Only an actual answer can end the wait early (§3.3).
 */
async function pollForApprovalAnswer(input: {
  paperclipApiUrl: string;
  authorizationHeaderValue: string;
  runId: string;
  issueId: string;
  interactionId: string;
  idempotencyKey: string;
  /** Absolute deadline shared with the card POST (R4); a reply after it is never forwarded. */
  deadlineMs: number;
  signal: AbortSignal;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<unknown>;
  nowMs: () => number;
}): Promise<{ choice: HermesApprovalChoice; answered: boolean }> {
  const deadline = input.deadlineMs;
  // A human decision and a non-decision both deny, but only a human decision may let the run
  // keep streaming; report the difference so an unanswered approval fails the run (§3.3).
  const unanswered = { choice: "deny" as const, answered: false };
  while (!input.signal.aborted) {
    const interactionUrl = new URL(
      `/api/issues/${encodeURIComponent(input.issueId)}/interactions`,
      `${input.paperclipApiUrl.replace(/\/+$/, "")}/`,
    ).toString();
    let response: Response | null = null;
    try {
      response = await fetch(interactionUrl.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: input.authorizationHeaderValue,
          "X-Paperclip-Run-Id": input.runId,
        },
        signal: input.signal,
      });
    } catch {
      response = null;
    }

    if (response && response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const items = Array.isArray(body)
        ? body
        : Array.isArray(asRecord(body)?.interactions)
          ? (asRecord(body)?.interactions as unknown[])
          : null;
      if (items) {
        const matches = items.filter((item) => {
          const record = asRecord(item);
          return record
            && (record.id === input.interactionId || record.idempotencyKey === input.idempotencyKey);
        });
        if (matches.length === 1) {
          const record = asRecord(matches[0]);
          const result = asRecord(record?.result);
          const status = typeof record?.status === "string" ? record.status : "";
          // A cancelled or expired card is an unanswered approval: deny immediately
          // rather than waiting out the budget.
          if (result?.cancelled === true) return unanswered;
          if (status === "cancelled" || status === "expired" || result?.expirationReason) return unanswered;
          if (status === "pending") {
            // The interaction list is the only push-free signal available; a failed read is
            // not an answer, so keep waiting for the next tick.
          } else {
            // A human resolved the card. An answer this adapter cannot read still denies, but
            // it is a decision the board made, so the run is not failed for being unanswered.
            return {
              choice: resolveHermesApprovalChoice(record),
              answered: status === "answered" || status === "accepted" || status === "rejected",
            };
          }
        }
        // A card that was superseded by a newer card for the same request: the last one a
        // human actually resolved wins.
        if (matches.length > 1) {
          const acted = matches.filter((item) => {
            const status = asRecord(item)?.status;
            return typeof status === "string" && status !== "pending" && status.length > 0;
          });
          if (acted.length >= 1) {
            const record = asRecord(acted[acted.length - 1]);
            const status = typeof record?.status === "string" ? record.status : "";
            if (status === "answered" || status === "accepted" || status === "rejected") {
              return { choice: resolveHermesApprovalChoice(record), answered: true };
            }
          }
        }
      }
    }

    const remaining = deadline - input.nowMs();
    if (remaining <= 0) return unanswered;
    await delay(Math.min(APPROVAL_POLL_INTERVAL_MS, remaining), input.signal);
  }
  return unanswered;
}

/**
 * One human approval round trip (§3.1): post the card, wait for the answer, answer Hermes.
 * The returned choice is always a real Hermes choice — a bridge that could not deliver a
 * human decision reports why and denies.
 */
async function runApprovalBridge(input: {
  ctx: AdapterExecutionContext;
  state: ExecutionState;
  approval: HermesApprovalRequest;
  baseUrl: URL;
  headers: Record<string, string>;
  approvalTimeoutMs: number;
  deadlineMs: number;
  signal: AbortSignal;
  redactText: TextRedactor;
  nowMs: () => number;
}): Promise<{ choice: HermesApprovalChoice; answered: boolean; failure: BridgeFailure | null }> {
  const paperclipApiUrl = ctxRuntimeApiUrl(input.ctx);
  const authToken = input.ctx.authToken;
  const issueId = issueIdFromContext(input.ctx);
  if (!paperclipApiUrl || !authToken || !input.ctx.runId || !issueId) {
    return {
      choice: "deny",
      answered: false,
      failure: {
        code: APPROVAL_BRIDGE_UNAVAILABLE,
        message: "The Hermes approval bridge needs the Paperclip API URL, a run access token, and an issue.",
      },
    };
  }
  // R4: one absolute deadline covers every awaited approval call. With no time left
  // we refuse without creating a card or making even one request.
  const approvalDeadline = approvalDeadlineMs({
    approvalTimeoutMs: input.approvalTimeoutMs,
    deadlineMs: input.deadlineMs,
    nowMs: input.nowMs,
  });
  if (approvalDeadline <= input.nowMs()) {
    return {
      choice: "deny",
      answered: false,
      failure: {
        code: APPROVAL_TIMED_OUT,
        message: "There is no time left in this run to wait for an approval, so the command was denied.",
      },
    };
  }
  // shortcut: this timeout signal lives until it fires even after the bridge
  // returns (AbortSignal.any keeps a reference to it). Harmless for the bounded
  // approvalTimeoutSec window; upgrade if the bridge ever outlives a long budget.
  const signal = AbortSignal.any([
    input.signal,
    AbortSignal.timeout(Math.max(1, approvalDeadline - input.nowMs())),
  ]);

  const key = approvalKeyFor(input.ctx.runId, input.approval);
  if (!key) {
    return {
      choice: "deny",
      answered: false,
      failure: {
        code: APPROVAL_BRIDGE_FAILED,
        message: "The Paperclip approval id for this Hermes approval is too long.",
      },
    };
  }

  // Redact exact known credentials first, then hand off to the card builder,
  // which applies generic secret redaction before any length bound (R3).
  const body = buildApprovalInteractionBody({
    key,
    command: input.approval.command === null ? null : input.redactText(input.approval.command),
    reason: input.approval.reason === null ? null : input.redactText(input.approval.reason),
    allowed: input.approval.allowed,
  });

  let interactionId: string | null = null;
  try {
    if (body.refused === true) {
      // The command could not be fully presented to a human; deny without
      // creating a card, but still tell Hermes so the run cannot hang.
      throw new Error(String(body.summary));
    }
    ({ interactionId } = await createApprovalInteraction({
      paperclipApiUrl,
      authToken,
      runId: input.ctx.runId,
      issueId,
      body,
      signal,
    }));
  } catch (err) {
    return {
      choice: "deny",
      answered: false,
      failure: {
        // An operator stop is a cancelled run, not a broken bridge (R4).
        code: input.signal.aborted ? APPROVAL_RUN_CANCELLED : APPROVAL_BRIDGE_FAILED,
        message: err instanceof Error ? err.message : "Paperclip rejected the approval request.",
      },
    };
  }

  // A response that never arrives is answered with a deny; the SSE stream stays alive (§3.1).
  await input.ctx.onLog(
    "stdout",
    `[${APPROVAL_MARKER} run=${input.state.runId} request=${input.approval.requestId} card=${interactionId ?? "unknown"}]\n`,
  );

  const decision = await pollForApprovalAnswer({
    paperclipApiUrl,
    authorizationHeaderValue: `Bearer ${authToken}`,
    runId: input.ctx.runId,
    issueId,
    interactionId: interactionId ?? "",
    idempotencyKey: key,
    deadlineMs: approvalDeadline,
    signal,
    onLog: input.ctx.onLog,
    nowMs: input.nowMs,
  });
  // Consent that arrives at or after the deadline is never forwarded to Hermes (R4).
  const answered = decision.answered && input.nowMs() < approvalDeadline;
  const choice = answered ? decision.choice : "deny";

  // A positive decision is consent that only holds while the run is still live.
  // If the operator cancelled (or the wait budget expired) while the human was
  // deciding, the cancel wins: never hand Hermes a "run it" after a stop. Only
  // the deny side may use the cleanup window, because refusing is always safe.
  if (choice !== "deny" && signal.aborted) {
    return {
      choice: "deny",
      answered: false,
      failure: {
        code: APPROVAL_RUN_CANCELLED,
        message: "The run was cancelled before the approval decision could be delivered.",
      },
    };
  }

  const delivered = await postApproval({
    baseUrl: input.baseUrl,
    headers: input.headers,
    runId: input.state.runId,
    request: input.approval,
    key,
    choice,
    // A deny must land even when the run signal is already aborted; it gets its
    // own bounded window (R4). A positive answer requires the live run signal.
    signal: choice === "deny" ? cleanupSignal() : signal,
    onLog: input.ctx.onLog,
  });
  if (!answered && choice === "deny" && !delivered && input.signal.aborted) {
    // The run was cancelled and even the protective deny never reached Hermes:
    // report the cancellation rather than a generic bridge failure. The caller
    // still stops and observes the remote run.
    return {
      choice: "deny",
      answered: false,
      failure: {
        code: APPROVAL_RUN_CANCELLED,
        message: "The run was cancelled and the protective deny could not be delivered to Hermes.",
      },
    };
  }
  if (answered && !delivered) {
    // A human decided but Hermes never accepted the answer: the remote run is still
    // blocked, so record the transport failure instead of streaming on forever (R5).
    return {
      choice: "deny",
      answered: false,
      failure: { code: APPROVAL_BRIDGE_FAILED, message: "Hermes did not accept the approval answer." },
    };
  }

  return { choice, answered, failure: null };
}

type HandleEventApproval = {
  baseUrl: URL;
  headers: Record<string, string>;
  config: GatewayApprovalConfig;
  now: () => number;
  signal: AbortSignal;
};

async function handleEvent(
  ctx: AdapterExecutionContext,
  state: ExecutionState,
  frame: SseFrame,
  redactText: TextRedactor,
  approval: HandleEventApproval,
): Promise<void> {
  const parsed = parseJsonData(frame.data);
  const record = asRecord(parsed);
  const eventName = eventNameFromData(parsed, frame.event);
  state.lastEventName = eventName;
  const delta = asString(record?.delta, "") || asString(record?.text_delta, "");
  const sanitizedDelta = eventName === "message.delta" && delta ? redactText(delta) : null;
  const redacted = redactForLog(parsed, [], 0, redactText);
  const eventData = sanitizedDelta !== null
    ? JSON.stringify({ delta: sanitizedDelta })
    : stringifyForLog(redacted, 8_000);
  await ctx.onLog(
    "stdout",
    `[hermes-gateway:event] run=${state.runId} event=${eventName ?? "message"} data=${eventData}\n`,
  );

  if (sanitizedDelta !== null) {
    state.outputChunks.push(sanitizedDelta);
  }

  const status = extractStatus(parsed) ?? (eventName?.startsWith("run.") ? eventName.slice(4) : null);
  if (status && TERMINAL_STATUSES.has(status)) {
    markTerminal(state, {
      runId: state.runId,
      status,
      eventName,
      payload: record,
      output: extractOutput(parsed),
    });
    return;
  }

  if (!isApprovalRequestEvent(eventName)) return;
  const request = extractApprovalRequest(parsed, eventName);
  if (!request) {
    // Fail closed: an approval we cannot describe can never be answered safely.
    await failApproval(ctx, state, approval, null, APPROVAL_UNPARSEABLE, "Hermes requested approval without a usable request_id.", redactText);
    return;
  }
  // R5: registering must never block observation; the bridge is tracked work.
  void bridgeApprovalRequest(ctx, state, approval, request, redactText, eventName, record);
}

/**
 * Takes ownership of one Hermes approval request WITHOUT blocking observation (R5). The
 * bridge runs as tracked work on the execution state so the SSE stream, status polling and
 * cancellation all stay live for the whole human wait; the returned promise is that
 * tracked work. Dedupe is bound to request AND generation: a session-authority prompt
 * re-registered at a newer generation is a new request, never a replay.
 */
function bridgeApprovalRequest(
  ctx: AdapterExecutionContext,
  state: ExecutionState,
  approval: HandleEventApproval,
  request: HermesApprovalRequest,
  redactText: TextRedactor,
  eventName: string | null,
  payload: Record<string, unknown> | null,
): Promise<void> {
  const existing = state.approvalBridge;
  if (existing && existing.requestId === request.requestId && sameApprovalBinding(existing.binding, request.binding)) {
    // An SSE replay or a status poll rediscovering the same request must never raise a
    // second card or a second answer; the work already in flight owns it.
    return existing.task;
  }
  if (existing && existing.choice === null) {
    // One approval per run is in flight and unanswered: a second request cannot be
    // queued behind it (Hermes only has one pending approval), so refuse it outright
    // rather than let it sit unanswered (fail closed).
    const busyTask = failApproval(
      ctx,
      state,
      approval,
      request,
      APPROVAL_BRIDGE_FAILED,
      "Hermes requested a second approval while another approval was still unanswered.",
      redactText,
    ).finally(() => {
      state.approvalTasks.delete(busyTask);
    });
    // The in-flight approval keeps ownership of state.approvalBridge; this refusal
    // is only tracked so settlement still waits on its deny POST.
    state.approvalTasks.add(busyTask);
    return busyTask;
  }

  const task = runApprovalBridgeRequest(ctx, state, approval, request, redactText, eventName, payload)
    .catch(async (err: unknown) => {
      // Fail closed: a bridge that died unexpectedly still has to refuse the run, never
      // leave Hermes waiting on a human nobody is representing.
      await failApproval(
        ctx,
        state,
        approval,
        request,
        APPROVAL_BRIDGE_FAILED,
        err instanceof Error ? err.message : String(err),
        redactText,
      ).catch(() => undefined);
    })
    .finally(() => {
      state.approvalTasks.delete(task);
    });
  state.approvalBridge = { requestId: request.requestId, binding: request.binding, choice: null, task };
  state.approvalTasks.add(task);
  return task;
}

/** The tracked work behind one approval: outright deny, or the human bridge and its outcome. */
async function runApprovalBridgeRequest(
  ctx: AdapterExecutionContext,
  state: ExecutionState,
  approval: HandleEventApproval,
  request: HermesApprovalRequest,
  redactText: TextRedactor,
  eventName: string | null,
  payload: Record<string, unknown> | null,
): Promise<void> {
  if (approval.config.policy === "deny") {
    // Default policy: refuse immediately so Hermes never blocks on a human who is not there.
    await failApproval(ctx, state, approval, request, APPROVAL_TIMED_OUT, "Hermes requested approval, but this adapter is headless (headlessApprovalPolicy=deny).", redactText);
    return;
  }

  const bridge = runApprovalBridge({
    ctx,
    state,
    approval: request,
    baseUrl: approval.baseUrl,
    headers: approval.headers,
    approvalTimeoutMs: approval.config.timeoutMs,
    deadlineMs: approval.config.deadlineMs,
    signal: approval.signal,
    redactText,
    nowMs: approval.now,
  });
  await ctx.onLog("stdout", `[${APPROVAL_MARKER} run=${state.runId} request=${request.requestId} waiting for a human decision]\n`);

  const { choice, answered, failure } = await bridge;
  if (state.approvalBridge) state.approvalBridge.choice = choice;
  if (failure) {
    // A bridge that could not run at all still has to refuse the Hermes run, otherwise Hermes
    // waits out its own approval timer with nobody able to answer.
    await failApproval(ctx, state, approval, request, failure.code, failure.message, redactText);
    return;
  }
  // A human decision (even "deny") lets Hermes end the run on its own terms; an approval that
  // was never answered is this run's failure, so it stops here instead of streaming forever (§3.3).
  const terminalFailure = answered ? null : {
    code: APPROVAL_TIMED_OUT,
    message: "Hermes requested approval and the deny was sent, but no human decision was received.",
  };
  if (terminalFailure) {
    await ctx.onLog(
      "stderr",
      `[${APPROVAL_MARKER} run=${state.runId} request=${request.requestId} unanswered approval denied]\n`,
    );
    markTerminal(state, {
      runId: state.runId,
      status: "failed",
      eventName,
      payload,
      output: null,
      errorCode: terminalFailure.code,
      errorMessage: terminalFailure.message,
    });
    return;
  }
  await ctx.onLog("stdout", `[${APPROVAL_MARKER} run=${state.runId} request=${request.requestId} decision=${choice}]\n`);
  // Approved: the run resumes on Hermes; keep consuming this stream.
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

async function pollStatus(input: {
  ctx: AdapterExecutionContext;
  baseUrl: URL;
  headers: Record<string, string>;
  state: ExecutionState;
  signal: AbortSignal;
  intervalMs: number;
  redactText?: TextRedactor;
  approval: HandleEventApproval;
}): Promise<void> {
  const redactText = input.redactText ?? sanitizeSensitiveText;
  while (!input.signal.aborted && !input.state.terminal) {
    await delay(input.intervalMs, input.signal);
    if (input.signal.aborted || input.state.terminal) break;
    try {
      const status = await fetchJson(apiUrl(input.baseUrl, `/v1/runs/${encodeURIComponent(input.state.runId)}`), {
        method: "GET",
        headers: input.headers,
        signal: input.signal,
      });
      const normalized = extractStatus(status);
      if (normalized && TERMINAL_STATUSES.has(normalized)) {
        markTerminal(input.state, {
          runId: input.state.runId,
          status: normalized,
          payload: asRecord(status),
          output: extractOutput(status),
        });
        continue;
      }
      // Recovery path: if the SSE stream dropped (or never replayed) an approval.request, the run
      // status still carries the pending request, so the human wait can be (re)started here.
      // bridgeApprovalRequest dedupes by request_id, so this never raises a second card.
      const pending = extractPendingApproval(status);
      if (pending) {
        void bridgeApprovalRequest(input.ctx, input.state, input.approval, pending, redactText, "run.status", asRecord(status));
      }
    } catch (err) {
      if (input.signal.aborted) return;
      await input.ctx.onLog("stderr", `[hermes-gateway] status poll failed: ${redactErrorMessage(err, input.redactText)}\n`);
    }
  }
}

async function consumeEvents(input: {
  ctx: AdapterExecutionContext;
  baseUrl: URL;
  headers: Record<string, string>;
  state: ExecutionState;
  signal: AbortSignal;
  reconnectMs: number;
  redactText?: TextRedactor;
  approval: HandleEventApproval;
}): Promise<void> {
  const redactText = input.redactText ?? sanitizeSensitiveText;
  while (!input.signal.aborted && !input.state.terminal) {
    try {
      const response = await fetch(apiUrl(input.baseUrl, `/v1/runs/${encodeURIComponent(input.state.runId)}/events`), {
        method: "GET",
        headers: input.headers,
        signal: input.signal,
      });
      if (!response.ok) {
        await input.ctx.onLog("stderr", `[hermes-gateway] event stream HTTP ${response.status}; falling back to polling\n`);
        await delay(input.reconnectMs, input.signal);
        continue;
      }
      if (!response.body) {
        await input.ctx.onLog("stderr", "[hermes-gateway] event stream response had no body; falling back to polling\n");
        await delay(input.reconnectMs, input.signal);
        continue;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!input.signal.aborted && !input.state.terminal) {
        const { value, done } = await reader.read();
        if (done) {
          if (buffer.trim().length > 0) {
            const parsed = parseSseFramesForTest(`${buffer}\n\n`);
            buffer = parsed.rest;
            for (const frame of parsed.frames) {
              await handleEvent(input.ctx, input.state, frame, redactText, input.approval);
              if (input.state.terminal) break;
            }
          }
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseFramesForTest(buffer);
        buffer = parsed.rest;
        for (const frame of parsed.frames) {
          await handleEvent(input.ctx, input.state, frame, redactText, input.approval);
          if (input.state.terminal) break;
        }
      }
    } catch (err) {
      if (input.signal.aborted || input.state.terminal) return;
      await input.ctx.onLog("stderr", `[hermes-gateway] event stream disconnected: ${redactErrorMessage(err, input.redactText)}\n`);
    }
    if (!input.state.terminal) await delay(input.reconnectMs, input.signal);
  }
}

function parseUsage(value: unknown): UsageSummary | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const source = asRecord(record.usage) ?? record;
  const inputTokens = asNumber(source.input_tokens ?? source.inputTokens ?? source.input, 0);
  const outputTokens = asNumber(source.output_tokens ?? source.outputTokens ?? source.output, 0);
  const cachedInputTokens = asNumber(source.cached_input_tokens ?? source.cachedInputTokens, 0);
  if (inputTokens <= 0 && outputTokens <= 0 && cachedInputTokens <= 0) return undefined;
  return {
    inputTokens,
    outputTokens,
    ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
  };
}

function parseCostUsd(value: unknown): number | null {
  const record = asRecord(value);
  const raw = record?.cost_usd ?? record?.costUsd ?? asRecord(record?.usage)?.cost_usd ?? asRecord(record?.usage)?.costUsd;
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseFloat(raw) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function extractSessionId(value: unknown): string | null {
  const record = asRecord(value);
  return nonEmpty(record?.session_id) ?? nonEmpty(record?.sessionId) ?? nonEmpty(asRecord(record?.data)?.session_id);
}

function extractModel(value: unknown): string | null {
  const record = asRecord(value);
  return nonEmpty(record?.model) ?? nonEmpty(asRecord(record?.usage)?.model);
}

function extractErrorMessage(value: unknown): string | null {
  const record = asRecord(value);
  return nonEmpty(record?.error) ?? nonEmpty(record?.message) ?? nonEmpty(record?.detail) ?? extractOutput(value);
}

function terminalResultCode(status: string, errorCodeOverride?: string | null): { exitCode: number; signal: string | null; errorCode: string | null } {
  if (errorCodeOverride) return { exitCode: 1, signal: null, errorCode: errorCodeOverride };
  if (status === "completed") return { exitCode: 0, signal: null, errorCode: null };
  if (FAILURE_STATUSES.has(status)) return { exitCode: 1, signal: null, errorCode: "hermes_gateway_run_failed" };
  if (CANCELLED_STATUSES.has(status)) return { exitCode: 1, signal: "SIGTERM", errorCode: "hermes_gateway_cancelled" };
  return { exitCode: 1, signal: null, errorCode: "hermes_gateway_protocol_error" };
}

export function mapFinalResultForTest(input: {
  terminal: TerminalState;
  outputChunks: string[];
  sessionKey: string | null;
  strategy: SessionKeyStrategy;
  redactText?: TextRedactor;
}): AdapterExecutionResult {
  const redactText = input.redactText ?? sanitizeSensitiveText;
  const payload = input.terminal.payload ?? {};
  const output = redactText(
    input.terminal.output ?? extractOutput(payload) ?? input.outputChunks.join("").trim(),
  );
  const sessionId = extractSessionId(payload) ?? input.sessionKey;
  const sessionDisplayId = sessionId ? redactText(sessionId) : null;
  const mapped = terminalResultCode(input.terminal.status, input.terminal.errorCode);
  const usage = parseUsage(payload);
  const costUsd = parseCostUsd(payload);
  const errorMessage = mapped.errorCode
    ? redactText(
        input.terminal.errorMessage ??
          extractErrorMessage(payload) ??
          `Hermes run ${input.terminal.status}`,
      )
    : null;
  return {
    exitCode: mapped.exitCode,
    signal: mapped.signal,
    timedOut: false,
    provider: "hermes_gateway",
    model: extractModel(payload),
    ...(mapped.errorCode ? { errorCode: mapped.errorCode } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    ...(usage ? { usage } : {}),
    ...(costUsd !== null ? { costUsd } : {}),
    ...(output ? { summary: output.slice(0, 2_000) } : {}),
    sessionId: sessionDisplayId,
    sessionParams: {
      hermesRunId: input.terminal.runId,
      ...(sessionId && sessionDisplayId === sessionId ? { hermesSessionId: sessionId } : {}),
      strategy: input.strategy,
    },
    sessionDisplayId,
    resultJson: {
      run_id: input.terminal.runId,
      status: input.terminal.status,
      session_id: sessionDisplayId,
      last_event: input.terminal.eventName ?? null,
      output: output ?? "",
      usage: usage ?? null,
      cost_usd: costUsd,
      ...(input.terminal.resultExtras ?? {}),
    },
  };
}

async function stopRun(input: {
  ctx: AdapterExecutionContext;
  baseUrl: URL;
  headers: Record<string, string>;
  runId: string;
  redactText?: TextRedactor;
  /** When the stop is refused, retry it ONCE; each attempt is bounded. */
  retryOnce?: boolean;
}): Promise<Record<string, unknown> | null> {
  const stop = async () => {
    try {
      // The stop fetch is raced with its own bounded timer: a stalled
      // (non-abortable) request can never outlive the settlement window.
      const stopped = await Promise.race([
        fetchJson(apiUrl(input.baseUrl, `/v1/runs/${encodeURIComponent(input.runId)}/stop`), {
          method: "POST",
          headers: input.headers,
          signal: AbortSignal.timeout(FINAL_STATUS_READ_TIMEOUT_MS),
        }),
        new Promise((resolve) => setTimeout(() => resolve(undefined), FINAL_STATUS_READ_TIMEOUT_MS)),
      ]);
      if (stopped === undefined) throw new Error("stop request timed out");
      await input.ctx.onLog("stdout", `[hermes-gateway] stop requested for run ${input.runId}\n`);
      return asRecord(stopped);
    } catch (err) {
      await input.ctx.onLog("stderr", `[hermes-gateway] stop request failed: ${redactErrorMessage(err, input.redactText)}\n`);
      return null;
    }
  };
  const first = await stop();
  if (first !== null || !input.retryOnce) return first;
  // A refused stop means Hermes never accepted it — one retry before the
  // outcome is observed; an unconfirmed stop is reported, never assumed.
  return await stop();
}

/** Reads one run status; null when it cannot be read. */
async function readRunStatus(input: {
  baseUrl: URL;
  headers: Record<string, string>;
  runId: string;
}): Promise<Record<string, unknown> | null> {
  try {
    // Bounded read raced against its own timer: a stalled (non-abortable)
    // fetch must never outlive the caller's settlement window.
    const status = await Promise.race([
      fetchJson(apiUrl(input.baseUrl, `/v1/runs/${encodeURIComponent(input.runId)}`), {
        method: "GET",
        headers: input.headers,
        signal: AbortSignal.timeout(FINAL_STATUS_READ_TIMEOUT_MS),
      }),
      new Promise((resolve) => setTimeout(() => resolve(undefined), FINAL_STATUS_READ_TIMEOUT_MS)),
    ]);
    if (status === undefined) return null;
    return asRecord(status);
  } catch {
    return null;
  }
}


/**
 * Observes the run after a stop within a bounded window. Reads are bounded
 * individually (timer races) so even a stalled non-abortable fetch cannot
 * outlive the window. Fast path: a run that already reports terminal settles
 * on the first read. While the reported status keeps CHANGING (Hermes winding
 * the run down), keep polling; once it STALLS on the same non-terminal value,
 * return that observation. Repeated UNREADABLE reads back off and stop after
 * a few attempts — a dead gateway is not going to answer later in the window.
 * Returns the last readable record, or null when nothing was ever readable.
 */
async function fetchFinalStatus(input: {
  baseUrl: URL;
  headers: Record<string, string>;
  runId: string;
  deadlineMs: number;
}): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + input.deadlineMs;
  let lastRecord: Record<string, unknown> | null = null;
  let previous: string | null = null;
  let readFailures = 0;
  for (;;) {
    const budgetLeft = deadline - Date.now();
    if (budgetLeft <= 0) return lastRecord;
    // Each read gets at most its own slice of the observation window, so even
    // a stalled (non-abortable) fetch cannot push this loop past the deadline.
    const record = await Promise.race([
      readRunStatus(input),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), budgetLeft)),
    ]);
    if (record === null) {
      lastRecord = null;
      readFailures += 1;
      // Three unreadable reads in a row: the gateway is down for this window,
      // stop early and report the remote state as unresolved.
      if (readFailures >= 3) return null;
      const rem = deadline - Date.now();
      if (rem <= 0) return null;
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, rem)));
      continue;
    }
    readFailures = 0;
    lastRecord = record;
    const status = extractStatus(record);
    if (status && TERMINAL_STATUSES.has(status)) return record;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return record;
    if (status !== null && status === previous) {
      // The status stopped changing without reaching terminal: further polling
      // would burn the whole window for the same answer.
      return record;
    }
    previous = status;
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, remaining)));
  }
}

function redactErrorMessage(err: unknown, redactText: TextRedactor = sanitizeSensitiveText): string {
  if (err instanceof Error) return redactText(err.message);
  return redactText(String(err));
}

function isConfiguredLoopbackRefusal(error: HermesHttpError, baseUrl: URL): boolean {
  if (error.code !== "hermes_gateway_connect_failed" || !isLoopbackHostname(baseUrl.hostname)) return false;
  const cause = asRecord(error.transportCause);
  if (cause?.code !== "ECONNREFUSED") return false;
  const port = Number(baseUrl.port || (baseUrl.protocol === "https:" ? 443 : 80));
  const hostname = baseUrl.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const refusals = Array.isArray(cause.errors) ? cause.errors : [cause];
  if (refusals.length === 0 || refusals.length > 8) return false;
  return refusals.every((value) => {
    const refusal = asRecord(value);
    return refusal?.code === "ECONNREFUSED" && refusal.syscall === "connect" &&
      refusal.port === port && typeof refusal.address === "string" &&
      isLoopbackHostname(refusal.address) &&
      (hostname === "localhost" || refusal.address.toLowerCase() === hostname);
  });
}

function errorResult(err: unknown, baseUrl: URL, redactText: TextRedactor = sanitizeSensitiveText): AdapterExecutionResult {
  const hermesError = err as HermesHttpError;
  const code = hermesError.code ?? "hermes_gateway_protocol_error";
  const classified = hermesError.status ? classifyHttpError(hermesError.status) : null;
  const loopbackRefused = isConfiguredLoopbackRefusal(hermesError, baseUrl);
  const connectionFailure = err instanceof Error ? requestConnectionFailures.get(err) : undefined;
  const errorMessage = code === "hermes_gateway_auth_failed"
    ? `${redactErrorMessage(err, redactText)}. Check adapterConfig.apiKey matches the Hermes API_SERVER_KEY for the running gateway.`
    : loopbackRefused
      ? `${redactErrorMessage(err, redactText)}. The configured loopback gateway refers to the Paperclip server, not an agent sandbox or your browser's machine. Check that the Hermes API server is running there, or set adapterConfig.apiBaseUrl to its address reachable from the Paperclip server. Hermes Gateway connects to an already-running gateway; use hermes_local if Paperclip should launch the local Hermes CLI.`
      : redactErrorMessage(err, redactText);
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorCode: code,
    errorFamily: classified?.family ?? (code === "hermes_gateway_connect_failed" ? "transient_upstream" : null),
    retryNotBefore: hermesError.retryNotBefore ?? null,
    errorMessage,
    ...(connectionFailure ? { resultJson: { connectionFailure } } : {}),
    errorMeta: {
      // Diagnosis only: a redirected request may have received a response
      // before refusing a later connection. This never proves non-dispatch.
      ...(loopbackRefused ? { category: "gateway_loopback_connection_refused", phase: "create_run" } : {}),
      ...(hermesError.status ? { status: hermesError.status } : {}),
      ...(hermesError.body ? { body: redactForLog(hermesError.body, [], 0, redactText) as Record<string, unknown> } : {}),
    },
  };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const apiBaseUrlValue = asString(ctx.config.apiBaseUrl ?? ctx.config.url, "").trim();
  if (!apiBaseUrlValue) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "hermes_gateway_api_base_url_missing",
      errorMessage: "Hermes gateway adapter requires apiBaseUrl.",
      resultJson: { connectionFailure: gatewayConfigurationFailure("endpoint_missing") },
    };
  }

  const baseUrl = normalizeBaseUrl(apiBaseUrlValue);
  if (!baseUrl) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "hermes_gateway_api_base_url_invalid",
      errorMessage: `Invalid Hermes gateway apiBaseUrl: ${apiBaseUrlValue}`,
      resultJson: { connectionFailure: gatewayConfigurationFailure("endpoint_invalid") },
    };
  }
  if (isRemotePlainHttp(baseUrl) && !allowsInsecureRemoteHttp(ctx.config)) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "hermes_gateway_plain_http_remote_denied",
      errorMessage: remotePlainHttpDeniedMessage(baseUrl.hostname),
      resultJson: { connectionFailure: gatewayConfigurationFailure("insecure_transport") },
    };
  }

  const apiKey = nonEmpty(ctx.config.apiKey) ?? nonEmpty(ctx.config.token);
  if (!apiKey) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "hermes_gateway_api_key_missing",
      errorMessage: "Hermes gateway adapter requires apiKey.",
      resultJson: { connectionFailure: gatewayConfigurationFailure("credentials_missing") },
    };
  }

  const timeoutSec = parseNonNegativeNumber(ctx.config.timeoutSec, DEFAULT_TIMEOUT_SEC);
  const timeoutMs = timeoutSec > 0 ? Math.ceil(timeoutSec * 1000) : 0;
  const reconnectMs = Math.floor(clamp(parseNonNegativeNumber(ctx.config.eventReconnectMs, DEFAULT_EVENT_RECONNECT_MS), 250, 30_000));
  const pollIntervalMs = Math.floor(clamp(parseNonNegativeNumber(ctx.config.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS), 250, 10_000));
  const strategy = normalizeSessionKeyStrategy(ctx.config.sessionKeyStrategy);
  const sessionKey = resolveSessionKey({
    strategy,
    companyId: ctx.agent.companyId,
    agentId: ctx.agent.id,
    runId: ctx.runId,
    issueId: issueIdFromContext(ctx),
  });
  const extraHeaders = parseHeaders(ctx.config.headers);
  const runHeaders = buildHeaders({
    apiKey,
    sessionKey,
    runId: ctx.runId,
    extraHeaders,
    accept: "application/json",
    contentType: "application/json",
  });
  const eventHeaders = buildHeaders({
    apiKey,
    sessionKey,
    runId: ctx.runId,
    extraHeaders,
    accept: "text/event-stream",
  });
  const redactText = createTextRedactor([
    apiKey,
    sessionKey,
    runHeaders.Authorization,
    runHeaders["X-Hermes-Session-Key"],
    // The Paperclip run JWT must never echo back in a card, log, or result
    // either (R3), without ever being sent to the Hermes gateway.
    ctx.authToken,
    ctx.authToken ? `Bearer ${ctx.authToken}` : null,
  ]);
  const body = buildRunBody(ctx, sessionKey);
  const createRunUrl = apiUrl(baseUrl, "/v1/runs");
  const approvalConfig: GatewayApprovalConfig = {
    policy: ctx.config.headlessApprovalPolicy === "bridge" ? "bridge" : "deny",
    timeoutMs: Math.floor(clamp(parseNonNegativeNumber(ctx.config.approvalTimeoutSec, DEFAULT_APPROVAL_TIMEOUT_SEC), 15, 3_600)) * 1000,
    deadlineMs: timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY,
  };

  await ctx.onMeta?.({
    adapterType: ADAPTER_TYPE,
    command: "POST /v1/runs",
    commandArgs: [createRunUrl],
    context: {
      runId: ctx.runId,
      timeoutSec,
      eventReconnectMs: reconnectMs,
      sessionKeyStrategy: strategy,
      hasSessionKey: Boolean(sessionKey),
    },
  });
  await ctx.onLog("stdout", `[hermes-gateway] creating run at ${createRunUrl} (timeout=${timeoutSec}s, session=${strategy})\n`);
  await ctx.onLog("stdout", `[hermes-gateway] request headers (redacted): ${stringifyForLog(redactForLog(runHeaders, [], 0, redactText), 3_000)}\n`);

  let runId: string | null = null;
  try {
    // This adapter has no local child process, so crossing into the first
    // remote create request is its dispatch boundary. Report it before the
    // request can block so continuation gates may release their issue lock.
    ctx.onDispatch?.();
    const created = await fetchJson(createRunUrl, {
      method: "POST",
      headers: runHeaders,
      body: JSON.stringify(body),
    });
    runId = extractRunId(created);
    if (!runId) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: "hermes_gateway_protocol_error",
        errorMessage: "Hermes /v1/runs response did not include run_id.",
        errorMeta: { response: redactForLog(created, [], 0, redactText) as Record<string, unknown> },
      };
    }
  } catch (err) {
    return errorResult(err, baseUrl, redactText);
  }

  await ctx.onLog("stdout", `[hermes-gateway] run created: ${runId}\n`);

  const state = createExecutionState(runId);
  const controller = new AbortController();
  if (ctx.signal) {
    // An operator cancel must cut through an approval wait too (R4): the same
    // controller owns the streams and every awaited approval call.
    const abortFromOperator = () => controller.abort();
    if (ctx.signal.aborted) abortFromOperator();
    else ctx.signal.addEventListener("abort", abortFromOperator, { once: true });
  }
  void consumeEvents({
    ctx,
    baseUrl,
    headers: eventHeaders,
    state,
    signal: controller.signal,
    reconnectMs,
    redactText,
    approval: { baseUrl, headers: eventHeaders, config: approvalConfig, now: Date.now, signal: controller.signal },
  }).catch(() => undefined);
  void pollStatus({
    ctx,
    baseUrl,
    headers: eventHeaders,
    state,
    signal: controller.signal,
    intervalMs: pollIntervalMs,
    redactText,
    approval: { baseUrl, headers: eventHeaders, config: approvalConfig, now: Date.now, signal: controller.signal },
  }).catch(() => undefined);

  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    if (timeoutMs <= 0) return;
    timeoutTimer = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  // Cancellation is a settlement path of its own: with `timeoutSec: 0` there is
  // no local timeout either, so an operator stop that never reaches a Hermes
  // terminal event would leave execute() (and the agent run) pending forever.
  const cancelled = new Promise<"cancelled">((resolve) => {
    if (controller.signal.aborted) resolve("cancelled");
    else controller.signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
  });

  const outcome = await Promise.race([state.terminalPromise, timeoutPromise, cancelled]);
  if (timeoutTimer) clearTimeout(timeoutTimer);
  controller.abort();
  // A run that ended while a human approval was still open must not abandon that bridge:
  // the abort above cuts its wait short, and this bounded drain lets the exact denial land
  // before the adapter returns (§11 R5). An incomplete drain is reported, not hidden.
  const approvalSettled = await drainApprovalTasks(state);
  if (!approvalSettled) {
    await ctx.onLog("stderr", `[${APPROVAL_MARKER} run=${runId} hermes_gateway_approval_unsettled]\n`);
  }

  if (outcome === "cancelled") {
    // Stop the remote run and observe its terminal state within the same bounded
    // window the timeout path uses; an unsettled run is reported as `unknown`
    // rather than silently assumed stopped.
    await stopRun({ ctx, baseUrl, headers: eventHeaders, runId, redactText });
    const finalStatus = await fetchFinalStatus({ baseUrl, headers: eventHeaders, runId, deadlineMs: STOP_GRACE_MS });
    const finalStatusValue = extractStatus(finalStatus);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: APPROVAL_RUN_CANCELLED,
      errorMessage: "The Hermes gateway run was cancelled.",
      provider: "hermes_gateway",
      resultJson: {
        run_id: runId,
        status: finalStatusValue ?? "unknown",
        last_event: state.lastEventName,
        cancelled: true,
        approval_drained: approvalSettled,
        final_status: redactForLog(finalStatus, [], 0, redactText),
      },
      sessionParams: {
        hermesRunId: runId,
        strategy,
      },
      sessionDisplayId: sessionKey ? redactText(sessionKey) : null,
    };
  }

  if (outcome === "timeout") {
    await stopRun({ ctx, baseUrl, headers: eventHeaders, runId, redactText });
    const finalStatus = await fetchFinalStatus({ baseUrl, headers: eventHeaders, runId, deadlineMs: STOP_GRACE_MS });
    return {
      exitCode: 1,
      signal: null,
      timedOut: true,
      errorCode: "hermes_gateway_timeout",
      errorMessage: `Hermes gateway run timed out after ${timeoutSec}s.`,
      provider: "hermes_gateway",
      resultJson: {
        run_id: runId,
        status: extractStatus(finalStatus) ?? "timeout",
        last_event: state.lastEventName,
        final_status: redactForLog(finalStatus, [], 0, redactText),
      },
      sessionParams: {
        hermesRunId: runId,
        strategy,
      },
      sessionDisplayId: sessionKey ? redactText(sessionKey) : null,
    };
  }

  return mapFinalResultForTest({
    terminal: outcome,
    outputChunks: state.outputChunks,
    sessionKey,
    strategy,
    redactText,
  });
}
