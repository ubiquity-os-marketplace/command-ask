import { VoyageAIClient } from "voyageai";
import { retry } from "../../../helpers/retry";
import { Context } from "../../../types";
import { SuperVoyage } from "./voyage";
const VECTOR_SIZE = 1024;

export class Embedding extends SuperVoyage {
  protected context: Context;

  constructor(client: VoyageAIClient, context: Context) {
    super(client, context);
    this.context = context;
  }

  async createEmbedding(input: { text?: string; prompt?: string } = {}): Promise<number[]> {
    const { text = null, prompt = null } = input;
    if (text === null) {
      return new Array(VECTOR_SIZE).fill(0);
    } else {
      const response = await retry(
        () =>
          this.client.embed({
            input: prompt ? `${prompt} ${text}` : text,
            model: "voyage-large-2-instruct",
          }),
        { maxRetries: this.context.config.maxRetryAttempts }
      );
      return (response.data && response.data[0]?.embedding) || [];
    }
  }
}
