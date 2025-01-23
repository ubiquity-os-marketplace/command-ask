import { Context } from "../types/context";

interface CommentOptions {
  inReplyTo?: {
    commentId?: number; // Required for replying to existing comments
  };
}

/**
 * Add a comment to an issue or pull request
 * @param context - The context object containing environment and configuration details
 * @param message - The message to add as a comment
 * @param options - Optional parameters for pull request review comments
 */
export async function addCommentToIssue(context: Context, message: string, options?: CommentOptions) {
  const { payload } = context;
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;

  try {
    // If this is a pull request review comment
    if (options?.inReplyTo) {
      let pullNumber: number | undefined;

      if ("issue" in payload && payload.issue.pull_request) {
        pullNumber = payload.issue.number;
      } else {
        pullNumber = undefined;
      }

      if (!pullNumber) {
        throw new Error("Cannot add review comment: not a pull request");
      }

      if (options.inReplyTo.commentId) {
        // Reply to an existing review comment
        await context.octokit.rest.pulls.createReplyForReviewComment({
          owner,
          repo,
          pull_number: pullNumber,
          body: message,
          comment_id: options.inReplyTo.commentId,
        });
      }
    } else {
      // Regular issue comment
      let issueNumber: number | undefined;
      if ("issue" in payload) {
        issueNumber = payload.issue.number;
      } else {
        issueNumber = undefined;
      }

      if (!issueNumber) {
        throw new Error("Cannot determine issue/PR number");
      }

      await context.octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body: message,
      });
    }
  } catch (e: unknown) {
    const error = e instanceof Error ? e : new Error(String(e));
    let commentType = "issue_comment";
    if (options?.inReplyTo?.commentId) {
      commentType = "review_reply";
    } else if (options?.inReplyTo) {
      commentType = "review_comment";
    }
    context.logger.error("Adding a comment failed!", {
      err: error,
      type: commentType,
    });
    throw error;
  }
}
