import * as core from "@actions/core";
import * as github from "@actions/github";
import { Value } from "@sinclair/typebox/value";
import { envSchema } from "./types/env";
import { pluginSettingsSchema, PluginInputs, pluginSettingsValidator } from "./types";
import { plugin } from "./plugin";

/**
 * How a GitHub action executes the plugin.
 */
export async function run() {
  const payload = github.context.payload.inputs;
  const env = Value.Decode(envSchema, process.env);
  const settings = Value.Decode(pluginSettingsSchema, Value.Default(pluginSettingsSchema, JSON.parse(payload.settings)));

  if (!pluginSettingsValidator.test(settings)) {
    throw new Error("Invalid settings provided");
  }

  const inputs: PluginInputs = {
    stateId: payload.stateId,
    eventName: payload.eventName,
    eventPayload: JSON.parse(payload.eventPayload),
    settings,
    authToken: payload.authToken,
    ref: payload.ref,
  };

  await plugin(inputs, env);
}

run()
  .then((result) => {
    core.setOutput("result", result);
  })
  .catch((error) => {
    console.error(error);
    core.setFailed(error);
  });
