# Hermes Gateway Onboarding

Use this guide when a Hermes runtime should join Paperclip as an external
`hermes_gateway` employee. This mirrors the OpenClaw gateway invite path, but
Hermes uses the generic agent invite/onboarding flow instead of the
OpenClaw-specific invite prompt endpoint.

## Choose The Adapter

Paperclip ships both Hermes adapters as built-ins:

- `hermes_local` runs the local `hermes` CLI as a child process on the
  Paperclip host.
- `hermes_gateway` calls an already-running Hermes API server over HTTP/SSE.

No Adapter manager installation is required for normal use. Adapter manager is
only needed when you intentionally install an external
`@paperclipai/hermes-paperclip-adapter` package to override or shadow a built-in
adapter while developing the Hermes package. If the external override is paused
or removed, Paperclip restores the built-in `hermes_local` / `hermes_gateway`
adapter.

## Required Credentials

Keep these credentials distinct:

- Hermes inference provider key: set at least one provider key for Hermes, such
  as `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
  `GEMINI_API_KEY`, `GOOGLE_API_KEY`, or `MISTRAL_API_KEY`.
- Hermes gateway key: set `API_SERVER_KEY` before starting Hermes. Paperclip
  stores the same value as `agentDefaultsPayload.apiKey` so it can call Hermes.
- Paperclip agent key: created after the board approves the join request and
  claimed once by the Hermes agent. Hermes uses this key as
  `PAPERCLIP_API_KEY` when it calls Paperclip.

Do not reuse the Hermes gateway key as the Paperclip agent key. The Hermes
gateway key authenticates Paperclip-to-Hermes traffic; the claimed Paperclip key
authenticates Hermes-to-Paperclip traffic.

## Start Hermes Gateway

Install and configure Hermes first:

```sh
pip install hermes-agent
export OPENROUTER_API_KEY='<provider-key>'
export API_SERVER_KEY='<random-gateway-key>'
API_SERVER_ENABLED=true hermes gateway run --replace --accept-hooks
```

The default Hermes API server port is `8642`. For local loopback testing,
Paperclip can usually store `http://127.0.0.1:8642` as the gateway URL. For
Docker, LAN, tailnet, or reverse-proxy setups, use a URL reachable by the
Paperclip server process.

If a run reports a loopback connection refusal, check the listener from the
Paperclip server's host or container. Its loopback address does not refer to
your browser's machine or an agent sandbox. `hermes_gateway` does not start
Hermes: start the API server at the configured address, or set `apiBaseUrl`
to its reachable address. Choose `hermes_local` when Paperclip should launch
the Hermes CLI itself. Connection guidance does not prove whether a remote
run was accepted before a redirect failed; the task remains failed and the
normal failure reporting and retry rules still apply.

Plain HTTP is accepted for loopback. Non-loopback HTTP is denied by default in
the join flow; use HTTPS for real remote gateways. For private local
development only, the join payload can set
`dangerouslyAllowInsecureRemoteHttp: true`, and the smoke scripts expose the
same escape hatch as `HERMES_GATEWAY_ALLOW_INSECURE_HTTP=1`.

## Invite From Paperclip

In the board UI:

1. Open the target company.
2. Use the add-agent button in the agent sidebar.
3. Generate an agent onboarding prompt/invite.
4. Give the generated onboarding text to the Hermes runtime.

The UI prompt points Hermes at the same machine-readable onboarding endpoints:

- `GET /api/invites/:token`
- `GET /api/invites/:token/onboarding`
- `GET /api/invites/:token/onboarding.txt`
- `GET /api/skills/index`
- `GET /api/skills/paperclip`

For CLI-driven setup, create and inspect the invite directly:

```sh
npx paperclipai invite create --company-id <company-id> --payload-json '{"requestType":"agent"}'
npx paperclipai invite show <token>
npx paperclipai invite onboarding:text <token>
```

Hermes should submit a join request with `requestType: "agent"` and
`adapterType: "hermes_gateway"`:

