import { Context } from "@ubiquity-os/plugin-sdk";
import {
  CommentIssueSearchResult,
  FetchParams,
  Issue,
  IssueSearchResult,
  LinkedIssues,
  PullRequestLinkedIssue,
  SimilarComment,
  SimilarIssue,
  SimplifiedComment,
} from "../types/github-types";
import { TokenLimits } from "../types/llm";
import { idIssueFromComment } from "./issue";
import { fetchPullRequestComments, fetchPullRequestDetails } from "./pull-request-fetching";
import { getTokenLimits, updateTokenCount } from "./token-utils";

export async function fetchIssue(params: FetchParams, tokenLimits?: TokenLimits): Promise<Issue | null> {
  const { octokit, payload, logger } = params.context;
  const { issueNum, owner, repo } = params;

  // Ensure we always have a valid owner and repo
  const targetOwner = owner || payload.repository.owner.login;
  const targetRepo = repo || payload.repository.name;
  // Handle both issue comments and PR review comments
  let targetIssueNum = issueNum;
  if (!targetIssueNum && payload.action === "created") {
    if ("issue" in payload) {
      targetIssueNum = payload.issue.number;
    } else if ("pull_request" in payload) {
      targetIssueNum = payload.pull_request.number;
    }
  }

  if (!targetIssueNum) {
    logger.error("Could not determine issue/PR number from payload", { payload });
    return null;
  }

  try {
    const response = await octokit.rest.issues.get({
      owner: targetOwner,
      repo: targetRepo,
      issue_number: targetIssueNum,
    });

    const issue: Issue = response.data;

    if (tokenLimits) {
      updateTokenCount(
        JSON.stringify({
          issue: issue.body,
          comments: issue.comments,
        }),
        tokenLimits
      );
      if (issue.pull_request) {
        logger.debug(`Fetched PR #${targetIssueNum} and updated token count`);
      } else {
        logger.debug(`Fetched issue #${targetIssueNum} and updated token count`);
      }
    }

    // If this is a PR, fetch additional details
    if (issue.pull_request) {
      tokenLimits = tokenLimits || (await getTokenLimits(params.context));
      issue.prDetails = await fetchPullRequestDetails(params.context, targetOwner, targetRepo, targetIssueNum, tokenLimits);
    }

    return issue;
  } catch (error) {
    logger.error(`Error fetching issue`, {
      err: error,
      owner: targetOwner,
      repo: targetRepo,
      issue_number: targetIssueNum,
    });
    return null;
  }
}

export const GET_ISSUE_BY_ID = /* GraphQL */ `
  query GetIssueById($id: ID!) {
    node(id: $id) {
      ... on Issue {
        id
        number
        title
        body
        url
        repository {
          name
          owner {
            login
          }
        }
        author {
          login
        }
        comments(first: 100) {
          nodes {
            id
            body
            author {
              login
            }
          }
        }
      }
    }
  }
`;

export const GET_COMMENT_BY_ID = /* GraphQL */ `
  query GetCommentById($id: ID!) {
    node(id: $id) {
      ... on IssueComment {
        id
        body
        author {
          login
        }
        issue {
          id
          number
          title
          url
          repository {
            name
            owner {
              login
            }
          }
        }
      }
      ... on PullRequestReviewComment {
        id
        body
        author {
          login
        }
        pullRequest {
          id
          number
          title
          url
          repository {
            name
            owner {
              login
            }
          }
        }
      }
    }
  }
`;

// Helper function to convert GitHub node ID to LinkedIssues format
export async function fetchIssueFromId(context: Context, nodeId: string): Promise<LinkedIssues | null> {
  try {
    const { octokit } = context;
    const response = await octokit.graphql<IssueSearchResult>(GET_ISSUE_BY_ID, { id: nodeId });
    const issue = response.node;

    if (!issue) return null;

    return {
      issueNumber: issue.number,
      repo: issue.repository.name,
      owner: issue.repository.owner.login,
      url: issue.url,
      body: issue.body,
      comments: issue.comments.nodes.map((comment) => ({
        id: comment.id,
        body: comment.body,
        user: { login: comment.author?.login },
        org: issue.repository.owner.login,
        repo: issue.repository.name,
        issueUrl: issue.url,
        commentType: "issue_comment",
      })),
    };
  } catch (error: unknown) {
    context.logger.error("Error fetching issue by ID", { error: error instanceof Error ? error : Error("Unknown Error"), nodeId });
    return null;
  }
}

