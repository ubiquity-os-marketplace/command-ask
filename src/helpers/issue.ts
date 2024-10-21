import { createKey } from "../handlers/comments";
import { FetchedCodes, FetchParams, LinkedIssues } from "../types/github-types";
import { StreamlinedComment } from "../types/llm";
import { Context } from "../types/context"; // Import Context type

/**
 * Removes duplicate streamlined comments based on their body content.
 *
 * @param streamlinedComments - The record of streamlined comments to deduplicate.
 * @returns The deduplicated record of streamlined comments.
 */
export function dedupeStreamlinedComments(streamlinedComments: Record<string, StreamlinedComment[]>) {
  for (const key of Object.keys(streamlinedComments)) {
    streamlinedComments[key] = streamlinedComments[key].filter(
      (comment: StreamlinedComment, index: number, self: StreamlinedComment[]) => index === self.findIndex((t: StreamlinedComment) => t.body === comment.body)
    );
  }
  return streamlinedComments;
}

/**
 * Merges new streamlined comments into existing streamlined comments.
 *
 * @param existingComments - The existing comments to merge into.
 * @param newComments - The new comments to merge.
 * @returns The merged comments.
 */
export function mergeStreamlinedComments(existingComments: Record<string, StreamlinedComment[]>, newComments: Record<string, StreamlinedComment[]>) {
  if (!existingComments) {
    existingComments = {};
  }
  for (const [key, value] of Object.entries(newComments)) {
    if (!existingComments[key]) {
      existingComments[key] = [];
    }
    const previous = existingComments[key] || [];
    existingComments[key] = [...previous, ...value];
  }
  return existingComments;
}

/**
 * Extracts the owner, repository, and issue number from a given key.
 *
 * @param key - The key string in the format "owner/repo/issueNumber".
 * @returns A tuple containing the owner, repository, and issue number.
 */
export function splitKey(key: string): [string, string, string] {
  const parts = key.split("/");
  return [parts[0], parts[1], parts[2]];
}

/**
 * Identifies issues from a comment string.
 *
 * @param comment - The comment string that may contain issue references.
 * @param params - Additional parameters that may include context information.
 * @returns An array of linked issues or null if no issues are found.
 */
export function idIssueFromComment(comment?: string | null): LinkedIssues[] | null {
  const urlMatch = comment?.match(/https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/(pull|issues?)\/(\d+)/g);
  const response: LinkedIssues[] = [];

  if (urlMatch) {
    urlMatch.forEach((url) => {
      response.push(createLinkedIssueOrPr(url));
    });
  }

  return response.length > 0 ? response : null;
}

/**
 * Creates a linked issue or pull request object from a given GitHub URL.
 *
 * @param url - The GitHub URL to create the linked issue or pull request from.
 * @returns An object representing the linked issue or pull request.
 */
function createLinkedIssueOrPr(url: string): LinkedIssues {
  const key = createKey(url);
  const [owner, repo, issueNumber] = splitKey(key);
  return {
    owner,
    repo,
    issueNumber: parseInt(issueNumber),
    url,
  };
}

/**
 * Fetches the code linked from a GitHub issue.
 *
 * @param issue - The issue string containing GitHub URLs.
 * @param context - The context object containing the octokit instance.
 * @param url - The URL of the issue.
 * @param extensions - The list of file extensions to filter the linked files.
 * @returns A promise that resolves to an array of fetched codes.
 */
