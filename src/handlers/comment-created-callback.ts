import { LogReturn } from "@ubiquity-os/ubiquity-os-logger";
import { bubbleUpErrorComment, sanitizeMetadata } from "../helpers/errors";
import { Context } from "../types";
import { CallbackResult } from "../types/proxy";
import { addCommentToIssue } from "./add-comment";
import { askQuestion } from "./ask-llm";

export async function processCommentCallback(context: Context<"issue_comment.created" | "pull_request_review_comment.created">): Promise<CallbackResult> {
  const { logger, command, payload, env } = context;
  let question = "";

  if (payload.comment.user?.type === "Bot") {
    throw logger.error("Comment is from a bot. Skipping.");
  }

  if (command?.name === "ask") {
    question = command.parameters.question;
  } else if (payload.comment.body.trim().startsWith("/ask")) {
    question = payload.comment.body.trim().replace("/ask", "").trim();
  } else if (!question) {
    return { status: 200, reason: logger.info("No question found in comment. Skipping.").logMessage.raw };
  }

  try {
    // Determine if this is a pull request review comment by checking the event type
    const isPullRequestReviewComment = context.eventName === "pull_request_review_comment.created";

    // Add thinking message with proper comment type
    const commentOptions = isPullRequestReviewComment
      ? {
          inReplyTo: {
            commentId: isPullRequestReviewComment ? payload.comment.id : undefined,
          },
        }
      : undefined;

    await addCommentToIssue(
      context,
      `> [!TIP]
> ${env.UBIQUITY_OS_APP_NAME} is thinking...`,
      commentOptions
    );

    const response = await askQuestion(context, question);
    const { answer, tokenUsage, groundTruths } = response;
    if (!answer) {
      throw logger.error(`No answer from OpenAI`);
    }

    const metadataString = createStructuredMetadata(
      // don't change this header, it's used for tracking
      "ubiquity-os-llm-response",
      logger.info(`Answer: ${answer}`, {
        metadata: {
          groundTruths,
          tokenUsage,
        },
      })
    );

    // Post answer with proper comment type
    await addCommentToIssue(context, answer + metadataString, commentOptions);
    return { status: 200, reason: logger.info("Comment posted successfully").logMessage.raw };
  } catch (error) {
    throw await bubbleUpErrorComment(context, error, false);
  }
}

function createStructuredMetadata(header: string | undefined, logReturn: LogReturn) {
  let logMessage, metadata;
  if (logReturn) {
    logMessage = logReturn.logMessage;
    metadata = logReturn.metadata;
  }

  const jsonPretty = sanitizeMetadata(metadata);
  const stackLine = new Error().stack?.split("\n")[2] ?? "";
  const caller = stackLine.match(/at (\S+)/)?.[1] ?? "";
  const ubiquityMetadataHeader = `\n\n<!-- Ubiquity - ${header} - ${caller} - ${metadata?.revision}`;

  let metadataSerialized: string;
  const metadataSerializedVisible = ["```json", jsonPretty, "```"].join("\n");
  const metadataSerializedHidden = [ubiquityMetadataHeader, jsonPretty, "-->"].join("\n");

  if (logMessage?.type === "fatal") {
    // if the log message is fatal, then we want to show the metadata
    metadataSerialized = [metadataSerializedVisible, metadataSerializedHidden].join("\n");
  } else {
    // otherwise we want to hide it
    metadataSerialized = metadataSerializedHidden;
  }

  return metadataSerialized;
}
