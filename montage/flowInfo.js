// ============================================================
// БОТ МОНТАЖНИКОВ — T-3 «Предстоящие монтажи», T-10 «Отчет»,
// T-12 «Уведомления»
// ============================================================

const amo = require("./amo");
const calc = require("./calc");
const messenger = require("./messenger");
const settingsStore = require("./settings");
const deals = require("./deals");
const { say } = require("./ui");
const { FIELD, PIPELINE, REPORT_PIPELINE_IDS } = require("./constants");

const { mdSafe } = messenger;

// ============================================================
// T-3 Предстоящие монтажи
// ============================================================

async function showUpcoming(env, state) {
  const { ctx } = env;

  if (state.roleKey === "manager") {
    const names = state.managerRows.map((row) => row.foremanName);
    const leads = (await deals.findUpcomingLeads(ctx, { includeLekal: false })).filter((lead) =>
      names.some((name) => calc.sameName(amo.fieldText(ctx, lead, FIELD.MONTAGER), name))
    );

    if (leads.length === 0) {
      await say(env, "Монтажи не найдены");
      return;
    }

    const groups = new Map();

    for (const lead of deals.sortByTerms(ctx, leads.map((item) => ({ lead: item })))
      .map((item) => item.lead)) {
      const name = amo.fieldText(ctx, lead, FIELD.MONTAGER);

      if (!groups.has(name)) {
        groups.set(name, []);
      }

      groups.get(name).push(lead);
    }

    const lines = ["Предстоящие монтажи:"];

    for (const [name, list] of groups) {
      lines.push(mdSafe(name));

      for (let i = 0; i < list.length; i++) {
        lines.push(`${i + 1}. ${await deals.dealLine(ctx, list[i], "upcoming")}`);
      }
    }

    await say(env, lines.join("\n"), undefined, true);
    return;
  }

  const leads = (await deals.findUpcomingLeads(ctx, { includeLekal: true })).filter((lead) =>
    deals.belongsToForeman(ctx, lead, state.foremanName)
  );

  if (leads.length === 0) {
    await say(env, "Монтажи не найдены");
    return;
  }

  const sorted = deals.sortByTerms(ctx, leads.map((item) => ({ lead: item }))).map((item) => item.lead);
  const lines = ["Предстоящие монтажи:"];

  for (let i = 0; i < sorted.length; i++) {
    lines.push(`${i + 1}. ${await deals.dealLine(ctx, sorted[i], "upcoming")}`);
  }

  await say(env, lines.join("\n"), undefined, true);
}

// ============================================================
// T-12 Уведомления
// ============================================================

function formatNotificationTime(iso) {
  const moscow = new Date(new Date(iso).getTime() + 3 * 3600 * 1000);
  const pad = (value) => String(value).padStart(2, "0");

  return `${pad(moscow.getUTCDate())}.${pad(moscow.getUTCMonth() + 1)} ${pad(moscow.getUTCHours())}:${pad(moscow.getUTCMinutes())}`;
}

async function showNotifications(env) {
  const items = await messenger.loadNotifications(env.ctx, env.directId, 10);

  if (items.length === 0) {
    await say(env, "Уведомлений пока нет.");
    return;
  }

  // Старые сверху, новые снизу — как в переписке.
  const text = items
    .reverse()
    .map((item) => `${formatNotificationTime(item.at)}\n${item.text}`)
    .join("\n\n");

  await say(env, `Последние уведомления от бота:\n\n${text}`);
}

// ============================================================
// T-10 Отчет
// ============================================================

const B_FIRST_HALF = "1-15 текущего месяца";
const B_SECOND_HALF = "16-конец предыдущего месяца";
const B_CUSTOM = "Выбрать период";
const PERIOD_BUTTONS = [B_FIRST_HALF, B_SECOND_HALF, B_CUSTOM];
const B_BACK = "Назад";

const MSG_BAD_PERIOD =
  "Не удалось распознать указанную дату. Пожалуйста, введите период в формате:\nХХ.ХХ.ХХХХ - ХХ.ХХ.ХХХХ\nили\nХХ.ХХ.ХХХХ.";

