import { processCommentCallback } from "../handlers/comment-created-callback";
import { Context, SupportedEvents } from "../types";
import { CallbackResult, ProxyCallbacks } from "../types/proxy";

/**
 * The `callbacks` object defines an array of callback functions for each supported event type.
 *
 * Since multiple callbacks might need to be executed for a single event, we store each
 * callback in an array. This design allows for extensibility and flexibility, enabling
 * us to add more callbacks for a particular event without modifying the core logic.
 */
const callbacks = {
  "issue_comment.created": [processCommentCallback],
  "pull_request_review_comment.created": [processCommentCallback],
} as ProxyCallbacks;

export async function callCallbacks<T extends SupportedEvents>(context: Context<T>, eventName: T): Promise<CallbackResult> {
  if (!callbacks[eventName]) {
    context.logger.info(`No callbacks found for event ${eventName}`);
    return { status: 204, reason: "skipped" };
  }
  return (await Promise.all(callbacks[eventName].map((callback) => callback(context))))[0];
}
