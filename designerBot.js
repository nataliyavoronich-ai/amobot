// ============================================================
// БОТ ПРОЕКТИРОВЩИКОВ (amoMessenger)
// ============================================================
//
// Отдельный бот в отдельном amoMessenger-приложении, работающий в ТОМ ЖЕ
// Node.js-процессе/Render-сервисе, что и бот инженеров (server.js).
//
// У бота проектировщиков:
// - свои OAuth credentials (AMOMESSENGER_PROJECT_*);
// - свои access/refresh токены (свои ключи в Redis);
// - свой webhook-маршрут (/webhook/project) — этим гарантируется, что
//   события одного бота не попадают в сценарии другого (см. ТЗ п.2.4);
// - своё состояние пользователей (все Map'ы ниже — отдельные объекты,
//   физически не пересекающиеся с состоянием бота инженеров).
//
// Модуль не хранит собственных амоCRM/Sensei/Яндекс.Диск функций —
// всё это переиспользуется из server.js через объект ctx, который
// передаётся в init(app, ctx). Логика бота инженеров этим модулем
// не изменяется и не импортируется "как есть" — только пере используются
// уже проверенные универсальные функции.

const axios = require("axios");

// ============================================================
// 1. CONFIG
// ============================================================

const AMOMESSENGER_PROJECT_CLIENT_ID =
  process.env.AMOMESSENGER_PROJECT_CLIENT_ID || "";

const AMOMESSENGER_PROJECT_CLIENT_SECRET =
  process.env.AMOMESSENGER_PROJECT_CLIENT_SECRET || "";

const AMOMESSENGER_PROJECT_REDIRECT_URI =
  process.env.AMOMESSENGER_PROJECT_REDIRECT_URI ||
  "https://amobot-cpck.onrender.com/oauth/amomessenger/project/callback";

// id.amo.tm требует параметр scope в ссылке авторизации. Точный набор
// разрешённых значений зависит от того, какие права выданы конкретному
// приложению в личном кабинете developers.amo.tm — поэтому значение
// берётся из переменной окружения, а не зашивается в код. Несколько
// scope через пробел, как и предполагает OAuth2 (RFC 6749).
const AMOMESSENGER_PROJECT_SCOPE = process.env.AMOMESSENGER_PROJECT_SCOPE || "";

// Условный идентификатор бота — используется только в логах/отладке.
// Физическое разделение от бота инженеров обеспечивается отдельным
// webhook-маршрутом (/webhook/project) и отдельными объектами состояния
// в этом модуле, а не строковым префиксом ключей.
const BOT_ID = "project";

const DEFAULT_DESIGNER_NAME =
  process.env.DESIGNER_DEFAULT_NAME || "Субботин Дмитрий";

const NO_DESIGNER_VALUE = "Без проектировщика";

// --- Поля amoCRM (общие для инженерного бота значения полей переданы
//     через ctx там, где это те же самые поля; здесь только то, что
//     специфично для проектировщиков) ---

const DESIGNER_FIELD_ID = 211889; // "Проектировщик" (список)
const ENGINEER_FIELD_ID = 203849; // "Инженер"
const CONTRACT_NUMBER_FIELD_ID = 412776; // "№ Дог/Зам. листа"
const PRODUCT_FIELD_ID = 172572; // "Продукт"
const ADDRESS_FIELD_ID = 175412; // "Адрес объекта"
const ENGINEER_COMMENT_FIELD_ID = 555098; // "Комментарий инженера"
const ZRPO_COMMENT_FIELD_ID = 555424; // "Комментарий ЗРПО"
const REPORTS_LINK_FIELD_ID = 555436; // "Отчеты и проекты" (ссылка на общую папку)
const DESIGNER_COMMENT_FIELD_ID = 554526; // "Комментарий проектировщика"
const CONTACT_EMAIL_FIELD_ID = 141995; // "Email рабочий" (контакт)

const PROJECT_APPROVAL_STATUS_FIELD_ID = 543252; // "Согласование проекта"
const PROJECT_APPROVAL_DATE_FIELD_ID = 555100; // "Дата согласования проекта"
const CUT_TYPE_FIELD_ID = 555102; // "Раскрой"

const APPROVAL_DWG_FIELD_ID = 543248; // Проект для согласования: dwg/zip/sat
const APPROVAL_PDF_FIELD_ID = 543250; // Проект для согласования: pdf

const PRODUCTION_DWG_FIELD_ID = 543266; // Проект в производство: dwg/zip/sat
const PRODUCTION_PDF_FIELD_ID = 543268; // Проект в производство: pdf
const PRODUCTION_DXF_FIELD_ID = 543270; // Проект в производство: dxf
const PRODUCTION_EXCEL_FIELD_ID = 552176; // Проект в производство: excel

const PAYMENT_FIELDS = [
  { valueId: 184096, dateId: 430511 },
  { valueId: 553364, dateId: 430513 },
  { valueId: 418442, dateId: 430515 },
  { valueId: 551104, dateId: 440095 }
];

// Воронки, в которых загрузка файлов идёт последовательно (без выбора
// формата) — "Металл" и "Дерево". Во всех остальных воронках (включая
// "Рекламацию" — она отдельно не проверяется, а просто не входит в этот
// список) пользователь сам выбирает, какой файл загрузить.
const PIPELINE_METAL_ID = 207259;
const PIPELINE_WOOD_ID = 585508;

// --- Типы задач проектировщика ---

const DRAFT_TASK_TYPE_ID = 2867025; // Подг.черн.пр.(п)
const CLEAN_TASK_TYPE_ID = 2867029; // Подг.чист.пр.(п)
const CLIENT_CORRECTION_TASK_TYPE_ID = 2867033; // Правки клиент(п)
const SHOP_CORRECTION_TASK_TYPE_ID = 3002893; // ✏️Правки цех(п)
const SHOP_PROJECT_TASK_TYPE_ID = 2867037; // Подг.пр.в цех(п)

const DESIGNER_TASK_TYPE_IDS = [
  DRAFT_TASK_TYPE_ID,
  CLEAN_TASK_TYPE_ID,
  CLIENT_CORRECTION_TASK_TYPE_ID,
  SHOP_CORRECTION_TASK_TYPE_ID,
  SHOP_PROJECT_TASK_TYPE_ID
];

// Окно (в днях) для раздела "Задачи на сегодня" в ежедневной рассылке —
// см. ТЗ п.6 ("до конца следующего дня" / "до конца 3-го дня").
const DAILY_WINDOW_DAYS = {
  [DRAFT_TASK_TYPE_ID]: 1,
  [CLEAN_TASK_TYPE_ID]: 1,
  [CLIENT_CORRECTION_TASK_TYPE_ID]: 1,
  [SHOP_CORRECTION_TASK_TYPE_ID]: 1,
  [SHOP_PROJECT_TASK_TYPE_ID]: 3
};

// --- Типы загружаемых файлов (единая конфигурация для всех сценариев) ---

const FILE_TYPE_CONFIGS = {
  approvalDwg: {
    extensions: ["dwg", "zip", "sat"],
    fieldId: APPROVAL_DWG_FIELD_ID,
    folderKey: "approvalPath",
    defaultExtension: "dwg",
    promptText: "Загрузите проект (.dwg/.zip/.sat)",
    noteLabel: ".dwg/.zip/.sat для согласования",
    // buttonLabel используется только в "menu"-режиме (Внести правки в
    // проект клиента) — в "sequential"-режиме (черновой/чистовой проект)
    // не задействуется, там свой единственный "Перейти к загрузке проекта".
    buttonLabel: "Проект для согласования .dwg/.zip/.sat"
  },
  approvalPdf: {
    extensions: ["pdf"],
    fieldId: APPROVAL_PDF_FIELD_ID,
    folderKey: "approvalPath",
    defaultExtension: "pdf",
    promptText: "Загрузите PDF",
    noteLabel: ".pdf для согласования",
    buttonLabel: "Проект для согласования .pdf"
  },
  productionDwg: {
    extensions: ["dwg", "zip", "sat"],
    fieldId: PRODUCTION_DWG_FIELD_ID,
    folderKey: "productionPath",
    defaultExtension: "dwg",
    promptText: "Загрузите проект в производство (.dwg/.zip/.sat)",
    noteLabel: ".dwg/.zip/.sat в производство",
    buttonLabel: "Проект в производство .dwg/.zip/.sat"
  },
  productionPdf: {
    extensions: ["pdf"],
    fieldId: PRODUCTION_PDF_FIELD_ID,
    folderKey: "productionPath",
    defaultExtension: "pdf",
    promptText: "Загрузите PDF в производство",
    noteLabel: ".pdf в производство",
    buttonLabel: "Проект в производство .pdf"
  },
  productionDxf: {
    extensions: ["dxf"],
    fieldId: PRODUCTION_DXF_FIELD_ID,
    folderKey: "productionPath",
    defaultExtension: "dxf",
    promptText: "Загрузите .dxf",
    noteLabel: ".dxf в производство",
    buttonLabel: "Загрузить .dxf (раскрой)",
    needsCutName: true
  },
  productionExcel: {
    extensions: ["xlsx"],
    fieldId: PRODUCTION_EXCEL_FIELD_ID,
    folderKey: "productionPath",
    defaultExtension: "xlsx",
    promptText: "Загрузите excel",
    noteLabel: "excel",
    buttonLabel: "Загрузить excel"
  }
};

// --- Типы задач: какие кнопки/поля/результаты им соответствуют ---

