import {afterEach, describe, expect, it, vi} from 'vitest';
import {createApiClient} from '../src/api/client';
import {readOrderOperation} from '../src/orders/operations';
afterEach(() => vi.useRealTimers());
function processing() {return {operation_id: 'pending-id', state: 'processing', resource_type: 'order', resource_id: null, result: null, error: null, started_at: '2026-10-07T12:00:00Z', completed_at: null};}
function rejected() {return {...processing(), state: 'rejected', completed_at: '2026-10-07T12:00:05Z', error: {http_status: 422, error: {code: 'invalid', message: 'Rejected without side effect.', field_errors: [], details: {}}}};}
describe('bounded read-only order reconciliation', () => {
  it('polls processing with backoff and returns its verified outcome without mutations', async () => {
    vi.useFakeTimers(); let calls = 0; const transport = vi.fn(async () => new Response(JSON.stringify(++calls < 3 ? processing() : rejected())));
    const client = createApiClient({baseUrl: '/api/v1', transport}); const result = readOrderOperation(client, 'pending-id');
    const assertion = expect(result).resolves.toMatchObject({state: 'rejected'}); await vi.advanceTimersByTimeAsync(4000); await assertion;
    expect(transport).toHaveBeenCalledTimes(3); expect(transport.mock.calls.every(args => (args as unknown[])[1] && ((args as unknown[])[1] as RequestInit).method === 'GET')).toBe(true);
  });
  it('stops polling within thirty seconds while leaving processing unresolved', async () => {
    vi.useFakeTimers(); const transport = vi.fn(async () => new Response(JSON.stringify(processing())));
    const result = readOrderOperation(createApiClient({baseUrl: '/api/v1', transport}), 'pending-id'); const assertion = expect(result).resolves.toMatchObject({state: 'processing'});
    await vi.advanceTimersByTimeAsync(30000); await assertion; const count = transport.mock.calls.length;
    expect(count).toBeGreaterThan(1); expect(count).toBeLessThan(12); await vi.advanceTimersByTimeAsync(60000); expect(transport).toHaveBeenCalledTimes(count);
  });
  it('stops on session cancellation without another lookup or any mutation', async () => {
    vi.useFakeTimers(); const controller = new AbortController(); const transport = vi.fn(async () => new Response(JSON.stringify(processing())));
    const result = readOrderOperation(createApiClient({baseUrl: '/api/v1', transport}), 'pending-id', controller.signal); const assertion = expect(result).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(100); controller.abort(); await vi.advanceTimersByTimeAsync(2000); await assertion; expect(transport).toHaveBeenCalledTimes(1);
  });
});
