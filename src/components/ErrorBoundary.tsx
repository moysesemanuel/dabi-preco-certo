import { Component, type ErrorInfo, type ReactNode } from 'react';

/** Rede de segurança: uma falha inesperada em uma página mostra uma mensagem em vez de uma tela em branco. Os dados continuam salvos. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(_error: Error, _info: ErrorInfo) { /* não registra dados do usuário */ }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="notice error" role="alert" style={{ margin: 24 }}><strong>Algo deu errado nesta tela.</strong> Seus dados continuam salvos. Recarregue a página para continuar; se o problema se repetir, exporte um backup em “Backup” e avise o suporte.<div style={{ marginTop: 10 }}><button className="primary" onClick={() => window.location.reload()}>Recarregar a página</button></div></div>;
  }
}
