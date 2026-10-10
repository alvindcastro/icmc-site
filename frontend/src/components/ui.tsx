import { LoaderCircle, AlertCircle } from 'lucide-react';
import { Component, forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';

type FieldProps = InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string; suffix?: ReactNode };
export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field({ label, error, suffix, id, ...props }, ref) {
  return <div className="field">
    <label htmlFor={id}>{label}</label>
    <div className={`input-wrap${error ? ' invalid' : ''}`}>
      <input {...props} ref={ref} id={id} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined} />
      {suffix}
    </div>
    {error && <p className="field-error" id={`${id}-error`}>{error}</p>}
  </div>;
});

export function IconButton({ label, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button type="button" {...props} className={`icon-button ${props.className ?? ''}`} aria-label={label} title={props.title ?? label}>{children}</button>;
}
export function Feedback({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <div className={`feedback ${error ? 'feedback-error' : ''}`} role={error ? 'alert' : 'status'}>
    {error && <AlertCircle size={18} aria-hidden="true" />}<div>{children}</div>
  </div>;
}
export function Loading({ children }: { children: ReactNode }) {
  return <div className="loading" role="status"><LoaderCircle size={20} className="spin" aria-hidden="true" />{children}</div>;
}
type BoundaryState = { failed: boolean; resetKey: string };
// Keeps a rendering failure inside the page area; a new resetKey (the route) or an explicit retry renders again.
export class ErrorBoundary extends Component<{ resetKey: string; children: ReactNode }, BoundaryState> {
  state: BoundaryState = { failed: false, resetKey: this.props.resetKey };
  static getDerivedStateFromError(): Partial<BoundaryState> { return { failed: true }; }
  static getDerivedStateFromProps(props: { resetKey: string }, state: BoundaryState): BoundaryState | null {
    return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey };
  }
  render() {
    return this.state.failed ? <Feedback error>This page could not be displayed.
      <button className="text-action" onClick={() => this.setState({ failed: false })}>Try again</button></Feedback> : this.props.children;
  }
}
