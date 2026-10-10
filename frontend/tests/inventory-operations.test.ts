import {afterEach,describe,expect,it,vi} from 'vitest';
import {createApiClient} from '../src/api/client';
import {readInventoryOperation} from '../src/inventory/operations';
afterEach(()=>vi.useRealTimers());
const processing = {operation_id:'pending-id',state:'processing',resource_type:'purchase',resource_id:null,result:null,error:null,started_at:'2026-10-07T12:00:00Z',completed_at:null};
const rejected = {...processing,state:'rejected',completed_at:'2026-10-07T12:00:05Z',error:{http_status:422,error:{code:'invalid',message:'Rejected without stock changes.',field_errors:[],details:{}}}};
describe('bounded read-only inventory reconciliation',()=>{
  it('backs off to a verified rejection using only GET requests',async()=>{
    vi.useFakeTimers();let calls=0;const transport=vi.fn(async()=>new Response(JSON.stringify(++calls < 3 ? processing : rejected)));
    const assertion=expect(readInventoryOperation(createApiClient({baseUrl:'/api/v1',transport}),'pending-id')).resolves.toMatchObject({state:'rejected'});await vi.advanceTimersByTimeAsync(4000);await assertion;
    expect(transport).toHaveBeenCalledTimes(3);expect(transport.mock.calls.every(args=>((args as unknown[])[1] as RequestInit).method==='GET')).toBe(true);
  });
  it('stops within thirty seconds without changing processing into success',async()=>{
    vi.useFakeTimers();const transport=vi.fn(async()=>new Response(JSON.stringify(processing)));
    const assertion=expect(readInventoryOperation(createApiClient({baseUrl:'/api/v1',transport}),'pending-id')).resolves.toMatchObject({state:'processing'});await vi.advanceTimersByTimeAsync(30000);await assertion;
    const calls=transport.mock.calls.length;expect(calls).toBeGreaterThan(1);expect(calls).toBeLessThan(12);await vi.advanceTimersByTimeAsync(60000);expect(transport).toHaveBeenCalledTimes(calls);
  });
  it('stops polling when the session aborts',async()=>{
    vi.useFakeTimers();const controller=new AbortController(),transport=vi.fn(async()=>new Response(JSON.stringify(processing)));
    const assertion=expect(readInventoryOperation(createApiClient({baseUrl:'/api/v1',transport}),'pending-id',controller.signal)).rejects.toThrow();await vi.advanceTimersByTimeAsync(100);controller.abort();await vi.advanceTimersByTimeAsync(5000);await assertion;expect(transport).toHaveBeenCalledTimes(1);
  });
});
