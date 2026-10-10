import * as Dialog from '@radix-ui/react-dialog';
import {useContext} from 'react';
import {UNSAFE_DataRouterContext, useBlocker} from 'react-router-dom';
type GuardProps = {dirty: boolean; busy: boolean; onLeave: () => void; label?: string};
export function NavigationGuard(props: GuardProps) {
  const router = useContext(UNSAFE_DataRouterContext);
  return router ? <DataGuard {...props} /> : null;
}
function DataGuard({dirty, busy, onLeave, label = 'order'}: GuardProps) {
  const blocker = useBlocker(dirty || busy);
  return <Dialog.Root open={blocker.state === 'blocked'} onOpenChange={open => {if (!open && blocker.state === 'blocked') blocker.reset();}}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="editor-dialog" aria-describedby={undefined}>
    <Dialog.Title>Leave {label}?</Dialog.Title><p className="discard-copy">{busy ? 'A save is in progress. Wait for its result before leaving.' : 'Unsaved changes will be discarded. Any unresolved save must still be reconciled.'}</p>
    <div className="editor-actions"><button className="button secondary" onClick={() => {if (blocker.state === 'blocked') blocker.reset();}}>Stay editing</button><button className="button danger" disabled={busy} onClick={() => {if (blocker.state === 'blocked') {onLeave(); blocker.proceed();}}}>Leave {label}</button></div>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
