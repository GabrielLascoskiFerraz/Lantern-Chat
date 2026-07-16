/* global window, document */
const api = window.migrationUi;
const $ = (id) => document.getElementById(id);
const fields = { backups: $('backups'), output: $('output'), mapping: $('mapping'), report: $('report') };
let analyzedSignature = '';
let lastReportFile = '';
let lastBackupFile = '';
let lastCredentialsFile = '';
let busy = false;

const cleanError = (error) => String(error?.message || error || 'Não foi possível concluir a operação.')
  .replace(/^(?:Error invoking remote method '[^']+': )?(?:Error: )+/, '');
const signature = () => JSON.stringify({
  backups: fields.backups.value,
  mapping: fields.mapping.value,
  missingUsers: $('missing-users').checked,
  missingAttachments: $('missing-attachments').checked
});
const setStep = (name) => {
  const order = ['source', 'review', 'output'];
  const activeIndex = order.indexOf(name);
  document.querySelectorAll('.step').forEach((step) => {
    const index = order.indexOf(step.dataset.step);
    step.classList.toggle('active', index === activeIndex);
    step.classList.toggle('complete', index < activeIndex);
  });
};
const setBusy = (active, title = 'Processando…') => {
  busy = active;
  $('busy').classList.toggle('hidden', !active);
  $('busy-title').textContent = title;
  $('analyze').disabled = active;
  $('convert').disabled = active || !analyzedSignature || analyzedSignature !== signature() || !fields.output.value;
  $('top-state').textContent = active ? 'Processando' : 'Pronto';
  $('top-state').className = active ? 'status-badge working' : 'status-badge';
};
const invalidate = () => {
  if (analyzedSignature && analyzedSignature !== signature()) {
    analyzedSignature = '';
    $('convert').disabled = true;
    $('output-card').classList.add('disabled');
    $('output-hint').textContent = 'As opções mudaram. Analise novamente.';
    setStep('source');
  }
};
const migrationInput = (convert) => ({
  backupsDir: fields.backups.value,
  outputDir: fields.output.value,
  mappingFile: fields.mapping.value,
  reportFile: fields.report.value,
  allowMissingUsers: $('missing-users').checked,
  allowMissingAttachments: $('missing-attachments').checked,
  convert
});
const appendOutput = (text) => {
  const log = $('log');
  if (log.textContent === 'Aguardando análise…') log.textContent = '';
  log.textContent += text;
  log.scrollTop = log.scrollHeight;
};
const metricValue = (counts, key) => Number(counts?.[key] || 0).toLocaleString('pt-BR');
const renderMetrics = (counts) => {
  const definitions = [
    ['Backups', 'backups'],
    ['Usuários', 'users'],
    ['Mensagens', 'messages'],
    ['Anexos', 'attachments']
  ];
  $('metrics').replaceChildren(...definitions.map(([label, key]) => {
    const card = document.createElement('article');
    card.className = 'metric';
    const value = document.createElement('strong');
    value.textContent = metricValue(counts, key);
    const caption = document.createElement('span');
    caption.textContent = label;
    card.append(value, caption);
    return card;
  }));
};
const renderIssues = (report) => {
  const errors = Array.isArray(report?.errors) ? report.errors : [];
  const warnings = Array.isArray(report?.warnings) ? report.warnings : [];
  const nodes = [];
  if (!errors.length && !warnings.length) {
    const item = document.createElement('div');
    item.className = 'issue success';
    item.textContent = 'Nenhum conflito ou inconsistência foi encontrado.';
    nodes.push(item);
  }
  for (const message of errors) {
    const item = document.createElement('div');
    item.className = 'issue error';
    item.textContent = message;
    nodes.push(item);
  }
  for (const message of warnings) {
    const item = document.createElement('div');
    item.className = 'issue warning';
    item.textContent = message;
    nodes.push(item);
  }
  $('issues').replaceChildren(...nodes);
  return errors.length === 0;
};
const analyze = async () => {
  if (busy) return;
  if (!fields.backups.value) {
    $('source-hint').textContent = 'Selecione a pasta que contém os backups.';
    return;
  }
  setBusy(true, 'Analisando backups…');
  $('source-hint').textContent = 'Verificando contas, mensagens e anexos…';
  try {
    const result = await api.run(migrationInput(false));
    const report = result?.report || {};
    lastReportFile = result?.reportFile || '';
    $('open-report').classList.toggle('hidden', !lastReportFile);
    $('results').classList.remove('hidden');
    renderMetrics(report.counts || {});
    const valid = Boolean(result?.ok) && renderIssues(report);
    $('result-summary').textContent = valid
      ? 'Os dados estão consistentes e prontos para conversão.'
      : 'Corrija os erros encontrados ou ajuste as opções avançadas.';
    if (valid) {
      analyzedSignature = signature();
      $('output-card').classList.remove('disabled');
      $('output-hint').textContent = fields.output.value
        ? 'Pronto para gerar o backup convertido.'
        : 'Escolha onde o backup convertido será salvo.';
      $('source-hint').textContent = 'Análise concluída sem erros impeditivos.';
      setStep('review');
    } else {
      analyzedSignature = '';
      $('output-card').classList.add('disabled');
      $('source-hint').textContent = 'A análise encontrou erros.';
    }
  } catch (error) {
    $('source-hint').textContent = cleanError(error);
    analyzedSignature = '';
  } finally {
    setBusy(false);
  }
};
const convert = async () => {
  if (busy || !analyzedSignature || analyzedSignature !== signature()) return;
  if (!fields.output.value) {
    $('output-hint').textContent = 'Escolha a pasta de destino.';
    return;
  }
  setBusy(true, 'Gerando backup convertido…');
  $('output-hint').textContent = 'Criando banco canônico e verificando os arquivos…';
  setStep('output');
  try {
    const result = await api.run(migrationInput(true));
    const report = result?.report || {};
    if (!result?.ok || !report.converted || !report.backupFile) {
      throw new Error(report?.errors?.[0] || result?.stderr || 'O backup convertido não pôde ser criado.');
    }
    lastReportFile = result.reportFile || lastReportFile;
    lastBackupFile = report.backupFile;
    lastCredentialsFile = report.credentialsFile || '';
    $('conversion-path').textContent = lastBackupFile;
    $('conversion-result').classList.remove('hidden');
    $('open-credentials').classList.toggle('hidden', !lastCredentialsFile);
    $('output-hint').textContent = 'Conversão concluída. Importe esta pasta pelo Lantern Relay UI.';
    $('top-state').textContent = 'Concluído';
    $('top-state').className = 'status-badge success';
    $('convert').disabled = true;
  } catch (error) {
    $('output-hint').textContent = cleanError(error);
    $('top-state').textContent = 'Falha';
    $('top-state').className = 'status-badge error';
  } finally {
    setBusy(false);
    if (lastBackupFile) {
      $('top-state').textContent = 'Concluído';
      $('top-state').className = 'status-badge success';
      $('convert').disabled = true;
    }
  }
};

api.onOutput(appendOutput);
document.querySelectorAll('[data-pick]').forEach((button) => button.addEventListener('click', async () => {
  if (busy) return;
  const kind = button.dataset.pick;
  const picker = { backups: api.pickBackups, output: api.pickOutput, mapping: api.pickMapping, report: api.pickReport }[kind];
  const selected = picker ? await picker() : null;
  if (!selected) return;
  fields[kind].value = selected;
  if (kind === 'output' && analyzedSignature === signature()) {
    $('output-hint').textContent = 'Pronto para gerar o backup convertido.';
  }
  invalidate();
  setBusy(false);
}));
document.querySelector('[data-clear="mapping"]').addEventListener('click', () => {
  fields.mapping.value = '';
  invalidate();
});
$('missing-users').addEventListener('change', invalidate);
$('missing-attachments').addEventListener('change', invalidate);
$('analyze').addEventListener('click', analyze);
$('convert').addEventListener('click', convert);
$('clear-log').addEventListener('click', () => { $('log').textContent = ''; });
$('open-report').addEventListener('click', () => lastReportFile && api.openPath(lastReportFile));
$('open-backup').addEventListener('click', () => lastBackupFile && api.openPath(lastBackupFile));
$('open-credentials').addEventListener('click', () => lastCredentialsFile && api.openPath(lastCredentialsFile));
