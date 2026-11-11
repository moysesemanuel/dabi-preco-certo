import { describe, expect, it, vi } from 'vitest';
import { licenseStorage, maskLicenseKey, safeApiBase, verifyLicense } from '../src/features/sharing/licenseClient';
import { generateLicenseKey } from '../worker/src/licenses';

const KEY = generateLicenseKey();
const API = 'https://orcamento.exemplo.test';
const reply = (status: number, body?: unknown, headers: Record<string, string> = {}) => vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status, headers })) as unknown as typeof fetch;
const OK = { status: 'active', licenseId: 'lic_0123456789abcdef', quotas: { active: { used: 1, limit: 100 }, daily: { used: 2, limit: 30 } } };

describe('Verificação da licença no app', () => {
  it('licença válida', async () => {
    expect(await verifyLicense(API, KEY, reply(200, OK))).toEqual({ state: 'valid', licenseId: 'lic_0123456789abcdef', quotas: OK.quotas });
  });
  it('inválida (401), revogada (403) e limitada (429)', async () => {
    expect(await verifyLicense(API, KEY, reply(401, { error: 'UNAUTHORIZED' }))).toEqual({ state: 'invalid' });
    expect(await verifyLicense(API, KEY, reply(403, { error: 'LICENSE_REVOKED' }))).toEqual({ state: 'revoked' });
    expect(await verifyLicense(API, KEY, reply(429, {}, { 'retry-after': '42' }))).toEqual({ state: 'rate-limited', retryAfterSeconds: 42 });
  });
  it('erros de rede, resposta inesperada e corpo malformado não derrubam o app', async () => {
    expect(await verifyLicense(API, KEY, vi.fn(async () => { throw new TypeError('failed'); }) as unknown as typeof fetch)).toEqual({ state: 'error', reason: 'network' });
    expect(await verifyLicense(API, KEY, reply(500))).toEqual({ state: 'error', reason: 'unexpected' });
    expect(await verifyLicense(API, KEY, reply(200, { status: 'active' }))).toEqual({ state: 'error', reason: 'unexpected' });
    expect(await verifyLicense(API, KEY, vi.fn(async () => new Response('não é json', { status: 200 })) as unknown as typeof fetch)).toEqual({ state: 'error', reason: 'unexpected' });
  });
  it('sem serviço configurado ou com chave fora do formato, nem chama a rede', async () => {
    const f = reply(200, OK);
    expect(await verifyLicense(undefined, KEY, f)).toEqual({ state: 'error', reason: 'not-configured' });
    expect(await verifyLicense('', KEY, f)).toEqual({ state: 'error', reason: 'not-configured' });
    expect(await verifyLicense(API, 'abc', f)).toEqual({ state: 'error', reason: 'bad-format' });
    expect(await verifyLicense(API, '', f)).toEqual({ state: 'error', reason: 'bad-format' });
    expect(f).not.toHaveBeenCalled();
  });
  it('envia a chave só no cabeçalho Authorization, nunca na URL, sem cookies', async () => {
    const f = reply(200, OK);
    await verifyLicense(`${API}/`, `  ${KEY}  `, f);
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API}/api/license`);
    expect(url).not.toContain(KEY.slice(9));
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(init).toMatchObject({ method: 'GET', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
    expect(init.body).toBeUndefined();
  });
  it('não registra a chave em log', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(m => vi.spyOn(console, m).mockImplementation(() => {}));
    await verifyLicense(API, KEY, reply(401, {}));
    await verifyLicense(API, KEY, vi.fn(async () => { throw new TypeError(`erro ${KEY}`); }) as unknown as typeof fetch);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
  it('só aceita https (ou http em localhost) para não expor a chave em texto puro', () => {
    expect(safeApiBase('https://orcamento.exemplo.test/qualquer/caminho')).toBe('https://orcamento.exemplo.test');
    expect(safeApiBase('http://localhost:8787')).toBe('http://localhost:8787');
    expect(safeApiBase('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    for (const bad of ['http://orcamento.exemplo.test', 'ftp://x.test', 'javascript:alert(1)', 'lixo', '', undefined]) expect(safeApiBase(bad), String(bad)).toBeUndefined();
  });
});

describe('Armazenamento local da chave', () => {
  const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m }; };
  it('salva, lê e remove', () => {
    const st = memory();
    expect(licenseStorage.get(st)).toBeNull();
    expect(licenseStorage.set(KEY, st)).toBe(true);
    expect(licenseStorage.get(st)).toBe(KEY);
    licenseStorage.clear(st);
    expect(licenseStorage.get(st)).toBeNull();
  });
  it('não salva chave fora do formato e ignora valor corrompido', () => {
    const st = memory();
    expect(licenseStorage.set('qualquer coisa', st)).toBe(false);
    expect(st.m.size).toBe(0);
    st.setItem('pedidocerto.license.v1', '<script>');
    expect(licenseStorage.get(st)).toBeNull();
  });
  it('navegador sem armazenamento (ou que lança erro) não quebra nada', () => {
    const broken = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); }, removeItem: () => { throw new Error('x'); } };
    expect(licenseStorage.get(broken)).toBeNull();
    expect(licenseStorage.set(KEY, broken)).toBe(false);
    expect(() => licenseStorage.clear(broken)).not.toThrow();
    expect(licenseStorage.set(KEY, undefined)).toBe(false);
  });
  it('a máscara nunca mostra a chave inteira', () => {
    const masked = maskLicenseKey(KEY);
    expect(masked).not.toContain(KEY.slice(9, 37));
    expect(masked.startsWith('dabi_lic_')).toBe(true); expect(masked.endsWith(KEY.slice(-4))).toBe(true);
  });
});
