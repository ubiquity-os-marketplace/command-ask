import { createKey, getAllStreamlinedComments } from "../handlers/comments";
import { Context } from "../types";
import { IssueWithUser, SimplifiedComment, User } from "../types/github-types";
import { FetchParams, Issue, Comments, LinkedIssues } from "../types/github-types";
import { StreamlinedComment } from "../types/llm";
import {
  dedupeStreamlinedComments,
  fetchCodeLinkedFromIssue,
  idIssueFromComment,
  mergeStreamlinedComments,
  pullReadmeFromRepoForIssue,
  splitKey,
} from "./issue";
import { handleIssue, handleSpec, handleSpecAndBodyKeys, throttlePromises } from "./issue-handling";

/**
 * Recursively fetches linked issues and processes them, including fetching comments and specifications.
 *
 * @param params - The parameters required to fetch the linked issues, including context and other details.
 * @returns A promise that resolves to an object containing linked issues, specifications, streamlined comments, and seen issue keys.
 */
export async function recursivelyFetchLinkedIssues(params: FetchParams) {
  const { linkedIssues, seen, specAndBodies, streamlinedComments } = await fetchLinkedIssues(params);
  const fetchPromises = linkedIssues.map(async (linkedIssue) => await mergeCommentsAndFetchSpec(params, linkedIssue, streamlinedComments, specAndBodies, seen));
  await throttlePromises(fetchPromises, 10);
  const linkedIssuesKeys = linkedIssues.map((issue) => createKey(`${issue.owner}/${issue.repo}/${issue.issueNumber}`));
  const specAndBodyKeys = Array.from(new Set([...Object.keys(specAndBodies), ...Object.keys(streamlinedComments), ...linkedIssuesKeys]));
  await handleSpecAndBodyKeys(specAndBodyKeys, params, dedupeStreamlinedComments(streamlinedComments), seen);
  return { linkedIssues, specAndBodies, streamlinedComments };
}

/**
 * Fetches linked issues recursively and processes them.
 *
 * @param params - The parameters required to fetch the linked issues, including context and other details.
 * @returns A promise that resolves to an object containing linked issues, specifications, streamlined comments, and seen issue keys.
 */
export async function fetchLinkedIssues(params: FetchParams) {
  const { comments, issue } = await fetchIssueComments(params);
  if (!issue) {
    return { streamlinedComments: {}, linkedIssues: [], specAndBodies: {}, seen: new Set<string>() };
  }
  if (!issue.body || !issue.html_url) {
    throw new Error("Issue body or URL not found");
  }

  if (!params.owner || !params.repo) {
    throw new Error("Owner, repo, or issue number not found");
  }
  const issueKey = createKey(issue.html_url);
  const [owner, repo, issueNumber] = splitKey(issueKey);
  const linkedIssues: LinkedIssues[] = [{ body: issue.body, comments, issueNumber: parseInt(issueNumber), owner, repo, url: issue.html_url }];
  const specAndBodies: Record<string, string> = {};
  const seen = new Set<string>([issueKey]);

  comments.push({
    body: issue.body,
    user: issue.user as User,
    id: issue.id.toString(),
    org: params.owner,
    repo: params.repo,
    issueUrl: issue.html_url,
  });

  //Fetch the README of the repository
  try {
    const readme = await pullReadmeFromRepoForIssue(params);
    if (readme) {
      comments.push({
        body: readme,
        user: issue.user as User,
        id: issue.id.toString(),
        org: params.owner,
        repo: params.repo,
        issueUrl: issue.html_url,
      });
    }
  } catch (error) {
    params.context.logger.error(`Error fetching README`, {
      error: error as Error,
      owner,
      repo,
      issue,
    });
  }

  for (const comment of comments) {
    const foundIssues = idIssueFromComment(comment.body);
    const foundCodes = comment.body ? await fetchCodeLinkedFromIssue(comment.body, params.context, comment.issueUrl) : [];
    if (foundIssues) {
      for (const linkedIssue of foundIssues) {
        const linkedKey = createKey(linkedIssue.url, linkedIssue.issueNumber);
        if (seen.has(linkedKey)) continue;

        seen.add(linkedKey);
        const { comments: fetchedComments, issue: fetchedIssue } = await fetchIssueComments({
          context: params.context,
          issueNum: linkedIssue.issueNumber,
          owner: linkedIssue.owner,
          repo: linkedIssue.repo,
        });

        if (!fetchedIssue || !fetchedIssue.body) {
          continue;
        }

        specAndBodies[linkedKey] = fetchedIssue?.body;
        linkedIssue.body = fetchedIssue?.body;
        linkedIssue.comments = fetchedComments;
        linkedIssues.push(linkedIssue);
      }
    }

    if (foundCodes) {
      for (const code of foundCodes) {
        comments.push({
          body: code.body,
          user: code.user,
          id: code.id,
          org: code.org,
          repo: code.repo,
          issueUrl: code.issueUrl,
        });
      }
    }
  }

  const streamlinedComments = await getAllStreamlinedComments(linkedIssues);
  return { streamlinedComments, linkedIssues, specAndBodies, seen };
}

/**
 * Merges comments and fetches the specification for a linked issue.
 *
 * @param params - The parameters required to fetch the linked issue, including context and other details.
 * @param linkedIssue - The linked issue for which comments and specifications need to be fetched.
 * @param streamlinedComments - A record of streamlined comments associated with issues.
 * @param specOrBodies - A record of specifications or bodies associated with issues.
 * @param seen - A set of issue keys that have already been processed to avoid duplication.
 */
