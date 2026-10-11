import type {ApiClient} from '../api/client';
import {readOperation} from '../api/operations';
import {checkedOrderOperation} from './responses';
export const readOrderOperation = (client: ApiClient, id: string, external?: AbortSignal) => readOperation(client, id, checkedOrderOperation, external);