// pipelineDependent: true — режим загрузки (последовательно/с выбором)
// зависит от воронки сделки (см. getEffectiveListMode): "Металл"/"Дерево" —
// последовательная загрузка без выбора, любая другая воронка — выбор
// формата вручную. Без этого флага (SHOP_CORRECTION) воронка не проверяется,
// всегда используется выбор формата.
const TASK_TYPE_CONFIG = {
  [DRAFT_TASK_TYPE_ID]: {
    label: "Подготовить черновой проект",
    pipelineDependent: true,
    extended: false,
    completeResult: "Проект готов",
    sequenceKeys: ["approvalDwg", "approvalPdf"],
    menuKeys: ["approvalDwg", "approvalPdf"],
    specialResults: ["Недостаточно данных", "Нереализуемо"],
    requireAllForFinish: false
  },
  [CLEAN_TASK_TYPE_ID]: {
    label: "Подготовить чистовой проект",
    pipelineDependent: true,
    extended: false,
    completeResult: "Проект готов",
    sequenceKeys: ["approvalDwg", "approvalPdf"],
    menuKeys: ["approvalDwg", "approvalPdf"],
    specialResults: ["Недостаточно данных", "Нереализуемо"],
    requireAllForFinish: false
  },
  [CLIENT_CORRECTION_TASK_TYPE_ID]: {
    label: "Внести правки в проект клиента",
    pipelineDependent: true,
    extended: false,
    completeResult: "Правки внесены",
    // Как подтвердил заказчик: эта задача пишет в "Проект для согласования"
    // (543248/543250), а не в "Проект в производство" — раньше здесь
    // ошибочно использовались productionDwg/productionPdf.
    sequenceKeys: ["approvalDwg", "approvalPdf"],
    menuKeys: ["approvalDwg", "approvalPdf"],
    specialResults: ["Не хватает информации", "Нереализуемо"],
    requireAllForFinish: false
  },
  [SHOP_CORRECTION_TASK_TYPE_ID]: {
    label: "Внести правки в проект для цеха",
    extended: true,
    completeResult: "Правки внесены",
    menuKeys: ["productionDwg", "productionPdf", "productionDxf", "productionExcel"],
    specialResults: ["Недостаточно данных", "Нереализуемо", "Проект не согласован"],
    requireAllForFinish: false
  },
  [SHOP_PROJECT_TASK_TYPE_ID]: {
    label: "Подготовить проект для цеха",
    pipelineDependent: true,
    extended: true,
    completeResult: "Проект готов",
    // dwg и pdf грузятся последовательно и полностью автоматически в обеих
    // "последовательных" воронках. Дальше сценарии расходятся:
    // - "Металл" (metalTailKeys): та же автоматика без единой кнопки едет
    //   дальше через dxf (с запросом "Раскрой") и excel и сама завершает
    //   задачу — см. startSequentialUpload/processUploadBatch.
    // - "Дерево" (woodDecision): dxf не обязателен, поэтому вместо
    //   автопродолжения пользователю задаётся один явный вопрос с двумя
    //   кнопками, и в зависимости от ответа последовательность
    //   возобновляется либо с dxf, либо сразу с excel (тот же сценарий,
    //   что и у "Металла", просто с другой точки входа).
    // В остальных воронках (getEffectiveListMode === "menu") действует
    // обычный выбор формата из menuKeys.
    sequenceKeys: ["productionDwg", "productionPdf"],
    metalTailKeys: ["productionDxf", "productionExcel"],
    woodDecision: {
      question: 'Нужна ли загрузка файла .dxf?',
      options: [
        { label: "Перейти к загрузке .dxf", tailKeys: ["productionDxf", "productionExcel"] },
        { label: "Перейти к загрузке excel", tailKeys: ["productionExcel"] }
      ]
    },
    menuKeys: ["productionDwg", "productionPdf", "productionDxf", "productionExcel"],
    specialResults: ["Нет предоплаты", "Не хватает информации", "Проект не согласован"],
    requireAllForFinish: true,
    requiredKeys: ["productionDwg", "productionPdf"]
  }
};

// Режим загрузки для конкретной сделки: "sequential" (без выбора, только
// для воронок "Металл"/"Дерево") или "menu" (выбор формата — всё остальное).
function getEffectiveListMode(config, item) {
  if (!config.pipelineDependent) {
    return "menu";
  }

  const isSequentialPipeline =
    item.pipeline_id === PIPELINE_METAL_ID || item.pipeline_id === PIPELINE_WOOD_ID;

  return isSequentialPipeline ? "sequential" : "menu";
}

// --- Главное меню ---
// Кнопок больше нет (см. пояснение к изменению): "главное меню" — это
// сразу список всех открытых задач проектировщика, как раньше делала
// кнопка "Все задачи".

// ============================================================
// 2. ТОКЕНЫ amoMessenger (бот проектировщиков) + Redis
// ============================================================

let projectAccessToken = process.env.AMOMESSENGER_PROJECT_ACCESS_TOKEN || "";
let projectRefreshToken = process.env.AMOMESSENGER_PROJECT_REFRESH_TOKEN || "";

async function saveProjectTokensToRedis(ctx) {
  if (!projectAccessToken || !projectRefreshToken) {
    return;
  }

  await ctx.redisRequest(["SET", "amomessenger_project_access_token", projectAccessToken]);
  await ctx.redisRequest(["SET", "amomessenger_project_refresh_token", projectRefreshToken]);

  console.log("[Бот проектировщиков] Токены amoMessenger сохранены в Redis.");
}

async function loadProjectTokensFromRedis(ctx) {
  try {
    const accessResponse = await ctx.redisRequest(["GET", "amomessenger_project_access_token"]);
    const refreshResponse = await ctx.redisRequest(["GET", "amomessenger_project_refresh_token"]);

    if (accessResponse.result && refreshResponse.result) {
      projectAccessToken = accessResponse.result;
      projectRefreshToken = refreshResponse.result;

      console.log("[Бот проектировщиков] Токены amoMessenger загружены из Redis.");
    } else {
      console.log("[Бот проектировщиков] В Redis пока нет токенов amoMessenger.");
    }
  } catch (error) {
    console.error(
      "[Бот проектировщиков] Ошибка загрузки токенов amoMessenger из Redis:",
      error.message
    );
  }
}

async function refreshProjectMessengerToken(ctx) {
  if (!projectRefreshToken) {
    throw new Error("Refresh Token бота проектировщиков не найден");
  }

  const response = await axios.post(
    "https://id.amo.tm/oauth2/access_token",
    {
      grant_type: "refresh_token",
      client_id: AMOMESSENGER_PROJECT_CLIENT_ID,
      client_secret: AMOMESSENGER_PROJECT_CLIENT_SECRET,
      refresh_token: projectRefreshToken,
      redirect_uri: AMOMESSENGER_PROJECT_REDIRECT_URI
    },
    { headers: { "Content-Type": "application/json" }, timeout: 30000 }
  );

  projectAccessToken = response.data.access_token;

  if (response.data.refresh_token) {
    projectRefreshToken = response.data.refresh_token;
  }

  await saveProjectTokensToRedis(ctx);

  console.log("[Бот проектировщиков] Токен amoMessenger обновлён и сохранён в Redis.");

  return projectAccessToken;
}

// ============================================================
// 3. amoMessenger API (бот проектировщиков)
// ============================================================

async function getProjectAmoMessengerUserName(ctx, userId) {
  if (!userId) {
    return "";
  }

  const doRequest = () =>
    axios.get("https://api.amo.tm/v1.3/users", {
      params: { "user_id[]": userId },
      headers: {
        Authorization: `Bearer ${projectAccessToken}`,
        "Content-Type": "application/json"
      },
      timeout: 30000,
      validateStatus: () => true
    });

  try {
    let response = await doRequest();

    if (response.status === 401 || response.status === 403) {
      await refreshProjectMessengerToken(ctx);
      response = await doRequest();
    }

    const items = response.data?._embedded?.items || [];

    if (!Array.isArray(items) || items.length === 0) {
      return "";
    }

    const user = items.find((item) => String(item.id) === String(userId)) || items[0];

    return String(user?.name || "").trim();
  } catch (error) {
    console.error(
      "[Бот проектировщиков] Ошибка получения имени пользователя amoMessenger:",
      error.response?.status || error.message
    );

    return "";
  }
}

