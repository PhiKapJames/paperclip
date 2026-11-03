export const ADAPTER_TYPE = "hermes_gateway";
export const ADAPTER_LABEL = "Hermes Gateway";

export const DEFAULT_TIMEOUT_SEC = 600;
export const DEFAULT_EVENT_RECONNECT_MS = 2_000;
export const DEFAULT_POLL_INTERVAL_MS = 1_000;
/**
 * How long a bridged human approval may wait, in seconds. Paperclip-side only;
 * set it to the approval timeout the operator configured on their Hermes
 * deployment (Hermes' own default is about 300s, but it is configurable there).
 */
export const DEFAULT_APPROVAL_TIMEOUT_SEC = 300;
export const STOP_GRACE_MS = 10_000;
