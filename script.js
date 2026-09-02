(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const cash = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const KEY = 'pontoflex-vanilla-v1';
  const statusesWithHours = ['worked', 'holiday'];
  const labels = {
    worked: 'Trabalhado',
    dayoff: 'Folga',
    absence: 'Falta',
    certificate: 'Atestado',
    vacation: 'Férias',
    holiday: 'Feriado trabalhado'
  };

  const seed = {
    nome: '',
    cpf: '',
    cargo: '',
    empresa: '',
    cnpj: '',
    cep: '',
    endereco: '',
    telefone: '',
    salario: 0,
    divisor: 220,
    jornada: 8,
    adicionalNoturno: 20,
    vt: 6,
    vr: 5,
    adiantamento: 0,
    outros: 0,
    inss: true,
    registros: []
  };

  let state = load();
  let editing = null;
  let lastFocused = null;
  let tab = 'jornada';
  let competencia = currentCompetency();
  let cepLookupId = 0;
  let toastTimer;

  function numberOr(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function cloneSeed() {
    return { ...seed, registros: [] };
  }

  function normaliseEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;

    const intervals = Array.isArray(entry.intervals)
      ? entry.intervals.slice(0, 6).map(interval => ({
        in: typeof interval?.in === 'string' ? interval.in.slice(0, 5) : '',
        out: typeof interval?.out === 'string' ? interval.out.slice(0, 5) : ''
      }))
      : [];

    const status = Object.hasOwn(labels, entry.status) ? entry.status : 'worked';
    return {
      id: typeof entry.id === 'string' && entry.id ? entry.id : makeId(),
      data: typeof entry.data === 'string' ? entry.data.slice(0, 10) : '',
      status,
      intervals,
      extra: numberOr(entry.extra, 50) === 100 ? 100 : 50,
      diaria: Math.max(0, numberOr(entry.diaria)),
      observacao: typeof entry.observacao === 'string' ? entry.observacao.slice(0, 240) : ''
    };
  }

  function normaliseState(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const clean = { ...cloneSeed() };
    const textFields = ['nome', 'cpf', 'cargo', 'empresa', 'cnpj', 'cep', 'endereco', 'telefone'];
    const numberFields = ['salario', 'divisor', 'jornada', 'adicionalNoturno', 'vt', 'vr', 'adiantamento', 'outros'];

    textFields.forEach(field => {
      clean[field] = typeof source[field] === 'string' ? source[field].slice(0, 240) : '';
    });
    numberFields.forEach(field => {
      clean[field] = Math.max(0, numberOr(source[field], seed[field]));
    });
    clean.divisor = Math.max(1, clean.divisor || seed.divisor);
    clean.jornada = Math.min(24, Math.max(1, clean.jornada || seed.jornada));
    clean.inss = source.inss !== false;
    clean.registros = Array.isArray(source.registros) ? source.registros.map(normaliseEntry).filter(Boolean) : [];
    return clean;
  }

  function load() {
    try {
      return normaliseState(JSON.parse(localStorage.getItem(KEY) || '{}'));
    } catch {
      return cloneSeed();
    }
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      showToast('Não foi possível salvar no armazenamento deste navegador.');
    }
  }

  function makeId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `registro-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function currentCompetency() {
    const date = new Date();
    if (date.getDate() > 25) date.setMonth(date.getMonth() + 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }

  function range() {
    const [year, month] = competencia.split('-').map(Number);
    const start = new Date(year, month - 2, 26, 12);
    const end = new Date(year, month - 1, 25, 12);
    const iso = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    return {
      start: iso(start),
      end: iso(end),
      label: `${start.toLocaleDateString('pt-BR')} a ${end.toLocaleDateString('pt-BR')}`
    };
  }

  function formatDate(dateString, options = { day: '2-digit', month: 'short' }) {
    return new Date(`${dateString}T12:00:00`).toLocaleDateString('pt-BR', options);
  }

  function mins(value) {
    if (!/^\d{2}:\d{2}$/.test(value || '')) return 0;
    const [hours, minutes] = value.split(':').map(Number);
    return hours * 60 + minutes;
  }

  function elapsed(start, end) {
    if (!start || !end) return 0;
    const from = mins(start);
    let to = mins(end);
    if (to <= from) to += 1440;
    return to - from;
  }

  function worked(entry) {
    return statusesWithHours.includes(entry.status)
      ? entry.intervals.reduce((total, interval) => total + elapsed(interval.in, interval.out), 0)
      : 0;
  }

  function inss(base) {
    let total = 0;
    let previousLimit = 0;
    for (const [limit, rate] of [[1621, .075], [2902.84, .09], [4354.27, .12], [8475.55, .14]]) {
      total += Math.max(0, Math.min(base, limit) - previousLimit) * rate;
      previousLimit = limit;
      if (base <= limit) break;
    }
    return total;
  }

  function entries() {
    const period = range();
    return state.registros
      .filter(entry => entry.data >= period.start && entry.data <= period.end)
      .sort((a, b) => b.data.localeCompare(a.data));
  }

  function summary() {
    let regularMinutes = 0;
    let extra50 = 0;
    let extra100 = 0;
    let dailyPayments = 0;
    let absences = 0;

    entries().forEach(entry => {
      dailyPayments += numberOr(entry.diaria);
      if (entry.status === 'absence') absences += 1;

      const total = worked(entry);
      const extra = Math.max(0, total - numberOr(state.jornada) * 60);
      regularMinutes += Math.min(total, numberOr(state.jornada) * 60);
      if (entry.extra === 100) extra100 += extra;
      else extra50 += extra;
    });

    const hourlyRate = numberOr(state.salario) / numberOr(state.divisor, 220) || 0;
    const extra50Value = extra50 / 60 * hourlyRate * 1.5;
    const extra100Value = extra100 / 60 * hourlyRate * 2;
    const absenceValue = numberOr(state.salario) / 30 * absences;
    const gross = numberOr(state.salario) + extra50Value + extra100Value + dailyPayments;
    const contributionBase = Math.max(0, gross - absenceValue - dailyPayments);
    const socialSecurity = state.inss ? inss(contributionBase) : 0;
    const transport = numberOr(state.salario) * numberOr(state.vt) / 100;
    const meal = numberOr(state.salario) * numberOr(state.vr) / 100;
    const discounts = absenceValue + socialSecurity + transport + meal + numberOr(state.adiantamento) + numberOr(state.outros);

    return {
      regularMinutes,
      extra50,
      extra100,
      dailyPayments,
      absences,
      hourlyRate,
      extra50Value,
      extra100Value,
      absenceValue,
      gross,
      socialSecurity,
      transport,
      meal,
      discounts,
      net: gross - discounts
    };
  }

  function escapeHTML(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function metricMarkup(label, value) {
    return `<div><span>${escapeHTML(label)}</span><b>${escapeHTML(value)}</b></div>`;
  }

  function render({ syncFields = false } = {}) {
    save();
    $('#mes').value = competencia;
    $('#periodo').textContent = range().label;

    const data = summary();
    $('#metricas').innerHTML = [
      ['Salário base', cash.format(numberOr(state.salario))],
      ['Horas normais', `${(data.regularMinutes / 60).toFixed(1)}h`],
      ['Horas extras', `${((data.extra50 + data.extra100) / 60).toFixed(1)}h`],
      ['Diárias', cash.format(data.dailyPayments)],
      ['Líquido estimado', cash.format(data.net)]
    ].map(([label, value]) => metricMarkup(label, value)).join('');

    const currentEntries = entries();
    $('#qtdDias').textContent = `${currentEntries.length} ${currentEntries.length === 1 ? 'dia' : 'dias'}`;
    $('#registros').innerHTML = currentEntries.length
      ? currentEntries.map(entryMarkup).join('')
      : '<div class="empty"><h3>Nenhum registro</h3><p>Adicione um dia para iniciar os cálculos.</p></div>';

    renderPaycheck(data);
    if (syncFields) fillFields();
  }

  function entryMarkup(entry) {
    const intervalText = statusesWithHours.includes(entry.status) && entry.intervals.length
      ? entry.intervals.map((interval, index) => `${index + 1}º ${escapeHTML(interval.in || '—')}–${escapeHTML(interval.out || '—')}`).join(' · ')
      : 'Sem intervalos registrados';
    const daily = entry.diaria ? `<mark class="daily">${escapeHTML(cash.format(entry.diaria))}</mark>` : '';
    const note = entry.observacao ? ` · ${escapeHTML(entry.observacao)}` : '';

    return `<article class="entry">
      <time datetime="${escapeHTML(entry.data)}">${escapeHTML(formatDate(entry.data))}</time>
      <div class="entry-details">
        <strong>${escapeHTML(labels[entry.status])}${daily}</strong>
        <small>${intervalText} · ${(worked(entry) / 60).toFixed(2)}h${note}</small>
      </div>
      <div class="entry-actions">
        <button type="button" data-edit="${escapeHTML(entry.id)}" aria-label="Editar registro de ${escapeHTML(formatDate(entry.data))}">Editar</button>
        <button type="button" class="danger" data-del="${escapeHTML(entry.id)}" aria-label="Excluir registro de ${escapeHTML(formatDate(entry.data))}">Excluir</button>
      </div>
    </article>`;
  }

  function renderPaycheck(data) {
    const rows = [
      ['Salário mensal', `${numberOr(state.divisor)}h`, numberOr(state.salario), 0],
      ['Hora extra 50%', `${(data.extra50 / 60).toFixed(2)}h`, data.extra50Value, 0],
      ['Hora extra 100%', `${(data.extra100 / 60).toFixed(2)}h`, data.extra100Value, 0],
      ['Faltas', `${data.absences} dia(s)`, 0, data.absenceValue],
      ['INSS', 'Tabela configurada', 0, data.socialSecurity],
      ['Vale-transporte', `${numberOr(state.vt)}%`, 0, data.transport],
      ['Vale-refeição', `${numberOr(state.vr)}%`, 0, data.meal],
      ['Adiantamento', 'Valor fixo', 0, numberOr(state.adiantamento)],
      ['Outros descontos', 'Informado', 0, numberOr(state.outros)]
    ];

    if (data.dailyPayments) rows.splice(3, 0, ['Diárias', 'Competência', data.dailyPayments, 0]);

    const tableRows = rows.map(([description, reference, earnings, discounts]) => `<tr>
      <td>${escapeHTML(description)}</td>
      <td>${escapeHTML(reference)}</td>
      <td>${earnings ? escapeHTML(cash.format(earnings)) : ''}</td>
      <td>${discounts ? escapeHTML(cash.format(discounts)) : ''}</td>
    </tr>`).join('');

    $('#holerite').innerHTML = `<div class="payhead">
      <div><p class="eyebrow">PONTOFLEX</p><h2>Demonstrativo de pagamento</h2></div>
      <b>${escapeHTML(range().label)}</b>
    </div>
    <div class="company">
      <p><span>Empresa</span><b>${escapeHTML(state.empresa || 'Não informada')}</b></p>
      <p><span>CNPJ</span><b>${escapeHTML(state.cnpj || '—')}</b></p>
      <p><span>Endereço</span><b>${escapeHTML(state.endereco || '—')}</b></p>
    </div>
    <div class="person">
      <p><span>Funcionário</span><b>${escapeHTML(state.nome || 'Não informado')}</b></p>
      <p><span>CPF</span><b>${escapeHTML(state.cpf || '—')}</b></p>
      <p><span>Cargo</span><b>${escapeHTML(state.cargo || '—')}</b></p>
    </div>
    <div class="table-wrap">
      <table>
        <caption class="visually-hidden">Proventos e descontos do período</caption>
        <thead><tr><th scope="col">Descrição</th><th scope="col">Referência</th><th scope="col">Proventos</th><th scope="col">Descontos</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
    <div class="totals">
      <p><span>Proventos</span><b>${escapeHTML(cash.format(data.gross))}</b></p>
      <p><span>Descontos</span><b>${escapeHTML(cash.format(data.discounts))}</b></p>
      <p class="net"><span>Valor líquido</span><b>${escapeHTML(cash.format(data.net))}</b></p>
    </div>
    <p>Local e data: __________________________________, ____/____/________</p>
    <div class="signatures">
      <div>${escapeHTML(state.nome || 'Funcionário')}<small>Assinatura do funcionário</small></div>
      <div>${escapeHTML(state.empresa || 'Empresa')}<small>Assinatura da empresa</small></div>
    </div>`;
  }

  function fillFields() {
    $$('[data-field]').forEach(element => {
      const field = element.dataset.field;
      if (element.type === 'checkbox') element.checked = Boolean(state[field]);
      else element.value = state[field] ?? '';
    });
  }

  function showModal() {
    lastFocused = document.activeElement;
    if (typeof $('#modal').showModal === 'function') $('#modal').showModal();
    else $('#modal').setAttribute('open', '');
    requestAnimationFrame(() => $('#data').focus());
  }

  function closeModal() {
    const modal = $('#modal');
    if (modal.open && typeof modal.close === 'function') modal.close();
    else modal.removeAttribute('open');
  }

  function openModal(entry = null) {
    editing = entry
      ? { ...entry, intervals: entry.intervals.map(interval => ({ ...interval })) }
      : {
        id: makeId(),
        data: new Date().toISOString().slice(0, 10),
        status: 'worked',
        intervals: [{ in: '08:00', out: '12:00' }, { in: '13:00', out: '17:00' }],
        extra: 50,
        diaria: 0,
        observacao: ''
      };

    $('#data').value = editing.data;
    $('#situacao').value = editing.status;
    $('#tipoExtra').value = editing.extra;
    $('#diaria').value = editing.diaria || '';
    $('#observacao').value = editing.observacao || '';
    $('#erros').textContent = '';
    renderIntervals();
    toggleIntervals();
    showModal();
  }

  function renderIntervals() {
    $('#intervalos').innerHTML = editing.intervals.map((interval, index) => `<div class="interval-row">
      <label for="entrada-${index}">Entrada ${index + 1}<input id="entrada-${index}" type="time" data-in="${index}" value="${escapeHTML(interval.in)}"></label>
      <label for="saida-${index}">Saída ${index + 1}<input id="saida-${index}" type="time" data-out="${index}" value="${escapeHTML(interval.out)}"></label>
      ${editing.intervals.length > 1 ? `<button type="button" class="remove" data-remove="${index}" aria-label="Remover intervalo ${index + 1}">×</button>` : ''}
    </div>`).join('');
  }

  function toggleIntervals() {
    const visible = statusesWithHours.includes($('#situacao').value);
    $('#intervalosFieldset').hidden = !visible;
    $('#tipoExtra').closest('label').hidden = !visible;
  }

  function setTab(id) {
    if (!['jornada', 'contracheque', 'configuracoes'].includes(id)) return;
    tab = id;

    $$('[data-tab]').forEach(button => {
      const isActive = button.dataset.tab === id;
      button.classList.toggle('active', isActive);
      if (isActive) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });

    $$('.page').forEach(page => {
      const isActive = page.id === id;
      page.classList.toggle('active', isActive);
      page.hidden = !isActive;
    });

    $('#titulo').textContent = id === 'jornada' ? 'Minha jornada' : id === 'contracheque' ? 'Contracheque' : 'Configurações';
    $('#novo').hidden = id !== 'jornada';
    $('#competencia').hidden = id === 'configuracoes';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function shiftCompetency(amount) {
    const [year, month] = competencia.split('-').map(Number);
    const date = new Date(year, month - 1 + amount, 1);
    competencia = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    render();
  }

  function download(name, data, type) {
    const url = URL.createObjectURL(new Blob([data], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  function baseName(type) {
    const name = (state.nome || 'funcionario')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\W+/g, '-');
    return `${name}-${competencia}-${type}`;
  }

  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 3500);
  }

  function printMode(mode) {
    document.body.classList.add(`print-${mode}`);
    const cleanPrintMode = () => {
      document.body.classList.remove(`print-${mode}`);
      window.removeEventListener('afterprint', cleanPrintMode);
    };
    window.addEventListener('afterprint', cleanPrintMode);
    window.print();
  }

  function maskCpf(value) {
    return value.replace(/\D/g, '').slice(0, 11)
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d{1,2})$/, '$1-$2');
  }

  function maskCnpj(value) {
    return value.replace(/\D/g, '').slice(0, 14)
      .replace(/(\d{2})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d)/, '$1/$2')
      .replace(/(\d{4})(\d{1,2})$/, '$1-$2');
  }

  function maskCep(value) {
    return value.replace(/\D/g, '').slice(0, 8).replace(/(\d{5})(\d)/, '$1-$2');
  }

  async function lookupCep(value) {
    const requestId = ++cepLookupId;
    $('#cepStatus').textContent = 'Buscando endereço…';
    try {
      const response = await fetch(`https://viacep.com.br/ws/${value.replace(/\D/g, '')}/json/`);
      if (!response.ok) throw new Error('Falha na consulta');
      const result = await response.json();
      if (requestId !== cepLookupId) return;
      if (result.erro) throw new Error('CEP não encontrado');
      state.endereco = [result.logradouro, result.bairro, `${result.localidade} - ${result.uf}`]
        .filter(Boolean)
        .join(', ');
      $('#cepStatus').textContent = 'Endereço preenchido automaticamente.';
      save();
      render({ syncFields: true });
    } catch {
      if (requestId === cepLookupId) $('#cepStatus').textContent = 'CEP não encontrado ou sem conexão.';
    }
  }

  function validImportedData(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
  }

  $$('[data-tab]').forEach(button => button.addEventListener('click', () => setTab(button.dataset.tab)));
  $('#novo').addEventListener('click', () => openModal());
  $('#mes').addEventListener('change', event => {
    if (/^\d{4}-\d{2}$/.test(event.target.value)) {
      competencia = event.target.value;
      render();
    }
  });
  $('#mesAnterior').addEventListener('click', () => shiftCompetency(-1));
  $('#mesSeguinte').addEventListener('click', () => shiftCompetency(1));

  $('#registros').addEventListener('click', event => {
    const editId = event.target.dataset.edit;
    const deleteId = event.target.dataset.del;
    if (editId) openModal(state.registros.find(entry => entry.id === editId));
    if (deleteId && window.confirm('Excluir este registro?')) {
      state.registros = state.registros.filter(entry => entry.id !== deleteId);
      render();
      showToast('Registro excluído.');
    }
  });

  $('#intervalos').addEventListener('input', event => {
    const index = event.target.dataset.in ?? event.target.dataset.out;
    if (index === undefined) return;
    editing.intervals[Number(index)][event.target.dataset.in !== undefined ? 'in' : 'out'] = event.target.value;
  });

  $('#intervalos').addEventListener('click', event => {
    const index = event.target.dataset.remove;
    if (index === undefined) return;
    editing.intervals.splice(Number(index), 1);
    renderIntervals();
  });

  $('#adicionarIntervalo').addEventListener('click', () => {
    if (editing.intervals.length >= 6) return;
    editing.intervals.push({ in: '', out: '' });
    renderIntervals();
  });

  $('#situacao').addEventListener('change', () => {
    $('#erros').textContent = '';
    toggleIntervals();
  });

  $('#salvarRegistro').addEventListener('click', () => {
    editing = {
      ...editing,
      data: $('#data').value,
      status: $('#situacao').value,
      intervals: statusesWithHours.includes($('#situacao').value) ? editing.intervals : [],
      extra: Number($('#tipoExtra').value) === 100 ? 100 : 50,
      diaria: Math.max(0, numberOr($('#diaria').value)),
      observacao: $('#observacao').value.trim().slice(0, 240)
    };

    const hasMissingInterval = statusesWithHours.includes(editing.status)
      && editing.intervals.some(interval => !interval.in || !interval.out);
    if (!editing.data || hasMissingInterval) {
      $('#erros').textContent = 'Preencha a data e todos os pares de entrada e saída.';
      return;
    }

    state.registros = [...state.registros.filter(entry => entry.id !== editing.id), editing];
    closeModal();
    render();
    showToast('Registro salvo com sucesso.');
  });

  $('#modal').addEventListener('close', () => {
    $('#erros').textContent = '';
    if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
  });

  $$('[data-field]').forEach(element => element.addEventListener('input', event => {
    const field = event.target.dataset.field;
    let value = event.target.type === 'checkbox'
      ? event.target.checked
      : event.target.type === 'number'
        ? Math.max(0, numberOr(event.target.value))
        : event.target.value;

    if (field === 'cpf') value = maskCpf(value);
    if (field === 'cnpj') value = maskCnpj(value);
    if (field === 'cep') {
      value = maskCep(value);
      if (value.replace(/\D/g, '').length === 8) lookupCep(value);
      else $('#cepStatus').textContent = '';
    }

    state[field] = value;
    if (event.target.type !== 'checkbox') event.target.value = value;
    save();
    render();
  }));

  $('#exportar').addEventListener('click', () => {
    download(`${baseName('backup')}.json`, JSON.stringify(state, null, 2), 'application/json');
    showToast('Backup JSON exportado.');
  });

  $('#importar').addEventListener('click', () => $('#arquivo').click());
  $('#arquivo').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const imported = JSON.parse(await file.text());
      if (!validImportedData(imported)) throw new Error('Formato inválido');
      state = normaliseState(imported);
      render({ syncFields: true });
      showToast('Backup importado com sucesso.');
    } catch {
      showToast('Backup inválido. Nenhuma alteração foi aplicada.');
    } finally {
      event.target.value = '';
    }
  });

  $('#csv').addEventListener('click', () => {
    const rows = [
      ['Data', 'Situação', 'Entradas e saídas', 'Horas', 'Diária', 'Observação'],
      ...entries().map(entry => [
        entry.data,
        labels[entry.status],
        entry.intervals.map(interval => `${interval.in}-${interval.out}`).join(' | '),
        (worked(entry) / 60).toFixed(2),
        entry.diaria,
        entry.observacao
      ])
    ];
    const csv = '\ufeff' + rows
      .map(row => row.map(value => `"${String(value ?? '').replaceAll('"', '""')}"`).join(';'))
      .join('\r\n');
    download(`${baseName('folha-de-ponto')}.csv`, csv, 'text/csv;charset=utf-8');
    showToast('Folha de ponto exportada em CSV.');
  });

  $('#limpar').addEventListener('click', () => {
    if (!window.confirm('Apagar todos os dados? Esta ação não pode ser desfeita.')) return;
    state = cloneSeed();
    render({ syncFields: true });
    showToast('Todos os dados foram removidos.');
  });

  $('#imprimirContra').addEventListener('click', () => printMode('paycheck'));
  $('#imprimirPonto').addEventListener('click', () => printMode('point'));

  let swipe = {};
  $('#app').addEventListener('touchstart', event => {
    swipe = {
      x: event.touches[0].clientX,
      y: event.touches[0].clientY,
      blocked: Boolean(event.target.closest('input, button, select, dialog'))
    };
  }, { passive: true });

  $('#app').addEventListener('touchend', event => {
    if (swipe.blocked) return;
    const deltaX = event.changedTouches[0].clientX - swipe.x;
    const deltaY = event.changedTouches[0].clientY - swipe.y;
    if (Math.abs(deltaX) <= 65 || Math.abs(deltaX) <= Math.abs(deltaY) * 1.3) return;
    const tabs = ['jornada', 'contracheque', 'configuracoes'];
    const index = tabs.indexOf(tab);
    setTab(tabs[Math.max(0, Math.min(2, index + (deltaX < 0 ? 1 : -1))) ]);
  }, { passive: true });

  setTab('jornada');
  render({ syncFields: true });
})();
