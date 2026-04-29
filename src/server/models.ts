export const DEFAULT_MODEL = "deepseek";
export const MODEL_LIST = [
    "deepseek",
    "deepseek-thinking",
    "deepseek-expert",
    "deepseek-nosearch",
    "deepseek-thinking-nosearch",
    "deepseek-expert-nosearch",
];

export function getModelConfig(model: string = DEFAULT_MODEL) {
    if (!model.startsWith("deepseek")) {
        throw new Error(`Unsupported model: ${model}`);
    }
    return {
        model,
        modelType: model.includes("expert") ? "expert" : null,
        thinkingEnabled: model.includes("thinking"),
        searchEnabled: !model.includes("nosearch"),
    };
}