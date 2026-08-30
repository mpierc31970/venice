import OpenAI from "openai";

const apiKey = process.env.VENICE_API_KEY;
if (!apiKey) {
  throw new Error("VENICE_API_KEY is not set. Add it to .env (see .env.example).");
}

export const VENICE_MODEL = "zai-org-glm-5-2";

export const venice = new OpenAI({
  apiKey,
  baseURL: "https://api.venice.ai/api/v1",
});