async function startReport(env, state) {
  state.flow = { name: "report_period", step: "choose" };
  await say(env, "Выберите период отчета", PERIOD_BUTTONS);
}

// Просмотр воронок для отчёта: одна выгрузка на воронку, короткий кэш.
const scanCache = new Map();
const SCAN_TTL_MS = 120000;

function scanPipeline(ctx, pipelineId, fromUnix) {
  const key = `${pipelineId}|${fromUnix}`;
  const cached = scanCache.get(key);

  if (cached && Date.now() - cached.at < SCAN_TTL_MS) {
    return cached.promise;
  }

  const promise = amo.getLeadsUpdatedSince(ctx, pipelineId, fromUnix);

  scanCache.set(key, { at: Date.now(), promise });
  promise.catch(() => scanCache.delete(key));

  return promise;
}

// Монтажи периода: по каждому слоту монтажника, где «Дата монтажа» в периоде.
async function collectEntries(ctx, foremanNames, period) {
  const scanned = await Promise.all(REPORT_PIPELINE_IDS.map((id) => scanPipeline(ctx, id, period.fromUnix)));
  const entries = [];

  for (const lead of scanned.flat()) {
    for (const found of amo.slotsOfForemen(ctx, lead, foremanNames)) {
      const slot = amo.readSlot(ctx, lead, found.index);

      if (slot.date >= period.fromUnix && slot.date <= period.toUnix) {
        entries.push({ lead, slot, foreman: found.foreman, pipelineId: Number(lead.pipeline_id) });
      }
    }
  }

  return entries;
}

function sum(entries, pick) {
  return entries.reduce((total, entry) => total + calc.num(pick(entry)), 0);
}

// T-10.5: отчёт бригадира.
function foremanReportText(ctx, period, entries) {
  const lines = [
    `Отчет за ${period.label}`,
    `Кол-во выполненных монтажей: ${entries.length}`,
    `Стоимость выполненных монтажей: ${calc.formatMoney(sum(entries, (e) => e.slot.price + e.slot.extra))}`,
    `Общее баллов КТУ: ${calc.fmt(sum(entries, (e) => amo.ktuTotal(e.slot)))}`,
    `км * тариф = ${calc.formatMoney(sum(entries, (e) => e.slot.kmFactTotal))}`
  ];

  for (const entry of entries) {
    lines.push(
      "",
      `Договор № ${amo.contractNumber(ctx, entry.lead)}:`,
      `Стоимость работ: ${calc.fmt(entry.slot.price)}`,
      `Баллов КТУ: ${calc.fmt(amo.ktuTotal(entry.slot))}`,
      `${calc.fmt(entry.slot.kmFact)} км * ${calc.fmt(entry.slot.tariff)} тариф = ${calc.fmt(entry.slot.kmFactTotal)}`,
      `${calc.fmt(entry.slot.kmDelivery)} км * ${calc.fmt(entry.slot.tariffDelivery)} = ${calc.fmt(entry.slot.kmDeliveryTotal)}`
    );
  }

  return lines.join("\n");
}

function percent(part, whole) {
  return whole > 0 ? calc.fmt((part / whole) * 100) : "0";
}

function blockLines(title, entries) {
  const budget = sum(entries, (e) => e.lead.price);
  const cost = sum(entries, (e) => e.slot.price);

  return [
    title,
    `Кол-во выполненных монтажей: ${entries.length}`,
    `Бюджет сделок: ${calc.formatMoney(budget)}`,
    `Стоимость монтажа: ${calc.formatMoney(cost)}; (${percent(cost, budget)}% от бюджета)`,
    `Баллы КТУ: ${calc.fmt(sum(entries, (e) => amo.ktuTotal(e.slot)))}`,
    `КМтранспорт*тариф: ${calc.formatMoney(sum(entries, (e) => e.slot.kmFactTotal))}`,
    `КМдоставки*тариф: ${calc.formatMoney(sum(entries, (e) => e.slot.kmDeliveryTotal))}`
  ];
}