async function sendProjectDirectMessage(ctx, directId, text, buttons, options) {
  if (!projectAccessToken) {
    throw new Error("Токен amoMessenger бота проектировщиков не найден");
  }

  const url = `https://api.amo.tm/v1.3/direct/${directId}/sendMessage`;

  const body = { text };

  // По умолчанию formatting_mode = "plain" — текст (в т.ч. с * _ ~ | и
  // обратными кавычками из пользовательских комментариев) отправляется как
  // есть, без интерпретации разметки. Включаем "md" только там, где реально
  // нужна разметка (см. вызовы с options.markdown), чтобы не ловить
  // случайную интерпретацию спецсимволов в чужом тексте (комментарии и т.п.).
  if (options && options.markdown) {
    body.formatting_mode = "md";
  }

  if (buttons && buttons.length > 0) {
    body.reply_markup = {
      inline_keyboard: { buttons: buttons.map((buttonText) => ({ text: buttonText })) }
    };
  }

  const doRequest = () =>
    axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${projectAccessToken}`,
        "Content-Type": "application/json"
      },
      timeout: 30000,
      validateStatus: () => true
    });

  let response = await doRequest();

  if (response.status === 401 || response.status === 403) {
    await refreshProjectMessengerToken(ctx);
    response = await doRequest();
  }

  if (response.status >= 400) {
    throw new Error(`amoMessenger (проектировщики) DIRECT HTTP ${response.status}`);
  }

  return response;
}

function wrapSend(userKey, rawSend) {
  return async (text, buttons, options) => {
    const result = await rawSend(text, buttons, options);

    designerLastBotMessage[userKey] = { text, buttons: buttons || null };

    return result;
  };
}

// ============================================================
// 4. РЕЕСТР ЗАРЕГИСТРИРОВАННЫХ ПРОЕКТИРОВЩИКОВ
// ============================================================
// "Зарегистрированный" проектировщик — тот, кто хотя бы раз написал боту
// (см. ТЗ п.6 "каждому зарегистрированному проектировщику"). Реестр
// хранит сопоставление amoMessenger user_id -> {directId, name}, чтобы
// бот мог проактивно писать пользователю (ежедневная рассылка, уведомление
// о новой задаче), а не только отвечать на входящие сообщения. Хранится
// отдельно от состояния/токенов бота инженеров (ТЗ п.3.3).

let registry = {};
let registryLoaded = false;
let registryDirty = false;

async function loadRegistry(ctx) {
  try {
    const response = await ctx.redisRequest(["GET", "amomessenger_project_registry"]);

    if (response.result) {
      registry = JSON.parse(response.result);
    }
  } catch (error) {
    console.error("[Бот проектировщиков] Ошибка загрузки реестра пользователей:", error.message);
  }

  registryLoaded = true;
}

async function flushRegistry(ctx) {
  if (!registryDirty) {
    return;
  }

  registryDirty = false;

  try {
    await ctx.redisRequest(["SET", "amomessenger_project_registry", JSON.stringify(registry)]);
  } catch (error) {
    console.error("[Бот проектировщиков] Ошибка сохранения реестра пользователей:", error.message);
  }
}

async function touchRegistry(userKey, data) {
  if (!userKey) {
    return;
  }

  const existing = registry[userKey];

  if (existing && existing.directId === data.directId && existing.name === data.name) {
    return;
  }

  registry[userKey] = {
    userId: userKey,
    directId: data.directId || (existing && existing.directId) || "",
    name: data.name || (existing && existing.name) || "",
    updatedAt: Date.now()
  };

  registryDirty = true;
}

// ============================================================
// 5. СОПОСТАВЛЕНИЕ ЗАДАЧИ И ПРОЕКТИРОВЩИКА (поле "Проектировщик")
// ============================================================

function normalizeDesignerNameForMatch(value) {
  const raw = String(value || "");
  const namePart = raw.split(",")[0];

  return namePart.trim().toLowerCase().replace(/\s+/g, " ");
}

function leadBelongsToDesigner(ctx, lead, designerName) {
  const values = ctx.getFieldValues(lead, DESIGNER_FIELD_ID);
  const normalizedDesigner = normalizeDesignerNameForMatch(designerName);

  if (!values || values.length === 0 || !normalizedDesigner) {
    return false;
  }

  return values.some((raw) => {
    const text = String(raw || "").trim();

    if (text === NO_DESIGNER_VALUE) {
      return normalizedDesigner === normalizeDesignerNameForMatch(DEFAULT_DESIGNER_NAME);
    }

    return normalizeDesignerNameForMatch(text) === normalizedDesigner;
  });
}

// ============================================================
// 6. ПОИСК И ФОРМАТИРОВАНИЕ ЗАДАЧ
// ============================================================

async function loadOpenDesignerTasksOfType(ctx, taskTypeId) {
  return ctx.loadAllTasksPaginated(
    { "filter[task_type][0]": taskTypeId, "filter[is_completed]": 0 },
    { verbose: false, errorLabel: `project-${taskTypeId}` }
  );
}

async function buildDesignerTaskItem(ctx, task, lead) {
  let contactName = "";
  let contactPhones = [];
  let contactEmail = "";

  const mainContactId = ctx.getMainContactId(lead);

  if (mainContactId) {
    const contact = await ctx.getContact(mainContactId);

    if (contact) {
      contactName = contact.name || "";
      contactPhones = ctx.getContactPhones(contact);
      contactEmail = ctx.getFieldValueJoined(contact, CONTACT_EMAIL_FIELD_ID);
    }
  }

  const responsibleName = await ctx.getUserName(lead.responsible_user_id);

  const payments = PAYMENT_FIELDS.map((p, idx) => ({
    n: idx + 1,
    amount: ctx.getFieldValueJoined(lead, p.valueId),
    date: ctx.formatDateFieldValue(lead, p.dateId)
  })).filter((p) => p.amount || p.date);

  return {
    task_id: Number(task.id),
    lead_id: Number(task.entity_id),
    task_type_id: Number(task.task_type_id),
    complete_till: task.complete_till,
    pipeline_id: lead.pipeline_id !== undefined ? Number(lead.pipeline_id) : null,
    lead_link: `https://${ctx.AMOCRM_SUBDOMAIN}.amocrm.ru/leads/detail/${task.entity_id}`,
    engineer: ctx.getFieldValueJoined(lead, ENGINEER_FIELD_ID),
    responsible_name: responsibleName,
    contact_name: contactName,
    contact_phones: contactPhones.join(", "),
    contact_email: contactEmail,
    contract_number: ctx.getFieldValueJoined(lead, CONTRACT_NUMBER_FIELD_ID),
    product: ctx.getFieldValueJoined(lead, PRODUCT_FIELD_ID),
    budget: lead.price !== undefined && lead.price !== null ? String(lead.price) : "",
    address: ctx.getFieldValueJoined(lead, ADDRESS_FIELD_ID),
    engineer_comment: ctx.getFieldValueJoined(lead, ENGINEER_COMMENT_FIELD_ID),
    zrpo_comment: ctx.getFieldValueJoined(lead, ZRPO_COMMENT_FIELD_ID),
    approval_status: ctx.getFieldValueJoined(lead, PROJECT_APPROVAL_STATUS_FIELD_ID),
    approval_date: ctx.formatDateFieldValue(lead, PROJECT_APPROVAL_DATE_FIELD_ID),
    reports_link: ctx.getFieldValueJoined(lead, REPORTS_LINK_FIELD_ID),
    payments
  };
}

function buildLightDesignerItem(ctx, task, lead) {
  return {
    task_id: Number(task.id),
    lead_id: Number(task.entity_id),
    task_type_id: Number(task.task_type_id),
    complete_till: task.complete_till,
    lead_link: `https://${ctx.AMOCRM_SUBDOMAIN}.amocrm.ru/leads/detail/${task.entity_id}`,
    engineer: ctx.getFieldValueJoined(lead, ENGINEER_FIELD_ID),
    contract_number: ctx.getFieldValueJoined(lead, CONTRACT_NUMBER_FIELD_ID),
    product: ctx.getFieldValueJoined(lead, PRODUCT_FIELD_ID),
    budget: lead.price !== undefined && lead.price !== null ? String(lead.price) : "",
    address: ctx.getFieldValueJoined(lead, ADDRESS_FIELD_ID),
    reports_link: ctx.getFieldValueJoined(lead, REPORTS_LINK_FIELD_ID)
  };
}

async function findDesignerTasksOfType(ctx, taskTypeId, designerName) {
  const tasks = await loadOpenDesignerTasksOfType(ctx, taskTypeId);

  const results = [];

  for (const task of tasks) {
    if (!task.entity_id || task.entity_type !== "leads" || task.is_completed !== false) {
      continue;
    }

    const lead = await ctx.getLead(task.entity_id);

    if (!lead || !leadBelongsToDesigner(ctx, lead, designerName)) {
      continue;
    }

    results.push(await buildDesignerTaskItem(ctx, task, lead));
  }

  return results;
}

async function loadAllDesignerTasksWithLeads(ctx) {
  const result = [];

  for (const taskTypeId of DESIGNER_TASK_TYPE_IDS) {
    const tasks = await loadOpenDesignerTasksOfType(ctx, taskTypeId);

    for (const task of tasks) {
      if (!task.entity_id || task.entity_type !== "leads" || task.is_completed !== false) {
        continue;
      }

      const lead = await ctx.getLead(task.entity_id);

      if (!lead) {
        continue;
      }

      result.push({ task, lead });
    }
  }

  return result;
}

// Форматирование с Markdown-разметкой amoMessenger (**жирный**, *курсив*,
// `моноширинный`, [именованная ссылка](url)) — работает только если
// сообщение отправлено с options.markdown = true (formatting_mode: "md").
// Значения из amoCRM (свободный текст) экранируются через
// ctx.sanitizeForMarkdown, чтобы случайный "*"/"_"/"~"/"|"/"`" в чужом
// тексте не сломал разметку остального сообщения (экранирования сама
// разметка не поддерживает).
function mdField(ctx, label, value) {
  return `*${label}:* **${ctx.sanitizeForMarkdown(value || "—")}**`;
}

function mdMonoField(ctx, label, value) {
  return `*${label}:* \`${ctx.sanitizeForMarkdown(value || "—")}\``;
}

function mdLink(label, url) {
  // Именованная ссылка "[текст](url)" на практике дублирует текст — похоже
  // на баг формата на стороне amoMessenger (см. пояснение в server.js).
  // Обычный "сырой" URL распознаётся и становится кликабельным сам, без
  // этого дефекта — используем его.
  return url ? `*${label}:* ${url}` : `*${label}:* —`;
}

// Короткая строка для списков (ежедневная рассылка, список задач одного типа) —
// показывать только заполненные поля (ТЗ п.6).
function formatDesignerListLine(ctx, item, index) {
  const parts = [];

  // Список может смешивать несколько типов задач (главное меню = список всех
  // задач, ежедневная рассылка) — без явного указания типа непонятно, что
  // именно нужно подготовить/поправить.
  const typeConfig = TASK_TYPE_CONFIG[item.task_type_id];

  if (typeConfig) parts.push(`Тип задачи: **${ctx.sanitizeForMarkdown(typeConfig.label)}**`);

  if (item.engineer) parts.push(`Инженер: ${item.engineer}`);
  if (item.contract_number) parts.push(`№ Дог/Зам. листа: ${item.contract_number}`);
  if (item.product) parts.push(`Продукт: ${item.product}`);
  if (item.budget) parts.push(`Бюджет сделки: ${item.budget}`);
  if (item.address) parts.push(`Адрес объекта: ${item.address}`);
  if (item.reports_link) parts.push(`Отчеты и проекты: ${item.reports_link}`);

  parts.push(`Ссылка на сделку: ${item.lead_link}`);

  return `${index + 1}. ${parts.join("; ")}\n\n`;
}

// Полная карточка задачи (ТЗ п.8-13) — все поля показываются всегда,
// "—" вместо пустых, как и в карточках бота инженеров.
function formatDesignerDetailCard(ctx, item, extended) {
  const typeConfig = TASK_TYPE_CONFIG[item.task_type_id];
  // Жирный шрифт работает только если в запросе sendMessage передан
  // formatting_mode: "md" (см. sendProjectDirectMessage, вызывается с
  // options.markdown = true в обоих местах, где используется эта карточка).
  // typeConfig.label — фиксированные строки без спецсимволов разметки,
  // оборачивать безопасно.
  const header = typeConfig ? `**Вам необходимо "${typeConfig.label}":**\n\n` : "";

  const lines = [
    mdField(ctx, "Инженер", item.engineer),
    mdField(ctx, "Ответственный за сделку", item.responsible_name),
    mdField(ctx, "Имя контакта", item.contact_name),
    mdField(ctx, "Телефон контакта", item.contact_phones),
    mdField(ctx, "Email контакта", item.contact_email),
    mdField(ctx, "№ Дог/Зам. листа", item.contract_number),
    mdField(ctx, "Продукт", item.product),
    mdField(ctx, "Бюджет сделки", item.budget),
    mdMonoField(ctx, "Адрес объекта", item.address),
    mdField(ctx, "Комментарий инженера", item.engineer_comment),
    mdField(ctx, "Комментарий ЗРПО", item.zrpo_comment)
  ];

  if (extended) {
    lines.push(mdField(ctx, "Согласование проекта", item.approval_status));
    lines.push(mdField(ctx, "Дата согласования проекта", item.approval_date));

    if (item.payments.length === 0) {
      lines.push("*Оплаты:* —");
    } else {
      item.payments.forEach((p) => {
        const label = `Оплата ${p.n}` + (p.date ? ` (дата: ${p.date})` : "");
        lines.push(mdField(ctx, label, p.amount));
      });
    }
  }

  lines.push(mdLink("Отчеты и проекты", item.reports_link));
  lines.push(mdLink("Ссылка на сделку", item.lead_link));

  return header + lines.join("\n");
}

