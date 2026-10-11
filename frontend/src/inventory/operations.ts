import type {ApiClient} from '../api/client';
import {readOperation} from '../api/operations';
import {checkedInventoryOperation} from './responses';
export const readInventoryOperation = (client: ApiClient, id: string, external?: AbortSignal) => readOperation(client, id, checkedInventoryOperation, external);
