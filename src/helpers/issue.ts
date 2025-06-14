import { Context } from "../types";
import { FetchParams, LinkedIssues } from "../types/github-types";

export function splitKey(context: Context, key: string): [string, string, string] {
  try {
    const cleanKey = key.replace(/\/+/g, "/").replace(/\/$/, "");
    const parts = cleanKey.split("/");

    if (parts.length >= 3) {
      const lastThree = parts.slice(-3);
      return [lastThree[0], lastThree[1], lastThree[2]];
    }

    throw new Error("Invalid key format");
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    throw context.logger.error("Invalid key format", { stack: err.stack });
  }
}

function cleanGitHubUrl(url: string): string {
  let cleanUrl;
  try {
    cleanUrl = decodeURIComponent(url);
  } catch {
    cleanUrl = url;
  }

  cleanUrl = cleanUrl.replace(/[[]]/g, "");
  cleanUrl = cleanUrl.replace(/([^:])\/+/g, "$1/");
  cleanUrl = cleanUrl.replace(/\/+$/, "");
  cleanUrl = cleanUrl.replace(/\/issues\/\d+\/issues\/\d+/, (match) => {
    const number = RegExp(/\d+/).exec(match)?.[0] || "";
    return `/issues/${number}`;
  });

  return cleanUrl;
}

function addIssue(response: LinkedIssues[], seenKeys: Set<string>, owner: string, repo: string, number: string, type: string = "issues"): void {
  const key = `${owner}/${repo}/${number}`;
  if (!seenKeys.has(key)) {
    seenKeys.add(key);
    response.push({
      comments: undefined,
      owner,
      repo,
      issueNumber: parseInt(number),
      url: `https://github.com/${owner}/${repo}/${type}/${number}`,
      body: undefined,
    });
  }
}

export function idIssueFromComment(comment?: string | null, params?: FetchParams): LinkedIssues[] | null {
  if (!comment || !params) return null;

  const response: LinkedIssues[] = [];
  const seenKeys = new Set<string>();
  const cleanedComment = cleanGitHubUrl(comment);
  const currentOwner = params.context.payload.repository?.owner?.login;
  const currentRepo = params.context.payload.repository?.name;

  const patterns = [
    {
      regex: /https:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+?)\/(issues|pull)\/(\d+)(?:$|#|\s|])/g,
      handler: (match: RegExpExecArray) => addIssue(response, seenKeys, match[1], match[2], match[4], match[3]),
    },
    {
      regex: /([^/\s]+)\/([^/#\s]+)#(\d+)(?:$|\s|])/g,
      handler: (match: RegExpExecArray) => addIssue(response, seenKeys, match[1], match[2], match[3]),
    },
    {
      regex: /(?:^|\s|Resolves\s+|Closes\s+|Fixes\s+|Depends on )#(\d+)(?:$|\s|])/gi,
      handler: (match: RegExpExecArray) => {
        if (match[1] === "1234" && cleanedComment.includes("You must link the issue number e.g.")) return;
        if (currentOwner && currentRepo) addIssue(response, seenKeys, currentOwner, currentRepo, match[1]);
      },
    },
    {
      regex: /Depends on https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)\/(issues|pull)\/(\d+)(?:$|\s|])/g,
      handler: (match: RegExpExecArray) => addIssue(response, seenKeys, match[1], match[2], match[4], match[3]),
    },
  ];

  patterns.forEach(({ regex, handler }) => {
    let match;
    while ((match = regex.exec(cleanedComment)) !== null) {
      handler(match);
    }
  });

  return response.length > 0 ? response : null;
}
