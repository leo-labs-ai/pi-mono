import { type Api, type Model, supportsUltrafast } from "@leo-labs-ai/pi-ai";
import { isVirtualModel } from "./virtual-models.ts";

export type UltrafastCommandAction = "on" | "off" | "status" | "toggle";

/** Parse the argument text after `/ultrafast`. Returns undefined for unknown arguments. */
export function parseUltrafastArgument(argument: string): UltrafastCommandAction | undefined {
	const value = argument.trim().toLowerCase();
	if (value === "") return "toggle";
	if (value === "on" || value === "off" || value === "status") return value;
	return undefined;
}

/** Whether the next request to `model` carries `service_tier: "ultrafast"`. */
export function isUltrafastActive(enabled: boolean, model: Pick<Model<Api>, "id" | "api"> | undefined): boolean {
	return enabled && model !== undefined && supportsUltrafast(model);
}

type ModelRef = Pick<Model<Api>, "id" | "api">;

/**
 * What the preference means for the current selection. A virtual selection never reaches a
 * provider, so its outcome depends on the physical model the router picks per request: `pending`
 * until a response has been routed, then `routed-*` describes the latest route only.
 */
export type UltrafastState = "off" | "active" | "ignored" | "pending" | "routed-active" | "routed-ignored";

export function getUltrafastState(
	enabled: boolean,
	selected: ModelRef | undefined,
	routed: ModelRef | undefined,
): UltrafastState {
	if (!enabled || !selected) return "off";
	if (isVirtualModel(selected)) {
		if (!routed) return "pending";
		return supportsUltrafast(routed) ? "routed-active" : "routed-ignored";
	}
	return supportsUltrafast(selected) ? "active" : "ignored";
}

/** One-line description for `/ultrafast` output. */
export function describeUltrafastStatus(enabled: boolean, selected: ModelRef | undefined, routed?: ModelRef): string {
	const state = getUltrafastState(enabled, selected, routed);
	switch (state) {
		case "off":
			return enabled ? "Ultrafast is on (no model selected)" : "Ultrafast is off";
		case "active":
			return `Ultrafast is on (active for ${selected?.id})`;
		case "ignored":
			return `Ultrafast is on, but ${selected?.id} does not support it; the setting is ignored until you switch to a supported model`;
		case "pending":
			return `Ultrafast is on; ${selected?.id} routes each request, so support is known after the first routed response`;
		case "routed-active":
			return `Ultrafast is on; the latest route (${routed?.id}) supports it`;
		case "routed-ignored":
			return `Ultrafast is on, but the latest route (${routed?.id}) does not support it; routes can change per request`;
	}
}
