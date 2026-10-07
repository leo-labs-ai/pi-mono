import { Agent } from "@leo-labs-ai/pi-agent-core";
import { createModels } from "@leo-labs-ai/pi-ai";
import { anthropicProvider } from "@leo-labs-ai/pi-ai/providers/anthropic";

const models = createModels();
models.setProvider(anthropicProvider());
const model = models.getModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Anthropic smoke-test model not found");

export const agent = new Agent({
	initialState: { model },
	streamFn: models.streamSimple.bind(models),
});
