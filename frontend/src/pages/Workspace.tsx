import { ArrowUpRight, Clock3, Globe2, Coins, UserRound, RotateCw, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useSession } from '../auth/session';
import { Feedback, Loading } from '../components/ui';
import { formatBusinessTime } from '../lib/format';

export function Workspace() {
  const { session, settings, settingsError, loadSettings } = useSession();
  return <>
    <div className="page-heading"><div><span className="eyebrow">STAFF WORKSPACE</span><h1>Workspace</h1></div>
      <Link className="button secondary" to="/account"><UserRound size={17} />My account<ArrowUpRight size={15} /></Link></div>
    <section className="page-section" aria-labelledby="business-heading"><div className="section-heading"><h2 id="business-heading">Business settings</h2>
      {settings && <span className={`status-label ${settings.confirmation.currency && settings.confirmation.timezone ? 'success' : 'warning'}`}>
        {settings.confirmation.currency && settings.confirmation.timezone ? 'Confirmed' : 'Provisional'}</span>}</div>
      {settingsError ? <Feedback error>{settingsError}<button className="button secondary" onClick={() => void loadSettings()}><RotateCw size={17} />Retry business settings</button></Feedback>
        : !settings ? <Loading>Loading business settings...</Loading> : <>
          {(!settings.confirmation.currency || !settings.confirmation.timezone) && <Feedback>Provisional business settings</Feedback>}
          <dl className="settings-grid"><div><dt><Coins size={18} />Currency</dt><dd>{settings.currency}</dd><small>{settings.minor_digits} decimal places</small></div>
            <div><dt><Globe2 size={18} />Business timezone</dt><dd>{settings.timezone}</dd><small>Business local time</small></div>
            <div><dt>Fulfillment</dt><dd>{settings.fulfillment_methods.map(method => method === 'pickup' ? 'Pickup' : 'Delivery').join(' / ') || 'Not configured'}</dd></div>
            <div><dt>Pickup location</dt><dd>{settings.pickup_location ?? 'Unconfirmed'}</dd></div></dl>
        </>}
    </section>
    <section className="page-section" aria-labelledby="session-heading"><div className="section-heading"><h2 id="session-heading">Staff session</h2><ShieldCheck size={20} className="positive-icon" /></div>
      <dl className="session-grid"><div><dt>Signed in as</dt><dd>{session?.user.display_name}</dd><small>{session?.user.username}</small></div>
        <div><dt><Clock3 size={17} />Session expires</dt><dd>{settings && session ? formatBusinessTime(session.idle_expires_at, settings.timezone) : 'Business timezone unavailable'}</dd></div></dl>
    </section>
  </>;
}

export function Account() {
  const { session, settings } = useSession();
  return <><div className="page-heading"><div><span className="eyebrow">STAFF ACCOUNT</span><h1>My account</h1></div></div>
    <section className="page-section"><h2>Account details</h2><dl className="settings-grid">
      <div><dt>Name</dt><dd>{session?.user.display_name}</dd></div><div><dt>Username</dt><dd>{session?.user.username}</dd></div>
      <div><dt>Access</dt><dd>Staff</dd></div><div><dt>Absolute session limit</dt><dd>{settings && session ? formatBusinessTime(session.absolute_expires_at, settings.timezone) : 'Business timezone unavailable'}</dd></div>
    </dl></section></>;
}
