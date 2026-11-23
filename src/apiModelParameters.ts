import models from "./abliterationModels.json";

// Documented Responses modes. For large models, omit aliases for the same depth.
// https://docs.abliteration.ai/capabilities/thinking
const standard = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
const abliteration = new Map(models.map(model => [model.id, model]));

export const ABLITERATION_MODELS: readonly string[] = [...abliteration.keys()];

// https://docs.abliteration.ai/capabilities/images
export function isTextOnlyApiModel(profileId: string | undefined, model: string | undefined): boolean {
  return profileId === "abliteration" && model !== undefined && abliteration.get(model)?.images === false;
}

export function apiImageInputError(profileId: string | undefined, model: string | undefined, hasImages: boolean): string | undefined {
  if (hasImages && isTextOnlyApiModel(profileId, model)) {
    return `Модель ${model} принимает только текст. Удалите изображения или выберите модель с поддержкой изображений, например abliterated-model-large-flash.`;
  }
}

export function apiEffortLevels(profileId: string, model: string): readonly string[] {
  if (profileId === "abliteration") return abliteration.get(model)?.efforts ?? standard;
  return standard;
}

export function isValidApiModelId(input: unknown): input is string {
  return typeof input === "string" && input.length > 0 && input.length <= 256 && !/[\s\p{C}]/u.test(input);
}
