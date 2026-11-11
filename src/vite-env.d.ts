/// <reference types="vite/client" />
interface ImportMetaEnv {
  /** Endereço do serviço de compartilhamento de orçamentos (Worker), ex.: https://orcamento.dabitech.com.br */
  readonly VITE_QUOTES_API_URL?: string;
}
