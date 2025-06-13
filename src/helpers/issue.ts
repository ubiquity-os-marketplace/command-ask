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
  let cleanUrl = url;
  try {
    cleanUrl = decodeURIComponent(url);
  } catch {
    cleanUrl = url;
  }

  cleanUrl = cleanUrl.replace(/[[]]/g, "");
  cleanUrl = cleanUrl.replace(/([^:])\/+/g, "$1/");
  cleanUrl = cleanUrl.replace(/\/+$/, "");
  cleanUrl = cleanUrl.replace(/\/issues\/\d+\/issues\/\d+/, (match) => {
    const number = match.match(/\d+/)?.[0] || "";
    return `/issues/${number}`;
  });

  return cleanUrl;
}

export function idIssueFromComment(comment?: string | null, params?: FetchParams): LinkedIssues[] | null {
  if (!comment || !params) return null;

  const response: LinkedIssues[] = [];
  const seenKeys = new Set<string>();
  const cleanedComment = cleanGitHubUrl(comment);

  const urlPattern = /https:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+?)\/(issues|pull)\/(\d+)(?:$|#|\s|])/g;
  let match;
  while ((match = urlPattern.exec(cleanedComment)) !== null) {
    const [_, owner, repo, type, number] = match;
    const key = `${owner}/${repo}/${number}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      response.push({
        owner,
        repo,
        issueNumber: parseInt(number),
        url: `https://github.com/${owner}/${repo}/${type}/${number}`,
        body: undefined,
      });
    }
  }

  const crossRepoPattern = /([^/\s]+)\/([^/#\s]+)#(\d+)(?:$|\s|])/g;
  while ((match = crossRepoPattern.exec(cleanedComment)) !== null) {
    const [_, owner, repo, number] = match;
    const key = `${owner}/${repo}/${number}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      response.push({
        owner,
        repo,
        issueNumber: parseInt(number),
        url: `https://github.com/${owner}/${repo}/issues/${number}`,
        body: undefined,
      });
    }
  }

  const hashPattern = /(?:^|\s)#(\d+)(?:$|\s|])/g;
  while ((match = hashPattern.exec(cleanedComment)) !== null) {
    const [_, number] = match;
    if (number === "1234" && cleanedComment.includes("You must link the issue number e.g.")) {
      continue;
    }
    const owner = params.context.payload.repository?.owner?.login;
    const repo = params.context.payload.repository?.name;
    if (owner && repo) {
      const key = `${owner}/${repo}/${number}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        response.push({
          owner,
          repo,
          issueNumber: parseInt(number),
          url: `https://github.com/${owner}/${repo}/issues/${number}`,
          body: undefined,
        });
      }
    }
  }

  const resolvePattern = /(?:Resolves|Closes|Fixes)\s+#(\d+)(?:$|\s|])/gi;
  while ((match = resolvePattern.exec(cleanedComment)) !== null) {
    const [_, number] = match;
    const owner = params.context.payload.repository?.owner?.login;
    const repo = params.context.payload.repository?.name;
    if (owner && repo) {
      const key = `${owner}/${repo}/${number}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        response.push({
          owner,
          repo,
          issueNumber: parseInt(number),
          url: `https://github.com/${owner}/${repo}/issues/${number}`,
          body: undefined,
        });
      }
    }
  }

  const dependsOnPattern = /Depends on (?:(?:#(\d+))|(?:https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)\/(issues|pull)\/(\d+)))(?:$|\s|])/g;
  while ((match = dependsOnPattern.exec(cleanedComment)) !== null) {
    if (match[1]) {
      const owner = params.context.payload.repository?.owner?.login;
      const repo = params.context.payload.repository?.name;
      if (owner && repo) {
        const key = `${owner}/${repo}/${match[1]}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          response.push({
            owner,
            repo,
            issueNumber: parseInt(match[1]),
            url: `https://github.com/${owner}/${repo}/issues/${match[1]}`,
            body: undefined,
          });
        }
      }
    } else if (match[2] && match[3] && match[5]) {
      const key = `${match[2]}/${match[3]}/${match[5]}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        response.push({
          owner: match[2],
          repo: match[3],
          issueNumber: parseInt(match[5]),
          url: `https://github.com/${match[2]}/${match[3]}/${match[4]}/${match[5]}`,
          body: undefined,
        });
      }
    }
  }
  return response.length > 0 ? response : null;
}
