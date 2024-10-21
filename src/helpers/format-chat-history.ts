import { Context } from "../types";
import { StreamlinedComment, StreamlinedComments } from "../types/llm";
import { createKey, streamlineComments } from "../handlers/comments";
import { fetchPullRequestDiff, fetchIssue, fetchIssueComments } from "./issue-fetching";
import { splitKey } from "./issue";

/**
 * Formats the chat history by combining streamlined comments and specifications or bodies for issues and pull requests.
 *
 * @param context - The context object containing information about the current GitHub event.
 * @param streamlined - A record of streamlined comments for each issue or pull request.
 * @param specAndBodies - A record of specifications or bodies for each issue or pull request.
 * @returns A promise that resolves to a formatted string representing the chat history.
 */
export async function formatChatHistory(
  context: Context,
  streamlined: Record<string, StreamlinedComment[]>,
  specAndBodies: Record<string, string>
): Promise<string[]> {
  const keys = new Set([...Object.keys(streamlined), ...Object.keys(specAndBodies), createKey(context.payload.issue.html_url)]);
  const chatHistory = await Promise.all(
    Array.from(keys).map(async (key) => {
      const isCurrentIssue = key === createKey(context.payload.issue.html_url);
      return createContextBlockSection(context, key, streamlined, specAndBodies, isCurrentIssue);
    })
  );
  return Array.from(new Set(chatHistory));
}

/**
 * Generates the correct header string based on the provided parameters.
 *
 * @param prDiff - The pull request diff string, if available.
 * @param issueNumber - The issue number.
 * @param isCurrentIssue - A boolean indicating if this is the current issue.
 * @param isBody - A boolean indicating if this is for the body of the issue.
 * @returns The formatted header string.
 */
function getCorrectHeaderString(prDiff: string | null, issueNumber: number, isCurrentIssue: boolean, isBody: boolean) {
  const headerTemplates = {
    pull: `Pull #${issueNumber} Request`,
    issue: `Issue #${issueNumber} Specification`,
    convo: `Issue #${issueNumber} Conversation`,
  };

  const type = prDiff ? "pull" : "issue";
  const context = isCurrentIssue ? "current" : "linked";
  const bodyContext = isBody ? "convo" : type;

  return `${context.charAt(0).toUpperCase() + context.slice(1)} ${headerTemplates[bodyContext]}`;
}

/**
 * Creates a context block section for the given issue or pull request.
 *
 * @param context - The context object containing information about the current GitHub event.
 * @param key - The unique key representing the issue or pull request.
 * @param streamlined - A record of streamlined comments for each issue or pull request.
 * @param specAndBodies - A record of specifications or bodies for each issue or pull request.
 * @param isCurrentIssue - A boolean indicating whether the key represents the current issue.
 * @returns A formatted string representing the context block section.
 */
async function createContextBlockSection(
  context: Context,
  key: string,
  streamlined: Record<string, StreamlinedComment[]>,
  specAndBodies: Record<string, string>,
  isCurrentIssue: boolean
) {
  let comments = streamlined[key];
  if (!comments || comments.length === 0) {
    const [owner, repo, number] = splitKey(key);
    const { comments: fetchedComments } = await fetchIssueComments({
      context,
      owner,
      repo,
      issueNum: parseInt(number),
    });
    comments = streamlineComments(fetchedComments)[key];
  }
  const [org, repo, issueNum] = key.split("/");
  const issueNumber = parseInt(issueNum);
  if (!issueNumber || isNaN(issueNumber)) {
    throw context.logger.error("Issue number is not valid");
  }
  const prDiff = await fetchPullRequestDiff(context, org, repo, issueNumber);
  const specHeader = getCorrectHeaderString(prDiff, issueNumber, isCurrentIssue, false);
  let specOrBody = specAndBodies[key];
  if (!specOrBody) {
    specOrBody =
      (
        await fetchIssue({
          context,
          owner: org,
          repo,
          issueNum: issueNumber,
        })
      )?.body || "No specification or body available";
  }
  const specOrBodyBlock = [createHeader(specHeader, key), createSpecOrBody(specOrBody), createFooter(specHeader)];
  const header = getCorrectHeaderString(prDiff, issueNumber, isCurrentIssue, true);
  const repoString = `${org}/${repo} #${issueNumber}`;
  const block = [specOrBodyBlock.join(""), createHeader(header, repoString), createComment({ issueNumber, repo, org, comments }), createFooter(header)];
  if (!prDiff) {
    return block.join("");
  }
  const diffBlock = [createHeader("Linked Pull Request Code Diff", repoString), prDiff, createFooter("Linked Pull Request Code Diff")];
  return block.concat(diffBlock).join("");
}

/**
 * Creates a header string for the given content and repository string.
 *
 * @param content - The content to include in the header.
 * @param repoString - The repository string to include in the header.
 * @returns A formatted header string.
 */
function createHeader(content: string, repoString: string) {
  return `=== ${content} === ${repoString} ===\n\n`;
}

/**
 * Creates a footer string for the given content.
 *
 * @param content - The content to include in the footer.
 * @returns A formatted footer string.
 */
function createFooter(content: string) {
  return `=== End ${content} ===\n\n`;
}

/**
 * Creates a comment string from the StreamlinedComments object.
 *
 * @param comment - The StreamlinedComments object.
 * @returns A string representing the comments.
 */
function createComment(comment: StreamlinedComments) {
  if (!comment.comments) {
    return "";
  }
  // Format comments
  const formattedComments = comment.comments.map((c) => `${c.id} ${c.user}: ${c.body}\n`);
  return formattedComments.join("");
}

/**
 * Creates a formatted string for the specification or body of an issue.
 *
 * @param specOrBody - The specification or body content.
 * @returns A formatted string representing the specification or body.
 */
function createSpecOrBody(specOrBody: string) {
  return `${specOrBody}\n`;
}
