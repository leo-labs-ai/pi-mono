import { bedrockProviderModule } from "@leo-labs-ai/pi-ai/bedrock-provider";
import { registerBunOAuthFlows } from "@leo-labs-ai/pi-ai/bun-oauth";
import { setBedrockProviderModule } from "@leo-labs-ai/pi-ai/compat";
// Bun loads .wasm imports as files: embedded in compiled executables, evaluating to a readable path.
import quickjsWasmPath from "quickjs-wasi/quickjs.wasm";
import { APP_NAME, setEmbeddedQuickJSWasmPath } from "../config.ts";

process.title = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;
registerBunOAuthFlows();
setBedrockProviderModule(bedrockProviderModule);
setEmbeddedQuickJSWasmPath(quickjsWasmPath);
