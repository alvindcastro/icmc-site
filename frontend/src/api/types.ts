export type StaffSession = {
  user: { id: string; username: string; display_name: string; role: 'staff' };
  csrf_token: string;
  idle_expires_at: string;
  absolute_expires_at: string;
};

export type BusinessSettings = {
  version: number;
  environment: 'development' | 'live';
  confirmation: {
    currency: boolean; timezone: boolean; fulfillment: boolean;
    delivery: boolean; tax: boolean; confirmed_at: string | null;
  };
  currency: string;
  minor_digits: number;
  timezone: string;
  fulfillment_methods: ('pickup' | 'delivery')[];
  pickup_location: string | null;
  delivery_policy: { mode: 'manual_amount' | 'fixed_amount' | 'disabled'; fixed_charge_minor: number | null };
  tax_policy: { mode: 'manual_amount'; inclusive: false };
  payment_methods: ('cash' | 'bank_transfer' | 'other')[];
  capabilities: Record<'orders' | 'menu' | 'payments' | 'inventory' | 'purchases' | 'recipes' | 'planning' | 'preparation_recording', boolean>;
};

export type FieldError = { path: string; code: string; message: string };
export type FetchTransport = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type PermittedAction = { allowed: boolean; reason_code: string | null; reason: string | null };
export type Category = { id: string; name: string };
export type PageResult<T> = { items: T[]; page: number; limit: number; total: number; has_next: boolean };
export type SellingUnit = 'tray' | 'piece' | 'stick' | 'package';
export type PackageContents = { quantity: number; unit: 'piece' };
export type FoodInput = { name: string; category_id: string; description: string; available: boolean };
export type VariantInput = { label: string; selling_unit: SellingUnit; price_minor: number; available: boolean; package_contents: PackageContents | null };
export type MenuVariant = VariantInput & {
  id: string; version: number; food_id: string; confirmation_status: 'provisional' | 'confirmed'; recipe_id: string | null;
  permitted_actions: { edit: PermittedAction };
};
export type Food = FoodInput & {
  id: string; version: number; confirmation_status: 'provisional' | 'confirmed'; variants: MenuVariant[];
  permitted_actions: { edit: PermittedAction; add_variant: PermittedAction };
};
export type Operation<T = unknown> = {
  operation_id: string; state: 'processing' | 'succeeded' | 'rejected'; resource_type: string | null; resource_id: string | null;
  result: {http_status: number; body: T} | null;
  error: {http_status: number; error: {code: string; message: string; field_errors: FieldError[]; details: Record<string, unknown>}} | null;
  started_at: string; completed_at: string | null;
};
export type MenuOperation = Operation<Food | MenuVariant>;