export async function mergeCommentsAndFetchSpec(
  params: FetchParams,
  linkedIssue: LinkedIssues,
  streamlinedComments: Record<string, StreamlinedComment[]>,
  specOrBodies: Record<string, string>,
  seen: Set<string>
) {
  if (linkedIssue.comments) {
    const streamed = await getAllStreamlinedComments([linkedIssue]);
    const merged = mergeStreamlinedComments(streamlinedComments, streamed);
    streamlinedComments = { ...streamlinedComments, ...merged };
  }
  if (linkedIssue.body) {
    await handleSpec(params, linkedIssue.body, specOrBodies, createKey(linkedIssue.url, linkedIssue.issueNumber), seen, streamlinedComments);
  }
}

/**
 * Fetches the diff of a pull request.
 *
 * @param context - The context containing the octokit instance and logger.
 * @param org - The organization or owner of the repository.
 * @param repo - The name of the repository.
 * @param issue - The pull request number.
 * @returns A promise that resolves to the diff of the pull request as a string, or null if an error occurs.
 */
export async function fetchPullRequestDiff(context: Context, org: string, repo: string, issue: number): Promise<string | null> {
  const { octokit, logger } = context;
  try {
    const { data } = await octokit.pulls.get({
      owner: org,
      repo,
      pull_number: issue,
      mediaType: {
        format: "diff",
      },
    });
    return data as unknown as string;
  } catch (error) {
    logger.error(`Error fetching pull request diff`, {
      error: error as Error,
      owner: org,
      repo,
      pull_number: issue,
    });
    return null;
  }
}

/**
 * Fetches the details of a pull request.
 *
 * @param params - The parameters required to fetch the pull request, including context and other details.
 * @returns A promise that resolves to the pull request details or null if an error occurs.
 */
export async function fetchIssue(params: FetchParams): Promise<Issue | null> {
  const { octokit, payload, logger } = params.context;
  const { issueNum, owner, repo } = params;
  try {
    const response = await octokit.rest.issues.get({
      owner: owner || payload.repository.owner.login,
      repo: repo || payload.repository.name,
      issue_number: issueNum || payload.issue.number,
    });
    return response.data as IssueWithUser;
  } catch (error) {
    logger.error(`Error fetching issue`, {
      error: error as Error,
      owner: owner || payload.repository.owner.login,
      repo: repo || payload.repository.name,
      issue_number: issueNum || payload.issue.number,
    });
    return null;
  }
}

/**
 * Fetches the comments for a given issue or pull request.
 *
 * @param params - The parameters required to fetch the issue comments, including context and other details.
 * @returns A promise that resolves to an object containing the issue and its comments.
 */
export async function fetchIssueComments(params: FetchParams) {
  const { octokit, payload, logger } = params.context;
  const { issueNum, owner, repo } = params;
  const issue = await fetchIssue(params);
  let comments: Comments = [];
  try {
    if (issue?.pull_request) {
      const response = await octokit.rest.pulls.listReviewComments({
        owner: owner || payload.repository.owner.login,
        repo: repo || payload.repository.name,
        pull_number: issueNum || payload.issue.number,
      });
      comments = response.data;
    } else {
      const response = await octokit.rest.issues.listComments({
        owner: owner || payload.repository.owner.login,
        repo: repo || payload.repository.name,
        issue_number: issueNum || payload.issue.number,
      });
      comments = response.data;
    }
  } catch (e) {
    logger.error(`Error fetching comments `, {
      e,
      owner: owner || payload.repository.owner.login,
      repo: repo || payload.repository.name,
      issue_number: issueNum || payload.issue.number,
    });
    comments = [];
  }
  comments = comments.filter((comment) => comment.user?.type !== "Bot") as Comments;
  const simplifiedComments = castCommentsToSimplifiedComments(comments, params);

  return {
    issue,
    comments: simplifiedComments,
  };
}

/**
 * Fetches and handles an issue based on the provided key and parameters.
 *
 * @param key - The unique key representing the issue in the format "owner/repo/issueNumber".
 * @param params - The parameters required to fetch the issue, including context and other details.
 * @param streamlinedComments - A record of streamlined comments associated with issues.
 * @param seen - A set of issue keys that have already been processed to avoid duplication.
 * @returns A promise that resolves to an array of streamlined comments for the specified issue.
 */
export async function fetchAndHandleIssue(
  key: string,
  params: FetchParams,
  streamlinedComments: Record<string, StreamlinedComment[]>,
  seen: Set<string>
): Promise<StreamlinedComment[]> {
  const [owner, repo, issueNumber] = splitKey(key);
  const issueParams = { ...params, owner, repo, issueNum: parseInt(issueNumber) };
  await handleIssue(issueParams, streamlinedComments, seen);
  return streamlinedComments[key] || [];
}

function castCommentsToSimplifiedComments(comments: Comments, params: FetchParams): SimplifiedComment[] {
  if (!comments) {
    return [];
  }
  return comments
    .filter((comment) => comment.body !== undefined)
    .map((comment) => ({
      id: comment.id.toString(),
      org: params.owner || params.context.payload.repository.owner.login,
      repo: params.repo || params.context.payload.repository.name,
      issueUrl: comment.html_url,
      body: comment.body as string,
      user: comment.user as User,
      url: comment.html_url,
    }));
}
