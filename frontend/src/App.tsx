import type { ApiClient } from './api/client';
import { Navigate, Route, Routes, useLocation, Link } from 'react-router-dom';
import { SessionProvider, useSession } from './auth/session';
import { Shell } from './components/Shell';
import { Loading } from './components/ui';
import { SignIn } from './pages/SignIn';
import { Account, Workspace } from './pages/Workspace';
import { MenuPage } from './menu/MenuPage';
import {OrderArea} from './orders/OrderArea';
import {DashboardPage, OrderDetails, OrdersPage, PrintOrder} from './orders/OrderPages';
import {InventoryArea} from './inventory/InventoryArea';
import {IngredientsPage, IngredientDetails, PurchasesPage, PurchaseDetails} from './inventory/InventoryPages';
import {RecipePage} from './recipes/RecipePage';
import {PlanningPage} from './planning/PlanningPage';
import {ShoppingListPage} from './planning/ShoppingListPage';
import {PreparationPage} from './preparation/PreparationPage';
import {PreparationDetails} from './preparation/PreparationDetails';
import {PreparationCorrectionPage} from './preparation/PreparationCorrectionPage';

function ProtectedShell({ mode }: { mode: 'live' | 'fixtures' }) {
  const { status } = useSession();
  const location = useLocation();
  if (status === 'checking') return <main className="session-loading"><Loading>Checking your session...</Loading></main>;
  if (status !== 'authenticated') {
    return <Navigate to={`/sign-in?returnTo=${encodeURIComponent(location.pathname + location.search + location.hash)}`} replace />;
  }
  return <Shell mode={mode} />;
}
export function App({ client, mode = 'live' }: { client: ApiClient; mode?: 'live' | 'fixtures' }) {
  return <SessionProvider client={client}><Routes>
    <Route path="/sign-in" element={<SignIn mode={mode} />} />
    <Route element={<ProtectedShell mode={mode} />}>
      <Route path="/" element={<Workspace />} />
      <Route path="/account" element={<Account />} />
      <Route path="/menu" element={<MenuPage client={client} />} />
      <Route path="/menu/:foodId/variants/:variantId/recipe" element={<RecipePage client={client} />} />
      <Route element={<InventoryArea client={client} />}>
        <Route path="/ingredients" element={<IngredientsPage />} />
        <Route path="/ingredients/:id" element={<IngredientDetails />} />
        <Route path="/purchases" element={<PurchasesPage />} />
        <Route path="/purchases/:id" element={<PurchaseDetails />} />
        <Route path="/preparations/:id" element={<PreparationDetails />} />
        <Route path="/preparations/:id/correct" element={<PreparationCorrectionPage />} />
      </Route>
      <Route element={<OrderArea client={client} />}>
        <Route path="/orders" element={<OrdersPage />} />
        <Route path="/orders/:id" element={<OrderDetails />} />
        <Route path="/orders/:id/print" element={<PrintOrder />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/planning" element={<PlanningPage />} />
        <Route path="/planning/shopping-list" element={<ShoppingListPage />} />
        <Route path="/planning/prepare" element={<PreparationPage />} />
      </Route>
      <Route path="*" element={<><h1>Page unavailable</h1><Link to="/">Return to workspace</Link></>} />
    </Route>
  </Routes></SessionProvider>;
}
