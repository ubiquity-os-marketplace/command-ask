import { jest } from "@jest/globals";
import { Octokit } from "@octokit/rest";
import { LogReturn, Logs } from "@ubiquity-os/ubiquity-os-logger";
import { CompletionsType } from "../src/adapters/openai/helpers/completions";
import { Context, SupportedEvents } from "../src/types";
import { SimilarComment, SimilarIssue, TreeNode } from "../src/types/github-types";
import { db } from "./__mocks__/db";

const TEST_QUESTION = "what is pi?";
const ISSUE_ID_2_CONTENT = "More context here #2";
const ISSUE_ID_3_CONTENT = "More context here #3";
const MOCK_ANSWER = "This is a mock answer for the chat";
const SPEC = "This is a demo spec for a demo task just perfect for testing.";
const ISSUE_BODY_BASE = "Related to issue";

interface CommentOptions {
  raw?: boolean;
  updateComment?: boolean;
}

export function createContext(body = TEST_QUESTION) {
  const user = db.users.findFirst({ where: { id: { equals: 1 } } });
  return {
    payload: {
      issue: db.issue.findFirst({ where: { id: { equals: 1 } } }) as unknown as Context<"issue_comment.created">["payload"]["issue"],
      sender: user,
      repository: db.repo.findFirst({ where: { id: { equals: 1 } } }) as unknown as Context["payload"]["repository"],
      comment: { body, user: user } as unknown as Context["payload"]["comment"],
      action: "created" as string,
      installation: { id: 1 } as unknown as Context["payload"]["installation"],
      organization: { login: "ubiquity" } as unknown as Context["payload"]["organization"],
    },
    commentHandler: {
      postComment: jest.fn((context: Context, message: LogReturn, options: CommentOptions) => {
        console.log("Adding a comment...", message);
        return {
          id: 1,
          body: message.logMessage.raw,
          options: options,
        };
      }),
    },
    command: {
      name: "ask",
      parameters: {
        question: body,
      },
    },
    owner: "ubiquity",
    repo: "test-repo",
    logger: new Logs("debug"),
    config: {
      maxDepth: 5,
      processDocumentLinks: true,
    },
    env: {
      UBIQUITY_OS_APP_NAME: "UbiquityOS",
      OPENROUTER_API_KEY: "test",
      VOYAGEAI_API_KEY: "test",
      SUPABASE_URL: "test",
      SUPABASE_KEY: "test",
      GOOGLE_SERVICE_ACCOUNT_KEY: "test",
    },
    adapters: {
      supabase: {
        issue: {
          getIssue: async () => {
            return [
              {
                id: "1",
                markdown: SPEC,
                plaintext: SPEC,
                author_id: 1,
                created_at: new Date().toISOString(),
                modified_at: new Date().toISOString(),
                embedding: [1, 2, 3],
              },
            ];
          },
          findSimilarIssues: async () => {
            return [
              {
                issue_id: "2",
                issue_plaintext: `${ISSUE_BODY_BASE} #3`,
                similarity: 0.5,
              },
              {
                issue_id: "3",
                issue_plaintext: "Some other issue",
                similarity: 0.3,
              },
            ];
          },
        },
        comment: {
          getComments: async () => {
            return [
              {
                id: "1",
                plaintext: TEST_QUESTION,
                markdown: TEST_QUESTION,
                author_id: 1,
                created_at: new Date().toISOString(),
                modified_at: new Date().toISOString(),
                embedding: [1, 2, 3],
              },
              {
                id: "2",
                plaintext: ISSUE_ID_2_CONTENT,
                markdown: ISSUE_ID_2_CONTENT,
                author_id: 1,
                created_at: new Date().toISOString(),
                modified_at: new Date().toISOString(),
                embedding: [1, 2, 3],
              },
              {
                id: "3",
                plaintext: ISSUE_ID_3_CONTENT,
                markdown: ISSUE_ID_3_CONTENT,
                author_id: 1,
                created_at: new Date().toISOString(),
                modified_at: new Date().toISOString(),
                embedding: [1, 2, 3],
              },
              {
                id: "4",
                plaintext: "Something new",
                markdown: "Something new",
                author_id: 1,
                created_at: new Date().toISOString(),
                modified_at: new Date().toISOString(),
                embedding: [1, 2, 3],
              },
            ];
          },
          findSimilarComments: async () => {
            return [
              {
                id: "2",
                plaintext: ISSUE_ID_2_CONTENT,
                markdown: ISSUE_ID_2_CONTENT,
                author_id: 1,
                created_at: new Date().toISOString(),
                modified_at: new Date().toISOString(),
                embedding: [1, 2, 3],
              },
              {
                id: "3",
                plaintext: ISSUE_ID_3_CONTENT,
                markdown: ISSUE_ID_3_CONTENT,
                author_id: 1,
                created_at: new Date().toISOString(),
                modified_at: new Date().toISOString(),
                embedding: [1, 2, 3],
              },
              {
                id: "4",
                plaintext: "New Comment",
                markdown: "New Comment",
                author_id: 1,
                created_at: new Date().toISOString(),
                modified_at: new Date().toISOString(),
                embedding: [1, 2, 3],
              },
            ];
          },
        },
      },
      voyage: {
        embedding: {
          createEmbedding: async () => {
            return new Array(1024).fill(0);
          },
        },
        reranker: {
          reRankResults: async (similarText: string[]) => {
            return similarText;
          },
          reRankSimilarContent: async (similarIssues: SimilarIssue[], similarComments: SimilarComment[]) => {
            return {
              similarIssues,
              similarComments,
            };
          },
          reRankTreeNodes: async (rootNode: TreeNode) => {
            return rootNode;
          },
        },
      },
      google: {
        drive: {
          parseDriveLink: async () => {
            return {
              isAccessible: true,
              fileId: "123",
            };
          },
          generatePermissionUrl: async () => {
            return "https://google.com";
          },
        },
      },
      openai: {
        completions: {
          getModelMaxTokenLimit: () => {
            return 50000;
          },
          getModelMaxOutputLimit: () => {
            return 10000;
          },
          createCompletion: async (): Promise<CompletionsType> => {
            return {
              answer: MOCK_ANSWER,
              groundTruths: [MOCK_ANSWER],
              tokenUsage: {
                input: 1000,
                output: 150,
                total: 1150,
              },
            };
          },
          getPromptTokens: async (query: string): Promise<number> => {
            return query ? query.length : 100;
          },
          findTokenLength: async () => {
            return 1000;
          },
          createGroundTruthCompletion: async (): Promise<string> => {
            return `["${MOCK_ANSWER}"]`;
          },
        },
      },
    },
    octokit: new Octokit(),
    eventName: "issue_comment.created" as SupportedEvents,
  } as unknown as Context;
}
