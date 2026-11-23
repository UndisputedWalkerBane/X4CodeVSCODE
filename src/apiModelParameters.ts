// Documented Responses modes. For large models, omit aliases for the same depth.
// https://docs.abliteration.ai/capabilities/thinking
const standard = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
const abliteration = new Map<string, readonly string[]>([
  ["abliterated-model", standard],
  ["abliterated-model-large-flash", ["none", "low", "high", "max"]],
  ["abliterated-model-large-v2", ["low", "high", "max"]],
  ["abliterated-model-large", ["none", "high", "max"]],
]);

export const ABLITERATION_MODELS: readonly string[] = [...abliteration.keys()];

export function apiEffortLevels(profileId: string, model: string): readonly string[] {
  if (profileId === "abliteration") return abliteration.get(model) ?? standard;
  return standard;
}

export function isValidApiModelId(input: unknown): input is string {
  return typeof input === "string" && input.length > 0 && input.length <= 256 && !/[\s\p{C}]/u.test(input);
}
