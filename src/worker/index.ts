/**
 * Worker thread entry point — W1 skeleton
 *
 * Handles message dispatch for CPU-intensive tasks.
 * Full vectra integration comes in W2.
 * Worker does NOT make HTTP requests and does NOT import Obsidian API.
 */

import type { WorkerRequest, WorkerResponse } from '../types';

self.onmessage = async (e: MessageEvent) => {
	const msg = e.data as WorkerRequest & { _requestId?: string };
	const requestId = msg._requestId;

	try {
		const response = await handleMessage(msg);
		if (requestId) {
			(response as Record<string, unknown>)._requestId = requestId;
		}
		self.postMessage(response);
	} catch (err) {
		const errorResponse: WorkerResponse = {
			type: 'error',
			payload: {
				code: 'WORKER_ERROR',
				message: err instanceof Error ? err.message : String(err),
			},
		};
		if (requestId) {
			(errorResponse as Record<string, unknown>)._requestId = requestId;
		}
		self.postMessage(errorResponse);
	}
};

async function handleMessage(msg: WorkerRequest & { _requestId?: string }): Promise<WorkerResponse> {
	switch (msg.type) {
		case 'index.status': {
			return {
				type: 'index.status.result',
				payload: { totalDocs: 0, lastIndexTime: 0 },
			};
		}

		case 'index.full':
		case 'index.incremental':
		case 'index.delete':
		case 'vector.search':
		case 'vector.upsert':
		case 'vector.delete': {
			return {
				type: 'error',
				payload: {
					code: 'NOT_IMPLEMENTED',
					message: `${msg.type} will be implemented in W2`,
				},
			};
		}

		default: {
			return {
				type: 'error',
				payload: {
					code: 'UNKNOWN_REQUEST',
					message: `Unknown request type: ${(msg as WorkerRequest).type}`,
				},
			};
		}
	}
}
