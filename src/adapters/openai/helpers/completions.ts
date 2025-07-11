import { retry } from "@ubiquity-os/plugin-sdk/helpers";
import { encode } from "gpt-tokenizer";
import OpenAI from "openai";
import { checkLlmRetryableState } from "../../../helpers/retry";
import { Context } from "../../../types";
import { CompletionsModelHelper, ModelApplications } from "../../../types/llm";
import { SuperOpenAi } from "./openai";

export interface CompletionsType {
  answer: string;
  groundTruths: string[];
  tokenUsage: {
    input: number;
    output: number;
    total: number;
  };
}

export class Completions extends SuperOpenAi {
  protected context: Context;

  constructor(client: OpenAI, context: Context) {
    super(client, context);
    this.context = context;
  }

  private _getSystemPromptTemplate(groundTruths: string = "{groundTruths}", botName: string = "{botName}", localContext: string = "{localContext}"): string {
    return [
      "You Must obey the following ground truths: ",
      groundTruths + "\n",
      "You are tasked with assisting as a GitHub bot by generating responses based on provided chat history and similar responses, focusing on using available knowledge within the provided corpus, which may contain code, documentation, or incomplete information. Your role is to interpret and use this knowledge effectively to answer user questions.\n\n# Steps\n\n1. **Understand Context**: Review the chat history and any similar provided responses to understand the context.\n2. **Extract Relevant Information**: Identify key pieces of information, even if they are incomplete, from the available corpus.\n3. **Apply Knowledge**: Use the extracted information and relevant documentation to construct an informed response.\n4. **Draft Response**: Compile the gathered insights into a coherent and concise response, ensuring it's clear and directly addresses the user's query.\n5. **Review and Refine**: Check for accuracy and completeness, filling any gaps with logical assumptions where necessary.\n\n# Output Format\n\n- Concise and coherent responses in paragraphs that directly address the user's question.\n- Incorporate inline code snippets or references from the documentation if relevant.\n\n# Examples\n\n**Example 1**\n\n*Input:*\n- Chat History: \"What was the original reason for moving the LP tokens?\"\n- Corpus Excerpts: \"It isn't clear to me if we redid the staking yet and if we should migrate. If so, perhaps we should make a new issue instead. We should investigate whether the missing LP tokens issue from the MasterChefV2.1 contract is critical to the decision of migrating or not.\"\n\n*Output:*\n\"It was due to missing LP tokens issue from the MasterChefV2.1 Contract.\n\n# Notes\n\n- Ensure the response is crafted from the corpus provided, without introducing information outside of what's available or relevant to the query.\n- Consider edge cases where the corpus might lack explicit answers, and justify responses with logical reasoning based on the existing information.",
      `Your name is: ${botName}`,
      "\n",
      "Main Context",
      localContext,
    ].join("\n");
  }

  async getPromptTokens(query: string = "{query}"): Promise<number> {
    const systemTemplate = this._getSystemPromptTemplate();
    const messages = [
      {
        role: "system",
        content: [{ type: "text", text: systemTemplate }],
      },
      {
        role: "user",
        content: [{ type: "text", text: query }],
      },
    ];

    // Convert messages to string to count tokens
    const messagesStr = JSON.stringify(messages);
    return encode(messagesStr, { disallowedSpecial: new Set() }).length;
  }

  async createCompletion(query: string, model: string = "o1-mini", localContext: string[], groundTruths: string[], botName: string): Promise<CompletionsType> {
    const { logger } = this.context;
    const numTokens = await this.findTokenLength(query, localContext, groundTruths);
    logger.debug(`Number of tokens: ${numTokens}`);
    const sysMsg = this._getSystemPromptTemplate(JSON.stringify(groundTruths), botName, localContext.join("\n"));
    logger.info(`System message: ${sysMsg}`);

    const res: OpenAI.Chat.Completions.ChatCompletion = await retry(
      async () => {
        const response = await this.client.chat.completions.create({
          model: model,
          // @ts-expect-error This will be passed in the payload to OpenRouter
          models: this.context.config.models,
          messages: [
            {
              role: "system",
              content: [
                {
                  type: "text",
                  text: sysMsg,
                },
              ],
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: query,
                },
              ],
            },
          ],
          temperature: 0.2,
          top_p: 0.5,
          frequency_penalty: 0,
          presence_penalty: 0,
          response_format: {
            type: "text",
          },
        });
        if (!response.choices || !response.choices[0].message) {
          throw logger.error(`Failed to generate completion: ${JSON.stringify(response)}`);
        }
        return response;
      },
      { maxRetries: this.context.config.maxRetryAttempts, isErrorRetryable: checkLlmRetryableState }
    );

    const answer = res.choices[0].message;
    if (answer && answer.content && res.usage) {
      return {
        answer: answer.content,
        groundTruths,
        tokenUsage: { input: res.usage.prompt_tokens, output: res.usage.completion_tokens, total: res.usage.total_tokens },
      };
    }
    return { answer: "", tokenUsage: { input: 0, output: 0, total: 0 }, groundTruths };
  }

  async createGroundTruthCompletion<TApp extends ModelApplications>(
    groundTruthSource: string,
    systemMsg: string,
    model: CompletionsModelHelper<TApp>
  ): Promise<string | null> {
    const msgs = [
      {
        role: "system",
        content: systemMsg,
      },
      {
        role: "user",
        content: groundTruthSource,
      },
    ] as OpenAI.Chat.Completions.ChatCompletionMessageParam[];

    const res = await retry(
      async () => {
        const response = await this.client.chat.completions.create({
          messages: msgs,
          model: model,
          // @ts-expect-error This will be passed in the payload to OpenRouter
          models: this.context.config.models,
        });
        if (!response.choices || !response.choices[0].message || !response.choices[0].message.content) {
          throw this.context.logger.error(`Failed to generate ground truth completion: ${JSON.stringify(response)}`);
        }
        return response;
      },
      { maxRetries: this.context.config.maxRetryAttempts, isErrorRetryable: checkLlmRetryableState }
    );

    return res.choices[0].message.content;
  }

  async findTokenLength(prompt: string, additionalContext: string[] = [], localContext: string[] = [], groundTruths: string[] = []): Promise<number> {
    // disallowedSpecial: new Set() because we pass the entire diff as the prompt, we should account for all special characters
    return encode(prompt + additionalContext.join("\n") + localContext.join("\n") + groundTruths.join("\n"), { disallowedSpecial: new Set() }).length;
  }
}
