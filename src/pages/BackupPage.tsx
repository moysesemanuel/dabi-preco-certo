import { Download, Upload } from 'lucide-react';
import type { DataSet } from '../domain/types';
import { Field } from '../components/Field';
import { saveData, validateBackup } from '../storage/db';
import type { PageProps } from '../utils';

export function BackupPage({ data, inform, replaceData }: PageProps & { replaceData: (d: DataSet) => void }) {
  function exportBackup() {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `pedidocerto-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    URL.revokeObjectURL(url);
    inform('Backup exportado. Guarde o arquivo em local seguro.');
  }
  async function importBackup(file: File | undefined) {
    if (!file) return;
    try {
      if (file.size > 5_000_000) throw new Error('Arquivo acima do limite de 5 MB.');
      const incoming = validateBackup(JSON.parse(await file.text()));
      if (!confirm('Restaurar este backup substituirá os dados atuais. Deseja continuar?')) return;
      await saveData(incoming); replaceData(incoming); inform('Backup restaurado com sucesso.');
    } catch (e) { inform(e instanceof Error ? e.message : 'Falha ao importar backup.'); }
  }
  return <>
    <div className="head"><div><div className="eyebrow">Proteção dos dados</div><h1>Backup e restauração</h1><p className="muted">Salve uma cópia dos seus dados antes de trocar de dispositivo ou limpar o navegador.</p></div></div>
    <div className="two">
      <section className="card stack"><span className="icon-box"><Download size={21} /></span><h2 className="section-title">Exportar meus dados</h2><p className="muted">Cria um arquivo JSON contendo ingredientes, receitas e encomendas. O arquivo fica sob seu controle.</p><button className="primary" onClick={exportBackup}><Download size={17} /> Baixar backup</button></section>
      <section className="card stack"><span className="icon-box"><Upload size={21} /></span><h2 className="section-title">Restaurar backup</h2><p className="muted">Importe um backup do PedidoCerto. Essa ação substitui todos os dados atuais.</p><Field label="Arquivo .json"><input type="file" accept=".json,application/json" onChange={e => { void importBackup(e.target.files?.[0]); e.currentTarget.value = ''; }} /></Field></section>
    </div>
    <div className="notice warn" style={{ marginTop: 18 }}>Atenção: estes dados são salvos apenas neste navegador e podem ser perdidos ao limpar o armazenamento. Não há sincronização na nuvem nem recuperação automática nesta versão. Faça backups frequentes.</div>
  </>;
}
