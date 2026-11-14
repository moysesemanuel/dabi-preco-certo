import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// jsdom não implementa rolagem nem confirm; o app os usa.
window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/** Cada teste recebe um IndexedDB novo e vazio (como um navegador recém-aberto), sem esperar conexões antigas fecharem. */
export async function resetStorage(): Promise<void> { (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory(); }
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
