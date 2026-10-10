import * as Dialog from '@radix-ui/react-dialog';
import { Home, UserRound, LogOut, Menu, X, Utensils, ShieldCheck, FlaskConical, ClipboardList, CalendarDays, LayoutDashboard, Package, ReceiptText } from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useSession } from '../auth/session';
import { recipesEnabled } from '../recipes/model';
import { ErrorBoundary, Feedback, IconButton } from './ui';

function Navigation({ onNavigate }: { onNavigate?: () => void }) {
  const {settings} = useSession();
  return <nav aria-label="Main navigation">
    <NavLink to="/" end onClick={onNavigate}><Home size={18} />Workspace</NavLink>
    {settings?.capabilities.menu && <NavLink to="/menu" onClick={onNavigate}><ClipboardList size={18} />{recipesEnabled(settings) ? 'Menu & Recipes' : 'Menu'}</NavLink>}
    {settings?.capabilities.orders && <><NavLink to="/dashboard" onClick={onNavigate}><LayoutDashboard size={18} />Dashboard</NavLink><NavLink to="/orders" onClick={onNavigate}><CalendarDays size={18} />Orders</NavLink></>}
    {settings?.capabilities.inventory && <NavLink to="/ingredients" onClick={onNavigate}><Package size={18} />Ingredients</NavLink>}
    {settings?.capabilities.inventory && settings.capabilities.purchases && <NavLink to="/purchases" onClick={onNavigate}><ReceiptText size={18} />Purchases</NavLink>}
    <NavLink to="/account" onClick={onNavigate}><UserRound size={18} />My account</NavLink>
  </nav>;
}
function StaffActions() {
  const { session, signOut, signOutBusy } = useSession();
  return <div className="staff-actions"><div className="staff-name"><span className="staff-avatar"><UserRound size={17} /></span>
    <span>{session?.user.display_name}<small>Staff</small></span></div>
    <button className="signout-button" onClick={() => void signOut()} disabled={signOutBusy}><LogOut size={17} />Sign out</button>
  </div>;
}
export function Shell({ mode }: { mode: 'live' | 'fixtures' }) {
  const [open, setOpen] = useState(false);
  const { sessionError, checkSession } = useSession();
  const { pathname } = useLocation();
  return <div className="app-shell">
    <aside className="desktop-sidebar"><div className="brand"><Utensils size={23} /><span>Food<br />reservations</span></div>
      <div className="nav-group-label">WORKSPACE</div><Navigation /><StaffActions />
    </aside>
    <div className="app-body">
      <header className="app-header"><div className="mobile-navigation">
        <Dialog.Root open={open} onOpenChange={setOpen}><Dialog.Trigger asChild><IconButton label="Open navigation"><Menu size={22} /></IconButton></Dialog.Trigger>
          <Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="navigation-drawer" aria-describedby={undefined}>
            <div className="drawer-heading"><Dialog.Title>Food reservations</Dialog.Title><Dialog.Close asChild><IconButton label="Close navigation"><X size={21} /></IconButton></Dialog.Close></div>
            <Navigation onNavigate={() => setOpen(false)} /><StaffActions />
          </Dialog.Content></Dialog.Portal>
        </Dialog.Root><span className="mobile-brand">Food reservations</span>
      </div>
      <span className={`environment-label ${mode === 'fixtures' ? 'fixture-label' : ''}`}>
        {mode === 'fixtures' ? <FlaskConical size={15} /> : <ShieldCheck size={15} />}{mode === 'fixtures' ? 'Development fixtures' : 'Staff workspace'}
      </span></header>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <main id="main-content" className="page-content" tabIndex={-1}>
        {sessionError && <Feedback error>{sessionError}<button className="text-action" onClick={() => void checkSession()}>Retry session check</button></Feedback>}
        <ErrorBoundary resetKey={pathname}><Outlet /></ErrorBoundary>
      </main>
    </div>
  </div>;
}
