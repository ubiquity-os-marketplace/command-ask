import { db } from "./__mocks__/db";
import { server } from "./__mocks__/node";
import usersGet from "./__mocks__/users-get.json";
import { expect, describe, beforeAll, beforeEach, afterAll, afterEach, it } from "@jest/globals";
import { Logs } from "@ubiquity-dao/ubiquibot-logger";
import { Context, SupportedEventsU } from "../src/types";
import { drop } from "@mswjs/data";
import issueTemplate from "./__mocks__/issue-template";
import repoTemplate from "./__mocks__/repo-template";
import { askQuestion } from "../src/handlers/ask-llm";
import { runPlugin } from "../src/plugin";
import { TransformDecodeCheckError, Value } from "@sinclair/typebox/value";
import { envSchema } from "../src/types/env";
import { CompletionsType } from "../src/adapters/openai/helpers/completions";

const TEST_QUESTION = "what is pi?";
const TEST_SLASH_COMMAND = "@UbiquityOS what is pi?";
const LOG_CALLER = "_Logs.<anonymous>";
const ISSUE_ID_2_CONTENT = "More context here #2";
const ISSUE_ID_3_CONTENT = "More context here #3";

type Comment = {
  id: number;
  user: {
    login: string;
    type: string;
  };
  body: string;
  url: string;
  html_url: string;
  owner: string;
  repo: string;
  issue_number: number;
  issue_url?: string;
  pull_request_url?: string;
};

const octokit = jest.requireActual("@octokit/rest");
jest.requireActual("openai");

beforeAll(() => {
  server.listen();
});
afterEach(() => {
  drop(db);
  server.resetHandlers();
});
afterAll(() => server.close());

// TESTS

describe("Ask plugin tests", () => {
  beforeEach(async () => {
    await setupTests();
  });

  it("should ask GPT a question", async () => {
    const ctx = createContext(TEST_SLASH_COMMAND);
    createComments([transformCommentTemplate(1, 1, TEST_QUESTION, "ubiquity", "test-repo", true)]);
    const res = await askQuestion(ctx, TEST_QUESTION);

    expect(res).toBeDefined();

    expect(res?.answer).toBe("This is a mock answer for the chat");
  });

  it("should not ask GPT a question if comment is from a bot", async () => {
    const ctx = createContext(TEST_SLASH_COMMAND);
    const infoSpy = jest.spyOn(ctx.logger, "info");

    createComments([transformCommentTemplate(1, 1, TEST_QUESTION, "ubiquity", "test-repo", true)]);
    if (!ctx.payload.comment.user) return;
    ctx.payload.comment.user.type = "Bot";
    await runPlugin(ctx);

    expect(infoSpy).toHaveBeenCalledWith("Comment is from a bot. Skipping.");
  });

  it("should not ask GPT a question if comment does not start with bot name", async () => {
    const ctx = createContext(TEST_QUESTION);
    const infoSpy = jest.spyOn(ctx.logger, "info");

    createComments([transformCommentTemplate(1, 1, TEST_QUESTION, "ubiquity", "test-repo", true)]);
    await runPlugin(ctx);

    expect(infoSpy).toHaveBeenCalledWith("Comment does not mention the app. Skipping.");
  });

  it("should not ask GPT a question if no question is provided", async () => {
    const ctx = createContext(`@UbiquityOS `);
    const infoSpy = jest.spyOn(ctx.logger, "info");

    createComments([transformCommentTemplate(1, 1, TEST_QUESTION, "ubiquity", "test-repo", true)]);
    await runPlugin(ctx);

    expect(infoSpy).toHaveBeenCalledWith("Comment is empty. Skipping.");
  });
  it("Should throw if OPENAI_API_KEY is not defined", () => {
    const settings = {};
    expect(() => Value.Decode(envSchema, settings)).toThrow(TransformDecodeCheckError);
  });

  it("should construct the chat history correctly", async () => {
    const ctx = createContext(TEST_SLASH_COMMAND);
    const infoSpy = jest.spyOn(ctx.logger, "info");
    createComments([transformCommentTemplate(1, 1, TEST_QUESTION, "ubiquity", "test-repo", true)]);
    await runPlugin(ctx);

    expect(infoSpy).toHaveBeenCalledTimes(3);
    expect(infoSpy).toHaveBeenNthCalledWith(1, `Asking question: @UbiquityOS ${TEST_QUESTION}`);
    expect(infoSpy).toHaveBeenNthCalledWith(3, "Answer: This is a mock answer for the chat", {
      caller: LOG_CALLER,
      tokenUsage: {
        input: 1000,
        output: 150,
        total: 1150,
      },
    });
  });

  it("should collect the linked issues correctly", async () => {
    const ctx = createContext(TEST_SLASH_COMMAND);
    const infoSpy = jest.spyOn(ctx.logger, "info");
    createComments([
      transformCommentTemplate(1, 1, ISSUE_ID_2_CONTENT, "ubiquity", "test-repo", true, "2"),
      transformCommentTemplate(2, 1, TEST_QUESTION, "ubiquity", "test-repo", true, "1"),
      transformCommentTemplate(3, 2, ISSUE_ID_3_CONTENT, "ubiquity", "test-repo", true, "3"),
      transformCommentTemplate(4, 3, "Just a comment", "ubiquity", "test-repo", true, "1"),
    ]);

    await runPlugin(ctx);

    expect(infoSpy).toHaveBeenCalledTimes(3);

    expect(infoSpy).toHaveBeenNthCalledWith(1, `Asking question: @UbiquityOS ${TEST_QUESTION}`);

    const prompt = `=== Current Issue #1 Specification === ubiquity/test-repo/1 ===

    This is a demo spec for a demo task just perfect for testing.
    === End Current Issue #1 Specification ===

    === Current Issue #1 Conversation === ubiquity/test-repo #1 ===

    1 ubiquity: ${ISSUE_ID_2_CONTENT} [#2](https://www.github.com/ubiquity/test-repo/issues/2)
    2 ubiquity: ${TEST_QUESTION} [#1](https://www.github.com/ubiquity/test-repo/issues/1)
    === End Current Issue #1 Conversation ===

    === Linked Issue #2 Specification === ubiquity/test-repo/2 ===

    Related to issue #3
    === End Linked Issue #2 Specification ===

    === Linked Issue #2 Conversation === ubiquity/test-repo #2 ===

    3 ubiquity: ${ISSUE_ID_3_CONTENT} [#3](https://www.github.com/ubiquity/test-repo/issues/3)
    === End Linked Issue #2 Conversation ===

   === Linked Issue #3 Specification === ubiquity/test-repo/3 ===

    Just another issue
    === End Linked Issue #3 Specification ===

    === Linked Issue #3 Conversation === ubiquity/test-repo #3 ===

    4 ubiquity: Just a comment [#1](https://www.github.com/ubiquity/test-repo/issues/1)
    4 ubiquity: Just a comment [#1](https://www.github.com/ubiquity/test-repo/issues/1)
    === End Linked Issue #3 Conversation ===\n
    `;

    const normalizedExpected = normalizeString(prompt);
    const normalizedReceived = normalizeString(infoSpy.mock.calls[1][0]);

    expect(normalizedReceived).toEqual(normalizedExpected);
  });
});

