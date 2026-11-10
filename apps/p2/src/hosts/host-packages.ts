// The host packages of p2's facets: the modules a facet shares with its host as instances, by specifier. Apart from
// plugins.ts (the server's plugin component, which builds with esbuild) so the worker entry imports only these: a
// worker loads neither esbuild nor the server's API.

import * as piCodemode from "@earendil-works/pi-codemode";
import * as piMcp from "@earendil-works/pi-mcp";
import * as piMcpOauth from "@earendil-works/pi-mcp/oauth";
import * as piSchema from "@earendil-works/pi-schema";
import * as schemaFormats from "@earendil-works/pi-schema/formats";
import * as piAi from "@leo-labs-ai/pi-ai";
import * as anthropicMessages from "@leo-labs-ai/pi-ai/api/anthropic-messages.lazy";
import * as googleGenerativeAi from "@leo-labs-ai/pi-ai/api/google-generative-ai.lazy";
import * as openaiCompletions from "@leo-labs-ai/pi-ai/api/openai-completions.lazy";
import * as openaiResponses from "@leo-labs-ai/pi-ai/api/openai-responses.lazy";
import * as piAiModels from "@leo-labs-ai/pi-ai/models";
import * as allProviders from "@leo-labs-ai/pi-ai/providers/all";
import * as fauxProvider from "@leo-labs-ai/pi-ai/providers/faux";
import * as radiusProvider from "@leo-labs-ai/pi-ai/providers/radius";
import * as radiusConfig from "@leo-labs-ai/pi-ai/providers/radius-config";
import * as piDurable from "@leo-labs-ai/pi-durable";
import * as durableCodemode from "@leo-labs-ai/pi-durable/codemode";
import * as durableEnv from "@leo-labs-ai/pi-durable/env";
import * as durableEnvNode from "@leo-labs-ai/pi-durable/env/node";
import * as durableToolSearch from "@leo-labs-ai/pi-durable/tool-search";
import * as durableTools from "@leo-labs-ai/pi-durable/tools";
import * as piEnv from "@leo-labs-ai/pi-env";
import * as piTui from "@leo-labs-ai/pi-tui";
import * as ws from "ws";
import * as yaml from "yaml";
import * as api from "../api/v1/index.ts";
import * as apiNode from "../api/v1/node.ts";
import * as apiWorker from "../api/v1/worker.ts";

/** The packages a facet shares with its host as instances (never bundled into a plugin's script), by specifier. */
export const SHARED_PACKAGES = {
	"@leo-labs-ai/pi-ai": piAi,
	"@leo-labs-ai/pi-ai/api/anthropic-messages.lazy": anthropicMessages,
	"@leo-labs-ai/pi-ai/api/google-generative-ai.lazy": googleGenerativeAi,
	"@leo-labs-ai/pi-ai/api/openai-completions.lazy": openaiCompletions,
	"@leo-labs-ai/pi-ai/api/openai-responses.lazy": openaiResponses,
	"@leo-labs-ai/pi-ai/models": piAiModels,
	"@leo-labs-ai/pi-ai/providers/all": allProviders,
	"@leo-labs-ai/pi-ai/providers/faux": fauxProvider,
	"@leo-labs-ai/pi-ai/providers/radius": radiusProvider,
	"@leo-labs-ai/pi-ai/providers/radius-config": radiusConfig,
	"@earendil-works/pi-codemode": piCodemode,
	"@leo-labs-ai/pi-durable": piDurable,
	"@leo-labs-ai/pi-durable/codemode": durableCodemode,
	"@leo-labs-ai/pi-durable/env": durableEnv,
	"@leo-labs-ai/pi-durable/env/node": durableEnvNode,
	"@leo-labs-ai/pi-durable/tool-search": durableToolSearch,
	"@leo-labs-ai/pi-durable/tools": durableTools,
	"@leo-labs-ai/pi-env": piEnv,
	"@earendil-works/pi-mcp": piMcp,
	"@earendil-works/pi-mcp/oauth": piMcpOauth,
	"@earendil-works/pi-schema": piSchema,
	"@earendil-works/pi-schema/formats": schemaFormats,
	ws,
	yaml,
};

/** The host packages of worker facets (pi-tui too: file completion ranks as pi-tui's autocomplete does). */
export const WORKER_PACKAGES = {
	"@p2/app/v1": api,
	"@p2/app/v1/node": apiNode,
	"@p2/app/v1/worker": apiWorker,
	"@leo-labs-ai/pi-tui": piTui,
	...SHARED_PACKAGES,
};
