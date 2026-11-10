// ============================================================
// БОТ МОНТАЖНИКОВ — поиск сделок и оформление карточек/списков
// ============================================================

const amo = require("./amo");
const calc = require("./calc");
const messenger = require("./messenger");
const files = require("./files");
const { FIELD, PIPELINE, SALES_PIPELINE_IDS, TASK_TYPE, UPCOMING_STATUS } = require("./constants");

const { mdSafe, mdLink } = messenger;

// ------------------------------------------------------------
// Принадлежность сделки бригадиру
// ------------------------------------------------------------

// Бригадир указан в «Монтажник» (446003); в воронке «Дерево производство»
// снятие лекал — «Лекальщик» (552052). Принимаем оба поля, чтобы не
// потерять сделку, если заполнено только одно.
function leadForemanNames(ctx, lead) {
  const names = [amo.fieldText(ctx, lead, FIELD.MONTAGER)];

  if (Number(lead.pipeline_id) === PIPELINE.WOOD_PRODUCTION) {
    names.push(amo.fieldText(ctx, lead, FIELD.LEKALSHIK));
  }

  return names.filter(Boolean);
}

function belongsToForeman(ctx, lead, foremanName) {
  return leadForemanNames(ctx, lead).some((name) => calc.sameName(name, foremanName));
}

// ------------------------------------------------------------
// Поиск
// ------------------------------------------------------------

async function leadsByTasks(ctx, tasks) {
  const taskByLead = new Map();

  for (const task of tasks) {
    if (task.entity_id && !taskByLead.has(String(task.entity_id))) {
      taskByLead.set(String(task.entity_id), task);
    }
  }

  const leads = await amo.getLeadsByIds(ctx, [...taskByLead.keys()]);

  return leads.map((lead) => ({ lead, task: taskByLead.get(String(lead.id)) }));
}

// T-6: открыта «Отчет о монтаже», бригадир — текущий пользователь.
async function findReportDeals(ctx, foremanName) {
  const found = await leadsByTasks(ctx, await amo.getOpenTasks(ctx, TASK_TYPE.MONTAGE_REPORT));

  return found.filter(
    (item) => SALES_PIPELINE_IDS.includes(Number(item.lead.pipeline_id)) && belongsToForeman(ctx, item.lead, foremanName)
  );
}

function moscowTodayRange(ctx) {
  const start = ctx.todayMoscowStartUnix();

  return { from: start, to: start + 86400 - 1 };
}

// T-4: открыта «Подт-ть монтаж» со сроком «сегодня».
async function findConfirmDeals(ctx, foremanName) {
  const { from, to } = moscowTodayRange(ctx);
  const tasks = (await amo.getOpenTasks(ctx, TASK_TYPE.CONFIRM_MONTAGE)).filter(
    (task) => Number(task.complete_till) >= from && Number(task.complete_till) <= to
  );
  const found = await leadsByTasks(ctx, tasks);

  return found.filter((item) => belongsToForeman(ctx, item.lead, foremanName));
}

// T-7: открыта «Принять отчет»; бригадир — из числа подчинённых руководителя.
async function findAcceptDeals(ctx, foremanNames) {
  const found = await leadsByTasks(ctx, await amo.getOpenTasks(ctx, TASK_TYPE.ACCEPT_REPORT));

  return found.filter((item) => foremanNames.some((name) => belongsToForeman(ctx, item.lead, name)));
}

// «Принять отчет» закрыта не больше суток назад: lead id → дата закрытия.
async function recentlyAcceptedLeadIds(ctx) {
  const since = Math.floor(Date.now() / 1000) - 24 * 3600;
  const tasks = await amo.getRecentlyClosedTasks(ctx, TASK_TYPE.ACCEPT_REPORT, since);
  const map = new Map();

  for (const task of tasks) {
    const key = String(task.entity_id);

    map.set(key, Math.max(map.get(key) || 0, Number(task.updated_at) || 0));
  }

  return map;
}

// T-9: открыта «Правки в отчет» + «Принять отчет» закрыта ≤ 24 ч назад.
async function findFixesDeals(ctx, foremanName) {
  const found = await leadsByTasks(ctx, await amo.getOpenTasks(ctx, TASK_TYPE.FIXES));
  const mine = found.filter(
    (item) => SALES_PIPELINE_IDS.includes(Number(item.lead.pipeline_id)) && belongsToForeman(ctx, item.lead, foremanName)
  );

  if (mine.length === 0) {
    return [];
  }

  const accepted = await recentlyAcceptedLeadIds(ctx);

  return mine.filter((item) => accepted.has(String(item.lead.id)));
}

// T-11: «Принять отчет» закрыта ≤ 24 ч назад, бригадир — текущий.
async function findCostRevisionDeals(ctx, foremanName) {
  const accepted = await recentlyAcceptedLeadIds(ctx);

  if (accepted.size === 0) {
    return [];
  }

  const leads = await amo.getLeadsByIds(ctx, [...accepted.keys()]);

  return leads
    .filter((lead) => SALES_PIPELINE_IDS.includes(Number(lead.pipeline_id)) && belongsToForeman(ctx, lead, foremanName))
    .map((lead) => ({ lead }));
}

