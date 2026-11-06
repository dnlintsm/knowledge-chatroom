/**
 * Say why a Claude turn failed.
 *
 * ClaudeAgentAdapter turns every failed turn (a result with is_error) into one
 * generic "SDK resume/run failed; check the original files, tools, credentials
 * and execution configuration." error and drops the SDK's result, which says
 * what went wrong: a bad API key, an unknown model, a gateway error, max turns.
 * keepFailureReason() puts that reason back into the error, so the chat and the
 * agent log show it.
 */

import { ClaudeAgentAdapter } from "@ag-ui/claude-agent-sdk";
import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

const GENERIC = "SDK resume/run failed";

/** The reason a failed result gives, in one line. */
export function failureReason(result: SDKResultMessage): string {
  if (result.subtype === "success") {
    const text = result.result?.trim();
    if (text) return text;
    return result.api_error_status ? `API error ${result.api_error_status}` : "the turn ended with an error";
  }
  const details = (result.errors ?? []).map((e) => e.trim()).filter(Boolean);
  return details.length ? `${result.subtype}: ${details.join("; ")}` : result.subtype;
}

/** `err` with the reason, when it is the adapter's generic failure. */
export function withReason(err: unknown, reason: string | undefined): unknown {
  if (!reason || !(err instanceof Error) || !err.message.startsWith(GENERIC)) return err;
  return new Error(`Claude run failed: ${reason}`, { cause: err });
}

async function* tapFailures(stream: AsyncIterable<SDKMessage>, seen: { reason?: string }) {
  for await (const message of stream) {
    if (message.type === "result" && message.is_error) seen.reason = failureReason(message);
    yield message;
  }
}

type Observe = (this: unknown, stream: AsyncIterable<SDKMessage>, ...rest: unknown[]) => AsyncGenerator<SDKMessage>;

/**
 * Wrap the adapter's (private) observeRecovery, which reads the SDK stream and
 * throws the generic error on a failed result. Without it (a newer adapter),
 * runs keep the generic message and the agent says so once.
 */
export function keepFailureReason(adapterClass: typeof ClaudeAgentAdapter = ClaudeAgentAdapter): void {
  const proto = adapterClass.prototype as unknown as { observeRecovery?: Observe; __keepsReason?: boolean };
  const base = proto.observeRecovery;
  if (proto.__keepsReason) return;
  if (typeof base !== "function") {
    console.warn("[agent] ClaudeAgentAdapter.observeRecovery is gone; failed runs only show the adapter's generic error.");
    return;
  }
  proto.observeRecovery = async function* (stream, ...rest) {
    const seen: { reason?: string } = {};
    try {
      yield* base.call(this, tapFailures(stream, seen), ...rest);
    } catch (err) {
      throw withReason(err, seen.reason);
    }
  };
  proto.__keepsReason = true;
}
