export interface ChatModels {
  default: string;
  models: string[];
}

export function advertisedChatModels(value: unknown): ChatModels | null {
  if (typeof value !== "object" || value === null) return null;
  const options = value as Partial<ChatModels>;
  if (typeof options.default !== "string" || !options.default || !Array.isArray(options.models)) return null;
  const models = [...new Set([options.default, ...options.models.filter((model) => typeof model === "string" && model)])];
  return { default: options.default, models };
}
