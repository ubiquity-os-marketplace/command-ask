import { getOpenRouterModelTokenLimits } from "@ubiquity-os/plugin-sdk/helpers";
import { encode } from "gpt-tokenizer";
import { Context } from "../types";
import { TokenLimits } from "../types/llm";

export async function getTokenLimits(context: Context): Promise<TokenLimits> {
  const limits = await getOpenRouterModelTokenLimits(context.config.model);
  const modelMaxTokenLimit = limits?.contextLength ?? 128_000;
  const maxCompletionTokens = limits?.maxCompletionTokens ?? 16_384;

  return {
    modelMaxTokenLimit,
    maxCompletionTokens,
    runningTokenCount: 0,
    context,
    tokensRemaining: modelMaxTokenLimit - maxCompletionTokens,
  };
}

export function updateTokenCount(text: string, tokenLimits: TokenLimits): boolean {
  const tokenCount = encode(text, { disallowedSpecial: new Set() }).length;
  if (tokenLimits.runningTokenCount + tokenCount > tokenLimits.tokensRemaining) {
    tokenLimits.context.logger.debug(`Skipping ${text} to stay within token limits.`);
    return false;
  }
  tokenLimits.context.logger.debug(`Added ${tokenCount} tokens. Running total: ${tokenLimits.runningTokenCount}. Remaining: ${tokenLimits.tokensRemaining}`);
  tokenLimits.runningTokenCount += tokenCount;
  tokenLimits.tokensRemaining -= tokenCount;
  return true;
}
