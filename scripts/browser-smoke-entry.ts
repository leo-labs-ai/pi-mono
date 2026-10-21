import { createHost, memoryLinkPair, replicatedState } from "@earendil-works/chord";
import { createAssistantMessageEventStream, Type } from "@leo-labs-ai/pi-ai";
import { complete, getModel, getProviders, streamSimple } from "@leo-labs-ai/pi-ai/compat";
import { Agent, streamProxy } from "@leo-labs-ai/pi-agent-core";

// Keep this entry browser-safe. It is bundled by scripts/check-browser-smoke.mjs
// to catch accidental Node-only runtime imports in browser-facing package exports.
const model = getModel("google", "gemini-2.5-flash");
const schema = Type.Object({ prompt: Type.String() });
const stream = createAssistantMessageEventStream();

const agent = new Agent({ initialState: { model }, streamFn: streamSimple });
agent.steer({ role: "user", content: [{ type: "text", text: "queued" }], timestamp: 0 });

console.log(
	model.id,
	getProviders().length,
	typeof complete,
	schema.type,
	typeof stream.push,
	agent.hasQueuedMessages(),
	typeof streamProxy,
	typeof createHost,
	typeof memoryLinkPair,
	replicatedState({ browser: true }).value.browser,
);
