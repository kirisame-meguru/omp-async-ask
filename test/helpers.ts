import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { ANSWER_TYPE, EVENT_TYPE, type QuestionEvent } from "../src/state";

export const input = {
	title: "Deployment target",
	html: '<form><label>Target<input name="target" required></label></form>',
	blockedWork: "Deploying the service",
};

export function journal() {
	const entries: SessionEntry[] = [];
	const append = (data: QuestionEvent) => {
		entries.push({
			type: "custom",
			id: crypto.randomUUID(),
			parentId: entries.at(-1)?.id ?? null,
			timestamp: new Date().toISOString(),
			customType: EVENT_TYPE,
			data,
		});
	};
	return { entries, append };
}

export function recorded(sessionId: string, requestId: string, answerId: string): AgentMessage {
	return {
		role: "custom",
		customType: ANSWER_TYPE,
		content: "The user answered.",
		display: true,
		timestamp: Date.now(),
		details: { sessionId, requestId, answerId },
	};
}

/** The actual on-disk envelope written by OMP's public sendMessage API. */
export function recordedEntry(
	sessionId: string,
	requestId: string,
	answerId: string,
): Extract<SessionEntry, { type: "custom_message" }> {
	return {
		type: "custom_message",
		id: crypto.randomUUID(),
		parentId: null,
		timestamp: new Date().toISOString(),
		customType: ANSWER_TYPE,
		content: "The user answered.",
		display: true,
		attribution: "user",
		details: { sessionId, requestId, answerId },
	};
}