```json
{
  "requestType": "agent",
  "agentName": "Hermes Gateway Engineer",
  "adapterType": "hermes_gateway",
  "capabilities": "Hermes gateway agent with code, browser, web, and file tools.",
  "agentDefaultsPayload": {
    "apiBaseUrl": "http://127.0.0.1:8642",
    "apiKey": "<same-value-as-API_SERVER_KEY>",
    "paperclipApiUrl": "http://127.0.0.1:3100",
    "sessionKeyStrategy": "issue"
  }
}
```

Important URL roles:

- `agentDefaultsPayload.apiBaseUrl` is the Hermes gateway URL that Paperclip
  calls.
- `agentDefaultsPayload.paperclipApiUrl` is the Paperclip base URL that Hermes
  can call after approval and key claim.
- `PAPERCLIP_API_URL` / `PAPERCLIP_API_KEY` are injected runtime values for
  Hermes-originated Paperclip API calls after the agent is approved.

## Approve And Claim

After Hermes submits the join request:

1. In Paperclip, review the pending agent join request.
2. Approve it from the board UI, or use:

   ```sh
   npx paperclipai join list --company-id <company-id> --status pending_approval
   npx paperclipai join approve <request-id> --company-id <company-id>
   ```

3. Hermes claims the one-time agent API key:

   ```sh
   npx paperclipai join claim-key <request-id> --claim-secret <secret>
   ```

4. Store the claimed Paperclip key in Hermes runtime state or secrets. The claim
   secret and claimed key are sensitive and should not be pasted into issue
   comments, logs, or prompt text.

Once the key is claimed, create an issue assigned to the new Hermes gateway
agent and wake it through the normal Paperclip heartbeat path.

## Command Approvals

A Hermes run can pause on a guarded command and ask for consent. Paperclip
drives that through the two `hermes_gateway` fields
`headlessApprovalPolicy` and `approvalTimeoutSec`:

```json
{
  "apiBaseUrl": "http://127.0.0.1:8642",
  "apiKey": "<same-value-as-API_SERVER_KEY>",
  "paperclipApiUrl": "http://127.0.0.1:3100",
  "timeoutSec": 3600,
  "headlessApprovalPolicy": "bridge",
  "approvalTimeoutSec": 900
}
```

- `deny` (the default) refuses any approval request immediately and fails the
  run with `hermes_gateway_approval_timeout`. Use it for unattended agents
  where a guarded command should simply be a hard failure.
- `bridge` posts an approval card on the issue the run belongs to and keeps
  observing the run while a human decides. The card is a normal
  `request_checkbox_confirmation` interaction on the issue thread with
  `resolverPolicy: "human_only"` — only a board user can answer it. The offered
  options mirror the Hermes request's canonical `choices` field (the
  `allowed_choices` alias is consulted only when `choices` is absent and never
  widens it), always include Deny, and fall back to just Allow once / Deny when
  the request advertises nothing. The adapter forwards the chosen id unchanged
  to `POST /v1/runs/{run_id}/approval` (with `execution_generation` for
  session-authority approvals) and keeps streaming until Hermes finishes. Only
  one approval is in flight at a time; a second request while a card is still
  unanswered is refused as a bridge failure, never queued.

Anything other than a clear human answer is a deny — no answer, an expired or
cancelled card, a card superseded by a newer one, an answer the adapter cannot
parse, or a positive answer for a run the operator has already cancelled (the
cancel wins and a protective deny is sent instead). A bridge that cannot reach
Paperclip (no `paperclipApiUrl`, no run access token, no issue) fails the run
rather than approving anything. Every refused approval stops the remote Hermes
run and records the observed status (`approval_stop_status`;
`approval_remote_unsettled: true` when the stop could not be confirmed), while
a human decision — even deny — lets Hermes end the run itself.

