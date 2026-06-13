import type { WorkerRequest, WorkerResponse } from '../types';

interface PendingRequest {
	resolve: (response: WorkerResponse) => void;
	reject: (error: Error) => void;
}

/**
 * Manages communication with the Worker thread.
 * Wraps postMessage with typed request/response and Promise-based API.
 */
export class WorkerManager {
	private pending = new Map<string, PendingRequest>();
	private requestCounter = 0;

	constructor(private worker: Worker) {
		this.worker.onmessage = (e: MessageEvent) => {
			const data = e.data as WorkerResponse & { _requestId?: string };
			if (data._requestId) {
				const pending = this.pending.get(data._requestId);
				if (pending) {
					this.pending.delete(data._requestId);
					const { _requestId, ...response } = data;
					void _requestId;
					pending.resolve(response as WorkerResponse);
				}
			}
		};

		this.worker.onerror = (e: ErrorEvent) => {
			for (const [id, pending] of this.pending) {
				this.pending.delete(id);
				pending.reject(new Error(`Worker error: ${e.message}`));
			}
		};
	}

	request(req: WorkerRequest): Promise<WorkerResponse> {
		return new Promise<WorkerResponse>((resolve, reject) => {
			const requestId = `req_${++this.requestCounter}_${Date.now()}`;
			this.pending.set(requestId, { resolve, reject });
			this.worker.postMessage({ ...req, _requestId: requestId });
		});
	}

	destroy(): void {
		this.worker.terminate();
		this.pending.clear();
	}
}