// Helper function to convert GitHub node ID to SimplifiedComment format
export async function fetchCommentFromId(context: Context, nodeId: string): Promise<SimplifiedComment | null> {
  try {
    const { octokit } = context;
    const response = await octokit.graphql<CommentIssueSearchResult>(GET_COMMENT_BY_ID, { id: nodeId });
    const comment = response.node;

    if (!comment) return null;

    const isIssueOrPr = comment.issue || comment.pullRequest;

    if (!isIssueOrPr) {
      context.logger.error("Comment has no associated issue or PR", { commentId: comment.id });
      return null;
    }

    return {
      id: comment.id,
      body: comment.body,
      user: { login: comment.author?.login },
      org: isIssueOrPr.repository.owner.login,
      repo: isIssueOrPr.repository.name,
      issueUrl: isIssueOrPr.url,
      commentType: comment.issue ? "issue_comment" : "pull_request_review_comment",
    };
  } catch (error) {
    context.logger.error("Error fetching comment by ID", { error: error instanceof Error ? error : Error("Unknown Error"), nodeId });
    return null;
  }
}

export async function fetchSimilarContent(
  context: Context,
  similarIssues: Array<{ issue_id: string; similarity: number; text_similarity: number }>,
  similarComments: Array<{ comment_id: string; similarity: number; text_similarity: number; comment_issue_id: string }>
): Promise<{ similarIssues: SimilarIssue[]; similarComments: SimilarComment[] }> {
  const fetchedIssues: SimilarIssue[] = [];
  const fetchedComments: SimilarComment[] = [];

  // Fetch similar issues
  for (const issue of similarIssues) {
    const fetchedIssue = await fetchIssueFromId(context, issue.issue_id);
    if (fetchedIssue) {
      fetchedIssues.push({
        ...fetchedIssue,
        similarity: issue.similarity,
        text_similarity: issue.text_similarity,
        issue_id: issue.issue_id,
      });
    }
  }

  // Fetch similar comments
  for (const comment of similarComments) {
    const fetchedComment = await fetchCommentFromId(context, comment.comment_id);
    if (fetchedComment) {
      fetchedComments.push({
        ...fetchedComment,
        similarity: comment.similarity,
        text_similarity: comment.text_similarity,
        comment_id: comment.comment_id,
        comment_issue_id: comment.comment_issue_id,
      });
    }
  }

  return {
    similarIssues: fetchedIssues,
    similarComments: fetchedComments,
  };
}

function getTargetParams(params: FetchParams) {
  const { payload, logger } = params.context;
  const { issueNum, owner, repo } = params;

  const targetOwner = owner || payload.repository.owner.login;
  const targetRepo = repo || payload.repository.name;
  // Handle both issue comments and PR review comments
  let targetIssueNum = issueNum;
  if (!targetIssueNum && payload.action === "created") {
    if ("issue" in payload) {
      targetIssueNum = payload.issue.number;
    } else if ("pull_request" in payload) {
      targetIssueNum = payload.pull_request.number;
    }
  }

  if (!targetIssueNum) {
    logger.error("Could not determine issue/PR number from payload", { payload });
    return null;
  }

  return { targetOwner, targetRepo, targetIssueNum };
}

async function processLinkedIssue(
  params: FetchParams,
  linked: LinkedIssues | PullRequestLinkedIssue,
  currentTokenLimits: TokenLimits
): Promise<LinkedIssues | null> {
  const linkedIssue = await fetchIssue(
    {
      ...params,
      owner: linked.owner,
      repo: linked.repo,
      issueNum: "issueNumber" in linked ? linked.issueNumber : linked.number,
    },
    currentTokenLimits
  );

  if (!linkedIssue) return null;

  const result: LinkedIssues = {
    issueNumber: "issueNumber" in linked ? linked.issueNumber : linked.number,
    owner: linked.owner,
    repo: linked.repo,
    url: linkedIssue.html_url,
    body: linkedIssue.body,
    comments: undefined,
  };

  if (linkedIssue.pull_request) {
    result.prDetails = await fetchPullRequestDetails(
      params.context,
      linked.owner,
      linked.repo,
      "issueNumber" in linked ? linked.issueNumber : linked.number,
      currentTokenLimits
    );
  }

  return result;
}

