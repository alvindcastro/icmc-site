import type {ApiClient} from '../api/client';
import type {Operation} from '../api/types';
import type {OrderMutationResult} from './types';
import {checkedOrderOperation} from './responses';
export async function readOrderOperation(client: ApiClient, id: string, external?: AbortSignal): Promise<Operation<OrderMutationResult>> {
  const deadline = Date.now() + 30000; const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  const signal = external ? AbortSignal.any([external, controller.signal]) : controller.signal;
  let delay = 1000;
  try {
    while (true) {
      signal.throwIfAborted();
      const operation = checkedOrderOperation(await client.request(`/operations/${encodeURIComponent(id)}`, {signal}), id);
      signal.throwIfAborted();
      if (operation.state !== 'processing' || Date.now() + delay >= deadline) return operation;
      await new Promise<void>((resolve, reject) => {
        const cancel = () => {clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(new DOMException('Aborted', 'AbortError'));};
        const timer = setTimeout(() => {signal.removeEventListener('abort', cancel); resolve();}, delay);
        signal.addEventListener('abort', cancel, {once: true});
      });
      delay = Math.min(delay * 2, 5000);
    }
  } finally {clearTimeout(timeout);}
}
