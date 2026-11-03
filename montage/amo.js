// ============================================================
// БОТ МОНТАЖНИКОВ — РАБОТА С amoCRM (сделки, задачи, примечания, поля)
// Все функции принимают ctx (набор общих функций из amoSharedUtils) первым
// аргументом — как и в остальных ботах проекта.
// ============================================================

const { FIELD, SLOT_FIELDS, TASK_TYPE, COST_APPROVAL_NEW_FIELD_NAME } = require("./constants");
const calc = require("./calc");

function api(ctx, path) {
  return `https://${ctx.AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4${path}`;
}

function listFrom(response, key) {
  return (response.data && response.data._embedded && response.data._embedded[key]) || [];
}

// Постраничная выгрузка (limit 250). 204 — «ничего нет».
async function fetchAll(ctx, path, params, key, { maxPages = 40 } = {}) {
  const all = [];

  for (let page = 1; page <= maxPages; page++) {
    const response = await ctx.amoCrmGet(api(ctx, path), { ...params, limit: 250, page });

    if (response.status === 204) {
      break;
    }

    if (response.status !== 200) {
      throw new Error(`amoCRM GET ${path} HTTP ${response.status}: ${JSON.stringify(response.data).slice(0, 300)}`);
    }

    const items = listFrom(response, key);

    all.push(...items);

    if (items.length < 250) {
      break;
    }
  }

  return all;
}

// ------------------------------------------------------------
// Задачи
// ------------------------------------------------------------

// Открытые задачи типа (по всем сделкам).
async function getOpenTasks(ctx, typeId) {
  return fetchAll(
    ctx,
    "/tasks",
    { "filter[entity_type]": "leads", "filter[task_type][0]": typeId, "filter[is_completed]": 0 },
    "tasks"
  );
}

// Задачи типа у конкретных сделок (открытые или закрытые).
async function getTasksForLeads(ctx, leadIds, typeId, completed) {
  const result = [];
  const ids = [...new Set(leadIds.map(String))];

  for (let i = 0; i < ids.length; i += 50) {
    const params = {
      "filter[entity_type]": "leads",
      "filter[task_type][0]": typeId,
      "filter[is_completed]": completed ? 1 : 0
    };

    ids.slice(i, i + 50).forEach((id, index) => {
      params[`filter[entity_id][${index}]`] = id;
    });

    result.push(...(await fetchAll(ctx, "/tasks", params, "tasks", { maxPages: 4 })));
  }

  return result;
}

// Закрытые задачи типа, изменённые не раньше fromUnix. Фильтр по дате отдаём
// amoCRM; если он не принят — просматриваем последние страницы сами.
async function getRecentlyClosedTasks(ctx, typeId, fromUnix) {
  const base = { "filter[entity_type]": "leads", "filter[task_type][0]": typeId, "filter[is_completed]": 1 };

  try {
    const tasks = await fetchAll(ctx, "/tasks", { ...base, "filter[updated_at][from]": fromUnix }, "tasks", {
      maxPages: 10
    });

    return tasks.filter((task) => Number(task.updated_at) >= fromUnix);
  } catch (error) {
    console.error("[Бот монтажников] Фильтр задач по updated_at не принят, просматриваю вручную:", error.message);

    const tasks = await fetchAll(ctx, "/tasks", { ...base, "order[id]": "desc" }, "tasks", { maxPages: 6 });

    return tasks.filter((task) => Number(task.updated_at) >= fromUnix);
  }
}

