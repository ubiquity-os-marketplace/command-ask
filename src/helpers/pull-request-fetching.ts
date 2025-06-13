import { Context } from "../types";
import { FetchParams, PullRequestGraphQlResponse, PullRequestLinkedIssue, SimplifiedComment } from "../types/github-types";
import { TokenLimits } from "../types/llm";
import { processPullRequestDiff } from "./pull-request-parsing";

/**
 * Fetch both PR review comments and regular PR comments
 */
export async function fetchPullRequestComments(params: FetchParams) {
  const { octokit, logger } = params.context;
  const { owner, repo, issueNum } = params;

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
      const prData: PullRequestGraphQlResponse = await octokit.graphql<PullRequestGraphQlResponse>(
        `
        query($owner: String!, $repo: String!, $number: Int!, $commentsAfter: String, $reviewsAfter: String) {
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
          commentsAfter: commentsEndCursor,
          reviewsAfter: reviewsEndCursor,
        }
      );

      // Process PR comments for this page
      if (prData.repository.pullRequest.comments.nodes) {
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

      // Process review comments for this page
      if (prData.repository.pullRequest.reviews.nodes) {
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

      // Process linked issues (only needed once)
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

      // Update pagination flags and cursors
      hasMoreComments = prData.repository.pullRequest.comments.pageInfo.hasNextPage;
      hasMoreReviews = prData.repository.pullRequest.reviews.pageInfo.hasNextPage;
      commentsEndCursor = prData.repository.pullRequest.comments.pageInfo.endCursor;
      reviewsEndCursor = prData.repository.pullRequest.reviews.pageInfo.endCursor;

      // Break if we've fetched all pages
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
