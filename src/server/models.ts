import type { ServerChatRequest } from "../deepseekWebClient.js";

export const DEFAULT_MODEL = "deepseek";
export const MODEL_LIST = [
    // flash
    "deepseek",
    "deepseek-thinking",
    "deepseek-thinking-nosearch",
    "deepseek-nosearch",
    // expert
    "deepseek-expert",
    "deepseek-expert-thinking",
    // vision
    "deepseek-vision",
    "deepseek-vision-thinking",
];

export function getModelConfig(model: string = DEFAULT_MODEL) {
    if (!model.startsWith("deepseek")) {
        throw new Error(`Unsupported model: ${model}`);
    }
    let modelType: ServerChatRequest["modelType"] = null;
    // search 的配置得看网页版脸色
    let searchEnabled = !model.includes("nosearch");
    if (model.includes("expert")) {
        modelType = "expert";
        searchEnabled = false;
    } else if (model.includes("vision")) {
        modelType = "vision";
        searchEnabled = false;
    }
    return {
        model,
        modelType,
        thinkingEnabled: model.includes("thinking"),
        searchEnabled,
    };
}