async function fetchPrComments(params: FetchParams, targetOwner: string, targetRepo: string, targetIssueNum: number, currentTokenLimits: TokenLimits) {
  // For PRs, get both types of comments and linked issues
  const prData = await fetchPullRequestComments({
    ...params,
    owner: targetOwner,
    repo: targetRepo,
    issueNum: targetIssueNum,
  });

  // Update token count
  updateTokenCount(
    JSON.stringify(
      prData.comments.map((comment: SimplifiedComment) => ({
        id: comment.id,
        body: comment.body,
        user: comment.user,
        ...(comment.referencedCode ? { referencedCode: comment.referencedCode } : {}),
      }))
    ),
    currentTokenLimits
  );

  const linkedIssues: LinkedIssues[] = [];
  // Process linked issues from PR with their full content
  for (const linked of prData.linkedIssues) {
    // First fetch the issue/PR to determine its type
    const processedLinked = await processLinkedIssue(params, linked, currentTokenLimits);
    if (processedLinked) {
      const linkedComments = await fetchIssueComments(
        {
          ...params,
          owner: linked.owner,
          repo: linked.repo,
          issueNum: linked.number,
          currentDepth: (params.currentDepth || 0) + 1,
        },
        currentTokenLimits
      );
      processedLinked.comments = linkedComments.comments;
      linkedIssues.push(processedLinked);
    }
  }

  return { comments: prData.comments, linkedIssues };
}

async function fetchRegularIssueComments(
  params: FetchParams,
  targetOwner: string,
  targetRepo: string,
  targetIssueNum: number,
  currentTokenLimits: TokenLimits
) {
  const { octokit, logger } = params.context;
  // For regular issues, get issue comments
  try {
    const response = await octokit.rest.issues.listComments({
      owner: targetOwner,
      repo: targetRepo,
      issue_number: targetIssueNum,
    });

    logger.debug(`Fetched comments for issue #${targetIssueNum}`);

    const comments = response.data
      .filter((comment): comment is typeof comment & { body: string } => comment.user?.type !== "Bot" && typeof comment.body === "string")
      .map((comment) => ({
        body: comment.body,
        user: comment.user,
        id: comment.id.toString(),
        org: targetOwner,
        repo: targetRepo,
        issueUrl: comment.html_url,
        commentType: "issue_comment" as const,
      }));
    // Update token count
    updateTokenCount(
      JSON.stringify(
        comments.map((comment: SimplifiedComment) => ({
          body: comment.body,
          id: comment.id,
          user: comment.user,
        }))
      ),
      currentTokenLimits
    );

    const linkedIssuesFromComments = comments
      .map((comment) => idIssueFromComment(comment.body, params))
      .filter((issues): issues is LinkedIssues[] => issues !== null)
      .flat();

    const linkedIssues: LinkedIssues[] = [];
    // Process any linked issues found in comments
    for (const linked of linkedIssuesFromComments) {
      const processedLinked = await processLinkedIssue(params, linked, currentTokenLimits);
      if (processedLinked) {
        linkedIssues.push(processedLinked);
      }
    }

    return { comments, linkedIssues };
  } catch (e) {
    logger.error(`Error fetching issue comments`, {
      e,
      owner: targetOwner,
      repo: targetRepo,
      issue_number: targetIssueNum,
    });
    return { comments: [], linkedIssues: [] };
  }
}

export async function fetchIssueComments(params: FetchParams, tokenLimits?: TokenLimits) {
  const targetParams = getTargetParams(params);
  if (!targetParams) {
    return { issue: null, comments: null, linkedIssues: null };
  }

  const { targetOwner, targetRepo, targetIssueNum } = targetParams;
  const currentTokenLimits = tokenLimits || (await getTokenLimits(params.context));

  const issue = await fetchIssue(
    {
      ...params,
      owner: targetOwner,
      repo: targetRepo,
      issueNum: targetIssueNum,
    },
    currentTokenLimits
  );

  params.context.logger.debug(`Fetched issue #${targetIssueNum}`);

  if (!issue) {
    return { issue: null, comments: null, linkedIssues: null };
  }

  const result = issue.pull_request
    ? await fetchPrComments(params, targetOwner, targetRepo, targetIssueNum, currentTokenLimits)
    : await fetchRegularIssueComments(params, targetOwner, targetRepo, targetIssueNum, currentTokenLimits);

  params.context.logger.debug(`Processed ${result.comments.length} comments and ${result.linkedIssues.length} linked issues`);
  return { issue, comments: result.comments, linkedIssues: result.linkedIssues };
}