// HELPERS

function normalizeString(str: string) {
  return str.replace(/\s+/g, " ").trim();
}

function transformCommentTemplate(commentId: number, issueNumber: number, body: string, owner: string, repo: string, isIssue = true, linkTo: string = "1") {
  const COMMENT_TEMPLATE = {
    id: 1,
    user: {
      login: "ubiquity",
      type: "User",
    },
    body: TEST_QUESTION,
    url: "https://api.github.com/repos/ubiquity/test-repo/issues/comments/1",
    html_url: "https://www.github.com/ubiquity/test-repo/issues/1",
    owner: "ubiquity",
    repo: "test-repo",
    issue_number: 1,
  };

  const comment: Comment = {
    id: commentId,
    user: {
      login: COMMENT_TEMPLATE.user.login,
      type: "User",
    },
    body: body + ` [#${linkTo}](${COMMENT_TEMPLATE.html_url.replace("1", linkTo.toString())})`,
    url: COMMENT_TEMPLATE.url.replace("1", issueNumber.toString()),
    html_url: COMMENT_TEMPLATE.html_url.replace("1", issueNumber.toString()),
    owner: owner,
    repo: repo,
    issue_number: issueNumber,
  };

  if (isIssue) {
    comment.issue_url = COMMENT_TEMPLATE.html_url.replace("1", issueNumber.toString());
  } else {
    comment.pull_request_url = COMMENT_TEMPLATE.html_url.replace("1", issueNumber.toString());
  }

  return comment;
}

async function setupTests() {
  for (const item of usersGet) {
    db.users.create(item);
  }

  db.repo.create({
    ...repoTemplate,
  });

  db.issue.create({
    ...issueTemplate,
  });

  db.issue.create({
    ...issueTemplate,
    id: 2,
    number: 2,
    body: "Related to issue #3",
  });

  db.issue.create({
    ...issueTemplate,
    id: 3,
    number: 3,
    body: "Just another issue",
  });
}

function createComments(comments: Comment[]) {
  for (const comment of comments) {
    db.comments.create({
      ...comment,
    });
  }
}

function createContext(body = TEST_SLASH_COMMAND) {
  const user = db.users.findFirst({ where: { id: { equals: 1 } } });
  return {
    payload: {
      issue: db.issue.findFirst({ where: { id: { equals: 1 } } }) as unknown as Context["payload"]["issue"],
      sender: user,
      repository: db.repo.findFirst({ where: { id: { equals: 1 } } }) as unknown as Context["payload"]["repository"],
      comment: { body, user: user } as unknown as Context["payload"]["comment"],
      action: "created" as string,
      installation: { id: 1 } as unknown as Context["payload"]["installation"],
      organization: { login: "ubiquity" } as unknown as Context["payload"]["organization"],
    },
    owner: "ubiquity",
    repo: "test-repo",
    logger: new Logs("debug"),
    config: {},
    env: {
      UBIQUITY_OS_APP_NAME: "UbiquityOS",
      OPENAI_API_KEY: "test",
    },
    adapters: {
      supabase: {
        issue: {
          getIssue: async () => {
            return [
              {
                id: "1",
                markdown: "This is a demo spec for a demo task just perfect for testing.",
                plaintext: "This is a demo spec for a demo task just perfect for testing.",
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
                issue_plaintext: "Related to issue #3",
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
        },
      },
      openai: {
        completions: {
          createCompletion: async (): Promise<CompletionsType> => {
            return {
              answer: "This is a mock answer for the chat",
              tokenUsage: {
                input: 1000,
                output: 150,
                total: 1150,
              },
            };
          },
        },
      },
    },
    octokit: new octokit.Octokit(),
    eventName: "issue_comment.created" as SupportedEventsU,
  } as unknown as Context;
}
