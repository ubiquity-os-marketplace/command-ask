import { Context } from "../../types";

export function validateGroundTruths(context: Context, truthsString: string | null): string[] {
  const { logger } = context;

  let truths;
  if (!truthsString) {
    throw logger.error("Failed to generate ground truths");
  }

  try {
    truths = JSON.parse(truthsString);
  } catch (err) {
    throw logger.error("Failed to parse ground truths", { err });
  }
  if (!Array.isArray(truths)) {
    throw logger.error("Ground truths must be an array");
  }

  if (truths.length > 10) {
    throw logger.error("Ground truths must not exceed 10");
  }

  truths.forEach((truth: string) => {
    if (typeof truth !== "string") {
      throw logger.error("Each ground truth must be a string");
    }
  });

  return truths;
}
