import { splitKey } from "../helpers/issue";
import { LinkedIssues, SimplifiedComment } from "../types/github-types";
import { StreamlinedComment } from "../types/llm";

/**
 * Get all streamlined comments from linked issues
 * @param linkedIssues - The linked issues to get comments from
 * @returns The streamlined comments which are grouped by issue key
 */
export async function getAllStreamlinedComments(linkedIssues: LinkedIssues[]) {
  const streamlinedComments: Record<string, StreamlinedComment[]> = {};
  for (const issue of linkedIssues) {
    const linkedIssueComments = issue.comments || [];
    if (linkedIssueComments.length === 0) continue;
    const linkedStreamlinedComments = streamlineComments(linkedIssueComments);
    if (!linkedStreamlinedComments) continue;
    for (const [key, value] of Object.entries(linkedStreamlinedComments)) {
      streamlinedComments[key] = [...(streamlinedComments[key] || []), ...value];
    }
  }
  return streamlinedComments;
}

/**
 * Create a unique key for an issue based on its URL and optional issue number
 * @param issueUrl - The URL of the issue
 * @param issue - The optional issue number
 * @returns The unique key for the issue
 */
export function createKey(issueUrl: string, issue?: number) {
  const urlParts = issueUrl.split("/");

  let key;

  if (urlParts.length === 7) {
    const [, , , issueOrg, issueRepo, , issueNumber] = urlParts;
    key = `${issueOrg}/${issueRepo}/${issueNumber}`;
  }

  if (urlParts.length === 5) {
    const [, , issueOrg, issueRepo] = urlParts;
    key = `${issueOrg}/${issueRepo}/${issue}`;
  }

  if (urlParts.length === 8) {
    const [, , , issueOrg, issueRepo, , , issueNumber] = urlParts;
    key = `${issueOrg}/${issueRepo}/${issueNumber || issue}`;
  }

  if (urlParts.length === 3) {
    const [issueOrg, issueRepo, issueNumber] = urlParts;
    key = `${issueOrg}/${issueRepo}/${issueNumber || issue}`;
  }

  if (!key) {
    throw new Error("Invalid issue url");
  }

  if (key.includes("#")) {
    key = key.split("#")[0];
  }

  return key;
}

/**
 * Streamline comments by filtering out bot comments and organizing them by issue key
 * @param comments - The comments to streamline
 * @returns The streamlined comments grouped by issue key
 */
export function streamlineComments(comments: SimplifiedComment[]) {
  const streamlined: Record<string, StreamlinedComment[]> = {};
  for (const comment of comments) {
    const { user, issueUrl: url, body } = comment;
    // Skip bot comments
    if (user?.type === "Bot") continue;
    const key = createKey(url);
    const [owner, repo] = splitKey(key);
    if (!streamlined[key]) {
      streamlined[key] = [];
    }
    if (user && body) {
      streamlined[key].push({
        user: user.login,
        body,
        id: parseInt(comment.id, 10),
        org: owner,
        repo,
        issueUrl: url,
      });
    }
  }
  return streamlined;
}
