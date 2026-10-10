import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { App } from './App';
import { createApiClient } from './api/client';
import { readApiConfig } from './api/config';
import type { FetchTransport } from './api/types';
import './styles.css';

async function start() {
  const config = readApiConfig(import.meta.env);
  let transport: FetchTransport = fetch;
  if (import.meta.env.DEV && config.mode === 'fixtures') {
    const { createFixtureTransport } = await import('./api/fixtures');
    transport = createFixtureTransport({samples: true}).fetch;
  }
  const client = createApiClient({ baseUrl: config.baseUrl, transport });
  const router = createBrowserRouter([{path: '*', element: <App client={client} mode={config.mode} />}]);
  createRoot(document.getElementById('root')!).render(<RouterProvider router={router} />);
}

void start().catch(error => {
  const root = document.getElementById('root');
  if (root) root.textContent = `Unable to start: ${(error as Error).message}`;
});
