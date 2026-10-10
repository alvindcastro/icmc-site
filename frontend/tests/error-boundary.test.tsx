import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { createApiClient } from '../src/api/client';
import { createFixtureTransport } from '../src/api/fixtures';

const page = vi.hoisted(() => ({ broken: true }));
vi.mock('../src/pages/Workspace', () => ({
  Workspace: () => { if (page.broken) throw new Error('render failure'); return <h1>Workspace</h1>; },
  Account: () => <h1>My account</h1>,
}));

describe('page rendering failures', () => {
  it('keeps the shell usable, retries on request and renders again on another route', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = createApiClient({ baseUrl: '/api/v1', transport: createFixtureTransport({ latency: 0 }).fetch });
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={['/']}><App client={client} mode="fixtures" /></MemoryRouter>);
    await user.type(await screen.findByLabelText('Token'), 'local-admin-token');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('This page could not be displayed.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('This page could not be displayed.')).toBeVisible();
    await user.click(screen.getByRole('link', { name: 'My account' }));
    expect(await screen.findByRole('heading', { name: 'My account' })).toBeVisible();
    page.broken = false;
    await user.click(screen.getByRole('link', { name: 'Workspace' }));
    expect(await screen.findByRole('heading', { name: 'Workspace' })).toBeVisible();
  });
});
