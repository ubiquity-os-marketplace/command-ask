import { VoyageAIClient } from "voyageai";
import { Context } from "../../../types";
import { SimilarIssue, SimilarComment } from "../../../types/github-types";
import { SuperVoyage } from "./voyage";
import { TreeNode } from "../../../types/github-types";

interface DocumentWithMetadata {
  document: string;
  metadata: {
    type: "issue" | "comment";
    originalData: SimilarIssue | SimilarComment;
  };
}

export class Rerankers extends SuperVoyage {
  protected context: Context;

  constructor(client: VoyageAIClient, context: Context) {
    super(client, context);
    this.context = context;
  }

  private async _reRankNodesAtLevel(nodes: TreeNode[], query: string, topK: number = 100): Promise<TreeNode[]> {
    if (nodes.length === 0) return nodes;

    // Extract content from each node to create documents for reranking
    const documents = nodes.map((node) => {
      const content = [
        node.body || "",
        ...(node.comments?.map((comment) => comment.body || "") || []),
        ...(node.similarIssues?.map((issue) => issue.body || "") || []),
        ...(node.similarComments?.map((comment) => comment.body || "") || []),
        ...(node.codeSnippets?.map((snippet) => snippet.body || "") || []),
        node.readmeSection || "",
      ]
        .filter(Boolean)
        .join("\n");

      return {
        document: content,
        metadata: { originalNode: node },
      };
    });

    // Rerank the documents
    const response = await this.client.rerank({
      query,
      documents: documents.map((doc) => doc.document),
      model: "rerank-2",
      returnDocuments: true,
      topK: Math.min(topK, documents.length),
    });

    const rerankedResults = response.data || [];

    // Map the reranked results back to their original nodes with scores
    return rerankedResults
      .map((result, index) => {
        const originalNode = documents[index].metadata.originalNode;
        // Try different possible score properties from the API response
        const score = result.relevanceScore || 0;
        if (originalNode && typeof score === "number") {
          return {
            node: originalNode,
            score,
          };
        }
        return null;
      })
      .filter((item): item is { node: TreeNode; score: number } => item !== null)
      .sort((a, b) => b.score - a.score) // Sort by score in descending order
      .map((item) => item.node);
  }

  async reRankTreeNodes(rootNode: TreeNode, query: string, topK: number = 100): Promise<TreeNode> {
    try {
      // Helper function to process a node and its children recursively
      const processNode = async (node: TreeNode, parentNode?: TreeNode): Promise<TreeNode> => {
        // Create a new node with all properties from the original
        const processedNode: TreeNode = {
          ...node,
          parent: parentNode, // Set the parent reference
          children: [], // Clear children array to be populated with reranked children
        };

        // Rerank children if they exist
        if (node.children.length > 0) {
          const rerankedChildren = await this._reRankNodesAtLevel(node.children, query, topK);
          // Process each reranked child recursively, passing the current node as parent
          processedNode.children = await Promise.all(rerankedChildren.map((child) => processNode(child, processedNode)));
        }

        return processedNode;
      };

      // Process the entire tree starting from the root (no parent for root node)
      return await processNode(rootNode);
    } catch (e: unknown) {
      this.context.logger.error("Reranking tree nodes failed!", { e });
      return rootNode;
    }
  }

  async reRankResults(results: string[], query: string, topK: number = 5): Promise<string[]> {
    let response;
    try {
      response = await this.client.rerank({
        query,
        documents: results,
        model: "rerank-2",
        returnDocuments: true,
        topK,
      });
    } catch (e: unknown) {
      this.context.logger.error("Reranking failed!", { e });
      return results;
    }
    const rerankedResults = response.data || [];
    return rerankedResults.map((result) => result.document).filter((document): document is string => document !== undefined);
  }

  async reRankSimilarContent(
    similarIssues: SimilarIssue[],
    similarComments: SimilarComment[],
    query: string,
    topK: number = 5
  ): Promise<{ similarIssues: SimilarIssue[]; similarComments: SimilarComment[] }> {
    try {
      // Prepare documents for reranking
      const issueDocuments: DocumentWithMetadata[] = similarIssues.map((issue) => ({
        document: issue.body || "",
        metadata: { type: "issue", originalData: issue },
      }));

      const commentDocuments: DocumentWithMetadata[] = similarComments.map((comment) => ({
        document: comment.body || "",
        metadata: { type: "comment", originalData: comment },
      }));

      const allDocuments = [...issueDocuments, ...commentDocuments].filter((doc) => doc.document);

      if (allDocuments.length === 0) {
        return { similarIssues, similarComments };
      }

      // Rerank all documents together
      const response = await this.client.rerank({
        query,
        documents: allDocuments.map((doc) => doc.document),
        model: "rerank-2",
        returnDocuments: true,
        topK: Math.min(topK, allDocuments.length),
      });

      const rerankedResults = response.data || [];

      // Separate and reconstruct the reranked issues and comments
      const rerankedIssues: SimilarIssue[] = [];
      const rerankedComments: SimilarComment[] = [];

      rerankedResults.forEach((result, index) => {
        const originalDoc = allDocuments[index];
        if (originalDoc.metadata.type === "issue") {
          rerankedIssues.push(originalDoc.metadata.originalData as SimilarIssue);
        } else {
          rerankedComments.push(originalDoc.metadata.originalData as SimilarComment);
        }
      });

      return {
        similarIssues: rerankedIssues,
        similarComments: rerankedComments,
      };
    } catch (e: unknown) {
      this.context.logger.error("Reranking similar content failed!", { e });
      return { similarIssues, similarComments };
    }
  }
}
