export type SubagentRecoveryDisposition =
  | "fresh-dispatch-preferred"
  | "resume-preferred"
  | "progressed-non-resumable";

type RecoveryIdentity = { agentId?: string };

export type RecoveryGuidanceInput = RecoveryIdentity & (
  | { disposition: "fresh-dispatch-preferred"; resumable: boolean }
  | { disposition: "resume-preferred"; resumable: true }
  | { disposition: "progressed-non-resumable"; resumable: false }
);

/** Fixed guidance derived from trusted structured recovery inputs, never provider or subagent prose. */
export function formatSubagentRecoveryGuidance(input: RecoveryGuidanceInput): string | undefined {
  if (
    (input.disposition === "resume-preferred" && input.resumable !== true) ||
    (input.disposition === "progressed-non-resumable" && input.resumable !== false)
  ) {
    return undefined;
  }

  const identity = input.agentId ? ` Failed agent ID: ${input.agentId}.` : "";
  const capability = input.resumable
    ? " This agent is technically resumable via SendMessage."
    : " This agent is not resumable via SendMessage.";

  switch (input.disposition) {
    case "fresh-dispatch-preferred":
      return `Recovery guidance: PiCC observed no assistant or tool progress before this transient-category failure. Prefer explicitly dispatching a fresh replacement agent rather than continuing this failed run.${identity}${capability}`;
    case "resume-preferred":
      return `Recovery guidance: Assistant or tool progress may have occurred before this transient-category failure. Resume this same agent with SendMessage so its context and completed work are retained.${identity}${capability}`;
    case "progressed-non-resumable":
      return `Recovery guidance: Assistant or tool progress may have occurred, but same-agent continuation is unavailable.${identity}${capability} Review retained work and possible tool side effects before explicitly dispatching another agent.`;
  }
}

interface MessageLike {
  role?: unknown;
  content?: unknown;
  stopReason?: unknown;
}

function hasModelContent(content: unknown): boolean {
  if (typeof content === "string") return content.length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (typeof block === "string") return block.length > 0;
    if (typeof block !== "object" || block === null) return false;
    const candidate = block as {
      type?: unknown;
      text?: unknown;
      thinking?: unknown;
      thinkingSignature?: unknown;
      redacted?: unknown;
    };
    if (candidate.type === "text") return typeof candidate.text === "string" && candidate.text.length > 0;
    if (candidate.type === "thinking") {
      return (typeof candidate.thinking === "string" && candidate.thinking.length > 0) ||
        (typeof candidate.thinkingSignature === "string" && candidate.thinkingSignature.length > 0) ||
        candidate.redacted === true;
    }
    return true;
  });
}

function messageShowsProgress(message: MessageLike): boolean {
  if (message.role === "toolResult") return true;
  if (message.role !== "assistant" || message.stopReason === "pending") return false;
  if (hasModelContent(message.content)) return true;
  return message.stopReason !== "error" && message.stopReason !== "aborted";
}

/** Separates durable progress from streamed assistant content that a terminal pending boundary can retract. */
export class SubagentRecoveryProgress {
  private durableProgress = false;
  private provisionalAssistantProgress = false;
  private observationComplete = false;
  private readonly initialMessageCount: number;

  constructor(messages: readonly MessageLike[], countExistingHistory = true) {
    this.initialMessageCount = countExistingHistory ? 0 : messages.length;
    if (countExistingHistory) this.observeMessages(messages);
  }

  markObservationAvailable(): void {
    this.observationComplete = true;
  }

  markObservationIncomplete(): void {
    this.observationComplete = false;
  }

  consume(event: unknown): void {
    if (typeof event !== "object" || event === null) return;
    const candidate = event as { type?: unknown; message?: unknown };
    if (candidate.type === "tool_execution_start") {
      this.durableProgress = true;
      return;
    }
    if (typeof candidate.message !== "object" || candidate.message === null) return;
    const message = candidate.message as MessageLike;
    if (candidate.type === "message_update") {
      if (message.role === "assistant" && hasModelContent(message.content)) {
        this.provisionalAssistantProgress = true;
      }
    } else if (candidate.type === "message_end") {
      if (message.role === "assistant" && message.stopReason === "pending") {
        this.provisionalAssistantProgress = false;
      }
      if (messageShowsProgress(message)) this.durableProgress = true;
    }
  }

  observeMessages(messages: readonly MessageLike[]): void {
    const observed = messages.slice(this.initialMessageCount);
    const last = observed[observed.length - 1];
    if (last?.role === "assistant" && last.stopReason === "pending") {
      this.provisionalAssistantProgress = false;
    }
    if (observed.some(messageShowsProgress)) this.durableProgress = true;
  }

  hasProgress(): boolean {
    return this.durableProgress || this.provisionalAssistantProgress || !this.observationComplete;
  }
}
