import { bedrockProviderModule } from "@lue-labs/pi-ai/bedrock-provider";
import { registerBunOAuthFlows } from "@lue-labs/pi-ai/bun-oauth";
import { setBedrockProviderModule } from "@lue-labs/pi-ai/compat";
// Bun loads .wasm imports as files: embedded in compiled executables, evaluating to a readable path.
import quickjsWasmPath from "quickjs-wasi/quickjs.wasm";
import { APP_NAME, setEmbeddedQuickJSWasmPath } from "../config.ts";

process.title = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;
registerBunOAuthFlows();
setBedrockProviderModule(bedrockProviderModule);
setEmbeddedQuickJSWasmPath(quickjsWasmPath);
