import { Context } from "../../types";
import { AppParamsHelper, GroundTruthsSystemMessage, ModelApplications } from "../../types/llm";
import { chatBotPayloadTypeguard, codeReviewPayloadTypeguard } from "../../types/typeguards";
import { createGroundTruthSysMsg } from "./create-system-message";
import { GROUND_TRUTHS_SYSTEM_MESSAGES } from "./prompts";
import { validateGroundTruths } from "./validate";

export async function findGroundTruths<TApp extends ModelApplications = ModelApplications>(
  context: Context,
  application: TApp,
  params: AppParamsHelper<TApp>
): Promise<string[]> {
  const { logger } = context;
  const systemMsgObj = GROUND_TRUTHS_SYSTEM_MESSAGES[application];

  // params are deconstructed to show quickly what's being passed to the function

  if (chatBotPayloadTypeguard(params)) {
    const { dependencies, devDependencies, languages } = params;
    return findChatBotTruths(context, { dependencies, devDependencies, languages }, systemMsgObj);
  } else if (codeReviewPayloadTypeguard(params)) {
    const { taskSpecification } = params;
    return findCodeReviewTruths(context, { taskSpecification }, systemMsgObj);
  } else {
    throw logger.error("Invalid payload type for ground truths");
  }
}

async function findChatBotTruths(
  context: Context,
  params: AppParamsHelper<"chat-bot">,
  systemMsgObj: GroundTruthsSystemMessage<"chat-bot">
): Promise<string[]> {
  const {
    adapters: {
      openai: { completions },
    },
  } = context;
  const systemMsg = createGroundTruthSysMsg(systemMsgObj);
  const truths = await completions.createGroundTruthCompletion<"chat-bot">(JSON.stringify(params), systemMsg, "o1-mini");
  return validateGroundTruths(context, truths);
}

async function findCodeReviewTruths(
  context: Context,
  params: AppParamsHelper<"code-review">,
  systemMsgObj: GroundTruthsSystemMessage<"code-review">
): Promise<string[]> {
  const {
    adapters: {
      openai: { completions },
    },
  } = context;
  const systemMsg = createGroundTruthSysMsg(systemMsgObj);
  const truths = await completions.createGroundTruthCompletion<"code-review">(params.taskSpecification, systemMsg, "gpt-4o");
  return validateGroundTruths(context, truths);
}
