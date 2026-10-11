import type {BusinessSettings} from '../api/types';
export const preparationOperationMarker = 'food-reservations:preparation-operation';
export const correctionOperationMarker = 'food-reservations:preparation-correction-operation';
// Stock changes are shown with their direction: +750 returns stock, -100 uses more.
export const signedQuantity = (value: string) => value.startsWith('-') ? value : `+${value}`;
// Recording cooked food needs the plan it works from and the stock it deducts.
export const preparationEnabled = (settings: BusinessSettings) => settings.capabilities.orders && settings.capabilities.planning && settings.capabilities.inventory && settings.capabilities.preparation_recording;
