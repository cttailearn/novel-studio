import { randomUUID } from "node:crypto";
import type { AskBroker, AskRequest } from "../ai/ask.ts";

/**
 * 提问挂多久算作者不在。
 *
 * 十分钟 —— 够他放下手里的事回来看一眼，也不至于让一个会话永远吊着。
 * 超时后当作"没回答"：模型按自己的判断往下走，而不是替作者编一个答案。
 */
const ASK_TIMEOUT_MS = 10 * 60 * 1000;

/** 问题收尾的原因。 */
export type QuestionClosedReason = "answered" | "timeout" | "aborted";

/** 智能体发问。NDJSON 线上就是这一个形状。 */
export interface AskQuestionEvent {
	type: "question";
	id: string;
	question: string;
	options: string[];
}

/** 问题收尾。 */
export interface AskQuestionClosedEvent {
	type: "question_closed";
	id: string;
	reason: QuestionClosedReason;
}

type Emitter = (event: AskQuestionEvent | AskQuestionClosedEvent) => void;

interface PendingQuestion {
	id: string;
	sessionId: string;
	question: string;
	options: string[];
	settle: (answer: string, reason: QuestionClosedReason) => void;
	timer: NodeJS.Timeout;
}

/**
 * 全局待答表。
 *
 * 按 id 就能找到，不必先知道是哪个会话 —— 回答走的是独立的一条 HTTP 请求，
 * 那条请求手里只有 id。
 */
const pendingQuestions = new Map<string, PendingQuestion>();

/**
 * 一个会话的提问通道。
 *
 * 智能体在工具里挂着等作者回话；作者的回答从另一条 HTTP 请求进来，
 * 由 answer() 把这个工具的 Promise 解开，模型在同一轮里接着往下做。
 */
export class AskChannel implements AskBroker {
	private emitter: Emitter | null = null;
	/** 这个通道属于哪个会话。 */
	readonly sessionId: string;

	constructor(sessionId: string) {
		this.sessionId = sessionId;
	}

	/**
	 * 绑定当前这次请求的流出口。
	 *
	 * 出口每轮请求换一次（每次 POST /messages 是一条新的 NDJSON 流），
	 * 通道本身是会话级的 —— 跨轮复用同一个，模型才有"上一句我还没问完"的连续感。
	 */
	bindEmitter(emitter: Emitter | null): void {
		this.emitter = emitter;
	}

	ask(request: AskRequest, signal?: AbortSignal): Promise<string> {
		const id = randomUUID();
		const options = request.options ?? [];
		return new Promise<string>((resolve) => {
			let settled = false;
			const settle = (answer: string, reason: QuestionClosedReason): void => {
				if (settled) return;
				settled = true;
				const item = pendingQuestions.get(id);
				if (item) {
					clearTimeout(item.timer);
					pendingQuestions.delete(id);
				}
				this.emit({ type: "question_closed", id, reason });
				resolve(answer);
			};
			const timer = setTimeout(() => settle("", "timeout"), ASK_TIMEOUT_MS);
			// 别让这个定时器把进程钉住 —— 它只是兜底，不是主角。
			timer.unref?.();
			pendingQuestions.set(id, { id, sessionId: this.sessionId, question: request.question, options, settle, timer });

			// 这一轮被中止时，答案永远等不到了 —— 立刻放开，别把会话吊死。
			if (signal) {
				if (signal.aborted) {
					settle("", "aborted");
					return;
				}
				signal.addEventListener("abort", () => settle("", "aborted"), { once: true });
			}

			this.emit({ type: "question", id, question: request.question, options });
		});
	}

	/**
	 * 作者回话了。
	 *
	 * 返回 false 表示这问题已经不在了（超时、被中止，或者压根没有这个 id）。
	 */
	answer(id: string, answer: string): boolean {
		const item = pendingQuestions.get(id);
		if (!item) return false;
		item.settle(answer, "answered");
		return true;
	}

	/**
	 * 会话没了（删掉、换模型、超时淘汰）时把还挂着的问题放掉。
	 *
	 * 不放的话，那些工具会一直等着 —— 而等的那个请求可能早就断了。
	 */
	close(reason: QuestionClosedReason = "aborted"): void {
		for (const item of [...pendingQuestions.values()]) {
			if (item.sessionId === this.sessionId) item.settle("", reason);
		}
	}

	private emit(event: AskQuestionEvent | AskQuestionClosedEvent): void {
		this.emitter?.(event);
	}
}

/**
 * 作者回话了。按 id 找得到就行，不必先知道是哪个会话。
 */
export function answerQuestion(id: string, answer: string): boolean {
	const item = pendingQuestions.get(id);
	if (!item) return false;
	item.settle(answer, "answered");
	return true;
}

/** 现在有多少个问题挂着。给测试和运维看的。 */
export function pendingQuestionCount(): number {
	return pendingQuestions.size;
}
