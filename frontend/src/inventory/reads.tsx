import {useEffect, useState} from 'react';
import {ChevronLeft, ChevronRight, RotateCw} from 'lucide-react';
import type {ApiClient} from '../api/client';
import type {PageResult} from '../api/types';
import {Feedback, IconButton, Loading} from '../components/ui';

export function useInventoryRecord<T>(client: ApiClient, revision: number, path: string | null, validate: (value: unknown) => T) {
  const [retry, setRetry] = useState(0), [state, setState] = useState<{path: string | null; revision: number; value?: T; error?: string}>({path, revision});
  useEffect(() => {
    let active = true; const controller = new AbortController(); setState({path, revision});
    if (!path) return () => {active = false; controller.abort();};
    void client.request(path, {signal: controller.signal}).then(value => {const checked = validate(value); if (active) setState({path, revision, value: checked});})
      .catch(error => {if (active) setState({path, revision, error: error.message});});
    return () => {active = false; controller.abort();};
  }, [client, path, revision, retry, validate]);
  return {...(state.path === path && state.revision === revision ? state : {path, revision}), retry: () => setRetry(value => value + 1)};
}
export function ReadFailure({message, retry}: {message: string; retry: () => void}) {
  return <Feedback error>{message}<button className="text-action" onClick={retry}><RotateCw size={16} />Retry</button></Feedback>;
}
export function ReadState({error, retry, loading}: {error?: string; retry: () => void; loading: string}) {
  return error ? <ReadFailure message={error} retry={retry} /> : <Loading>{loading}</Loading>;
}
export function InventoryPagination({value, change, label}: {value: PageResult<unknown>; change: (page: number) => void; label: string}) {
  return <div className="pagination"><span>Page {value.page} of {Math.max(1, Math.ceil(value.total / value.limit))}</span><div>
    <IconButton label={`Previous ${label} page`} disabled={value.page === 1} onClick={() => change(value.page - 1)}><ChevronLeft size={20} /></IconButton>
    <IconButton label={`Next ${label} page`} disabled={!value.has_next} onClick={() => change(value.page + 1)}><ChevronRight size={20} /></IconButton>
  </div></div>;
}
