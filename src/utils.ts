import { recipeCost } from './domain/pricing';
import type { DataSet, Recipe, Unit } from './domain/types';

export type Page = 'dashboard' | 'ingredients' | 'recipes' | 'orders' | 'backup';
export type PageProps = {
  data: DataSet;
  update: (fn: (prev: DataSet) => DataSet) => void;
  inform: (msg: string) => void;
  focus: (page: Page) => void;
};

export const newId = () => crypto.randomUUID();
export const parse = (v: string) => Number(v.replace(',', '.'));
export const units: Unit[] = ['g', 'kg', 'ml', 'l', 'un'];
export const brDate = (iso: string) => iso.split('-').reverse().join('/');
export const canPrice = (r: Recipe, d: DataSet) => { try { return recipeCost(r, d.ingredients); } catch { return null; } };
