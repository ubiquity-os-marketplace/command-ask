import { http, HttpResponse, graphql } from "msw";
import { db } from "./db";
import issueTemplate from "./issue-template";

/**
 * Intercepts the routes and returns a custom payload
 */
export const handlers = [
  // GraphQL handler for fetching comment by ID
  graphql.query("GetCommentById", ({ variables }) => {
    // Try to find an issue comment first
    const comment = db.comments.findFirst({
      where: { id: { equals: Number(variables.id) } },
    });

    if (comment) {
      // If it's an issue comment
      if (comment.issue_url) {
        const issue = db.issue.findFirst({
          where: { number: { equals: comment.issue_number } },
        });

        return HttpResponse.json({
          data: {
            node: {
              __typename: "IssueComment",
              id: String(comment.id),
              body: comment.body,
              author: {
                login: comment.user.login,
              },
              issue: {
                id: String(issue?.id),
                number: issue?.number,
                title: issue?.title,
                url: issue?.html_url,
                repository: {
                  name: comment.repo,
                  owner: {
                    login: comment.owner,
                  },
                },
              },
            },
          },
        });
      }
      // If it's a pull request review comment
      else if (comment.pull_request_url) {
        const pull = db.pull.findFirst({
          where: { number: { equals: comment.issue_number } },
        });

        return HttpResponse.json({
          data: {
            node: {
              __typename: "PullRequestReviewComment",
              id: String(comment.id),
              body: comment.body,
              author: {
                login: comment.user.login,
              },
              pullRequest: {
                id: String(pull?.id),
                number: pull?.number,
                title: pull?.title,
                url: pull?.html_url,
                repository: {
                  name: comment.repo,
                  owner: {
                    login: comment.owner,
                  },
                },
              },
            },
          },
        });
      }
    }

    // If no comment found
    return HttpResponse.json({
      data: {
        node: null,
      },
    });
  }),

  // GraphQL handler for fetching issue by ID
  graphql.query("GetIssueById", ({ variables }) => {
    const issue = db.issue.findFirst({
      where: { id: { equals: Number(variables.id) } },
    });

    if (!issue) {
      return HttpResponse.json({
        data: {
          node: null,
        },
      });
    }

    const comments = db.comments.findMany({
      where: { issue_number: { equals: issue.number } },
    });

    return HttpResponse.json({
      data: {
        node: {
          id: String(issue.id),
          number: issue.number,
          title: issue.title,
          body: issue.body,
          url: issue.html_url,
          repository: {
            name: issue.repo,
            owner: {
              login: issue.owner,
            },
          },
          author: {
            login: "ubiquity",
          },
          comments: {
            nodes: comments.map((comment) => ({
              id: String(comment.id),
              body: comment.body,
              author: {
                login: comment.user.login,
              },
            })),
          },
        },
      },
    });
  }),

  http.post("https://api.openai.com/v1/chat/completions", () => {
    const answer = `${JSON.stringify(["This is a mock response from OpenAI"])}`;

    return HttpResponse.json({
      usage: {
        completion_tokens: 150,
        prompt_tokens: 1000,
        total_tokens: 1150,
      },
      choices: [
        {
          message: {
            content: answer,
          },
        },
      ],
    });
  }),
  //  GET https://api.github.com/repos/ubiquity/test-repo/issues/1
  http.get("https://api.github.com/repos/:owner/:repo/issues/:issue_number", ({ params: { owner, repo, issue_number: issueNumber } }) =>
    HttpResponse.json(
      db.issue.findFirst({ where: { owner: { equals: owner as string }, repo: { equals: repo as string }, number: { equals: Number(issueNumber) } } })
    )
  ),

  // get repo
  http.get("https://api.github.com/repos/:owner/:repo", ({ params: { owner, repo } }: { params: { owner: string; repo: string } }) => {
    const item = db.repo.findFirst({ where: { name: { equals: repo }, owner: { login: { equals: owner } } } });
    if (!item) {
      return new HttpResponse(null, { status: 404 });
    }
    return HttpResponse.json(item);
  }),
  // get issue
  http.get("https://api.github.com/repos/:owner/:repo/issues", ({ params: { owner, repo } }: { params: { owner: string; repo: string } }) =>
    HttpResponse.json(db.issue.findMany({ where: { owner: { equals: owner }, repo: { equals: repo } } }))
  ),
  // create issue
  http.post("https://api.github.com/repos/:owner/:repo/issues", () => {
    const id = db.issue.count() + 1;
    const newItem = { ...issueTemplate, id };
    db.issue.create(newItem);
    return HttpResponse.json(newItem);
  }),
  // get repo issues
  http.get("https://api.github.com/orgs/:org/repos", ({ params: { org } }: { params: { org: string } }) =>
    HttpResponse.json(db.repo.findMany({ where: { owner: { login: { equals: org } } } }))
  ),
  // add comment to issue
  http.post("https://api.github.com/repos/:owner/:repo/issues/:issue_number/comments", ({ params: { owner, repo, issue_number: issueNumber } }) =>
    HttpResponse.json({ owner, repo, issueNumber })
  ),
  // list pull requests
  http.get("https://api.github.com/repos/:owner/:repo/pulls", ({ params: { owner, repo } }: { params: { owner: string; repo: string } }) =>
    HttpResponse.json(db.pull.findMany({ where: { owner: { equals: owner }, repo: { equals: repo } } }))
  ),
  // update a pull request
  http.patch("https://api.github.com/repos/:owner/:repo/pulls/:pull_number", ({ params: { owner, repo, pull_number: pullNumber } }) =>
    HttpResponse.json({ owner, repo, pull_number: pullNumber })
  ),

  // list issue comments
  http.get("https://api.github.com/repos/:owner/:repo/issues/:issue_number/comments", ({ params: { owner, repo, issue_number: issueNumber } }) =>
    HttpResponse.json(
      db.comments.findMany({ where: { owner: { equals: owner as string }, repo: { equals: repo as string }, issue_number: { equals: Number(issueNumber) } } })
    )
  ),
  //list review comments
  http.get("https://api.github.com/repos/:owner/:repo/pulls/:pull_number/comments", ({ params: { owner, repo, pull_number: pullNumber } }) =>
    HttpResponse.json(
      db.comments.findMany({ where: { owner: { equals: owner as string }, repo: { equals: repo as string }, issue_number: { equals: Number(pullNumber) } } })
    )
  ),
  //  octokit.pulls.get
  http.get("https://api.github.com/repos/:owner/:repo/pulls/:pull_number", ({ params: { owner, repo, pull_number: pullNumber } }) =>
    HttpResponse.json(
      db.pull.findFirst({ where: { owner: { equals: owner as string }, repo: { equals: repo as string }, number: { equals: Number(pullNumber) } } })
    )
  ),
  http.get("https://api.github.com/repos/:owner/:repo/languages", () => HttpResponse.json(["JavaScript", "TypeScript", "Python"])),
  http.get("https://api.github.com/repos/:owner/:repo/contents/:path", () =>
    HttpResponse.json({
      type: "file",
      encoding: "base64",
      size: 5362,
      name: "README.md",
      content: Buffer.from(JSON.stringify({ content: "This is a mock README file" })).toString("base64"),
    })
  ),
  // [MSW] Warning: intercepted a request without a matching request handler:

  // • GET https://api.github.com/repos/ubiquity/test-repo/pulls/3/files?per_page=100?per_page=100
  http.get("https://api.github.com/repos/:owner/:repo/pulls/:pull_number/files", () =>
    HttpResponse.json([
      {
        sha: "abc123",
        filename: "file1.txt",
        status: "modified",
        additions: 10,
        deletions: 5,
        changes: 15,
      },
    ])
  ),
];