// Закрыть задачу с результатом. Уже закрытая задача — не ошибка.
async function closeTask(ctx, taskId, resultText) {
  const response = await ctx.amoCrmPatch(api(ctx, `/tasks/${taskId}`), {
    is_completed: true,
    result: { text: resultText }
  });

  if (response.status >= 400) {
    const text = JSON.stringify(response.data || {});

    if (/already|completed|закрыт/i.test(text)) {
      console.log(`[Бот монтажников] Задача ${taskId} уже была закрыта.`);
      return;
    }

    throw new Error(`amoCRM PATCH /tasks/${taskId} HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
}

// Контрольная задача (ТЗ 4.6 «Заказчик отсутствовал», 4.13 «Получена оплата»).
async function createTask(ctx, { leadId, responsibleUserId, typeId, text, hours = 1 }) {
  const response = await ctx.amoCrmPost(api(ctx, "/tasks"), [
    {
      task_type_id: typeId,
      text,
      complete_till: Math.floor(Date.now() / 1000) + hours * 3600,
      entity_id: Number(leadId),
      entity_type: "leads",
      responsible_user_id: Number(responsibleUserId)
    }
  ]);

  if (response.status >= 400) {
    throw new Error(`amoCRM POST /tasks HTTP ${response.status}: ${JSON.stringify(response.data).slice(0, 300)}`);
  }
}

// ------------------------------------------------------------
// Сделки, примечания
// ------------------------------------------------------------

async function getLeadsByIds(ctx, ids) {
  const result = [];
  const unique = [...new Set(ids.map(String))];

  for (let i = 0; i < unique.length; i += 50) {
    const params = { with: "contacts" };

    unique.slice(i, i + 50).forEach((id, index) => {
      params[`filter[id][${index}]`] = id;
    });

    result.push(...(await fetchAll(ctx, "/leads", params, "leads", { maxPages: 2 })));
  }

  return result;
}

async function getLeadsAtStatus(ctx, pipelineId, statusId) {
  return fetchAll(
    ctx,
    "/leads",
    {
      with: "contacts",
      "filter[pipeline_id]": pipelineId,
      "filter[statuses][0][pipeline_id]": pipelineId,
      "filter[statuses][0][status_id]": statusId
    },
    "leads",
    { maxPages: 20 }
  );
}

// Сделки воронки, изменённые после fromUnix (для отчётов).
async function getLeadsUpdatedSince(ctx, pipelineId, fromUnix) {
  return fetchAll(
    ctx,
    "/leads",
    { "filter[pipeline_id]": pipelineId, "filter[updated_at][from]": fromUnix },
    "leads",
    { maxPages: 40 }
  );
}

async function patchLead(ctx, leadId, body) {
  const response = await ctx.amoCrmPatch(api(ctx, `/leads/${leadId}`), body);

  if (response.status >= 400) {
    throw new Error(`amoCRM PATCH /leads/${leadId} HTTP ${response.status}: ${JSON.stringify(response.data).slice(0, 400)}`);
  }

  return response.data;
}

async function addNote(ctx, leadId, text) {
  const response = await ctx.amoCrmPost(api(ctx, `/leads/${leadId}/notes`), [
    { note_type: "common", params: { text } }
  ]);

  if (response.status >= 400) {
    throw new Error(`amoCRM POST notes HTTP ${response.status}: ${JSON.stringify(response.data).slice(0, 300)}`);
  }
}

// Основной контакт сделки: имя и телефоны (с кэшем на 10 минут).
const contactCache = new Map();

async function getContactInfo(ctx, lead) {
  const contacts = (lead && lead._embedded && lead._embedded.contacts) || [];
  const main = contacts.find((contact) => contact.is_main) || contacts[0];

  if (!main) {
    return { name: "", phones: [] };
  }

  const cached = contactCache.get(main.id);

  if (cached && Date.now() - cached.at < 600000) {
    return cached.info;
  }

  const response = await ctx.amoCrmGet(api(ctx, `/contacts/${main.id}`), {});

  if (response.status !== 200 || !response.data) {
    return { name: "", phones: [] };
  }

  const phoneField = (response.data.custom_fields_values || []).find((field) => field.field_code === "PHONE");
  const phones = ((phoneField && phoneField.values) || []).map((item) => String(item.value)).filter(Boolean);
  const info = { name: response.data.name || "", phones };

  contactCache.set(main.id, { at: Date.now(), info });

  return info;
}

// ------------------------------------------------------------
// Значения полей
// ------------------------------------------------------------

function fieldText(ctx, lead, fieldId) {
  return ctx.getFieldValueJoined(lead, fieldId);
}

function fieldNumber(ctx, lead, fieldId) {
  const raw = ctx.getFieldValues(lead, fieldId)[0];
  const value = Number(String(raw === undefined ? "" : raw).replace(",", "."));

  return Number.isFinite(value) ? value : 0;
}

function fieldHasValue(ctx, lead, fieldId) {
  return ctx.getFieldValues(lead, fieldId).length > 0;
}

function fieldEnumId(lead, fieldId) {
  const field = ((lead && lead.custom_fields_values) || []).find((item) => Number(item.field_id) === Number(fieldId));
  const value = field && field.values && field.values[0];

  return value && value.enum_id ? Number(value.enum_id) : null;
}

function contractNumber(ctx, lead) {
  return fieldText(ctx, lead, FIELD.CONTRACT_NUMBER) || `Сделка ${lead.id}`;
}

function setValue(fieldId, value) {
  return { field_id: Number(fieldId), values: [{ value }] };
}

function clearField(fieldId) {
  return { field_id: Number(fieldId), values: null };
}

// ------------------------------------------------------------
// Слоты монтажников (Таблица 2)
// ------------------------------------------------------------

// Номер слота (0..2), где в поле «N. Монтажник» указан этот монтажник.
function findSlotIndex(ctx, lead, foremanName) {
  for (let i = 0; i < SLOT_FIELDS.length; i++) {
    const value = fieldText(ctx, lead, SLOT_FIELDS[i].master);

    if (value && calc.sameName(value, foremanName)) {
      return i;
    }
  }

  return -1;
}

// Слоты, где указан кто-либо из заданных монтажников (для отчётов).
function slotsOfForemen(ctx, lead, foremanNames) {
  const result = [];

  for (let i = 0; i < SLOT_FIELDS.length; i++) {
    const value = fieldText(ctx, lead, SLOT_FIELDS[i].master);

    if (value && foremanNames.some((name) => calc.sameName(value, name))) {
      result.push({ index: i, foreman: value });
    }
  }

  return result;
}

// Прочитать значения слота в обычный объект.
function readSlot(ctx, lead, index) {
  const fields = SLOT_FIELDS[index];
  const out = {};

  for (const key of Object.keys(fields)) {
    out[key] = key === "master" || key === "note" ? fieldText(ctx, lead, fields[key]) : fieldNumber(ctx, lead, fields[key]);
  }

  return out;
}

// Сумма баллов КТУ слота.
function ktuTotal(slot) {
  return (
    calc.num(slot.ktuVideo) +
    calc.num(slot.ktuTimelapse) +
    calc.num(slot.ktuReviewVideo) +
    calc.num(slot.ktuRegulations) +
    calc.num(slot.ktuReport) +
    calc.num(slot.ktuReviewSite)
  );
}

// Собрать custom_fields_values для записи в слот: {ключ: значение|null}.
function slotFieldsPayload(index, values) {
  const fields = SLOT_FIELDS[index];
  const payload = [];

  for (const key of Object.keys(values)) {
    if (!fields[key]) {
      throw new Error(`Неизвестное поле слота: ${key}`);
    }

    payload.push(values[key] === null ? clearField(fields[key]) : setValue(fields[key], values[key]));
  }

  return payload;
}

// ------------------------------------------------------------
// Поле «[Бот] Согласование стоимости(new)» (T-11)
// ------------------------------------------------------------
// ID этого поля в ТЗ не указан — ищем по точному названию. Если не нашли,
// используем флаг «[Бот] Согласование стоимости» (555158) из таблицы 1.

let approvalFieldCache = null;

async function getCostApprovalField(ctx) {
  if (approvalFieldCache && Date.now() - approvalFieldCache.at < 3600000) {
    return approvalFieldCache.field;
  }

  const fields = await fetchAll(ctx, "/leads/custom_fields", {}, "custom_fields", { maxPages: 10 });
  let found = fields.find((field) => String(field.name).trim() === COST_APPROVAL_NEW_FIELD_NAME);

  if (!found) {
    found = fields.find((field) => Number(field.id) === FIELD.COST_APPROVAL_FLAG);
    console.warn(
      `[Бот монтажников] Поле «${COST_APPROVAL_NEW_FIELD_NAME}» не найдено, использую флаг ${FIELD.COST_APPROVAL_FLAG}.`
    );
  }

  if (!found) {
    throw new Error("Не найдено поле «[Бот] Согласование стоимости» в amoCRM.");
  }

  const field = { id: found.id, type: found.type, enums: found.enums || [] };

  approvalFieldCache = { at: Date.now(), field };

  return field;
}

// Значение поля согласования: wanted = true («Согласовать стоимость») или false («Согласование не нужно»).
function costApprovalPayload(field, wanted, requestedText, notNeededText) {
  if (field.type === "checkbox") {
    return setValue(field.id, wanted);
  }

  const text = wanted ? requestedText : notNeededText;
  const option = (field.enums || []).find((item) => String(item.value).trim() === text);

  if (!option) {
    throw new Error(`В поле согласования стоимости нет значения «${text}».`);
  }

  return { field_id: Number(field.id), values: [{ value: option.value, enum_id: option.id }] };
}

function isCostApprovalRequested(ctx, lead, field, requestedText) {
  const raw = ctx.getFieldValues(lead, field.id);

  if (field.type === "checkbox") {
    return raw.some((value) => value === true || value === "true" || value === "1");
  }

  return raw.some((value) => String(value).trim() === requestedText);
}

module.exports = {
  fetchAll,
  getOpenTasks,
  getTasksForLeads,
  getRecentlyClosedTasks,
  closeTask,
  createTask,
  getLeadsByIds,
  getLeadsAtStatus,
  getLeadsUpdatedSince,
  patchLead,
  addNote,
  getContactInfo,
  fieldText,
  fieldNumber,
  fieldHasValue,
  fieldEnumId,
  contractNumber,
  setValue,
  clearField,
  findSlotIndex,
  slotsOfForemen,
  readSlot,
  ktuTotal,
  slotFieldsPayload,
  getCostApprovalField,
  costApprovalPayload,
  isCostApprovalRequested,
  TASK_TYPE
};
