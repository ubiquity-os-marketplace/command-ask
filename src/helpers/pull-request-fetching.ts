import { Context } from "../types";
import { FetchParams, PullRequestGraphQlResponse, PullRequestLinkedIssue, SimplifiedComment } from "../types/github-types";
import { TokenLimits } from "../types/llm";
import { processPullRequestDiff } from "./pull-request-parsing";

/**
 * Fetch both PR review comments and regular PR comments
 */
export async function fetchPullRequestComments(params: FetchParams) {
  const { logger } = params.context;
  const { owner, repo, issueNum } = params;
  if (!owner || !repo || issueNum === undefined) {
    return { comments: [], linkedIssues: [] };
  }
  try {
    // Fetch PR data including both types of comments
    const allComments: SimplifiedComment[] = [];
    const linkedIssues: PullRequestLinkedIssue[] = [];
    let hasMoreComments = true;
    let hasMoreReviews = true;
    let commentsEndCursor: string | null = null;
    let reviewsEndCursor: string | null = null;

    const MAX_PAGES = 100; // Safety limit to prevent infinite loops
    let pageCount = 0;

    while (hasMoreComments || hasMoreReviews) {
      if (pageCount >= MAX_PAGES) {
        logger.error(`Reached maximum page limit (${MAX_PAGES}) while fetching PR comments`, { owner, repo, issueNum });
        break;
      }
      pageCount++;

      logger.debug(`Fetching PR comments page ${pageCount}`, { owner, repo, issueNum });
      const prData = await fetchPullRequestPage(params, owner, repo, issueNum, commentsEndCursor, reviewsEndCursor);

      processPageComments(prData, allComments, owner, repo, issueNum);
      processPageReviews(prData, allComments, owner, repo, issueNum);
      processLinkedIssues(prData, linkedIssues, commentsEndCursor, reviewsEndCursor);

      const paginationState = updatePaginationState(prData);
      hasMoreComments = paginationState.hasMoreComments;
      hasMoreReviews = paginationState.hasMoreReviews;
      commentsEndCursor = paginationState.commentsEndCursor;
      reviewsEndCursor = paginationState.reviewsEndCursor;

      if (!hasMoreComments && !hasMoreReviews) {
        break;
      }
    }

    return { comments: allComments, linkedIssues };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error("Error fetching PR comments", { stack: err.stack });
    return { comments: [], linkedIssues: [] };
  }
}

async function fetchPullRequestPage(
  { context: { octokit } }: FetchParams,
  owner: string,
  repo: string,
  issueNum: number,
  commentsAfter: string | null,
  reviewsAfter: string | null
): Promise<PullRequestGraphQlResponse> {
  return await octokit.graphql<PullRequestGraphQlResponse>(
    /* GraphQL */ `
      query ($owner: String!, $repo: String!, $number: Int!, $commentsAfter: String, $reviewsAfter: String) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            body
            closingIssuesReferences(first: 100) {
              nodes {
                number
                url
                body
                repository {
                  owner {
                    login
                  }
                  name
                }
              }
            }
            reviews(first: 100, after: $reviewsAfter) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                comments(first: 100) {
                  nodes {
                    id
                    body
                    author {
                      login
                      type: __typename
                    }
                    path
                    line
                    startLine
                    diffHunk
                  }
                }
              }
            }
            comments(first: 100, after: $commentsAfter) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                id
                body
                author {
                  login
                  type: __typename
                }
              }
            }
          }
        }
      }
    `,
    {
      owner,
      repo,
      number: issueNum,
      commentsAfter,
      reviewsAfter,
    }
  );
}

function processPageComments(prData: PullRequestGraphQlResponse, allComments: SimplifiedComment[], owner: string, repo: string, issueNum: number) {
  if (!prData.repository.pullRequest.comments.nodes) return;

  // Process PR comments for this page
  for (const comment of prData.repository.pullRequest.comments.nodes) {
    if (comment.author.type !== "Bot") {
      allComments.push({
        body: comment.body,
        user: {
          login: comment.author.login,
          type: comment.author.type,
        },
        id: comment.id,
        org: owner || "",
        repo: repo || "",
        issueUrl: `https://github.com/${owner}/${repo}/pull/${issueNum}`,
        commentType: "issue_comment",
      });
    }
  }
}

function processPageReviews(prData: PullRequestGraphQlResponse, allComments: SimplifiedComment[], owner: string, repo: string, issueNum: number) {
  if (!prData.repository.pullRequest.reviews.nodes) return;

  // Process review comments for this page
  for (const review of prData.repository.pullRequest.reviews.nodes) {
    for (const comment of review.comments.nodes) {
      if (comment.author.type !== "Bot") {
        const commentData: SimplifiedComment = {
          body: comment.body,
          user: {
            login: comment.author.login,
            type: comment.author.type,
          },
          id: comment.id,
          org: owner || "",
          repo: repo || "",
          issueUrl: `https://github.com/${owner}/${repo}/pull/${issueNum}`,
          commentType: "pull_request_review_comment",
          referencedCode: comment.path
            ? {
                content: comment.diffHunk || "",
                startLine: comment.startLine || comment.line || 0,
                endLine: comment.line || 0,
                path: comment.path,
              }
            : undefined,
        };
        allComments.push(commentData);
      }
    }
  }
}

function processLinkedIssues(
  prData: PullRequestGraphQlResponse,
  linkedIssues: PullRequestLinkedIssue[],
  commentsEndCursor: string | null,
  reviewsEndCursor: string | null
) {
  // Process the linked issues (only needed once)
  if (!commentsEndCursor && !reviewsEndCursor && prData.repository.pullRequest.closingIssuesReferences.nodes) {
    for (const issue of prData.repository.pullRequest.closingIssuesReferences.nodes) {
      linkedIssues.push({
        number: issue.number,
        owner: issue.repository.owner.login,
        repo: issue.repository.name,
        url: issue.url,
        body: issue.body,
      });
    }
  }
}

function updatePaginationState(prData: PullRequestGraphQlResponse) {
  // Update pagination flags and cursors
  return {
    hasMoreComments: prData.repository.pullRequest.comments.pageInfo.hasNextPage,
    hasMoreReviews: prData.repository.pullRequest.reviews.pageInfo.hasNextPage,
    commentsEndCursor: prData.repository.pullRequest.comments.pageInfo.endCursor,
    reviewsEndCursor: prData.repository.pullRequest.reviews.pageInfo.endCursor,
  };
}

export async function fetchPullRequestDetails(context: Context, org: string, repo: string, pullRequestNumber: number, tokenLimits: TokenLimits) {
  try {
    // Fetch diff
    const diffResponse = await context.octokit.rest.pulls.get({
      owner: org,
      repo,
      pull_number: pullRequestNumber,
      mediaType: { format: "diff" },
    });
    const diff = diffResponse.data as unknown as string;
    return processPullRequestDiff(context, diff, tokenLimits);
  } catch (e) {
    context.logger.error(`Error fetching PR details`, { owner: org, repo, issue: pullRequestNumber, err: String(e) });
    return { diff: null };
  }
}
