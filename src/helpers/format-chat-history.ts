import { Context } from "../types";
import { TokenLimits } from "../types/llm";
import { fetchIssueComments } from "./issue-fetching";
import { splitKey } from "./issue";
import { logger } from "./errors";
import { TreeNode } from "../types/github-types";
import { updateTokenCount, createDefaultTokenLimits } from "./token-utils";
import { SimilarIssue, SimilarComment } from "../types/github-types";

const SIMILAR_ISSUE_IDENTIFIER = "Similar Issues:";
const SIMILAR_COMMENT_IDENTIFIER = "Similar Comments:";

function validateGitHubKey(key: string): boolean {
  const parts = key.split("/");

  if (parts.length !== 3) return false;

  const [owner, repo, number] = parts;

  if (!owner || owner === "issues" || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/i.test(owner)) {
    return false;
  }

  if (!repo || !/^[a-zA-Z0-9-_]+$/i.test(repo)) {
    return false;
  }

  return /^\d+$/.test(number);
}

function extractGitHubInfo(url: string): { owner: string; repo: string; number: string } | null {
  try {
    const urlMatch = url.match(/github\.com\/([^/]+)\/([^/]+?)\/(issues|pull)\/(\d+)/);
    if (urlMatch) {
      return {
        owner: urlMatch[1],
        repo: urlMatch[2],
        number: urlMatch[4],
      };
    }

    const repoMatch = url.match(/([^/\s]+)\/([^/\s#]+)#(\d+)/);
    if (repoMatch) {
      return {
        owner: repoMatch[1],
        repo: repoMatch[2],
        number: repoMatch[3],
      };
    }

    return null;
  } catch {
    return null;
  }
}

async function extractReferencedIssuesAndPrs(body: string, owner: string, repo: string): Promise<string[]> {
  const links = new Set<string>();
  const processedRefs = new Set<string>();

  function addValidReference(key: string) {
    key = key.replace(/[[]]/g, "");

    if (!validateGitHubKey(key)) {
      return;
    }
    if (!processedRefs.has(key)) {
      processedRefs.add(key);
      links.add(key);
    }
  }

  const numberRefs = body.match(/(?:^|\s)#(\d+)(?:\s|$)/g) || [];
  for (const ref of numberRefs) {
    const number = ref.trim().substring(1);
    if (/^\d+$/.test(number)) {
      const key = `${owner}/${repo}/${number}`;
      addValidReference(key);
    }
  }

  const resolveRefs = body.match(/(?:Resolves|Closes|Fixes)\s+#(\d+)/gi) || [];
  for (const ref of resolveRefs) {
    const number = ref.split("#")[1];
    if (/^\d+$/.test(number)) {
      const key = `${owner}/${repo}/${number}`;
      addValidReference(key);
    }
  }

  const urlMatches = body.match(/https:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+?)\/(issues|pull)\/(\d+)(?:#[^/\s]*)?/g) || [];
  for (const url of urlMatches) {
    const info = extractGitHubInfo(url);
    if (info) {
      const key = `${info.owner}/${info.repo}/${info.number}`;
      addValidReference(key);
    }
  }

  const crossRepoMatches = body.match(/([^/\s]+)\/([^/\s#]+)#(\d+)/g) || [];
  for (const ref of crossRepoMatches) {
    const parts = ref.match(/([^/\s]+)\/([^/\s#]+)#(\d+)/);
    if (parts) {
      const key = `${parts[1]}/${parts[2]}/${parts[3]}`;
      if (validateGitHubKey(key)) {
        addValidReference(key);
      }
    }
  }

  return Array.from(links);
}

// Builds a tree by recursively fetching linked issues and PRs up to a certain depth
async function buildTree(
  context: Context,
  specAndBodies: Record<string, string>,
  maxDepth: number = 2,
  tokenLimit: TokenLimits,
  similarIssues?: SimilarIssue[],
  similarComments?: SimilarComment[]
): Promise<{ tree: TreeNode | null }> {
  const processedNodes = new Map<string, TreeNode>();
  // Extract issue/PR number based on payload type
  let issueNumber;
  if ("issue" in context.payload) {
    issueNumber = context.payload.issue.number;
  } else {
    issueNumber = undefined;
  }
  if (!issueNumber) {
    logger.error("Could not determine issue/PR number from payload", { payload: context.payload });
    return { tree: null };
  }

  const mainIssueKey = `${context.payload.repository.owner.login}/${context.payload.repository.name}/${issueNumber}`;
  const linkedIssueKeys = new Set<string>();
  const failedFetches = new Set<string>();
  const processingStack = new Set<string>();

  if (!validateGitHubKey(mainIssueKey)) {
    logger.error(`Invalid main issue key: ${mainIssueKey}`);
    return { tree: null };
  }

  async function createNode(key: string, depth: number = 0, refs?: Set<string>): Promise<TreeNode | null> {
    // Early return checks to prevent unnecessary processing
    if (depth > maxDepth || processingStack.has(key)) {
      // Processing stack is used to prevent infinite loops
      logger.debug(`Skip ${key} - max depth/already processing`);
      return processedNodes.get(key) || null;
    }

    if (processedNodes.has(key)) {
      logger.debug(`Return cached node: ${key}`);
      return processedNodes.get(key) || null;
    }

    if (linkedIssueKeys.has(key)) {
      logger.debug(`Skip ${key} - already linked`);
      return null;
    }

    if (failedFetches.has(key)) {
      logger.debug(`Skip ${key} - previous fetch failed`);
      return null;
    }

    processingStack.add(key);

    try {
      const [owner, repo, issueNum] = splitKey(key);
      const response = await fetchIssueComments({ context, owner, repo, issueNum: parseInt(issueNum) }, tokenLimit);
      const issue = response.issue;

      if (!issue) {
        failedFetches.add(key);
        return null;
      }

      const node: TreeNode = {
        key,
        children: [],
        depth,
        number: issue.number,
        html_url: issue.html_url,
        comments: response.comments.map((comment) => ({
          ...comment,
          user: comment.user?.login || undefined,
          body: comment.body || undefined,
        })),
        type: issue.pull_request ? "pull_request" : "issue",
        body: specAndBodies[key] || issue.body || undefined,
      };

      processedNodes.set(key, node);
      linkedIssueKeys.add(key);

      const references = refs || new Set<string>();

      // Helper function to validate and add references
      const validateAndAddReferences = async (text: string) => {
        const refs = await extractReferencedIssuesAndPrs(text, owner, repo);
        refs.forEach((ref) => {
          if (validateGitHubKey(ref) && !linkedIssueKeys.has(ref) && !processedNodes.has(ref) && !processingStack.has(ref)) {
            references.add(ref);
          }
        });
      };

      // Process body references
      if (node.body) {
        await validateAndAddReferences(node.body);
      }

      // Process comment references
      if (node.comments) {
        for (const comment of node.comments) {
          if (comment.body) {
            await validateAndAddReferences(comment.body);
          }
        }
      }

      // Process valid references
      for (const ref of references) {
        //Uses references found so far to create child nodes
        const childNode = await createNode(ref, depth + 1); // Recursively create child nodes until max depth is reached
        logger.debug(`Created child node for ${ref}`);
        if (childNode) {
          childNode.parent = node;
          node.children.push(childNode);
        }
      }
      return node;
    } catch (error) {
      failedFetches.add(key);
      logger.error(`Error creating node for ${key}: ${error}`);
      return null;
    } finally {
      processingStack.delete(key);
    }
  }
  const similarRefMap = new Set<string>();
  try {
    //Extract Refs from similar issues and comments
    if (similarIssues) {
      for (const issue of similarIssues) {
        const { owner, repo, body } = issue;
        if (!owner || !repo || !body) {
          continue;
        }
        linkedIssueKeys.add(issue.issue_id);
        const refs = await extractReferencedIssuesAndPrs(body, owner, repo);
        refs.forEach((ref) => {
          if (validateGitHubKey(ref) && !linkedIssueKeys.has(ref) && !processedNodes.has(ref) && !processingStack.has(ref)) {
            similarRefMap.add(ref);
          }
        });
      }
    }
    if (similarComments) {
      for (const comment of similarComments) {
        const { org, repo, body } = comment;
        if (!org || !repo || !body) {
          continue;
        }
        linkedIssueKeys.add(comment.comment_issue_id);
        const refs = await extractReferencedIssuesAndPrs(body, org, repo);
        refs.forEach((ref) => {
          if (validateGitHubKey(ref) && !linkedIssueKeys.has(ref) && !processedNodes.has(ref) && !processingStack.has(ref)) {
            similarRefMap.add(ref);
          }
        });
      }
    }
  } catch (error) {
    logger.error("Error extracting similar issues", { error: error as Error });
  }

  try {
    const tree = await createNode(mainIssueKey, undefined, similarRefMap);
    console.log(`Map size: ${JSON.stringify(Array.from(processedNodes.keys()))}`);
    return { tree };
  } catch (error) {
    logger.error("Error building tree", { error: error as Error });
    return { tree: null };
  }
}

// Helper function to process node content
async function processNodeContent(
  node: TreeNode,
  prefix: string,
  includeDiffs: boolean,
  tokenLimits: TokenLimits
): Promise<{ output: string[]; isSuccess: boolean; childrenOutput: string[]; tokenLimits: TokenLimits }> {
  const testTokenLimits = { ...tokenLimits };
  const output: string[] = [];
  const childrenOutput: string[] = [];

  // Early token limit check
  if (testTokenLimits.runningTokenCount >= testTokenLimits.tokensRemaining) {
    return { output, isSuccess: false, childrenOutput, tokenLimits: testTokenLimits };
  }

  // Essential information first
  const typeStr = node.type == "issue" ? "Issue" : "PR";
  const headerLine = `${prefix}${node.parent ? "└── " : ""}${typeStr} #${node.number} (${node.html_url})`;

  if (!updateTokenCount(headerLine, testTokenLimits)) {
    return { output, isSuccess: false, childrenOutput, tokenLimits: testTokenLimits };
  }
  output.push(headerLine);

  const childPrefix = prefix + (node.parent ? "    " : "");
  const contentPrefix = childPrefix + "    ";

  // Helper function to add content if tokens allow
  const tryAddContent = (content: string[], tokenLimit: TokenLimits): boolean => {
    const tempLimit = { ...tokenLimit };
    if (content.every((line) => updateTokenCount(line, tempLimit))) {
      content.forEach((line) => updateTokenCount(line, tokenLimit));
      output.push(...content);
      return true;
    }
    return false;
  };

  // Process body (truncate if needed)
  if (node.body?.trim()) {
    const bodyLines = formatContent("Body", node.body, childPrefix, contentPrefix, testTokenLimits);
    if (bodyLines.length > 0) {
      tryAddContent(bodyLines, testTokenLimits);
      output.push("");
    }
  }

  // Process PR diffs if space allows
  if (includeDiffs && node.type === "pull_request" && node.prDetails?.diff) {
    const diffLines = formatContent("Diff", node.prDetails.diff, childPrefix, contentPrefix, testTokenLimits);
    if (diffLines.length > 0) {
      tryAddContent(diffLines, testTokenLimits);
      output.push("");
    }
  }

  // Process comments (most recent first)
  if (node.comments?.length) {
    const commentsHeader = `${childPrefix}Comments: ${node.comments.length}`;
    if (updateTokenCount(commentsHeader, testTokenLimits)) {
      output.push(commentsHeader);

      // Sort comments by recency
      const sortedComments = [...node.comments].sort((a, b) => parseInt(b.id) - parseInt(a.id));

      for (const comment of sortedComments) {
        if (!comment.body?.trim()) continue;

        const commentLine = `${childPrefix}├── ${comment.commentType || "issuecomment"}-${comment.id}: ${comment.user}: ${comment.body.trim()}`;

        if (!updateTokenCount(commentLine, testTokenLimits)) {
          break;
        }
        output.push(commentLine);

        // Add referenced code if space allows
        if (includeDiffs && comment.commentType === "pull_request_review_comment" && comment.referencedCode) {
          const codeLines = [
            `${childPrefix}    Referenced code in ${comment.referencedCode.path}:`,
            `${childPrefix}    Lines ${comment.referencedCode.startLine}-${comment.referencedCode.endLine}:`,
            ...comment.referencedCode.content.split("\n").map((line) => `${childPrefix}    ${line}`),
          ];

          tryAddContent(codeLines, testTokenLimits);
        }
      }
      output.push("");
    }
  }

  // Process similar content only for root node if space allows
  if (!node.parent && testTokenLimits.runningTokenCount < testTokenLimits.tokensRemaining - 1000) {
    for (const [type, items] of [
      [SIMILAR_ISSUE_IDENTIFIER, node.similarIssues],
      [SIMILAR_COMMENT_IDENTIFIER, node.similarComments],
    ] as const) {
      if (!items?.length) continue;

      const typeHeader = `${childPrefix}${type}`;
      if (!updateTokenCount(typeHeader, testTokenLimits)) break;
      output.push(typeHeader);

      // Sort by similarity
      const sortedItems = [...items].sort((a, b) => b.similarity - a.similarity);

      for (const item of sortedItems) {
        const similarity = (item.similarity * 100).toFixed(2);
        const identifier =
          type === SIMILAR_ISSUE_IDENTIFIER ? "Issue #" + (item as SimilarIssue).issueNumber : "Comment by " + (item as SimilarComment).user?.login;
        const url = type === SIMILAR_ISSUE_IDENTIFIER ? (item as SimilarIssue).url : "";

        const itemHeader = contentPrefix + "- " + identifier;
        const urlPart = url ? " (" + url + ")" : "";
        const similarityPart = " - Similarity: " + similarity + "%";
        const itemLines = [itemHeader + urlPart + similarityPart];

        if (item.body) {
          const maxLength = 500;
          const truncatedBody = item.body.length > maxLength ? item.body.slice(0, maxLength) + "..." : item.body;
          itemLines.push(contentPrefix + "  " + truncatedBody);
        }

        if (!tryAddContent(itemLines, testTokenLimits)) {
          break;
        }
      }
      output.push("");
    }
  }

  const isSuccess = testTokenLimits.runningTokenCount <= testTokenLimits.tokensRemaining;
  return { output, isSuccess, childrenOutput, tokenLimits: testTokenLimits };
}

async function processTreeNode(node: TreeNode, prefix: string, output: string[], tokenLimits: TokenLimits): Promise<boolean> {
  // Early check for token limit
  if (tokenLimits.runningTokenCount >= tokenLimits.tokensRemaining) {
    return false;
  }

  // Process current node first to ensure most relevant content is included
  const result = await processNodeContent(node, prefix, false, tokenLimits); // Start without diffs

  if (result.isSuccess) {
    // If we have room for diffs and it's a PR, try adding them
    if (node.type === "pull_request" && tokenLimits.tokensRemaining - tokenLimits.runningTokenCount > 1000) {
      // Buffer for diffs
      const withDiffs = await processNodeContent(node, prefix, true, { ...tokenLimits });
      if (withDiffs.isSuccess) {
        output.push(...withDiffs.output);
        Object.assign(tokenLimits, withDiffs.tokenLimits);
      } else {
        output.push(...result.output);
        Object.assign(tokenLimits, result.tokenLimits);
      }
    } else {
      output.push(...result.output);
      Object.assign(tokenLimits, result.tokenLimits);
    }

    // Process children only if we have enough tokens left
    if (tokenLimits.runningTokenCount < tokenLimits.tokensRemaining) {
      // Sort children by recency (assuming newer items are more relevant)
      const sortedChildren = [...node.children].sort((a, b) => b.number - a.number);

      for (const child of sortedChildren) {
        // Check if we have enough tokens for more content
        if (tokenLimits.runningTokenCount >= tokenLimits.tokensRemaining - 500) {
          // Leave buffer
          break;
        }

        const isChildProcessingComplete = await processTreeNode(child, prefix + "  ", output, tokenLimits);
        if (!isChildProcessingComplete) {
          break;
        }
      }
    }

    return true;
  }

  return false;
}

function formatContent(type: string, content: string, prefix: string, contentPrefix: string, tokenLimits: TokenLimits): string[] {
  const output: string[] = [];
  const header = `${prefix}${type}:`;

  if (!updateTokenCount(header, tokenLimits)) {
    return output;
  }
  output.push(header);

  const lines = content.trim().split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;

    const formattedLine = `${contentPrefix}${line.trim()}`;
    if (!updateTokenCount(formattedLine, tokenLimits)) {
      break;
    }
    output.push(formattedLine);
  }

  return output;
}

export async function buildChatHistoryTree(
  context: Context,
  maxDepth: number = 2,
  similarComments: SimilarComment[],
  similarIssues: SimilarIssue[]
): Promise<{ tree: TreeNode | null; tokenLimits: TokenLimits }> {
  const specAndBodies: Record<string, string> = {};
  const tokenLimits = createDefaultTokenLimits(context);
  const { tree } = await buildTree(context, specAndBodies, maxDepth, tokenLimits, similarIssues, similarComments);
  return { tree, tokenLimits };
}

export async function formatChatHistory(
  context: Context,
  maxDepth: number = 2,
  similarIssues: SimilarIssue[],
  similarComments: SimilarComment[],
  availableTokens?: number
): Promise<string[]> {
  const { tree, tokenLimits } = await buildChatHistoryTree(context, maxDepth, similarComments, similarIssues);

  if (!tree) {
    return ["No main issue found."];
  }

  // Rerank the chat history
  const reRankedChat = await context.adapters.voyage.reranker.reRankTreeNodes(tree, context.payload.comment.body);

  // If availableTokens is provided, override the default tokensRemaining
  if (availableTokens !== undefined) {
    tokenLimits.tokensRemaining = availableTokens;
  }

  // Add similar issues and comments to the tree
  if (similarIssues?.length) {
    tree.similarIssues = similarIssues;
  }
  if (similarComments?.length) {
    tree.similarComments = similarComments;
  }

  const treeOutput: string[] = [];
  const headerLine = "Issue Tree Structure:";
  treeOutput.push(headerLine, "");

  const tokenLimitsnew = createDefaultTokenLimits(context);

  const isSuccess = await processTreeNode(reRankedChat, "", treeOutput, tokenLimitsnew);
  logger.debug(`Tree processing ${isSuccess ? "succeeded" : "failed"} with tokens: ${tokenLimitsnew.runningTokenCount}/${tokenLimitsnew.tokensRemaining}`);
  logger.debug(`Tree fetching tokens: ${tokenLimits.runningTokenCount}/${tokenLimits.tokensRemaining}`);
  return treeOutput;
}