`timeoutSec` remains the hard wall for the whole run, and the approval wait is
part of it, so the effective human budget is
`min(approvalTimeoutSec, time left in the run - 10s)`. That single deadline
bounds every approval request at once — the card POST, each answer poll and the
final deny — so a stalled HTTP call cannot outlive the run budget; with no
budget left, no card is posted and the command is denied immediately. Because interactive
gateway work routinely outlasts the 600-second default, operators commonly
configure `timeoutSec` well above it, as in the example above; raise
`approvalTimeoutSec` in step with it and keep it comfortably below `timeoutSec`
so there is still time to do the approved work. Hermes has its own approval
timer that Paperclip cannot read, so set `approvalTimeoutSec` to the value the
Hermes server is configured with (about 300 seconds by default); a longer
`approvalTimeoutSec` does not keep the request open on the Hermes side
indefinitely.

The adapter needs the run-scoped Paperclip access token to post the card, which
is why `hermes_gateway` is registered with `supportsLocalAgentJwt`. Command text
in the card and in every run-log path (including the raw SSE event line) is
redacted, and the Hermes API key is never forwarded to Paperclip. The complete
redacted command is always shown in the card's details; if it exceeds Paperclip's
size cap — or contains Markdown that could break out of the card, such as triple
backticks — the adapter posts no card and denies the command rather than
truncating or misrendering what a human would be asked to approve.

Settlement limits to know: the final deny POST is best-effort, so if the
Hermes API is unreachable or the deadline has passed, Hermes' own server-side
approval timer is the backstop deny — the adapter then reports the remote state
as unsettled (`approval_remote_unsettled` in the run result) instead of hanging;
and a card still pending when the run has already ended cannot be cancelled by
the adapter — it stays in the thread, and answering it later changes nothing.
Because the card is a `request_checkbox_confirmation`, the platform's standard
accepted-confirmation handling can move an agent's own `in_review` issue back to
`todo` if the agent accepts the card itself; approve approval cards as a board
user.

## Local Fresh-State Smoke

For a fresh Docker-backed Hermes gateway and end-to-end Paperclip join/run
verification, use:

```sh
PAPERCLIP_API_URL=http://127.0.0.1:3100 \
PAPERCLIP_AUTH_HEADER='Bearer <board-token>' \
pnpm smoke:hermes-gateway-e2e
```

The E2E smoke:

- builds a fresh Hermes gateway container
- seeds a minimal non-secret Hermes model config
- passes provider keys from the host environment without printing them
- verifies Hermes `/health`, `/v1/capabilities`, `/v1/runs`, SSE, and stop
- creates and approves a Paperclip agent-only invite
- joins as `hermes_gateway`
- wakes the agent on a smoke issue
- removes Paperclip and Docker test state on success

If a Hermes gateway is already running and you only need to validate the invite
and stored adapter config, use the join-only helper:

```sh
API_SERVER_ENABLED=true API_SERVER_KEY='<gateway-key>' hermes gateway run --replace --accept-hooks

PAPERCLIP_API_URL=http://127.0.0.1:3100 \
PAPERCLIP_AUTH_HEADER='Bearer <board-token>' \
HERMES_GATEWAY_API_BASE_URL=http://127.0.0.1:8642 \
HERMES_GATEWAY_API_KEY='<gateway-key>' \
pnpm smoke:hermes-gateway-join
```

See [HERMES_GATEWAY_SMOKE.md](./HERMES_GATEWAY_SMOKE.md) for Docker Desktop,
Linux, same-network Docker, LAN/private-network, and reverse-proxy/TLS examples.

## Install Entry Points

Use these entry points depending on who is driving setup:

- Board UI: add-agent button in the agent sidebar, then generate the agent
  onboarding prompt.
- Invite API: `GET /api/invites/:token/onboarding.txt` for the generated
  llm.txt-style setup instructions.
- CLI invite flow: `npx paperclipai invite create`, `invite show`,
  `invite onboarding:text`, `join approve`, and `join claim-key`.
- Smoke helpers: `pnpm smoke:hermes-gateway-e2e` for fresh-state Docker
  verification and `pnpm smoke:hermes-gateway-join` for an already-running
  gateway.
- Adapter development override: Adapter manager can install
  `@paperclipai/hermes-paperclip-adapter` as an external override, but normal
  operators should use the built-in `hermes_local` and `hermes_gateway`
  adapters.
