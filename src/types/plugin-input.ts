import { StaticDecode, Type as T } from "@sinclair/typebox";

/**
 * This should contain the properties of the bot config
 * that are required for the plugin to function.
 *
 * The kernel will extract those and pass them to the plugin,
 * which are built into the context object from setup().
 */

export const pluginSettingsSchema = T.Object(
  {
    model: T.String({
      default: "deepseek/deepseek-chat-v3-0324:free",
      description: "The LLM model you wish to use",
      examples: ["deepseek/deepseek-chat-v3-0324:free", "openai/gpt-4o", "openai/o1-mini"],
    }),
    openRouterBaseUrl: T.Optional(
      T.String({
        description: "The base URL for the OpenRouter API",
        examples: ["https://openrouter.ai/api/v1", "https://api.openai.com/v1"],
      })
    ),
    maxRetryAttempts: T.Number({ default: 5, description: "The number of times to retry AI prompts" }),
    similarityThreshold: T.Number({ default: 0.9, description: "When fetching embeddings context, the similarity threshold to use (1- similarityThreshold)" }),
    maxDepth: T.Optional(T.Number({ default: 3, description: "The max depth of referenced github issues to traverse for context" })), // max depth of the chat history to be fetched
    processDocumentLinks: T.Boolean({ default: true, description: "Whether to process document links" }),
  },
  { default: {} }
);

export type PluginSettings = StaticDecode<typeof pluginSettingsSchema>;
