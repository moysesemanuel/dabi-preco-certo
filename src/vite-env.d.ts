/// <reference types="vite/client" />
interface ImportMetaEnv {
  /** Endereço da API (Worker): contas, sincronização e orçamentos compartilhados. Ex.: https://api.exemplo.com */
  readonly VITE_API_URL?: string;
  /** Nome antigo de VITE_API_URL (ainda aceito). */
  readonly VITE_QUOTES_API_URL?: string;
  /** `on` = versão comercial: o app só abre com conta e licença ativa (veja docs/ACESSO_E_TRANSICAO.md). Vazio = modo local sem conta. */
  readonly VITE_REQUIRE_LOGIN?: string;
}