// ============================================================
// 7. КНОПКИ (с привязкой к task_id — см. ТЗ п.19)
// ============================================================

function tagId(item) {
  // Предпочитаем номер договора (ТЗ п.19): он понятнее пользователю в
  // кнопке, чем технический task_id. Если номера договора нет — резервный
  // вариант с task_id, чтобы идентификатор всё равно оставался уникальным.
  return item.contract_number ? `№ ${item.contract_number}` : `задача ${item.task_id}`;
}

function parseAnyDesignerTag(text) {
  // Общий разбор "любого хвоста в скобках" — не завязан на конкретный
  // формат (номер договора или "задача N"), чтобы не ломаться при смене
  // формата идентификатора в tagId().
  const match = String(text || "").match(/\(([^()]+)\)\s*$/);

  return match ? match[1] : null;
}

const FINISH_UPLOAD_LABEL = "✅Завершить загрузку проекта";

// До нажатия "Перейти к загрузке проекта" (task.menuUploadStarted === false)
// видны только сам переход к загрузке и спецрезультаты — независимо от
// того, что будет дальше (последовательная загрузка или выбор формата,
// см. getEffectiveListMode/startUploadFlow). Кнопки конкретных файлов и
// "Завершить загрузку проекта" появляются, только когда task.menuUploadStarted
// стал true — это бывает только в настоящем menu-режиме (воронки без
// последовательной загрузки, см. startUploadFlow). В "sequential"-режиме
// ("Металл"/"Дерево") этот экран вообще не используется — там бот сам ведёт
// пользователя по шагам без выбора формата (см. startSequentialUpload,
// runSequentialUpload, askWoodDxfDecision в processUploadBatch).
function buildTaskSelectedButtons(ctx, config, task) {
  const item = task.item;
  const buttons = [];
  const tag = (label) => ctx.buildTaggedButton(label, tagId(item));

  const hasUploadedAny = Object.keys(task.uploadedKeys || {}).some((k) => task.uploadedKeys[k]);

  if (!task.menuUploadStarted) {
    buttons.push(tag("Перейти к загрузке проекта"));
  } else {
    for (const key of config.menuKeys) {
      buttons.push(tag(FILE_TYPE_CONFIGS[key].buttonLabel));
    }
  }

  for (const label of config.specialResults) {
    buttons.push(tag(label));
  }

  // "Завершить загрузку проекта" — последней кнопкой, и только после того,
  // как загружен хотя бы один файл.
  if (task.menuUploadStarted && hasUploadedAny) {
    buttons.push(tag(FINISH_UPLOAD_LABEL));
  }

  return buttons;
}

// ============================================================
// 8. ЯНДЕКС.ДИСК: пути и имена файлов проектировщика
// ============================================================
// Формат имени файла у проектировщиков отличается от формата бота
// инженеров (ТЗ п.15: "{№ Дог/Зам. листа}.pdf", повтор — "...(1).pdf",
// без пробела перед скобкой, без даты в имени) — поэтому здесь свои
// небольшие функции построения имени/номера, но сама загрузка и
// публикация ссылки выполняются через уже проверенные ydUploadFromUrlAndWait /
// ydGetFolderPublicUrl / ydEnsureFolder(Path) из ctx.

