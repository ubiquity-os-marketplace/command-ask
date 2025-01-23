import { Context } from "../types";
import { addCommentToIssue } from "./add-comment";
import { askQuestion } from "./ask-llm";
import { CallbackResult } from "../types/proxy";
import { bubbleUpErrorComment, sanitizeMetadata } from "../helpers/errors";
import { LogReturn } from "@ubiquity-os/ubiquity-os-logger";

export async function processCommentCallback(context: Context<"issue_comment.created">): Promise<CallbackResult> {
  const { logger, command, payload } = context;
  let question = "";

  if (payload.comment.user?.type === "Bot") {
    throw logger.error("Comment is from a bot. Skipping.");
  }

  if (command?.name === "ask") {
    question = command.parameters.question;
  } else if (payload.comment.body.trim().startsWith("/ask")) {
    question = payload.comment.body.trim().replace("/ask", "").trim();
  }
  if (!question) {
    throw logger.error("No question provided");
  }

  try {
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
    //Check the type of comment
    if ("pull_request" in payload) {
      // This is a pull request review comment
      await addCommentToIssue(context, answer + metadataString, {
        inReplyTo: {
          commentId: payload.comment.id,
        },
      });
    } else {
      await addCommentToIssue(context, answer + metadataString);
    }
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
