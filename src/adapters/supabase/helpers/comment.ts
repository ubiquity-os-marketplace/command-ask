import { SupabaseClient } from "@supabase/supabase-js";
import { SuperSupabase } from "./supabase";
import { Context } from "../../../types/context";

export interface CommentType {
  id: string;
  plaintext: string;
  markdown?: string;
  author_id: number;
  created_at: string;
  modified_at: string;
  embedding: number[];
}

export interface CommentSimilaritySearchResult {
  comment_id: string;
  comment_plaintext: string;
  comment_issue_id: string;
  similarity: number;
  text_similarity: number;
}

export class Comment extends SuperSupabase {
  constructor(supabase: SupabaseClient, context: Context) {
    super(supabase, context);
  }
  async getComment(commentNodeId: string): Promise<CommentType[] | null> {
    const { data, error } = await this.supabase.from("issue_comments").select("*").eq("id", commentNodeId);
    if (error) {
      this.context.logger.error("Error getting comment", error);
    }
    return data;
  }
  async findSimilarComments(query: string, threshold: number, currentId: string): Promise<CommentSimilaritySearchResult[] | null> {
    const embedding = await this.context.adapters.voyage.embedding.createEmbedding({ text: query, prompt: "This is a query for the stored documents:" });
    //Escape the any special characters in the query for use in the SQL query
    query = query.replace(/'/g, "''").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "\\%").replace(/_/g, "\\_");
    this.context.logger.info(`Query: ${query}`);
    const { data, error } = await this.supabase.rpc("find_similar_comments", {
      current_id: currentId,
      query_text: query,
      query_embedding: embedding,
      threshold: threshold,
      max_results: 10,
    });
    if (error) {
      this.context.logger.error("Error finding similar comments", error);
    }
    return data;
  }
}
