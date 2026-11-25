import { createRoot, effect, nativeRendering } from "@oh-my-pi/pi-tui";
import { writeTerminalSequence } from "@oh-my-pi/pi-tui/driver/session";
import type { QuestionStore } from "./state";

// OSC 7501 child records coexist with the host's working/done/approval status.
// Clearing this id removes only our record, never another program's status.
const PENDING = "\x1b]7501;state=blocked:kind=question:id=omp-async-ask:app=omp:title=UXVlc3Rpb25z\x1b\\";
const CLEAR = "\x1b]7501;state=clear:id=omp-async-ask\x1b\\";

/** Publish pending questions using Tern's native waiting-state indicator. */
export class QuestionAttention {
	#published = false;
	readonly #unsubscribeStore: () => void;
	readonly #unsubscribeNative: () => void;

	constructor(readonly store: QuestionStore) {
		this.#unsubscribeStore = store.subscribe(() => this.#sync());
		this.#unsubscribeNative = createRoot(dispose => {
			effect(() => this.#sync());
			return dispose;
		});
		this.#sync();
	}

	#sync(): void {
		// Classic transcript redraws emit OSC 133 prompt marks, which drop blocked
		// records. Native surfaces do not: no polling or competing status writers.
		const pending = nativeRendering() && this.store.list().some(question => question.status === "pending");
		if (pending === this.#published) return;
		this.#published = pending;
		writeTerminalSequence(pending ? PENDING : CLEAR);
	}

	dispose(): void {
		this.#unsubscribeStore();
		this.#unsubscribeNative();
		if (!this.#published) return;
		this.#published = false;
		writeTerminalSequence(CLEAR);
	}
}
