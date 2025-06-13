import { jest } from "@jest/globals";
import { createContext } from "./utils";

describe("Log post message test", () => {
  it("Should post a waiting message on start", async () => {
    jest.unstable_mockModule("../src/handlers/ask-llm", () => ({
      askQuestion: jest.fn(() => ({
        answer: "hello",
        tokenUsage: 1,
        groundThreshold: [],
      })),
    }));
    const { processCommentCallback } = await import("../src/handlers/comment-created-callback");
    const context = createContext("hello");
    context.config.processDocumentLinks = false;
    await processCommentCallback(context);
    expect(context.commentHandler.postComment).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        logMessage: expect.objectContaining({
          raw: expect.stringContaining("Thinking..."),
        }),
      }),
      expect.anything()
    );
  });
});
