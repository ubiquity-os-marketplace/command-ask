import { jest } from "@jest/globals";
import { Logs } from "@ubiquity-os/ubiquity-os-logger";

describe("Log post message test", () => {
  it("Should post a waiting message on start", async () => {
    const addCommentToIssue = jest.fn();
    jest.unstable_mockModule("../src/handlers/add-comment", () => ({
      addCommentToIssue,
    }));
    jest.unstable_mockModule("../src/handlers/ask-llm", () => ({
      askQuestion: jest.fn(() => ({
        answer: "hello",
        tokenUsage: 1,
        groundThreshold: [],
      })),
    }));
    const { processCommentCallback } = await import("../src/handlers/comment-created-callback");
    const context = {
      payload: {
        comment: {
          user: {
            type: "User",
          },
          body: "/ask hello",
        },
      },
      logger: new Logs("debug"),
      env: {
        UBIQUITY_OS_APP_NAME: "UbiquityOS",
      },
    } as never;

    await processCommentCallback(context);
    expect(addCommentToIssue).toHaveBeenCalledWith(
      expect.anything(),
      `> [!TIP]
> UbiquityOS is thinking...`,
      undefined
    );
  });
});