const FUNNEL_TITLES = [
  { title: "Металл", ids: [PIPELINE.METAL, PIPELINE.METAL_PRODUCTION] },
  { title: "Дерево", ids: [PIPELINE.WOOD, PIPELINE.WOOD_PRODUCTION] },
  { title: "Рекламации", ids: [PIPELINE.RECLAMATION] }
];

// T-10.11: отчёт руководителя с группировкой по монтажникам и воронкам.
function managerReportText(period, entries, foremanNames) {
  const lines = [`Отчет за ${period.label}`];

  for (const name of foremanNames) {
    lines.push("", ...blockLines(`${name}:`, entries.filter((e) => calc.sameName(e.foreman, name))));
  }

  for (const funnel of FUNNEL_TITLES) {
    const list = entries.filter((e) => funnel.ids.includes(e.pipelineId));

    if (list.length > 0) {
      lines.push("", ...blockLines(`Общий отчет. Воронка ${funnel.title}:`, list));
    }
  }

  return lines.join("\n");
}

// До 31 дня включительно — весь текст (с разбиением на сообщения); дольше —
// только первое сообщение и предупреждение.
async function sendLongText(env, period, text, buttons) {
  if (period.days <= 31) {
    await say(env, text, buttons);
    return;
  }

  const first = calc.splitText(text, 3500)[0];

  await say(env, first);
  await say(env, "Текст отчета слишком длинный, показана только его часть. Выберите период не больше 31 дня.", buttons);
}

async function buildAndSend(env, state, period) {
  const { ctx } = env;

  await say(env, `Ожидайте, формируем отчет за период ${period.label}`);

  if (state.roleKey === "manager") {
    const names = state.managerRows.map((row) => row.foremanName);
    const entries = await collectEntries(ctx, names, period);

    state.flow = { name: "report_period", step: "manager", period, foremen: names };
    state.list = { kind: "report_foremen", map: Object.fromEntries(names.map((name) => [name, name])) };

    await sendLongText(env, period, managerReportText(period, entries, names), names);
    return;
  }

  const entries = await collectEntries(ctx, [state.foremanName], period);

  state.flow = null;
  await sendLongText(env, period, foremanReportText(ctx, period, entries));
}

async function handleReport(env, state, input) {
  const { ctx } = env;
  const flow = state.flow;
  const text = input.text;

  if (flow.step === "choose") {
    if (text === B_CUSTOM) {
      flow.step = "custom";
      await say(env, "Укажите период для отчета");
    } else if (text === B_FIRST_HALF) {
      await buildAndSend(env, state, calc.firstHalfOfCurrentMonth(ctx.getMoscowDate()));
    } else if (text === B_SECOND_HALF) {
      await buildAndSend(env, state, calc.secondHalfOfPreviousMonth(ctx.getMoscowDate()));
    } else {
      await say(env, "Выберите период отчета", PERIOD_BUTTONS);
    }

    return true;
  }

  if (flow.step === "custom") {
    const period = calc.parsePeriodText(text);

    if (!period) {
      await say(env, MSG_BAD_PERIOD);
      return true;
    }

    await buildAndSend(env, state, period);
    return true;
  }

  // Руководитель: выбор монтажника → его отчёт с кнопкой «Назад».
  if (flow.step === "manager") {
    const name = flow.foremen.find((item) => item === text);

    if (!name) {
      await say(env, "Выберите монтажника кнопкой.", flow.foremen);
      return true;
    }

    const entries = await collectEntries(ctx, [name], flow.period);

    flow.step = "manager_foreman";
    await sendLongText(env, flow.period, foremanReportText(ctx, flow.period, entries.filter((e) => calc.sameName(e.foreman, name))), [B_BACK]);
    return true;
  }

  if (flow.step === "manager_foreman") {
    if (text === B_BACK) {
      const entries = await collectEntries(ctx, flow.foremen, flow.period);

      flow.step = "manager";
      await sendLongText(env, flow.period, managerReportText(flow.period, entries, flow.foremen), flow.foremen);
    } else {
      await say(env, "Нажмите «Назад», чтобы вернуться к общему отчёту.", [B_BACK]);
    }

    return true;
  }

  return false;
}

module.exports = { showUpcoming, showNotifications, startReport, handleReport, settingsStore };