export async function fetchCodeLinkedFromIssue(
  issue: string,
  context: Context,
  url: string,
  extensions: string[] = [".ts", ".json", ".sol"]
): Promise<FetchedCodes[]> {
  const { octokit } = context;
  // Function to extract owner, repo, and path from a GitHub URL
  function parseGitHubUrl(url: string): { owner: string; repo: string; path: string } | null {
    const match = url.match(/https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/blob\/[^/]+\/(.+)/);
    return match ? { owner: match[1], repo: match[2], path: match[3] } : null;
  }
  // Function to check if a file has one of the specified extensions
  function hasValidExtension(path: string) {
    const cleanPath = path.split("#")[0]; // Remove any fragment identifiers like #L39-L49
    return extensions.some((ext) => cleanPath.toLowerCase().endsWith(ext.toLowerCase()));
  }
  //Function to remove Line numbers from the URL
  function removeLineNumbers(url: string) {
    const match = url.match(/(.*?)(#L\d+(-L\d+)?)/);
    return match ? match[1] : url;
  }
  // Extract all GitHub URLs from the issue
  const urls = issue.match(/https?:\/\/(www\.)?github\.com\/[^\s]+/g) || [];
  // Process each URL
  const results = await Promise.all(
    urls.map(async (url) => {
      let parsedUrl = parseGitHubUrl(url);
      parsedUrl = parsedUrl ? { ...parsedUrl, path: removeLineNumbers(parsedUrl.path) } : null;
      if (!parsedUrl || !hasValidExtension(parsedUrl.path)) return null;
      try {
        //Parse the commit sha from the URL
        const commitSha = url.match(/https?:\/\/github\.com\/[^/]+\/[^/]+\/blob\/([^/]+)\/.+/);
        let response;
        if (commitSha) {
          response = await octokit.repos.getContent({
            owner: parsedUrl.owner,
            repo: parsedUrl.repo,
            ref: commitSha ? commitSha[1] : "main",
            path: parsedUrl.path,
          });
        } else {
          response = await octokit.repos.getContent({
            owner: parsedUrl.owner,
            repo: parsedUrl.repo,
            path: parsedUrl.path,
          });
        }
        if ("content" in response.data) {
          const content = Buffer.from(response.data.content, "base64").toString();
          return { body: content, id: parsedUrl.path };
        }
      } catch (error) {
        console.error(`Error fetching content from ${url}:`, error);
      }
      return null;
    })
  );
  return results
    .filter((result): result is { body: string; id: string } => result !== null)
    .map((result) => ({
      ...result,
      org: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
      issueNumber: parseInt(issue.match(/\/issues\/(\d+)/)?.[1] || "0", 10),
      issueUrl: url,
      user: context.payload.sender,
    }));
}

/**
 * Optimizes the context strings by removing duplicates and sorting by information density.
 * Removes exact duplicates and sorts by information density and length.
 *
 * @param strings - The array of context strings to optimize.
 * @returns The optimized array of context strings.
 */
export function optimizeContext(strings: string[]): string[] {
  // Helper function to clean strings while preserving links
  function cleanString(inputString: string): string {
    // Preserve links by temporarily replacing them
    const links: string[] = [];
    inputString = inputString.replace(/https?:\/\/\S+/g, (match) => {
      links.push(match);
      return `__LINK${links.length - 1}__`;
    });
    // Clean the string
    inputString = inputString
      .replace(/[^\w\s-/]|_/g, "") // Remove punctuation except '-' and '/'
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    // Restore links
    inputString = inputString.replace(/__LINK(\d+)__/g, (i) => links[parseInt(i)]);

    return inputString;
  }
  // Helper function to calculate information density
  function informationDensity(s: string): number {
    const words = s.split(/\s+/);
    const uniqueWords = new Set(words);
    return uniqueWords.size / words.length;
  }
  // Clean and remove empty strings
  const cleanedStrings = strings.map(cleanString).filter((s) => s.length > 0);
  // Remove exact duplicates
  const uniqueStrings = Array.from(new Set(cleanedStrings));
  // Sort strings by information density and length
  uniqueStrings.sort((a, b) => {
    const densityDiff = informationDensity(b) - informationDensity(a);
    return densityDiff !== 0 ? densityDiff : b.length - a.length;
  });
  const result: string[] = [];
  const wordSet = new Set<string>();
  for (const str of uniqueStrings) {
    const words = str.split(/\s+/);
    const newWords = words.filter((word) => !wordSet.has(word) && !word.startsWith("http"));
    if (newWords.length > 0 || str.includes("http")) {
      result.push(str);
      newWords.forEach((word) => wordSet.add(word));
    }
  }
  return result;
}

/**
 * Extracts and returns the README content from the repository associated with the given issue.
 *
 * @param params - The parameters required to fetch the README, including the context with octokit instance.
 * @returns The content of the README file as a string.
 */
export async function pullReadmeFromRepoForIssue(params: FetchParams): Promise<string | undefined> {
  let readme;
  try {
    const response = await params.context.octokit.repos.getContent({
      owner: params.context.payload.repository.owner?.login || params.context.payload.organization?.login || "",
      repo: params.context.payload.repository.name,
      path: "README.md",
    });
    if ("content" in response.data) {
      readme = Buffer.from(response.data.content, "base64").toString();
    }
  } catch (error) {
    throw new Error(`Error fetching README from repository: ${error}`);
  }
  return readme;
}
