import { SupabaseClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { VoyageAIClient } from "voyageai";
import { createAdapters } from "../../src/adapters";
import { fetchRepoDependencies, fetchRepoLanguageStats } from "../../src/handlers/ground-truths/chat-bot";
import { findGroundTruths } from "../../src/handlers/ground-truths/find-ground-truths";
import { formatChatHistory } from "../../src/helpers/format-chat-history";
import { fetchSimilarContent } from "../../src/helpers/issue-fetching";
import { Context } from "../../src/types";

const SEPERATOR = "######################################################\n";

export interface FetchContext {
  formattedChat: string[];
  groundTruths: string[];
}

export interface EvalClients {
  supabase: SupabaseClient;
  voyage: VoyageAIClient;
  openai: OpenAI;
}

export function initAdapters(context: Context, clients: EvalClients): Context {
  const adapters = createAdapters(clients.supabase, clients.voyage, clients.openai, context);
  context.adapters = adapters;

  // Update adapter contexts
  Object.values(adapters).forEach((adapterGroup) => {
    Object.values(adapterGroup).forEach((adapter) => {
      if (adapter && typeof adapter === "object" && "context" in adapter) {
        adapter.context = context;
      }
    });
  });
  return context;
}

export async function fetchContext(context: Context, question: string): Promise<FetchContext> {
  const {
    config: { similarityThreshold, model, maxDepth },
    adapters: {
      supabase: { comment, issue },
      voyage: { reranker },
      openai: { completions },
    },
    logger,
  } = context;
  // Calculate total available tokens
  const modelMaxTokens = completions.getModelMaxTokenLimit(model);
  const maxCompletionTokens = completions.getModelMaxOutputLimit(model);
  let availableTokens = modelMaxTokens - maxCompletionTokens;

  // Calculate base prompt tokens (system message + query template)
  const basePromptTokens = await completions.getPromptTokens();
  availableTokens -= basePromptTokens;
  logger.debug(`Base prompt tokens: ${basePromptTokens}`);

  // Find similar comments and issues from Supabase
  const [similarCommentsSearch, similarIssuesSearch] = await Promise.all([
    comment.findSimilarComments(question, 1 - similarityThreshold, ""),
    issue.findSimilarIssues(question, 1 - similarityThreshold, ""),
  ]);

  // Fetch full content for similar items using GitHub API
  const { similarIssues, similarComments } = await fetchSimilarContent(context, similarIssuesSearch || [], similarCommentsSearch || []);

  logger.debug(`Fetched similar comments: ${JSON.stringify(similarComments)}`);
  logger.debug(`Fetched similar issues: ${JSON.stringify(similarIssues)}`);

  // Rerank similar content
  const { similarIssues: rerankedIssues, similarComments: rerankedComments } = await reranker.reRankSimilarContent(similarIssues, similarComments, question);

  // Calculate token usage from reranked content
  const similarText = [
    ...rerankedComments.map((comment) => comment.body).filter((body): body is string => !!body),
    ...rerankedIssues.map((issue) => issue.body).filter((body): body is string => !!body),
  ];
  const similarTextTokens = await completions.findTokenLength(similarText.join("\n"));
  availableTokens -= similarTextTokens;
  logger.debug(`Similar text tokens: ${similarTextTokens}`);

  // Gather repository data and calculate ground truths
  const [languages, { dependencies, devDependencies }] = await Promise.all([fetchRepoLanguageStats(context), fetchRepoDependencies(context)]);

  // Initialize ground truths
  let groundTruths: string[] = [];
  if (!languages.length) groundTruths.push("No languages found in the repository");
  if (!Reflect.ownKeys(dependencies).length) groundTruths.push("No dependencies found in the repository");
  if (!Reflect.ownKeys(devDependencies).length) groundTruths.push("No devDependencies found in the repository");

  // If not all empty, get full ground truths
  if (groundTruths.length !== 3) {
    groundTruths = await findGroundTruths(context, "chat-bot", { languages, dependencies, devDependencies });
  }

  // Calculate ground truths tokens
  const groundTruthsTokens = await completions.findTokenLength(groundTruths.join("\n"));
  availableTokens -= groundTruthsTokens;
  logger.debug(`Ground truths tokens: ${groundTruthsTokens}`);

  // Get formatted chat history with remaining tokens and reranked content
  const formattedChat = await formatChatHistory(context, maxDepth, rerankedIssues, rerankedComments, availableTokens);
  return {
    formattedChat,
    groundTruths,
  };
}

export function formattedHistory(fetchContext: FetchContext): string {
  //Iterate through the formatted chat history and add it to the final formatted chat
  let formattedChat = "#################### Chat History ####################\n";
  fetchContext.formattedChat.forEach((chat) => {
    formattedChat += chat;
  });
  formattedChat += SEPERATOR;
  //Iterate through the ground truths and add it to the final formatted chat
  formattedChat += "#################### Ground Truths ####################\n";
  fetchContext.groundTruths.forEach((truth) => {
    formattedChat += truth;
  });
  formattedChat += SEPERATOR;
  return formattedChat;
}
