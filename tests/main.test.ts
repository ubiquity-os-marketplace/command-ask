import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { drop } from "@mswjs/data";
import { TransformDecodeCheckError, Value } from "@sinclair/typebox/value";
import { LogReturn } from "@ubiquity-os/ubiquity-os-logger";
import { http, HttpResponse } from "msw";
import { envSchema } from "../src/types/env";
import { db } from "./__mocks__/db";
import issueTemplate from "./__mocks__/issue-template";
import { server } from "./__mocks__/node";
import repoTemplate from "./__mocks__/repo-template";
import usersGet from "./__mocks__/users-get.json";
import { createContext } from "./utils";

const TEST_QUESTION = "can you check [costs](https://github.com/user-attachments/files/20233948/costs.csv) and tell me the summary?";
const ISSUE_ID_2_CONTENT = "More context here #2";
const ISSUE_ID_3_CONTENT = "More context here #3";
const MOCK_ANSWER = "This is a mock answer for the chat";
const SPEC = "This is a demo spec for a demo task just perfect for testing.";
const BASE_LINK = "https://github.com/ubiquity/test-repo/issues/";
const ISSUE_BODY_BASE = "Related to issue";
const ISSUE_BODY_BASE_2 = "Just another issue";

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

// extractDependencies

jest.unstable_mockModule("../src/handlers/ground-truths/chat-bot", () => {
  return {
    fetchRepoDependencies: jest.fn().mockReturnValue({
      dependencies: {},
      devDependencies: {},
    }),
    extractDependencies: jest.fn(),
    // [string, number][]
    fetchRepoLanguageStats: jest.fn().mockReturnValue([
      ["JavaScript", 100],
      ["TypeScript", 200],
    ]),
  };
});

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
    jest.clearAllMocks();
    await setupTests();
  });

  it("should ask GPT a question", async () => {
    const ctx = createContext(TEST_QUESTION);
    createComments([transformCommentTemplate(1, 1, TEST_QUESTION, "ubiquity", "test-repo", true)]);
    const askQuestion = (await import("../src/handlers/ask-llm")).askQuestion;
    const res = await askQuestion(ctx, TEST_QUESTION);

    expect(res).toBeDefined();

    expect(res?.answer).toBe(MOCK_ANSWER);
  });

  it("Should throw if OPENAI_API_KEY is not defined", () => {
    const settings = {};
    expect(() => Value.Decode(envSchema, settings)).toThrow(TransformDecodeCheckError);
  });

  it("should construct the chat history correctly", async () => {
    const ctx = createContext(TEST_QUESTION);
    const debugSpy = jest.spyOn(ctx.logger, "debug");
    createComments([
      transformCommentTemplate(1, 1, ISSUE_ID_2_CONTENT, "ubiquity", "test-repo", true, "2"),
      transformCommentTemplate(2, 1, TEST_QUESTION, "ubiquity", "test-repo", true, "1"),
      transformCommentTemplate(3, 2, ISSUE_ID_3_CONTENT, "ubiquity", "test-repo", true, "3"),
      transformCommentTemplate(4, 3, "Just a comment", "ubiquity", "test-repo", true, "1"),
    ]);

    server.use(
      http.get("https://github.com/user-attachments/files/20233948/costs.csv", () => {
        return HttpResponse.text("5,4,3,2,1\n1,2,3,4,5\n");
      })
    );

    const issueCommentCreatedCallback = (await import("../src/handlers/comment-created-callback")).processCommentCallback;
    await issueCommentCreatedCallback(ctx);

    const expectedOutput = [
      "Formatted chat history: Issue Tree Structure:",
      "",
      "Issue #1 (" + BASE_LINK + "1)",
      "Body:",
      `      ${SPEC}`,
      "",
      "Comments: 2",
      `├── issue_comment-2: ubiquity: ${TEST_QUESTION} [#1](${BASE_LINK}1)`,
      `├── issue_comment-1: ubiquity: ${ISSUE_ID_2_CONTENT} [#2](${BASE_LINK}2)`,
      "",
      "Document Contents:",
      "├── costs.csv (https://github.com/user-attachments/files/20233948/costs.csv):",
      "    5,4,3,2,1",
      "    1,2,3,4,5",
      "",
      "Similar Issues:",
      "- Issue #2 (" + BASE_LINK + "2) - Similarity: 50.00%",
      `  ${ISSUE_BODY_BASE} #3`,
      "- Issue #3 (" + BASE_LINK + "3) - Similarity: 30.00%",
      `  ${ISSUE_BODY_BASE_2}`,
      "",
      "└── Issue #3 (" + BASE_LINK + "3)",
      "    Body:",
      `        ${ISSUE_BODY_BASE_2}`,
      "    Comments: 1",
      `    ├── issue_comment-4: ubiquity: Just a comment [#1](${BASE_LINK}1)`,
      "",
      "    └── Issue #2 (" + BASE_LINK + "2)",
      "        Body:",
      `            ${ISSUE_BODY_BASE} #3`,
      "        Comments: 1",
      `        ├── issue_comment-3: ubiquity: ${ISSUE_ID_3_CONTENT} [#3](${BASE_LINK}3)`,
      "",
    ].join("\n");

    // Find the index of the formatted chat history log
    const chatHistoryLogIndex = debugSpy.mock.calls.findIndex((call) => (call[0] as string).startsWith("Formatted chat history: Issue Tree Structure:"));

    const normalizedExpected = normalizeString(expectedOutput);
    const normalizedReceived = normalizeString(debugSpy.mock.calls[chatHistoryLogIndex][0] as string);
    expect(normalizedReceived).toEqual(normalizedExpected);

    // Find the index of the answer log
    const log = (ctx.commentHandler.postComment as jest.Mock).mock.calls[1][1] as LogReturn;
    expect(log.logMessage.raw).toEqual(MOCK_ANSWER);
    expect(log.metadata).toMatchObject({
      tokenUsage: {
        input: 1000,
        output: 150,
        total: 1150,
      },
      groundTruths: [MOCK_ANSWER],
    });
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
    body: body,
    url: "https://api.github.com/repos/ubiquity/test-repo/issues/comments/1",
    html_url: BASE_LINK + "1",
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
    body: `${ISSUE_BODY_BASE} #3`,
    html_url: BASE_LINK + "2",
    url: "https://api.github.com/repos/ubiquity/test-repo/issues/2",
  });

  db.issue.create({
    ...issueTemplate,
    id: 3,
    number: 3,
    body: ISSUE_BODY_BASE_2,
    html_url: BASE_LINK + "3",
    url: "https://api.github.com/repos/ubiquity/test-repo/issues/3",
  });
}

function createComments(comments: Comment[]) {
  for (const comment of comments) {
    db.comments.create({
      ...comment,
    });
  }
}
