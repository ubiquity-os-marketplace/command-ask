import { Context } from "../types";
import { SimilarComment, SimilarIssue, TreeNode } from "../types/github-types";
import { DocumentFile } from "../types/google";
import { TokenLimits } from "../types/llm";
import { splitKey } from "./issue";
import { fetchIssueComments } from "./issue-fetching";
import { createDefaultTokenLimits, updateTokenCount } from "./token-utils";

const SIMILAR_ISSUE_IDENTIFIER = "Similar Issues:";
const SIMILAR_COMMENT_IDENTIFIER = "Similar Comments:";

function validateGitHubKey(key: string): boolean {
  const parts = key.split("/");

  if (parts.length !== 3) return false;

  const [owner, repo, number] = parts;

  if (!owner || owner === "issues" || !/^[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?$/i.test(owner)) {
    return false;
  }

  if (!repo || !/^[A-Z0-9._-]+$/i.test(repo)) {
    return false;
  }

  return /^\d+$/.test(number);
}

function extractGitHubInfo(url: string): { owner: string; repo: string; number: string } | null {
  try {
    const urlMatch = RegExp(/github\.com\/([^/]+)\/([^/]+?)\/(issues|pull)\/(\d+)/).exec(url);
    if (urlMatch) {
      return {
        owner: urlMatch[1],
        repo: urlMatch[2],
        number: urlMatch[4],
      };
    }

    const repoMatch = RegExp(/([^/\s]+)\/([^/\s#]+)#(\d+)/).exec(url);
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

function extractNumberReferences(body: string, owner: string, repo: string): string[] {
  const links: string[] = [];
  const numberRefs = body.match(/(?:^|\s)#(\d+)(?:\s|$)/g) || [];

  for (const ref of numberRefs) {
    const number = ref.trim().substring(1);
    if (/^\d+$/.test(number)) {
      const key = `${owner}/${repo}/${number}`;
      links.push(key);
    }
  }

  return links;
}

function extractResolveReferences(body: string, owner: string, repo: string): string[] {
  const links: string[] = [];
  const resolveRefs = body.match(/(?:Resolves|Closes|Fixes)\s+#(\d+)/gi) || [];

  for (const ref of resolveRefs) {
    const number = ref.split("#")[1];
    if (/^\d+$/.test(number)) {
      const key = `${owner}/${repo}/${number}`;
      links.push(key);
    }
  }

  return links;
}

function extractUrlReferences(body: string): string[] {
  const links: string[] = [];
  const urlMatches = body.match(/https:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+?)\/(issues|pull)\/(\d+)(?:#[^/\s]*)?/g) || [];

  for (const url of urlMatches) {
    const info = extractGitHubInfo(url);
    if (info) {
      const key = `${info.owner}/${info.repo}/${info.number}`;
      links.push(key);
    }
  }

  return links;
}

function extractCrossRepoReferences(body: string): string[] {
  const links: string[] = [];
  const crossRepoMatches = body.match(/([^/\s]+)\/([^/\s#]+)#(\d+)/g) || [];

  for (const ref of crossRepoMatches) {
    const parts = RegExp(/([^/\s]+)\/([^/\s#]+)#(\d+)/).exec(ref);
    if (parts) {
      const key = `${parts[1]}/${parts[2]}/${parts[3]}`;
      if (validateGitHubKey(key)) {
        links.push(key);
      }
    }
  }

  return links;
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

  const numberRefs = extractNumberReferences(body, owner, repo);
  const resolveRefs = extractResolveReferences(body, owner, repo);
  const urlRefs = extractUrlReferences(body);
  const crossRepoRefs = extractCrossRepoReferences(body);

  [...numberRefs, ...resolveRefs, ...urlRefs, ...crossRepoRefs].forEach(addValidReference);

  return Array.from(links);
}

function getIssueNumber(context: Context): number | null {
  // Extract issue/PR number based on the payload type
  if ("issue" in context.payload) {
    return context.payload.issue.number;
  }
  if ("pull_request" in context.payload) {
    return context.payload.pull_request.number;
  }
  return null;
}

function shouldSkipNode(
  key: string,
  depth: number,
  maxDepth: number,
  processingStack: Set<string>,
  linkedIssueKeys: Set<string>,
  failedFetches: Set<string>
): boolean {
  return depth > maxDepth || processingStack.has(key) || linkedIssueKeys.has(key) || failedFetches.has(key);
}

async function validateAndAddReferences(
  text: string,
  owner: string,
  repo: string,
  references: Set<string>,
  linkedIssueKeys: Set<string>,
  processedNodes: Map<string, TreeNode>,
  processingStack: Set<string>
) {
  const refs = await extractReferencedIssuesAndPrs(text, owner, repo);
  refs.forEach((ref) => {
    if (validateGitHubKey(ref) && !linkedIssueKeys.has(ref) && !processedNodes.has(ref) && !processingStack.has(ref)) {
      references.add(ref);
    }
  });
}

async function processSimilarIssues(
  similarIssues: SimilarIssue[],
  linkedIssueKeys: Set<string>,
  processedNodes: Map<string, TreeNode>,
  processingStack: Set<string>
): Promise<string[]> {
  const refs: string[] = [];

  for (const issue of similarIssues) {
    const { owner, repo, body } = issue;
    if (!owner || !repo || !body) {
      continue;
    }
    linkedIssueKeys.add(issue.issue_id);
    const issueRefs = await extractReferencedIssuesAndPrs(body, owner, repo);
    issueRefs.forEach((ref) => {
      if (validateGitHubKey(ref) && !linkedIssueKeys.has(ref) && !processedNodes.has(ref) && !processingStack.has(ref)) {
        refs.push(ref);
      }
    });
  }

  return refs;
}

async function processSimilarComments(
  similarComments: SimilarComment[],
  linkedIssueKeys: Set<string>,
  processedNodes: Map<string, TreeNode>,
  processingStack: Set<string>
): Promise<string[]> {
  const refs: string[] = [];

  for (const comment of similarComments) {
    const { org, repo, body } = comment;
    if (!org || !repo || !body) {
      continue;
    }
    linkedIssueKeys.add(comment.comment_issue_id);
    const commentRefs = await extractReferencedIssuesAndPrs(body, org, repo);
    commentRefs.forEach((ref) => {
      if (validateGitHubKey(ref) && !linkedIssueKeys.has(ref) && !processedNodes.has(ref) && !processingStack.has(ref)) {
        refs.push(ref);
      }
    });
  }

  return refs;
}

async function extractSimilarReferences(
  similarIssues: SimilarIssue[] | undefined,
  similarComments: SimilarComment[] | undefined,
  linkedIssueKeys: Set<string>,
  processedNodes: Map<string, TreeNode>,
  processingStack: Set<string>
): Promise<Set<string>> {
  const similarRefMap = new Set<string>();

  try {
    //Extract Refs from similar issues and comments
    if (similarIssues) {
      const issueRefs = await processSimilarIssues(similarIssues, linkedIssueKeys, processedNodes, processingStack);
      issueRefs.forEach((ref) => similarRefMap.add(ref));
    }

    if (similarComments) {
      const commentRefs = await processSimilarComments(similarComments, linkedIssueKeys, processedNodes, processingStack);
      commentRefs.forEach((ref) => similarRefMap.add(ref));
    }
  } catch (error) {
    console.error("Error extracting similar references:", error);
  }

  return similarRefMap;
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
  const { logger } = context;
  const processedNodes = new Map<string, TreeNode>();

  const issueNumber = getIssueNumber(context);
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
    if (shouldSkipNode(key, depth, maxDepth, processingStack, linkedIssueKeys, failedFetches)) {
      // Processing stack is used to prevent infinite loops
      logger.debug(`Skip ${key} - max depth/already processing`);
      return processedNodes.get(key) || null;
    }

    if (processedNodes.has(key)) {
      logger.debug(`Return cached node: ${key}`);
      return processedNodes.get(key) || null;
    }

    processingStack.add(key);

    try {
      const [owner, repo, issueNum] = splitKey(context, key);
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

      // Process body references
      if (node.body) {
        await validateAndAddReferences(node.body, owner, repo, references, linkedIssueKeys, processedNodes, processingStack);
      }

      // Process comment references
      if (node.comments) {
        for (const comment of node.comments) {
          if (comment.body) {
            await validateAndAddReferences(comment.body, owner, repo, references, linkedIssueKeys, processedNodes, processingStack);
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

  const similarRefMap = await extractSimilarReferences(similarIssues, similarComments, linkedIssueKeys, processedNodes, processingStack);

  try {
    const tree = await createNode(mainIssueKey, undefined, similarRefMap);
    return { tree };
  } catch (error) {
    logger.error("Error building tree", { error: error as Error });
    return { tree: null };
  }
}

function addContentIfTokensAllow(content: string[], tokenLimit: TokenLimits, output: string[]): boolean {
  const tempLimit = { ...tokenLimit };
  if (content.every((line) => updateTokenCount(line, tempLimit))) {
    content.forEach((line) => updateTokenCount(line, tokenLimit));
    output.push(...content);
    return true;
  }
  return false;
}

function processNodeBody(node: TreeNode, childPrefix: string, contentPrefix: string, testTokenLimits: TokenLimits, output: string[]): void {
  if (node.body?.trim()) {
    const bodyLines = formatContent("Body", node.body, childPrefix, contentPrefix, testTokenLimits);
    if (bodyLines.length > 0) {
      addContentIfTokensAllow(bodyLines, testTokenLimits, output);
      output.push("");
    }
  }
}

function processNodeDiffs(
  node: TreeNode,
  includeDiffs: boolean,
  childPrefix: string,
  contentPrefix: string,
  testTokenLimits: TokenLimits,
  output: string[]
): void {
  if (includeDiffs && node.type === "pull_request" && node.prDetails?.diff) {
    const diffLines = formatContent("Diff", node.prDetails.diff, childPrefix, contentPrefix, testTokenLimits);
    if (diffLines.length > 0) {
      addContentIfTokensAllow(diffLines, testTokenLimits, output);
      output.push("");
    }
  }
}

function processNodeComments(node: TreeNode, includeDiffs: boolean, childPrefix: string, testTokenLimits: TokenLimits, output: string[]): void {
  if (!node.comments?.length) return;

  const commentsHeader = `${childPrefix}Comments: ${node.comments.length}`;
  if (!updateTokenCount(commentsHeader, testTokenLimits)) return;

  output.push(commentsHeader);

  // Sort comments by recency
  const sortedComments = [...node.comments].sort((a, b) => parseInt(b.id) - parseInt(a.id));

  for (const comment of sortedComments) {
    if (!comment.body?.trim()) continue;

    const commentLine = `${childPrefix}├── ${comment.commentType || "issue_comment"}-${comment.id}: ${comment.user}: ${comment.body.trim()}`;

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

      addContentIfTokensAllow(codeLines, testTokenLimits, output);
    }
  }
  output.push("");
}

function processNodeDocuments(node: TreeNode, childPrefix: string, testTokenLimits: TokenLimits, output: string[]): void {
  if (node.parent || !node.documents?.length) return;

  const driveHeader = `${childPrefix}Document Contents:`;
  if (!updateTokenCount(driveHeader, testTokenLimits)) return;

  output.push(driveHeader);

  for (const doc of node.documents) {
    const authorText = doc.author ? " (by " + doc.author + ")" : "";
    const urlText = doc.url ? " (" + doc.url + ")" : "";
    const docHeader = `${childPrefix}├── ${doc.name}${authorText}${urlText}:`;
    if (!updateTokenCount(docHeader, testTokenLimits)) break;
    output.push(docHeader);

    const docContent = doc.content
      .split("\n")
      .map((line) => `${childPrefix}    ${line.trim()}`)
      .join("\n");
    if (!updateTokenCount(docContent, testTokenLimits)) break;
    output.push(docContent, "");
  }
  output.push("");
}

function processSimilarIssueItems(items: SimilarIssue[], type: string, contentPrefix: string, testTokenLimits: TokenLimits, output: string[]): boolean {
  for (const item of items) {
    const similarity = (item.similarity * 100).toFixed(2);
    const identifier = "Issue #" + item.issueNumber;
    const url = item.url;

    const itemHeader = contentPrefix + "- " + identifier;
    const urlPart = url ? " (" + url + ")" : "";
    const similarityPart = " - Similarity: " + similarity + "%";
    const itemLines = [itemHeader + urlPart + similarityPart];

    if (item.body) {
      const maxLength = 500;
      const truncatedBody = item.body.length > maxLength ? item.body.slice(0, maxLength) + "..." : item.body;
      itemLines.push(contentPrefix + "  " + truncatedBody);
    }

    if (!addContentIfTokensAllow(itemLines, testTokenLimits, output)) {
      return false;
    }
  }
  return true;
}

function processSimilarCommentItems(items: SimilarComment[], type: string, contentPrefix: string, testTokenLimits: TokenLimits, output: string[]): boolean {
  for (const item of items) {
    const similarity = (item.similarity * 100).toFixed(2);
    const identifier = "Comment by " + item.user?.login;

    const itemHeader = contentPrefix + "- " + identifier;
    const similarityPart = " - Similarity: " + similarity + "%";
    const itemLines = [itemHeader + similarityPart];

    if (item.body) {
      const maxLength = 500;
      const truncatedBody = item.body.length > maxLength ? item.body.slice(0, maxLength) + "..." : item.body;
      itemLines.push(contentPrefix + "  " + truncatedBody);
    }

    if (!addContentIfTokensAllow(itemLines, testTokenLimits, output)) {
      return false;
    }
  }
  return true;
}

function processSimilarContent(node: TreeNode, childPrefix: string, contentPrefix: string, testTokenLimits: TokenLimits, output: string[]): void {
  // Process similar content only for root node if space allows
  if (node.parent || testTokenLimits.runningTokenCount >= testTokenLimits.tokensRemaining - 1000) return;

  if (node.similarIssues?.length) {
    const typeHeader = `${childPrefix}${SIMILAR_ISSUE_IDENTIFIER}`;
    if (!updateTokenCount(typeHeader, testTokenLimits)) return;
    output.push(typeHeader);

    const sortedItems = [...node.similarIssues].sort((a, b) => b.similarity - a.similarity);
    if (!processSimilarIssueItems(sortedItems, SIMILAR_ISSUE_IDENTIFIER, contentPrefix, testTokenLimits, output)) {
      return;
    }
    output.push("");
  }

  if (node.similarComments?.length) {
    const typeHeader = `${childPrefix}${SIMILAR_COMMENT_IDENTIFIER}`;
    if (!updateTokenCount(typeHeader, testTokenLimits)) return;
    output.push(typeHeader);

    const sortedItems = [...node.similarComments].sort((a, b) => b.similarity - a.similarity);
    if (!processSimilarCommentItems(sortedItems, SIMILAR_COMMENT_IDENTIFIER, contentPrefix, testTokenLimits, output)) {
      return;
    }
    output.push("");
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

  processNodeBody(node, childPrefix, contentPrefix, testTokenLimits, output);
  processNodeDiffs(node, includeDiffs, childPrefix, contentPrefix, testTokenLimits, output);
  processNodeComments(node, includeDiffs, childPrefix, testTokenLimits, output);
  processNodeDocuments(node, childPrefix, testTokenLimits, output);
  processSimilarContent(node, childPrefix, contentPrefix, testTokenLimits, output);

  const isSuccess = testTokenLimits.runningTokenCount <= testTokenLimits.tokensRemaining;
  return { output, isSuccess, childrenOutput, tokenLimits: testTokenLimits };
}

async function processNodeContentWithDiffs(
  node: TreeNode,
  prefix: string,
  tokenLimits: TokenLimits
): Promise<{ output: string[]; tokenLimits: TokenLimits; success: boolean }> {
  if (node.type === "pull_request" && tokenLimits.tokensRemaining - tokenLimits.runningTokenCount > 1000) {
    const withDiffs = await processNodeContent(node, prefix, true, { ...tokenLimits });
    return { output: withDiffs.output, tokenLimits: withDiffs.tokenLimits, success: withDiffs.isSuccess };
  } else {
    const result = await processNodeContent(node, prefix, false, tokenLimits);
    return { output: result.output, tokenLimits: result.tokenLimits, success: result.isSuccess };
  }
}

async function processChildNodes(children: TreeNode[], prefix: string, output: string[], tokenLimits: TokenLimits): Promise<boolean> {
  // Sort children by recency (assuming newer items are more relevant)
  const sortedChildren = [...children].sort((a, b) => b.number - a.number);

  for (const child of sortedChildren) {
    // Check if we have enough tokens for more content
    if (tokenLimits.runningTokenCount >= tokenLimits.tokensRemaining - 500) {
      // Leave buffer
      break;
    }

    const isChildProcessingComplete = await processTreeNode(child, prefix + "  ", output, tokenLimits);
    if (!isChildProcessingComplete) {
      return false;
    }
  }
  return true;
}

async function processTreeNode(node: TreeNode, prefix: string, output: string[], tokenLimits: TokenLimits): Promise<boolean> {
  // Early check for token limit
  if (tokenLimits.runningTokenCount >= tokenLimits.tokensRemaining) {
    return false;
  }

  // Process the current node first to ensure the most relevant content is included
  const result = await processNodeContent(node, prefix, false, tokenLimits); // Start without diffs

  if (!result.isSuccess) {
    return false;
  }

  // If we have room for diffs and it's a PR, try adding them
  const contentResult = await processNodeContentWithDiffs(node, prefix, tokenLimits);

  if (contentResult.success) {
    output.push(...contentResult.output);
    Object.assign(tokenLimits, contentResult.tokenLimits);
  } else {
    output.push(...result.output);
    Object.assign(tokenLimits, result.tokenLimits);
  }

  // Process children only if we have enough tokens left
  if (tokenLimits.runningTokenCount < tokenLimits.tokensRemaining) {
    return await processChildNodes(node.children, prefix, output, tokenLimits);
  }

  return true;
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
  similarIssues: SimilarIssue[],
  documents?: DocumentFile[]
): Promise<{ tree: TreeNode | null; tokenLimits: TokenLimits }> {
  const specAndBodies: Record<string, string> = {};
  const tokenLimits = createDefaultTokenLimits(context);
  const { tree } = await buildTree(context, specAndBodies, maxDepth, tokenLimits, similarIssues, similarComments);

  if (tree) {
    // Add documents to the root node if available
    if (documents && documents?.length) {
      tree.documents = documents;
    }

    // Add pull request specific content
    if ("pull_request" in context.payload) {
      const { diff_hunk, position, original_position, path, body } = context.payload.comment || {};
      if (diff_hunk) {
        tree.body += `\nPrimary Context: ${body || ""}\nDiff: ${diff_hunk}\nPath: ${path || ""}\nLines: ${position || ""}-${original_position || ""}`;
        tree.comments = tree.comments?.filter((comment) => comment.id !== String(context.payload.comment?.id));
      }
    }
  }

  return { tree, tokenLimits };
}

export async function formatChatHistory(
  context: Context,
  maxDepth: number = 2,
  similarIssues: SimilarIssue[],
  similarComments: SimilarComment[],
  availableTokens?: number,
  documents?: DocumentFile[]
): Promise<string[]> {
  const { logger } = context;
  const { tree, tokenLimits } = await buildChatHistoryTree(context, maxDepth, similarComments, similarIssues, documents);

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

  const tokenLimitsNew = createDefaultTokenLimits(context);

  const isSuccess = await processTreeNode(reRankedChat, "", treeOutput, tokenLimitsNew);
  logger.debug(`Tree processing ${isSuccess ? "succeeded" : "failed"} with tokens: ${tokenLimitsNew.runningTokenCount}/${tokenLimitsNew.tokensRemaining}`);
  logger.debug(`Tree fetching tokens: ${tokenLimits.runningTokenCount}/${tokenLimits.tokensRemaining}`);
  return treeOutput;
}