function sanitizeYandexSegment(value) {
  return String(value || "")
    .replace(/[#:+[\]]/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\//g, "-")
    .trim();
}

function buildDesignerFolderPaths(ctx, leadId) {
  const leadFolderPath = `${ctx.YANDEX_DISK_ROOT_FOLDER}/Сделка (id ${leadId})`;
  // "Проект для согласования"/"Проект в производство" — подпапки внутри
  // "Отчеты и проекты", по аналогии с папками "Видео"/"Договор" у бота
  // инженеров, а не напрямую в папке сделки.
  const reportsPath = `${leadFolderPath}/Отчеты и проекты`;

  return {
    leadFolderPath,
    reportsPath,
    approvalPath: `${reportsPath}/Проект для согласования`,
    productionPath: `${reportsPath}/Проект в производство`
  };
}

async function ensureDesignerTargetFolder(ctx, basePath, targetPath) {
  await ctx.ydEnsureFolderPath(basePath);
  await ctx.ydEnsureFolder(targetPath);
}

function buildDesignerFileName(baseName, number, extension) {
  const suffix = Number(number) > 0 ? `(${Number(number)})` : "";
  const ext = (extension && String(extension).trim()) || "dat";

  return `${baseName}${suffix}.${ext}`;
}

// Номер (1), (2)... нужен только при повторной загрузке файла ТОГО ЖЕ
// формата — dxf и pdf одного договора должны называться одинаково (без
// номера), поэтому существующие файлы ищутся строго с тем же расширением,
// каким сейчас загружается файл, а не с любым.
async function getNextDesignerFileNumber(ctx, folderPath, baseName, extension) {
  const response = await axios.get("https://cloud-api.yandex.net/v1/disk/resources", {
    params: { path: folderPath, limit: 1000, fields: "_embedded.items.name" },
    headers: ctx.yandexDiskHeaders(),
    timeout: 30000,
    validateStatus: () => true
  });

  if (response.status !== 200) {
    throw new Error(
      `Яндекс.Диск: не удалось получить список файлов "${folderPath}". HTTP ${response.status}`
    );
  }

  const items =
    response.data && response.data._embedded && Array.isArray(response.data._embedded.items)
      ? response.data._embedded.items
      : [];

  const escapedBase = ctx.escapeRegExp(baseName);
  const escapedExt = ctx.escapeRegExp(extension);
  const pattern = new RegExp(`^${escapedBase}(?:\\((\\d+)\\))?\\.${escapedExt}$`, "i");

  let maxNumber = -1;

  for (const item of items) {
    const name = item && item.name ? String(item.name) : "";
    const match = name.match(pattern);

    if (!match) {
      continue;
    }

    const number = match[1] === undefined ? 0 : Number(match[1]);

    if (!Number.isNaN(number)) {
      maxNumber = Math.max(maxNumber, number);
    }
  }

  return maxNumber + 1;
}

function classifyByExtension(ctx, urls, allowedExtensions) {
  const validFiles = [];
  const invalidFiles = [];

  // Если у формата ровно одно разрешённое расширение (approvalPdf,
  // productionPdf, productionDxf, productionExcel) — проверять/угадывать
  // по ссылке нечего: бот и так ждёт на этом шаге ровно один конкретный
  // формат. Это важно, потому что amoMessenger для некоторых форматов
  // (замечено на .dxf) отдаёт ссылку на файл без расширения в пути или с
  // посторонним "хвостом" вместо реального расширения — getUrlExtension в
  // таком случае возвращает "" или значение, не совпадающее с ожидаемым, и
  // корректный файл ошибочно браковался. Раз формат всё равно только один
  // возможный — используем его напрямую, не полагаясь на ссылку.
  const singleExpectedExtension = allowedExtensions.length === 1 ? allowedExtensions[0] : null;

  for (const url of urls || []) {
    const extension = ctx.getUrlExtension(url);

    if (singleExpectedExtension) {
      validFiles.push({ url, extension: singleExpectedExtension });
      continue;
    }

    // Для форматов с несколькими вариантами (dwg/zip/sat) неопределённое
    // расширение (та же особенность ссылок amoMessenger) тоже не повод
    // отклонять файл — он сохранится с расширением по умолчанию (см.
    // fileConfig.defaultExtension в processUploadBatch). Отклоняем только
    // когда расширение определено И оно точно не из списка разрешённых.
    if (extension === "" || allowedExtensions.includes(extension)) {
      validFiles.push({ url, extension });
    } else {
      console.log(
        "[Бот проектировщиков] Файл отклонён по расширению:",
        JSON.stringify({ url, extension, allowedExtensions })
      );
      invalidFiles.push({ url, extension });
    }
  }

  return { validFiles, invalidFiles };
}

async function buildUploadNoteText(ctx, designerName, keys, uploadedKeys, uploadedLastPath) {
  const entries = [];

  for (const key of keys) {
    if (!uploadedKeys[key]) {
      continue;
    }

    const path = uploadedLastPath[key];

    if (!path) {
      continue;
    }

    try {
      const url = await ctx.ydGetFolderPublicUrl(path);

      entries.push(`${FILE_TYPE_CONFIGS[key].noteLabel}: ${url}`);
    } catch (error) {
      console.error(
        "[Бот проектировщиков] Не удалось получить ссылку на файл для примечания:",
        path,
        error.message
      );
    }
  }

  if (entries.length === 0) {
    return "";
  }

  return (
    `${designerName || "Пользователь"} загрузил проектную документацию:\n` +
    entries.map((line, i) => `${i + 1}) ${line}`).join("\n")
  );
}

// ============================================================
// 9. СОСТОЯНИЕ ПОЛЬЗОВАТЕЛЕЙ (отдельное от бота инженеров)
// ============================================================
// Явная машина состояний (ТЗ п.21): state.step принимает одно из значений
// MAIN_MENU / TASK_LIST / TASK_SELECTED / WAITING_COMMENT / WAITING_UPLOAD.
// Внутри WAITING_UPLOAD конкретный ожидаемый файл определяется
// state.upload.key (approvalDwg/approvalPdf/productionDwg/... — см.
// FILE_TYPE_CONFIGS), что соответствует детализации из ТЗ
// (WAITING_PROJECT_DWG/WAITING_PROJECT_PDF/... — конкретные названия
// в ТЗ помечены как условные).

const designerState = {};
const designerLastBotMessage = {};
const designerUploadQueue = {};
const designerUploadNoticeTimers = {};
const lastKnownDesignerName = {};

const UPLOAD_NOTICE_DEBOUNCE_MS = 1800;

function resetDesignerState(userKey, designerName) {
  cancelDesignerUploadNotice(userKey);

  designerState[userKey] = {
    step: "MAIN_MENU",
    designerName:
      designerName || (designerState[userKey] && designerState[userKey].designerName) || "",
    tasks: null,
    listTaskType: null,
    task: null,
    pendingComment: null,
    upload: null
  };
}

function cancelDesignerUploadNotice(userKey) {
  if (designerUploadNoticeTimers[userKey]) {
    clearTimeout(designerUploadNoticeTimers[userKey]);
    delete designerUploadNoticeTimers[userKey];
  }
}

function scheduleDesignerUploadNotice(userKey, fn) {
  cancelDesignerUploadNotice(userKey);

  designerUploadNoticeTimers[userKey] = setTimeout(async () => {
    delete designerUploadNoticeTimers[userKey];

    try {
      await fn();
    } catch (error) {
      console.error(
        "[Бот проектировщиков] Ошибка отправки отложенного уведомления о загрузке:",
        error.message
      );
    }
  }, UPLOAD_NOTICE_DEBOUNCE_MS);
}

// Очередь последовательной загрузки файлов одного пользователя (ТЗ п.22) —
// один файл обрабатывается за раз, следующий стартует после завершения
// предыдущего, состояние читается заново внутри воркера (без гонок).
async function enqueueDesignerUpload(userKey, workFn) {
  const previous = designerUploadQueue[userKey] || Promise.resolve();

  const current = previous.catch(() => {}).then(workFn);

  designerUploadQueue[userKey] = current;

  try {
    await current;
  } finally {
    if (designerUploadQueue[userKey] === current) {
      delete designerUploadQueue[userKey];
    }
  }
}

// ============================================================
// 10. ЗАГРУЗКА ФАЙЛОВ (общий "движок" для всех сценариев)
// ============================================================

async function processUploadBatch(ctx, state, userKey, imageUrls, send) {
  const upload = state.upload;
  const task = state.task;

  if (!upload || !task) {
    return;
  }

  const fileConfig = FILE_TYPE_CONFIGS[upload.key];

  const { validFiles } = classifyByExtension(ctx, imageUrls, fileConfig.extensions);

  if (validFiles.length === 0) {
    await send(`${state.designerName || "Пользователь"}, загрузите, пожалуйста, файл корректного формата.`);
    return;
  }

  cancelDesignerUploadNotice(userKey);

  const targetPath = upload.folders[fileConfig.folderKey];

  console.log(
    "[Бот проектировщиков] Загрузка файлов:",
    JSON.stringify({
      task_id: task.task_id,
      lead_id: task.lead_id,
      key: upload.key,
      filesCount: validFiles.length,
      targetPath
    })
  );

  try {
    await ensureDesignerTargetFolder(ctx, upload.folders.reportsPath, targetPath);
  } catch (error) {
    console.error("[Бот проектировщиков] Ошибка подготовки папки на Яндекс.Диске:", error.message);
    await send("❌ Не удалось подготовить папку на Яндекс.Диске. Подробности есть в логах Render.");
    return;
  }

  const baseName = fileConfig.needsCutName
    ? `${sanitizeYandexSegment(task.item.contract_number) || `Задача ${task.task_id}`}_${sanitizeYandexSegment(
        task.dxfCutValue
      )}`
    : sanitizeYandexSegment(task.item.contract_number) || `Задача ${task.task_id}`;

  let uploaded = 0;
  let lastPath = "";
  const uploadedPaths = [];

  for (const file of validFiles) {
    try {
      const extension = file.extension || fileConfig.defaultExtension;
      const nextNumber = await getNextDesignerFileNumber(ctx, targetPath, baseName, extension);
      const fileName = buildDesignerFileName(baseName, nextNumber, extension);
      const uploadedPath = `${targetPath}/${fileName}`;

      await ctx.ydUploadFromUrlAndWait(uploadedPath, file.url);

      uploaded++;
      lastPath = uploadedPath;
      uploadedPaths.push(uploadedPath);

      console.log("[Бот проектировщиков] Файл сохранён на Яндекс.Диске:", uploadedPath);
    } catch (error) {
      console.error(
        "[Бот проектировщиков] Ошибка загрузки файла на Яндекс.Диск:",
        error.message
      );
    }
  }

  if (uploaded === 0) {
    await send("❌ Не удалось сохранить файл на Яндекс.Диске. Попробуйте загрузить его ещё раз.");
    return;
  }

  task.uploadedKeys[upload.key] = true;
  task.uploadedLastPath = task.uploadedLastPath || {};
  task.uploadedLastPath[upload.key] = lastPath;

  // Копится на task (не на upload — в menu-режиме upload обнуляется сразу
  // после этой пачки, до срабатывания отложенного уведомления ниже), чтобы
  // при нескольких подряд идущих сообщениях со файлами ссылки не терялись
  // и не дублировались в уведомлении.
  task.noticeUploadedPaths = task.noticeUploadedPaths || [];
  task.noticeUploadedPaths.push(...uploadedPaths);

  try {
    const publicUrl = await ctx.ydGetFolderPublicUrl(lastPath);

    await ctx.updateLeadCustomFields(task.lead_id, { [fileConfig.fieldId]: publicUrl });
  } catch (error) {
    console.error("[Бот проектировщиков] Не удалось записать ссылку на файл в сделку:", error.message);
  }

  const config = TASK_TYPE_CONFIG[task.task_type_id];

  if (upload.mode === "sequential") {
    const keys = upload.sequenceKeys;
    const nextIndex = upload.sequenceIndex + 1;

    // В "sequential"-режиме уведомление не откладывается (шаги идут по
    // одному), поэтому ссылки на файлы этой самой пачки шлём сразу же —
    // по аналогии с ботом инженеров ("Ссылки на загруженные файлы: ...").
    const linksText = await ctx.buildUploadedFilesLinksText(task.noticeUploadedPaths);

    task.noticeUploadedPaths = [];

    if (nextIndex < keys.length) {
      upload.sequenceIndex = nextIndex;
      upload.key = keys[nextIndex];

      const receivedText = linksText
        ? `Файл получен (${uploaded}).\n\n${linksText}`
        : `Файл получен (${uploaded}).`;

      await send(receivedText);
      await promptForSequentialKey(state, send);
      return;
    }

    if (linksText) {
      await send(linksText);
    }

    // "base"-цепочка (dwg/pdf, а в "Металле" сразу и dxf/excel) закончена.
    // В "Дереве" dxf не обязателен — вместо автозавершения задаём один
    // явный вопрос и по ответу либо продолжаем той же автоматикой с dxf,
    // либо сразу с excel (см. woodDecision в TASK_TYPE_CONFIG). Во всех
    // остальных случаях (Металл, либо это уже "tail"-цепочка после ответа
    // на этот вопрос) последовательность полностью пройдена — завершаем
    // задачу автоматически, без отдельной кнопки.
    const isPendingWoodDecision =
      upload.stage === "base" &&
      task.item.pipeline_id === PIPELINE_WOOD_ID &&
      config.woodDecision;

    if (isPendingWoodDecision) {
      await askWoodDxfDecision(ctx, state, send);
      return;
    }

    await finalizeDesignerTask(ctx, state, userKey, config.menuKeys, config.completeResult, send);
    return;
  }

  // menu-режим: после успешной пачки файлов снова показываем меню задачи
  state.upload = null;

  scheduleDesignerUploadNotice(userKey, async () => {
    const latestState = designerState[userKey];

    if (!latestState || !latestState.task) {
      return;
    }

    const cfg = TASK_TYPE_CONFIG[latestState.task.task_type_id];
    const paths = latestState.task.noticeUploadedPaths || [];

    latestState.task.noticeUploadedPaths = [];

    const linksText = await ctx.buildUploadedFilesLinksText(paths);

    const receivedText = linksText ? `Файл(ы) получено.\n\n${linksText}` : "Файл(ы) получено.";

    await send(receivedText);
    await send(
      "Когда закончите — выберите действие:",
      buildTaskSelectedButtons(ctx, cfg, latestState.task)
    );
  });
}

async function finalizeDesignerTask(ctx, state, userKey, uploadedKeysOrder, resultCaption, send) {
  const task = state.task;

  console.log(
    "[Бот проектировщиков] Завершение задачи в Sensei:",
    JSON.stringify({ task_id: task.task_id, lead_id: task.lead_id, resultCaption })
  );

  try {
    await ctx.senseiCompleteTask(task.lead_id, task.task_id, resultCaption);
  } catch (error) {
    console.error("[Бот проектировщиков] Ошибка завершения задачи в Sensei:", error.message);
    await send(
      "❌ Не удалось завершить задачу в Sensei. Подробности есть в логах Render. Попробуйте ещё раз."
    );
    return;
  }

  try {
    const noteText = await buildUploadNoteText(
      ctx,
      state.designerName,
      uploadedKeysOrder,
      task.uploadedKeys,
      task.uploadedLastPath || {}
    );

    if (noteText) {
      await ctx.addLeadNote(task.lead_id, noteText);
    }
  } catch (error) {
    console.error("[Бот проектировщиков] Не удалось добавить примечание о загрузке:", error.message);
  }

  await send(`✅ Задача завершена с результатом "${resultCaption}".`);

  state.task = null;
  state.upload = null;

  // Сразу ищем все открытые задачи проектировщика, а не только задачи
  // только что завершённого типа.
  await showDesignerTaskList(ctx, state, userKey, null, send);
}

// ============================================================
// 11. СЦЕНАРИИ TASK_SELECTED (переход к загрузке / завершение / спецрезультаты)
// ============================================================

// Вызывается только когда getEffectiveListMode уже определил "sequential"
// (воронка "Металл" или "Дерево") — здесь пипелайн повторно не проверяется.
async function startSequentialUpload(ctx, state, userKey, send) {
  const task = state.task;
  const config = TASK_TYPE_CONFIG[task.task_type_id];

  // В "Металле" сразу продолжаем той же автоматикой в dxf/excel (см.
  // metalTailKeys) — там, в отличие от "Дерева", dxf обязателен, поэтому
  // отдельный вопрос не нужен.
  const isMetal = task.item.pipeline_id === PIPELINE_METAL_ID;
  const keys =
    isMetal && config.metalTailKeys
      ? [...config.sequenceKeys, ...config.metalTailKeys]
      : config.sequenceKeys;

  await runSequentialUpload(ctx, state, keys, "base", send);
}

// Запускает (или возобновляет) автоматическую последовательную загрузку
// файлов без выбора формата — используется и для базовой цепочки
// (dwg/pdf, см. startSequentialUpload), и для "хвоста" после ответа на
// вопрос о dxf в "Дереве" (см. askWoodDxfDecision).
async function runSequentialUpload(ctx, state, keys, stage, send) {
  const task = state.task;
  const folders = buildDesignerFolderPaths(ctx, task.lead_id);

  state.upload = {
    mode: "sequential",
    sequenceKeys: keys,
    sequenceIndex: 0,
    key: keys[0],
    folders,
    stage
  };
  state.step = "WAITING_UPLOAD";

  await promptForSequentialKey(state, send);
}

// Просит либо значение "Раскрой" (для форматов с needsCutName — сейчас это
// только dxf, если оно ещё не указано в рамках этой задачи), либо сразу
// файл нужного формата — используется на каждом шаге последовательной
// загрузки.
async function promptForSequentialKey(state, send) {
  const upload = state.upload;
  const task = state.task;
  const fileConfig = FILE_TYPE_CONFIGS[upload.key];

  if (fileConfig.needsCutName && !task.dxfCutValue) {
    upload.awaitingCutName = true;
    await send("Укажите значение «Раскрой»");
    return;
  }

  await send(fileConfig.promptText);
}

// "Дерево": dxf не обязателен, поэтому вместо автопродолжения задаём один
// явный вопрос; по ответу возобновляем ту же автоматику либо с dxf, либо
// сразу с excel (config.woodDecision.options[].tailKeys).
async function askWoodDxfDecision(ctx, state, send) {
  const task = state.task;
  const config = TASK_TYPE_CONFIG[task.task_type_id];
  const decision = config.woodDecision;

  state.upload = null;
  state.step = "TASK_SELECTED";
  task.pendingWoodDecision = decision;

  const tag = (label) => ctx.buildTaggedButton(label, tagId(task.item));
  const buttons = decision.options.map((option) => tag(option.label));

  await send(decision.question, buttons);
}

async function startMenuUpload(ctx, state, userKey, key, send) {
  const task = state.task;
  const fileConfig = FILE_TYPE_CONFIGS[key];
  const folders = buildDesignerFolderPaths(ctx, task.lead_id);

  state.upload = {
    mode: "single",
    key,
    folders,
    awaitingCutName: !!fileConfig.needsCutName && !task.dxfCutValue
  };
  state.step = "WAITING_UPLOAD";

  if (state.upload.awaitingCutName) {
    await send("Укажите значение «Раскрой»");
  } else {
    await send(fileConfig.promptText);
  }
}

async function finishMenuUpload(ctx, state, userKey, send) {
  const task = state.task;
  const config = TASK_TYPE_CONFIG[task.task_type_id];

  const hasAny = Object.keys(task.uploadedKeys).some((k) => task.uploadedKeys[k]);

  if (!hasAny) {
    await send(
      "Пока не получено ни одного файла. Загрузите хотя бы один файл, прежде чем завершить загрузку.",
      buildTaskSelectedButtons(ctx, config, task)
    );
    return;
  }

  if (config.requireAllForFinish) {
    const missing = (config.requiredKeys || []).filter((k) => !task.uploadedKeys[k]);

    if (missing.length > 0) {
      const missingLabels = missing.map((k) => FILE_TYPE_CONFIGS[k].buttonLabel).join(", ");

      await send(
        `Не хватает обязательных файлов: ${missingLabels}.`,
        buildTaskSelectedButtons(ctx, config, task)
      );
      return;
    }
  }

  await finalizeDesignerTask(ctx, state, userKey, config.menuKeys, config.completeResult, send);
}

async function handleTaskSelectedButtons(ctx, state, userKey, trimmedText, send) {
  const task = state.task;
  const config = TASK_TYPE_CONFIG[task.task_type_id];
  // Важно: тег считаем от task.item (там есть contract_number), а не от
  // самого task — у обёртки state.task своего contract_number нет, только
  // task_id, из-за чего сверка с кнопками (тоже помеченными от item) не
  // совпадала и любое нажатие ошибочно считалось "устаревшей кнопкой".
  const expectedTag = tagId(task.item);

  const anyTag = parseAnyDesignerTag(trimmedText);

  if (anyTag !== null && anyTag !== expectedTag) {
    await send(
      "⚠️ Эта задача уже обработана или больше недоступна. Пожалуйста, обновите список задач."
    );
    await send(
      formatDesignerDetailCard(ctx, task.item, config.extended),
      buildTaskSelectedButtons(ctx, config, task),
      { markdown: true }
    );
    return true;
  }

  for (const label of config.specialResults) {
    if (ctx.parseTaggedButton(trimmedText, label) === expectedTag) {
      state.pendingComment = { resultCaption: label };
      state.step = "WAITING_COMMENT";
      await send("Укажите комментарий");
      return true;
    }
  }

  // Вопрос "Нужна ли загрузка файла .dxf?" в "Дереве" (см. askWoodDxfDecision) —
  // единственное место, где для sequential-режима вообще есть выбор из
  // нескольких кнопок; после ответа последовательность продолжается сама.
  if (task.pendingWoodDecision) {
    const decision = task.pendingWoodDecision;

    for (const option of decision.options) {
      if (ctx.parseTaggedButton(trimmedText, option.label) === expectedTag) {
        task.pendingWoodDecision = null;
        await runSequentialUpload(ctx, state, option.tailKeys, "tail", send);
        return true;
      }
    }

    return false;
  }

  if (!task.menuUploadStarted) {
    if (ctx.parseTaggedButton(trimmedText, "Перейти к загрузке проекта") === expectedTag) {
      await startUploadFlow(ctx, state, userKey, send);
      return true;
    }

    return false;
  }

  for (const key of config.menuKeys) {
    const fileConfig = FILE_TYPE_CONFIGS[key];

    if (ctx.parseTaggedButton(trimmedText, fileConfig.buttonLabel) === expectedTag) {
      await startMenuUpload(ctx, state, userKey, key, send);
      return true;
    }
  }

  if (ctx.parseTaggedButton(trimmedText, FINISH_UPLOAD_LABEL) === expectedTag) {
    await finishMenuUpload(ctx, state, userKey, send);
    return true;
  }

  return false;
}

// По воронке сделки решает, как грузить файлы: последовательно без выбора
// ("Металл"/"Дерево") или через выбор формата (все остальные воронки,
// включая "Рекламацию" — она отдельно не проверяется).
async function startUploadFlow(ctx, state, userKey, send) {
  const task = state.task;
  const config = TASK_TYPE_CONFIG[task.task_type_id];
  const mode = getEffectiveListMode(config, task.item);

  if (mode === "sequential") {
    await startSequentialUpload(ctx, state, userKey, send);
    return;
  }

  task.menuUploadStarted = true;
  await send("Выберите, какой файл загрузить:", buildTaskSelectedButtons(ctx, config, task));
}

async function handlePendingComment(ctx, state, userKey, trimmedText, send) {
  const comment = trimmedText;
  const task = state.task;
  const pending = state.pendingComment;

  if (!comment) {
    await send("Комментарий не может быть пустым. Укажите комментарий");
    return;
  }

  try {
    await ctx.updateLeadCustomFields(task.lead_id, { [DESIGNER_COMMENT_FIELD_ID]: comment });
  } catch (error) {
    console.error(
      "[Бот проектировщиков] Не удалось записать комментарий в поле сделки:",
      error.message
    );
  }

  try {
    await ctx.addLeadNote(task.lead_id, comment);
  } catch (error) {
    console.error("[Бот проектировщиков] Не удалось добавить примечание с комментарием:", error.message);
  }

  console.log(
    "[Бот проектировщиков] Завершение задачи в Sensei (спецрезультат):",
    JSON.stringify({ task_id: task.task_id, lead_id: task.lead_id, resultCaption: pending.resultCaption })
  );

  try {
    await ctx.senseiCompleteTask(task.lead_id, task.task_id, pending.resultCaption);
  } catch (error) {
    console.error("[Бот проектировщиков] Ошибка завершения задачи в Sensei:", error.message);
    await send(
      "❌ Не удалось завершить задачу в Sensei. Подробности есть в логах Render. Попробуйте ещё раз."
    );
    return;
  }

  await send(`Текущая задача amoCRM закрыта с результатом "${pending.resultCaption}".`);

  state.task = null;
  state.pendingComment = null;
  state.upload = null;

  // Сразу ищем все открытые задачи проектировщика, а не только задачи
  // только что завершённого типа.
  await showDesignerTaskList(ctx, state, userKey, null, send);
}

async function handleUploadStep(ctx, state, userKey, trimmedText, imageUrls, send) {
  const upload = state.upload;
  const fileConfig = FILE_TYPE_CONFIGS[upload.key];

  if (upload.awaitingCutName) {
    if (!trimmedText) {
      await send("Значение «Раскрой» не может быть пустым. Укажите значение «Раскрой»");
      return;
    }

    state.task.dxfCutValue = trimmedText;

    try {
      await ctx.updateLeadCustomFields(state.task.lead_id, { [CUT_TYPE_FIELD_ID]: trimmedText });
    } catch (error) {
      console.error("[Бот проектировщиков] Не удалось сохранить значение «Раскрой»:", error.message);
    }

    upload.awaitingCutName = false;

    await send(fileConfig.promptText);
    return;
  }

  if (imageUrls && imageUrls.length > 0) {
    await enqueueDesignerUpload(userKey, async () => {
      const currentState = designerState[userKey];

      if (!currentState || !currentState.upload) {
        return;
      }

      await processUploadBatch(ctx, currentState, userKey, imageUrls, send);
    });
    return;
  }

  await send(fileConfig.promptText);
}

// ============================================================
// 12. СПИСОК ЗАДАЧ / ВЫБОР ЗАДАЧИ
// ============================================================

async function showDesignerTaskList(ctx, state, userKey, taskTypeId, send) {
  console.log(
    "[Бот проектировщиков] Поиск задач:",
    JSON.stringify({ designerName: state.designerName, taskTypeId: taskTypeId || "все типы" })
  );

  await send("⏳ Проверяю задачи...");

  try {
    let items = [];

    if (taskTypeId) {
      items = await findDesignerTasksOfType(ctx, taskTypeId, state.designerName);
    } else {
      for (const id of DESIGNER_TASK_TYPE_IDS) {
        items = items.concat(await findDesignerTasksOfType(ctx, id, state.designerName));
      }
    }

    console.log(`[Бот проектировщиков] Найдено задач: ${items.length}`);

    state.step = "TASK_LIST";
    state.listTaskType = taskTypeId;
    state.task = null;
    state.upload = null;
    state.pendingComment = null;

    if (items.length === 0) {
      if (taskTypeId) {
        await send("🔍 Задач данного типа не найдено.");
        await showDesignerTaskList(ctx, state, userKey, null, send);
        return;
      }

      state.tasks = null;
      state.step = "MAIN_MENU";

      await send("🔍 Задач не найдено.");
      return;
    }

    const nowUnix = ctx.getCurrentMoscowUnix();
    const overdue = items.filter((i) => Number(i.complete_till || 0) < nowUnix);
    const current = items.filter((i) => Number(i.complete_till || 0) >= nowUnix);

    const orderedItems = [...overdue, ...current];

    state.tasks = orderedItems;

    let message = "🔍 Найдены задачи:\n\n";
    let index = 0;

    if (overdue.length > 0) {
      message += "Просроченные задачи:\n";
      overdue.forEach((item) => {
        message += formatDesignerListLine(ctx, item, index);
        index++;
      });
    }

    if (current.length > 0) {
      message += "Актуальные задачи:\n";
      current.forEach((item) => {
        message += formatDesignerListLine(ctx, item, index);
        index++;
      });
    }

    const buttons = orderedItems.map((item) => item.contract_number || `Задача ${item.task_id}`);

    await send(message, buttons, { markdown: true });
  } catch (error) {
    console.error("[Бот проектировщиков] Ошибка поиска задач:", error.message);
    await send("❌ Произошла ошибка при поиске задач. Подробности есть в логах Render.");
  }
}

async function selectDesignerTask(ctx, state, userKey, item, send) {
  console.log(
    "[Бот проектировщиков] Выбрана задача:",
    JSON.stringify({
      task_id: item.task_id,
      lead_id: item.lead_id,
      task_type_id: item.task_type_id,
      contract_number: item.contract_number
    })
  );

  state.task = {
    task_id: item.task_id,
    lead_id: item.lead_id,
    task_type_id: item.task_type_id,
    item,
    uploadedKeys: {},
    uploadedLastPath: {},
    dxfCutValue: null,
    menuUploadStarted: false,
    pendingWoodDecision: null
  };
  state.tasks = null;
  state.upload = null;
  state.pendingComment = null;
  state.step = "TASK_SELECTED";

  const config = TASK_TYPE_CONFIG[item.task_type_id];

  await send(
    formatDesignerDetailCard(ctx, item, config.extended),
    buildTaskSelectedButtons(ctx, config, state.task),
    { markdown: true }
  );
}

// ============================================================
// 13. ОСНОВНОЙ ОБРАБОТЧИК СООБЩЕНИЙ
// ============================================================

async function processDesignerMessage(ctx, { text, userKey, userName, directId, send, imageUrls }) {
  const trimmedText = String(text || "").trim();

  if (userName) {
    lastKnownDesignerName[userKey] = userName;
  }

  const designerName = userName || lastKnownDesignerName[userKey] || "";

  await touchRegistry(userKey, { userId: userKey, directId, name: designerName });

  if (ctx.isStartCommand(trimmedText)) {
    resetDesignerState(userKey, designerName);
    await showDesignerTaskList(ctx, designerState[userKey], userKey, null, send);
    return;
  }

  if (!designerState[userKey]) {
    resetDesignerState(userKey, designerName);
  }

  const state = designerState[userKey];

  if (designerName) {
    state.designerName = designerName;
  }

  // Защита от неожиданного ввода (ТЗ п.20): если бот ждал нажатия кнопки,
  // а пришёл посторонний текст — не выполнять случайное действие, а
  // повторить последнее актуальное сообщение с кнопками.
  const lastMsg = designerLastBotMessage[userKey];

  const allowsFreeText = !!state.pendingComment || (state.upload && state.upload.awaitingCutName);

  if (
    lastMsg &&
    Array.isArray(lastMsg.buttons) &&
    lastMsg.buttons.length > 0 &&
    !allowsFreeText &&
    !(imageUrls && imageUrls.length > 0) &&
    trimmedText &&
    !lastMsg.buttons.includes(trimmedText)
  ) {
    await send("⚠️ Пожалуйста, выберите один из предложенных вариантов ниже:");
    await send(lastMsg.text, lastMsg.buttons);
    return;
  }

  if (state.pendingComment) {
    await handlePendingComment(ctx, state, userKey, trimmedText, send);
    return;
  }

  if (state.upload) {
    await handleUploadStep(ctx, state, userKey, trimmedText, imageUrls, send);
    return;
  }

  if (state.task) {
    const handled = await handleTaskSelectedButtons(ctx, state, userKey, trimmedText, send);

    if (handled) {
      return;
    }
  }

  if (Array.isArray(state.tasks) && state.tasks.length > 0) {
    const selected = state.tasks.find(
      (item) => (item.contract_number || `Задача ${item.task_id}`) === trimmedText
    );

    if (selected) {
      await selectDesignerTask(ctx, state, userKey, selected, send);
      return;
    }
  }

  console.log("[Бот проектировщиков] Неизвестная команда:", trimmedText);

  await send(
    "⚠️ Неизвестная команда. Пожалуйста, следуйте кнопкам бота или начните заново командой `/старт`"
  );

  const last = designerLastBotMessage[userKey];

  if (last) {
    await send(last.text, last.buttons || undefined);
  }
}

// ============================================================
// 14. ЕЖЕДНЕВНАЯ РАССЫЛКА (08:55 Europe/Moscow) — ТЗ п.6
// ============================================================

async function runDailyDigest(ctx) {
  console.log("[Бот проектировщиков] Запуск ежедневной рассылки (08:55 МСК).");

  if (!registryLoaded) {
    await loadRegistry(ctx);
  }

  if (!projectAccessToken) {
    console.log("[Бот проектировщиков] Рассылка пропущена: нет access_token amoMessenger.");
    return;
  }

  let entries;

  try {
    entries = await loadAllDesignerTasksWithLeads(ctx);
  } catch (error) {
    console.error("[Бот проектировщиков] Ошибка подготовки ежедневной рассылки:", error.message);
    return;
  }

  console.log(
    `[Бот проектировщиков] Рассылка: загружено задач ${entries.length}, ` +
      `зарегистрировано проектировщиков ${Object.keys(registry).length}.`
  );

  const nowUnix = ctx.getCurrentMoscowUnix();
  const todayStart = ctx.todayMoscowStartUnix();
  const todayEnd = ctx.todayMoscowEndUnix();

  for (const registrant of Object.values(registry)) {
    if (!registrant.directId || !registrant.name) {
      continue;
    }

    const overdue = [];
    const today = [];

    for (const { task, lead } of entries) {
      if (!leadBelongsToDesigner(ctx, lead, registrant.name)) {
        continue;
      }

      const item = buildLightDesignerItem(ctx, task, lead);
      const till = Number(item.complete_till || 0);

      if (!till) {
        continue;
      }

      const windowDays = DAILY_WINDOW_DAYS[item.task_type_id] || 1;
      const windowEnd = todayEnd + (windowDays - 1) * 86400;

      if (till < nowUnix) {
        overdue.push(item);
      } else if (till >= todayStart && till <= windowEnd) {
        today.push(item);
      }
    }

    if (overdue.length === 0 && today.length === 0) {
      continue;
    }

    let message = `Доброе утро, ${registrant.name}! Вам нужно выполнить следующие задачи:\n\n`;
    let index = 0;

    if (overdue.length > 0) {
      message += "Просроченные задачи:\n";
      overdue.forEach((item) => {
        message += formatDesignerListLine(ctx, item, index);
        index++;
      });
    }

    if (today.length > 0) {
      message += "Задачи на сегодня:\n";
      today.forEach((item) => {
        message += formatDesignerListLine(ctx, item, index);
        index++;
      });
    }

    try {
      await sendProjectDirectMessage(ctx, registrant.directId, message.trim(), null, { markdown: true });

      console.log(
        `[Бот проектировщиков] Рассылка отправлена: ${registrant.name} ` +
          `(просроченных: ${overdue.length}, на сегодня: ${today.length}).`
      );
    } catch (error) {
      console.error(
        "[Бот проектировщиков] Ошибка отправки ежедневной рассылки:",
        registrant.directId,
        error.message
      );
    }
  }

  console.log("[Бот проектировщиков] Ежедневная рассылка завершена.");
}

// ============================================================
// 15. УВЕДОМЛЕНИЯ О НОВЫХ ЗАДАЧАХ — ТЗ п.18
// ============================================================
// amoCRM не предоставляет отдельного webhook-события "задача создана"
// (в отличие от событий по сделкам/контактам), поэтому уведомление
// реализовано через периодический опрос открытых задач с дедупликацией
// по task_id (список уже отправленных id хранится в Redis). Это
// сознательное отклонение от "мгновенного" push, отмеченное отдельно —
// см. сопроводительное сообщение к коду.

let seenTaskIds = new Set();
let seenLoaded = false;

async function loadSeenTaskIds(ctx) {
  try {
    const response = await ctx.redisRequest(["GET", "amomessenger_project_seen_tasks"]);

    if (response.result) {
      seenTaskIds = new Set(JSON.parse(response.result));
    }
  } catch (error) {
    console.error(
      "[Бот проектировщиков] Ошибка загрузки списка уже отправленных задач:",
      error.message
    );
  }

  seenLoaded = true;
}

async function saveSeenTaskIds(ctx) {
  try {
    const arr = Array.from(seenTaskIds).slice(-3000);

    await ctx.redisRequest(["SET", "amomessenger_project_seen_tasks", JSON.stringify(arr)]);
  } catch (error) {
    console.error(
      "[Бот проектировщиков] Ошибка сохранения списка уже отправленных задач:",
      error.message
    );
  }
}

function formatNewTaskNotification(name, items) {
  const header =
    items.length === 1
      ? `${name}, Вам необходимо выполнить новую задачу:\n\n`
      : `${name}, Вам необходимо выполнить новые задачи:\n\n`;

  const lines = items.map(({ item, label }, index) => {
    const parts = [];

    if (item.engineer) parts.push(item.engineer);
    if (item.contract_number) parts.push(item.contract_number);
    if (item.product) parts.push(item.product);
    if (item.budget) parts.push(item.budget);
    if (item.address) parts.push(item.address);
    parts.push(item.lead_link);

    const prefix = items.length > 1 ? `${index + 1}. ` : "";

    return `${prefix}${label}: ${parts.join(", ")}`;
  });

  return header + lines.join("\n");
}

async function pollNewTasks(ctx) {
  if (!seenLoaded) {
    await loadSeenTaskIds(ctx);
  }

  if (!registryLoaded) {
    await loadRegistry(ctx);
  }

  if (!projectAccessToken) {
    console.log("[Бот проектировщиков] Опрос новых задач пропущен: нет access_token amoMessenger.");
    return;
  }

  let entries;

  try {
    entries = await loadAllDesignerTasksWithLeads(ctx);
  } catch (error) {
    console.error("[Бот проектировщиков] Ошибка опроса новых задач:", error.message);
    return;
  }

  console.log(`[Бот проектировщиков] Опрос новых задач: открытых задач ${entries.length}, уже отправлено ${seenTaskIds.size}.`);

  const toNotify = {};
  let changed = false;

  for (const { task, lead } of entries) {
    const taskId = Number(task.id);

    if (seenTaskIds.has(taskId)) {
      continue;
    }

    seenTaskIds.add(taskId);
    changed = true;

    const registrant = Object.values(registry).find((entry) =>
      leadBelongsToDesigner(ctx, lead, entry.name)
    );

    if (!registrant || !registrant.directId) {
      continue;
    }

    const item = buildLightDesignerItem(ctx, task, lead);
    const config = TASK_TYPE_CONFIG[item.task_type_id];

    if (!toNotify[registrant.directId]) {
      toNotify[registrant.directId] = { name: registrant.name, items: [] };
    }

    toNotify[registrant.directId].items.push({ item, label: config.label });
  }

  for (const directId of Object.keys(toNotify)) {
    const { name, items } = toNotify[directId];

    try {
      await sendProjectDirectMessage(ctx, directId, formatNewTaskNotification(name, items));

      console.log(
        `[Бот проектировщиков] Уведомление о новой задаче отправлено: ${name} (задач: ${items.length}).`
      );
    } catch (error) {
      console.error(
        "[Бот проектировщиков] Ошибка отправки уведомления о новой задаче:",
        directId,
        error.message
      );
    }
  }

  if (changed) {
    await saveSeenTaskIds(ctx);
  }
}

// ============================================================
// 16. ПЛАНИРОВЩИКИ
// ============================================================

let lastDigestDateText = "";

function startSchedulers(ctx) {
  loadRegistry(ctx);
  loadSeenTaskIds(ctx);

  setInterval(() => {
    flushRegistry(ctx);
  }, 10000);

  setInterval(async () => {
    try {
      const now = ctx.getMoscowDate();
      const hh = String(now.getUTCHours()).padStart(2, "0");
      const mm = String(now.getUTCMinutes()).padStart(2, "0");
      const dateText = ctx.todayMoscowDateText();

      if (hh === "08" && mm === "55" && lastDigestDateText !== dateText) {
        lastDigestDateText = dateText;
        await runDailyDigest(ctx);
      }
    } catch (error) {
      console.error(
        "[Бот проектировщиков] Ошибка планировщика ежедневной рассылки:",
        error.message
      );
    }
  }, 30000);

  setInterval(() => {
    pollNewTasks(ctx).catch((error) => {
      console.error("[Бот проектировщиков] Ошибка опроса новых задач:", error.message);
    });
  }, 90000);

  console.log("[Бот проектировщиков] Планировщики (рассылка 08:55, опрос новых задач) запущены.");
}

// ============================================================
// 17. WEBHOOK И OAUTH-МАРШРУТЫ
// ============================================================

function init(app, ctx) {
  app.get("/oauth/amomessenger/project", (req, res) => {
    if (!AMOMESSENGER_PROJECT_CLIENT_ID) {
      return res.status(500).send("AMOMESSENGER_PROJECT_CLIENT_ID не задан");
    }

    // Значение scope можно переопределить прямо в ссылке (?scope=...) —
    // удобно для подбора правильного значения без передеплоя. По
    // умолчанию берётся AMOMESSENGER_PROJECT_SCOPE из переменных окружения.
    const scope = String(req.query.scope || AMOMESSENGER_PROJECT_SCOPE || "").trim();

    if (!scope) {
      return res.status(500).send(
        "Не задан scope. Укажите AMOMESSENGER_PROJECT_SCOPE в переменных окружения " +
          "(значение — из настроек приложения в кабинете developers.amo.tm) либо " +
          "откройте /oauth/amomessenger/project?scope=... с нужным значением вручную."
      );
    }

    const url =
      "https://id.amo.tm/oauth2/authorize?" +
      `client_id=${encodeURIComponent(AMOMESSENGER_PROJECT_CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(AMOMESSENGER_PROJECT_REDIRECT_URI)}` +
      `&scope=${encodeURIComponent(scope)}` +
      "&response_type=code";

    console.log("[Бот проектировщиков] amoMessenger OAuth URL:", url);

    res.redirect(url);
  });

  app.get("/oauth/amomessenger/project/callback", async (req, res) => {
    const code = req.query.code;

    if (!code) {
      return res.status(400).send("<h2>Ошибка OAuth</h2><p>Код авторизации не получен.</p>");
    }

    try {
      const response = await axios.post(
        "https://id.amo.tm/oauth2/access_token",
        {
          grant_type: "authorization_code",
          client_id: AMOMESSENGER_PROJECT_CLIENT_ID,
          client_secret: AMOMESSENGER_PROJECT_CLIENT_SECRET,
          redirect_uri: AMOMESSENGER_PROJECT_REDIRECT_URI,
          code
        },
        { headers: { "Content-Type": "application/json" }, timeout: 30000 }
      );

      projectAccessToken = response.data.access_token;
      projectRefreshToken = response.data.refresh_token;

      await saveProjectTokensToRedis(ctx);

      res.send(`
        <!DOCTYPE html>
        <html lang="ru">
        <head><meta charset="UTF-8"><title>Бот проектировщиков — OAuth</title></head>
        <body style="font-family:Arial;padding:40px;">
          <h2>Авторизация бота проектировщиков выполнена</h2>
          <p>Access Token получен: <b>ДА</b></p>
          <p>Refresh Token получен: <b>ДА</b></p>
          <p>Теперь можно закрыть это окно.</p>
        </body>
        </html>
      `);
    } catch (error) {
      console.error(
        "[Бот проектировщиков] OAuth ERROR:",
        error.response ? error.response.data : error.message
      );

      res.status(500).json({
        status: "Ошибка OAuth",
        message: error.response?.data || error.message
      });
    }
  });

  app.get("/oauth/amomessenger/project/status", (req, res) => {
    res.json({
      status: projectAccessToken ? "OK" : "Токен не найден",
      access_token: projectAccessToken ? "ДА" : "НЕТ",
      refresh_token: projectRefreshToken ? "ДА" : "НЕТ"
    });
  });

  app.get("/status/project", (req, res) => {
    res.json({
      status: "OK",
      service: "amoMessenger designer bot",
      bot_id: BOT_ID,
      amomessenger_token: projectAccessToken ? "ДА" : "НЕТ",
      task_type_ids: DESIGNER_TASK_TYPE_IDS,
      designer_field_id: DESIGNER_FIELD_ID,
      registered_designers: Object.keys(registry).length
    });
  });

  // Отдельный webhook-маршрут для отдельного amoMessenger-приложения —
  // гарантирует, что события бота проектировщиков не попадают в
  // обработчик бота инженеров ("/") и наоборот (ТЗ п.2.4).
  app.post("/webhook/project", async (req, res) => {
    const body = req.body || {};

    res.status(200).json({ status: "OK" });

    console.log("[Бот проектировщиков] Webhook получен, event_type:", body.event_type);

    try {
      if (body.event_type !== "income_message") {
        return;
      }

      const data = body._embedded || {};
      const context = data.context || {};
      const conversationIdentity = data.conversation_identity || {};
      const message = data.message || {};

      const directId = conversationIdentity.direct_id;
      const text = message.text || "";
      const userKey = context.user_id || (message.author && message.author.user_id);

      let userName = ctx.extractAmoMessengerUserName(message.author, context, message);

      if (!userName && userKey) {
        userName = await getProjectAmoMessengerUserName(ctx, userKey);
      }

      if (!directId || !userKey) {
        console.error(
          "[Бот проектировщиков] Не удалось определить direct_id или user_id из вебхука."
        );
        return;
      }

      const normalizedUserKey = String(userKey);
      const imageUrls = ctx.extractImageUrlsFromMessage(message);

      console.log(
        "[Бот проектировщиков] Входящее сообщение:",
        JSON.stringify({
          userKey: normalizedUserKey,
          userName,
          text,
          filesCount: imageUrls.length
        })
      );

      await processDesignerMessage(ctx, {
        text,
        userKey: normalizedUserKey,
        userName,
        directId,
        imageUrls,
        send: wrapSend(normalizedUserKey, (msgText, buttons, options) =>
          sendProjectDirectMessage(ctx, directId, msgText, buttons, options)
        )
      });
    } catch (error) {
      console.error("[Бот проектировщиков] WEBHOOK ERROR:", error.stack || error.message);
    }
  });

  console.log(
    "[Бот проектировщиков] Маршруты зарегистрированы: /webhook/project, " +
      "/oauth/amomessenger/project(/callback|/status), /status/project"
  );
}

// ============================================================
// 18. ЭКСПОРТ
// ============================================================

module.exports = {
  init,
  loadTokens: loadProjectTokensFromRedis,
  startSchedulers
};
