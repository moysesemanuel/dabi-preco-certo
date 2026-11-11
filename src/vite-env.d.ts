/// <reference types="vite/client" />
interface ImportMetaEnv {
  /** Endereço da API (Worker): contas, sincronização e orçamentos compartilhados. Ex.: https://api.exemplo.com */
  readonly VITE_API_URL?: string;
  /** Nome antigo de VITE_API_URL (ainda aceito). */
  readonly VITE_QUOTES_API_URL?: string;
}
