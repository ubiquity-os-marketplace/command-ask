import { SupabaseClient } from "@supabase/supabase-js";
import { SuperSupabase } from "./supabase";
import { Context } from "../../../types/context";

export interface IssueSimilaritySearchResult {
  issue_id: string;
  issue_plaintext: string;
  similarity: number;
  text_similarity: number;
}

export interface IssueType {
  id: string;
  markdown?: string;
  plaintext?: string;
  payload?: Record<string, unknown>;
  author_id: number;
  created_at: string;
  modified_at: string;
  embedding: number[];
}

export class Issue extends SuperSupabase {
  constructor(supabase: SupabaseClient, context: Context) {
    super(supabase, context);
  }
  async getIssue(issueNodeId: string): Promise<IssueType[] | null> {
    const { data, error } = await this.supabase.from("issues").select("*").eq("id", issueNodeId).returns<IssueType[]>();
    if (error) {
      this.context.logger.error("Error getting issue", error);
      return null;
    }
    return data;
  }
  async findSimilarIssues(plaintext: string, threshold: number, currentId: string): Promise<IssueSimilaritySearchResult[] | null> {
    const embedding = await this.context.adapters.voyage.embedding.createEmbedding({ text: plaintext, prompt: "This is a query for the stored documents:" });
    plaintext = plaintext.replace(/'/g, "''").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "\\%").replace(/_/g, "\\_");
    const { data, error } = await this.supabase.rpc("find_similar_issue_ftse", {
      current_id: currentId,
      query_text: plaintext,
      query_embedding: embedding,
      threshold: threshold,
      max_results: 10,
    });
    if (error) {
      this.context.logger.error("Error finding similar issues", error);
      return [];
    }
    return data;
  }
}
