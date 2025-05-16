import { createClient } from "@supabase/supabase-js";
import { GoogleAuth } from "google-auth-library";
import { google } from "googleapis";
import OpenAI from "openai";
import { VoyageAIClient } from "voyageai";
import { createAdapters } from "./adapters";
import { processCommentCallback } from "./handlers/comment-created-callback";
import { callCallbacks } from "./helpers/callback-proxy";
import { Context } from "./types";

export async function plugin(context: Context) {
  const { env, config } = context;
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_KEY);
  const voyageClient = new VoyageAIClient({
    apiKey: env.VOYAGEAI_API_KEY,
  });
  const openAiObject = {
    apiKey: (config.openAiBaseUrl && env.OPENROUTER_API_KEY) || env.OPENAI_API_KEY,
    ...(config.openAiBaseUrl && { baseURL: config.openAiBaseUrl }),
  };
  const openaiClient = new OpenAI(openAiObject);
  if (config.processDocumentLinks) {
    const credentials = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_KEY);

    if (!credentials || typeof credentials !== "object" || !credentials.client_email || !credentials.private_key) {
      throw context.logger.error("Invalid Google Service Account key. Exiting.");
    }

    const auth = new GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/cloud-platform"],
    });
    const drive = google.drive({ version: "v3", auth });
    context.logger.info("Google Drive API client initialized");
    context.adapters = createAdapters(supabase, voyageClient, openaiClient, context, drive);
  } else {
    context.adapters = createAdapters(supabase, voyageClient, openaiClient, context);
  }

  if (context.command) {
    return await processCommentCallback(context);
  }
  return await callCallbacks(context, context.eventName);
}