// T-3: сделки на статусах «предстоящий монтаж».
async function findUpcomingLeads(ctx, { includeLekal }) {
  const leads = [];

  for (const pipelineId of Object.keys(UPCOMING_STATUS).map(Number)) {
    if (pipelineId === PIPELINE.WOOD_PRODUCTION && !includeLekal) {
      continue;
    }

    // В воронке может быть несколько подходящих статусов.
    for (const statusId of [].concat(UPCOMING_STATUS[pipelineId])) {
      leads.push(...(await amo.getLeadsAtStatus(ctx, pipelineId, statusId)));
    }
  }

  return leads;
}

// ------------------------------------------------------------
// Оформление
// ------------------------------------------------------------

function termsText(ctx, lead) {
  return ctx.formatDateFieldValue(lead, FIELD.TERMS) || "—";
}

function dateText(ctx, lead) {
  if (Number(lead.pipeline_id) === PIPELINE.WOOD_PRODUCTION) {
    return ctx.formatDateFieldValue(lead, FIELD.LEKAL_DATE) || termsText(ctx, lead);
  }

  return termsText(ctx, lead);
}

function productText(ctx, lead) {
  return amo.fieldText(ctx, lead, FIELD.PRODUCT) || "—";
}

function floorsText(ctx, lead) {
  return amo.fieldText(ctx, lead, FIELD.FLOORS) || "—";
}

// «Договор № …» со ссылкой на «Проект в производство pdf» (если есть).
function contractLabel(ctx, lead) {
  const text = `Договор № ${amo.contractNumber(ctx, lead)}`;

  return mdLink(text, amo.fieldText(ctx, lead, FIELD.CONTRACT_LINK));
}

// Ссылка на папку «Монтаж» генерируется ботом (поле 557522 не используется).
async function folderLink(ctx, lead, text = "Папка на Яндекс Диске") {
  return mdLink(text, await files.folderLink(ctx, lead.id));
}

// Дата для сортировки/показа: у «Дерево производство» — дата снятия лекал
// (если указана), у остальных — сроки монтажа.
function sortKey(ctx, lead) {
  const lekal = Number(lead.pipeline_id) === PIPELINE.WOOD_PRODUCTION ? Number(ctx.getFieldValues(lead, FIELD.LEKAL_DATE)[0]) : 0;

  return lekal || Number(ctx.getFieldValues(lead, FIELD.TERMS)[0]) || 0;
}

function sortByTerms(ctx, items) {
  return [...items].sort((a, b) => sortKey(ctx, a.lead || a) - sortKey(ctx, b.lead || b));
}

// Строки списков. mode:
//   upcoming — «Сроки, № договора, Продукт, Кол-во этажей»
//   confirm / report — «Дата, адрес; продукт, этажи. Имя, телефон(ы), № договора»
//   accept — как report, но без этажей и с папкой
//   fixes — «Сроки, адрес; продукт, № договора. Комментарий»
async function dealLine(ctx, lead, mode) {
  const number = mdSafe(amo.contractNumber(ctx, lead));
  const product = mdSafe(productText(ctx, lead));
  const floors = mdSafe(floorsText(ctx, lead));

  if (mode === "upcoming") {
    return `${mdSafe(dateText(ctx, lead))}, ${contractLabel(ctx, lead)}, ${product}, Кол-во этажей: ${floors}.`;
  }

  const contact = await amo.getContactInfo(ctx, lead);
  const address = mdSafe(amo.fieldText(ctx, lead, FIELD.ADDRESS) || "—");
  const date = mdSafe(mode === "confirm" || mode === "report" ? dateText(ctx, lead) : termsText(ctx, lead));
  const contract = contractLabel(ctx, lead);

  if (mode === "confirm") {
    return `${date}, ${address}; ${product}, Кол-во этажей: ${floors}. ${mdSafe(contact.name)}, ${mdSafe(contact.phones.join(", "))}, ${contract}.`;
  }

  if (mode === "report") {
    return `${date}, ${address}; ${product}, Кол-во этажей: ${floors}. ${mdSafe(contact.name)}, ${mdSafe(contact.phones[0] || "")}, ${contract}.`;
  }

  if (mode === "accept") {
    return `${date}, ${address}; ${product}, ${mdSafe(contact.name)}, ${mdSafe(contact.phones[0] || "")}, ${contract}. ${await folderLink(ctx, lead, "Папка на яндекс-диске")}`;
  }

  if (mode === "fixes") {
    return `${date}, ${address}; ${product}, ${contract}. ${mdSafe(amo.fieldText(ctx, lead, FIELD.MASTER_COMMENT))}`;
  }

  return number;
}

// Кнопки-сделки: текст кнопки → id сделки (однозначный, без повторов).
function buildDealButtons(ctx, leads, prefixFn) {
  const map = {};
  const buttons = [];

  for (const lead of leads) {
    const prefix = prefixFn ? prefixFn(lead) : "";
    let text = `${prefix}${amo.contractNumber(ctx, lead)}`.trim();

    if (map[text]) {
      text = `${text} (id ${lead.id})`;
    }

    map[text] = lead.id;
    buttons.push(text);
  }

  return { map, buttons };
}

module.exports = {
  leadForemanNames,
  belongsToForeman,
  findReportDeals,
  findConfirmDeals,
  findAcceptDeals,
  findFixesDeals,
  findCostRevisionDeals,
  findUpcomingLeads,
  sortByTerms,
  dealLine,
  buildDealButtons,
  termsText,
  dateText,
  productText,
  floorsText,
  contractLabel,
  folderLink
};
