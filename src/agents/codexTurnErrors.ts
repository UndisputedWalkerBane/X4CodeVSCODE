import type { AgentEvent } from "./types";

export function isCodexImageInputError(message: string): boolean {
  return /\bmedia_images_not_supported\b|\bthis model does not accept image inputs\b/i.test(message);
}

/** Codex can report one provider failure in different envelopes during the same turn. */
export class CodexTurnErrors {
  private readonly otherMessages = new Set<string>();
  private readonly imageRequestIds = new Set<string>();
  private sawImageError = false;

  take(message: string): Extract<AgentEvent, { kind: "error" }> | undefined {
    if (!isCodexImageInputError(message)) {
      if (this.otherMessages.has(message)) return;
      this.otherMessages.add(message);
      return { kind: "error", message };
    }

    const requestId = /\brequest[ _-]?id["']?\s*[:=]\s*["']?([\w-]+)/i.exec(message)?.[1];
    // An envelope without a request ID can only identify the type of failure.
    // Its first identified copy supplies the ID for comparison with later events.
    const repeated = this.sawImageError &&
      (!requestId || this.imageRequestIds.size === 0 || this.imageRequestIds.has(requestId));
    this.sawImageError = true;
    if (requestId) this.imageRequestIds.add(requestId);
    if (repeated) return;

    const diagnostic = "media_images_not_supported" + (requestId ? `, request_id=${requestId}` : "");
    return {
      kind: "error",
      code: "media_images_not_supported",
      message: `Модель отклонила изображение в контексте чата. Чтобы работать с изображением, выберите модель с поддержкой изображений. (${diagnostic})`,
    };
  }
}
