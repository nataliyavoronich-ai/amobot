// ============================================================
// БОТ ПРОИЗВОДСТВО (amoMessenger + виджет настроек amoCRM)
// ============================================================
//
// Отдельный бот в отдельном amoMessenger-приложении, работающий в ТОМ ЖЕ
// Node.js-процессе/сервисе, что и бот инженеров (server.js) и бот
// проектировщиков (designerBot.js).
//
// У бота производства:
// - свои OAuth credentials (AMOMESSENGER_PRODUCTION_*);
// - свои access/refresh токены (свои ключи в Redis);
// - свой webhook-маршрут (/webhook/production) — этим гарантируется, что
//   события этого бота не попадают в сценарии других ботов;
// - НЕТ собственного токена amoCRM. В отличие от amoMessenger-канала,
//   для чтения/записи сделок этот бот (как и designerBot.js) переиспользует
//   уже существующий токен "Внешней интеграции" amoCRM через ctx —
//   отдельная "Приватная интеграция" amoCRM для этого проекта заведена
//   только для того, чтобы иметь возможность загрузить в неё виджет с
//   экраном настроек (см. widget-production/), сама она серверным кодом
//   не используется.
//
// Настройки виджета (роли, связь статусов/полей, сценарии, плановая
// готовность) виджет хранит в двух местах одновременно:
// 1) во встроенном хранилище amoCRM (set_settings/get_settings) — только
//    для нативного UX при повторном открытии настроек в браузере;
// 2) в Upstash Redis через этот модуль (POST/GET /widget/production/settings)
//    — это единственный источник, который читает серверный код бота.
//
// ФАЗА 1: приватная интеграция/виджет настроек.
// ФАЗА 2 (в работе): авторизация по "старт" (ТЗ п.7), ролевое главное меню
// (ТЗ п.8). Сценарий "Распределение" (ТЗ п.9-16) и остальные пункты меню
// (Исполнение/ОТК/Отчёт/Контроль сроков/...) — заглушки, реализация
// в следующих обновлениях.

const axios = require("axios");

// ============================================================
// 1. CONFIG
// ============================================================

const AMOMESSENGER_PRODUCTION_CLIENT_ID =
  process.env.AMOMESSENGER_PRODUCTION_CLIENT_ID || "";

const AMOMESSENGER_PRODUCTION_CLIENT_SECRET =
  process.env.AMOMESSENGER_PRODUCTION_CLIENT_SECRET || "";

const AMOMESSENGER_PRODUCTION_REDIRECT_URI =
  process.env.AMOMESSENGER_PRODUCTION_REDIRECT_URI || "";

// id.amo.tm требует параметр scope в ссылке авторизации (см. аналогичный
// комментарий в designerBot.js) — значение берётся из переменной окружения.
const AMOMESSENGER_PRODUCTION_SCOPE =
  process.env.AMOMESSENGER_PRODUCTION_SCOPE || "";

// Секрет, которым виджет (widget-production/script.js) подтверждает
// backend'у, что запрос к /widget/production/settings пришёл действительно
// от виджета, а не от произвольного клиента в интернете. Как и DEBUG_SECRET
// в server.js — не настоящая криптографическая защита (секрет попадает в
// исходный код виджета, видимый через devtools администратору аккаунта),
// а минимальный барьер от случайных/чужих запросов.
const PRODUCTION_WIDGET_SECRET = process.env.PRODUCTION_WIDGET_SECRET || "";

// Условный идентификатор бота — используется только в логах/отладке.
const BOT_ID = "production";

// ============================================================
// 2. ТОКЕНЫ amoMessenger (бот производства) + Redis
// ============================================================

let productionAccessToken = process.env.AMOMESSENGER_PRODUCTION_ACCESS_TOKEN || "";
let productionRefreshToken = process.env.AMOMESSENGER_PRODUCTION_REFRESH_TOKEN || "";

async function saveProductionTokensToRedis(ctx) {
  if (!productionAccessToken || !productionRefreshToken) {
    return;
  }

  await ctx.redisRequest(["SET", "amomessenger_production_access_token", productionAccessToken]);
  await ctx.redisRequest(["SET", "amomessenger_production_refresh_token", productionRefreshToken]);

  console.log("[Бот производства] Токены amoMessenger сохранены в Redis.");
}

async function loadProductionTokensFromRedis(ctx) {
  try {
    const accessResponse = await ctx.redisRequest(["GET", "amomessenger_production_access_token"]);
    const refreshResponse = await ctx.redisRequest(["GET", "amomessenger_production_refresh_token"]);

    if (accessResponse.result && refreshResponse.result) {
      productionAccessToken = accessResponse.result;
      productionRefreshToken = refreshResponse.result;

      console.log("[Бот производства] Токены amoMessenger загружены из Redis.");
    } else {
      console.log("[Бот производства] В Redis пока нет токенов amoMessenger.");
    }
  } catch (error) {
    console.error(
      "[Бот производства] Ошибка загрузки токенов amoMessenger из Redis:",
      error.message
    );
  }
}

async function refreshProductionMessengerToken(ctx) {
  if (!productionRefreshToken) {
    throw new Error("Refresh Token бота производства не найден");
  }

  const response = await axios.post(
    "https://id.amo.tm/oauth2/access_token",
    {
      grant_type: "refresh_token",
      client_id: AMOMESSENGER_PRODUCTION_CLIENT_ID,
      client_secret: AMOMESSENGER_PRODUCTION_CLIENT_SECRET,
      refresh_token: productionRefreshToken,
      redirect_uri: AMOMESSENGER_PRODUCTION_REDIRECT_URI
    },
    { headers: { "Content-Type": "application/json" }, timeout: 30000 }
  );

  productionAccessToken = response.data.access_token;

  if (response.data.refresh_token) {
    productionRefreshToken = response.data.refresh_token;
  }

  await saveProductionTokensToRedis(ctx);

  console.log("[Бот производства] Токен amoMessenger обновлён и сохранён в Redis.");

  return productionAccessToken;
}

// ============================================================
// 3. amoMessenger API (бот производства)
// ============================================================

async function sendProductionDirectMessage(ctx, directId, text, buttons, options) {
  if (!productionAccessToken) {
    throw new Error("Токен amoMessenger бота производства не найден");
  }

  const url = `https://api.amo.tm/v1.3/direct/${directId}/sendMessage`;

  const body = { text };

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
        Authorization: `Bearer ${productionAccessToken}`,
        "Content-Type": "application/json"
      },
      timeout: 30000,
      validateStatus: () => true
    });

  let response = await doRequest();

  if (response.status === 401 || response.status === 403) {
    await refreshProductionMessengerToken(ctx);
    response = await doRequest();
  }

  if (response.status >= 400) {
    throw new Error(`amoMessenger (производство) DIRECT HTTP ${response.status}`);
  }

  return response;
}

// ============================================================
// 4. НАСТРОЙКИ ВИДЖЕТА — Redis (источник истины для бота) + валидация
// ============================================================

const WIDGET_SETTINGS_REDIS_KEY = "widget_production_settings";
const WIDGET_SETTINGS_UPDATED_AT_REDIS_KEY = "widget_production_settings_updated_at";

// Последние успешно сохранённые/загруженные настройки — в памяти процесса,
// чтобы не ходить в Redis на каждый GET /widget/production/settings.
let productionWidgetSettingsCache = null;
let productionWidgetSettingsUpdatedAt = null;

const KNOWN_ROLE_KEYS = [
  "productionDirector", // Директор производства
  "metalShopForeman",   // Мастер металлического цеха
  "woodShopForeman",    // Мастер столярного цеха
  "otk"                 // ОТК
];

const KNOWN_BOT_STATUSES = ["execution", "distribution"];

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isNullOrPositiveInteger(value) {
  return value === null || value === undefined || isPositiveInteger(value);
}

// Проверяет число дней плановой готовности: 0 или положительное, не более
// двух знаков после запятой (ТЗ п.6.3).
function isValidReadinessDays(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return false;
  }

  return Math.round(value * 100) === value * 100;
}

// Валидирует JSON настроек виджета целиком. Возвращает { valid: true }
// либо { valid: false, error, field } — по этой паре POST-обработчик
// формирует понятный ответ 400, а виджет показывает причину рядом с нужным
// полем (ТЗ п.6.5/19 — сохранение с ошибкой должно быть заблокировано).
function validateProductionWidgetSettings(settings) {
  if (!settings || typeof settings !== "object") {
    return { valid: false, error: "Настройки должны быть JSON-объектом.", field: null };
  }

  // --- roles ---
  const roles = settings.roles;

  if (!roles || typeof roles !== "object") {
    return { valid: false, error: "Не заполнен раздел «Роли».", field: "roles" };
  }

  // Роли назначаются по имени пользователя amoMessenger (свободный текст,
  // например "@nataliya_voronich"), а не по id пользователя amoCRM — это
  // разные системы, и живой список пользователей amoMessenger браузер
  // виджета получить не может.
  const activeHandles = new Set();

  for (const roleKey of KNOWN_ROLE_KEYS) {
    const entries = roles[roleKey];

    if (entries === undefined) {
      continue;
    }

    if (!Array.isArray(entries)) {
      return {
        valid: false,
        error: `Роль «${roleKey}» должна быть списком пользователей.`,
        field: `roles.${roleKey}`
      };
    }

    for (const entry of entries) {
      const handle = entry && typeof entry.handle === "string" ? entry.handle.trim() : "";

      if (!handle) {
        return {
          valid: false,
          error: `В роли «${roleKey}» указан пустой пользователь — заполните имя или удалите строку.`,
          field: `roles.${roleKey}`
        };
      }

      if (entry.active) {
        if (activeHandles.has(handle)) {
          return {
            valid: false,
            error: "Один пользователь не может одновременно состоять в двух активных ролях.",
            field: `roles.${roleKey}`
          };
        }

        activeHandles.add(handle);
      }
    }
  }

  // --- statusFieldMap ---
  const statusFieldMap = settings.statusFieldMap;

  if (!Array.isArray(statusFieldMap)) {
    return {
      valid: false,
      error: "Раздел «Связь этапов и полей» должен быть таблицей строк.",
      field: "statusFieldMap"
    };
  }

  for (let i = 0; i < statusFieldMap.length; i++) {
    const row = statusFieldMap[i];

    if (!row || !isPositiveInteger(row.amoStatusId)) {
      return {
        valid: false,
        error: `Строка ${i + 1}: не указан текущий статус amoCRM.`,
        field: `statusFieldMap[${i}].amoStatusId`
      };
    }

    if (!KNOWN_BOT_STATUSES.includes(row.botStatus)) {
      return {
        valid: false,
        error: `Строка ${i + 1}: статус бота должен быть «Исполнение» или «Распределение».`,
        field: `statusFieldMap[${i}].botStatus`
      };
    }

    const optionalIdFields = [
      "amoPipelineId",
      "executorFieldId",
      "planDateFieldId",
      "factDateFieldId",
      "priceFieldId",
      "nextAmoStatusId"
    ];

    for (const fieldName of optionalIdFields) {
      if (!isNullOrPositiveInteger(row[fieldName])) {
        return {
          valid: false,
          error: `Строка ${i + 1}: некорректное значение поля «${fieldName}».`,
          field: `statusFieldMap[${i}].${fieldName}`
        };
      }
    }
  }

  // --- readinessMatrix ---
  const readinessMatrix = settings.readinessMatrix;

  if (readinessMatrix !== undefined && readinessMatrix !== null) {
    if (typeof readinessMatrix !== "object") {
      return {
        valid: false,
        error: "Раздел «Плановая готовность» заполнен некорректно.",
        field: "readinessMatrix"
      };
    }

    if (!isNullOrPositiveInteger(readinessMatrix.productFieldId)) {
      return {
        valid: false,
        error: "Не выбрано поле «Продукт» для плановой готовности.",
        field: "readinessMatrix.productFieldId"
      };
    }

    const products = readinessMatrix.products;

    if (products !== undefined) {
      if (!Array.isArray(products)) {
        return {
          valid: false,
          error: "Список продуктов плановой готовности заполнен некорректно.",
          field: "readinessMatrix.products"
        };
      }

      for (const product of products) {
        if (!product || !isPositiveInteger(product.enumId)) {
          return {
            valid: false,
            error: "В плановой готовности есть строка без выбранного продукта.",
            field: "readinessMatrix.products"
          };
        }

        if (
          product.readinessValue !== undefined &&
          product.readinessValue !== null &&
          !isValidReadinessDays(product.readinessValue)
        ) {
          return {
            valid: false,
            error: "Некорректное значение «Готовность изделия» — допустимы 0 и положительные числа " +
              "не более чем с двумя знаками после запятой.",
            field: "readinessMatrix.products"
          };
        }
      }
    }

    const statusIds = readinessMatrix.statusIds;

    if (statusIds !== undefined) {
      if (!Array.isArray(statusIds)) {
        return {
          valid: false,
          error: "Список статусов плановой готовности заполнен некорректно.",
          field: "readinessMatrix.statusIds"
        };
      }

      for (const statusId of statusIds) {
        if (!isPositiveInteger(statusId)) {
          return {
            valid: false,
            error: "В плановой готовности есть столбец без выбранного статуса.",
            field: "readinessMatrix.statusIds"
          };
        }
      }
    }

    const cells = readinessMatrix.cells || {};

    if (typeof cells !== "object") {
      return {
        valid: false,
        error: "Раздел «Плановая готовность» заполнен некорректно.",
        field: "readinessMatrix.cells"
      };
    }

    for (const cellKey of Object.keys(cells)) {
      if (!isValidReadinessDays(cells[cellKey])) {
        return {
          valid: false,
          error: `Некорректное значение плановой готовности для «${cellKey}» — ` +
            "допустимы 0 и положительные числа не более чем с двумя знаками после запятой.",
          field: `readinessMatrix.cells.${cellKey}`
        };
      }
    }
  }

  // --- scenarios ---
  const scenarios = settings.scenarios || {};

  if (typeof scenarios !== "object") {
    return { valid: false, error: "Раздел «Сценарии» заполнен некорректно.", field: "scenarios" };
  }

  for (const scenarioKey of ["metalRestock", "woodRestock"]) {
    const scenario = scenarios[scenarioKey];

    if (scenario === undefined) {
      continue;
    }

    if (!scenario || !isNullOrPositiveInteger(scenario.amoStatusId)) {
      return {
        valid: false,
        error: `Сценарий «${scenarioKey}»: некорректный статус amoCRM.`,
        field: `scenarios.${scenarioKey}.amoStatusId`
      };
    }
  }

  return { valid: true };
}

async function saveProductionWidgetSettingsToRedis(ctx, settings) {
  const updatedAt = new Date().toISOString();
  const payload = { ...settings, updatedAt };

  await ctx.redisRequest(["SET", WIDGET_SETTINGS_REDIS_KEY, JSON.stringify(payload)]);
  await ctx.redisRequest(["SET", WIDGET_SETTINGS_UPDATED_AT_REDIS_KEY, updatedAt]);

  productionWidgetSettingsCache = payload;
  productionWidgetSettingsUpdatedAt = updatedAt;

  console.log("[Бот производства] Настройки виджета сохранены в Redis.");

  return payload;
}

async function loadProductionWidgetSettingsFromRedis(ctx) {
  try {
    const response = await ctx.redisRequest(["GET", WIDGET_SETTINGS_REDIS_KEY]);

    if (response.result) {
      productionWidgetSettingsCache = JSON.parse(response.result);
      productionWidgetSettingsUpdatedAt = productionWidgetSettingsCache.updatedAt || null;

      console.log("[Бот производства] Настройки виджета загружены из Redis.");
    } else {
      console.log("[Бот производства] В Redis пока нет сохранённых настроек виджета.");
    }
  } catch (error) {
    console.error(
      "[Бот производства] Ошибка загрузки настроек виджета из Redis:",
      error.message
    );
  }
}

// ============================================================
// 5. ПРОВЕРКА СЕКРЕТА ВИДЖЕТА
// ============================================================

function isValidWidgetSecret(req) {
  if (!PRODUCTION_WIDGET_SECRET) {
    return false;
  }

  return req.get("X-Widget-Secret") === PRODUCTION_WIDGET_SECRET;
}

// ============================================================
// 6. РОЛИ И ГЛАВНОЕ МЕНЮ (ТЗ п.7-8)
// ============================================================
// Роль пользователя — не привязана к сессии/логину, а определяется заново
// при каждом "старт" путём сравнения имени пользователя amoMessenger со
// списками в настройках виджета (роль "Исполнитель" не настраивается явно —
// это fallback для всех, кто не найден ни в одной активной роли).

const PERFORMER_ROLE_KEY = "performer";

const ROLE_LABELS = {
  productionDirector: "Директор производства",
  metalShopForeman: "Мастер металлического цеха",
  woodShopForeman: "Мастер столярного цеха",
  otk: "ОТК",
  [PERFORMER_ROLE_KEY]: "Исполнитель"
};

// ТЗ п.8: набор кнопок главного меню зависит от роли. Единственная кнопка
// с реализованной логикой на Фазе 2 — "Распределение" (роли из §9); у
// остальных пока плейсхолдер "в разработке" (ТЗ п.20 — поведение остальных
// пунктов не описано, выдумывать его нельзя).
const MAIN_MENU_BUTTONS = {
  [PERFORMER_ROLE_KEY]: ["Распределение", "Исполнение", "ОТК", "Отчет", "Контроль сроков"],
  otk: ["Промежуточный ОТК", "Финальный ОТК", "Не приняты работы"],
  metalShopForeman: [
    "Распределение",
    "Пересмотреть стоимость",
    "Не приняты работы",
    "Отчет",
    "Контроль сроков",
    "Вопрос от продаж",
    "Не принято ОТК"
  ],
  woodShopForeman: [
    "Распределение",
    "Пересмотреть стоимость",
    "Не приняты работы",
    "Отчет",
    "Контроль сроков",
    "Вопрос от продаж",
    "Не принято ОТК"
  ],
  productionDirector: ["Контроль сроков", "Вопросы от продаж", "Отчет"]
};

// Роли, которым по ТЗ п.9 доступна "Распределение".
const DISTRIBUTION_ROLE_KEYS = [PERFORMER_ROLE_KEY, "metalShopForeman", "woodShopForeman"];

// Состояние пользователей бота производства — в памяти процесса, как и у
// двух других ботов (designerState/userPending* в server.js). Переживает
// только до следующего перезапуска процесса — после "старт" роль всегда
// переопределяется заново, так что потеря состояния при деплое не критична
// (пользователь просто заново жмёт "старт").
const productionUserState = {};

function normalizeHandleName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

// ТЗ п.7: ищем пользователя среди АКТИВНЫХ записей всех ролей по совпадению
// имени (не id — список пользователей amoMessenger недоступен виджету, см.
// комментарий в widget-production/script.js). Первое совпадение побеждает;
// валидация настроек (validateProductionWidgetSettings) уже не даёт одному
// имени быть активным в двух ролях одновременно, так что порядок проверки
// ролей не важен.
function resolveUserRole(settings, userName) {
  const normalizedUserName = normalizeHandleName(userName);

  if (!settings || !settings.roles || !normalizedUserName) {
    return PERFORMER_ROLE_KEY;
  }

  for (const roleKey of KNOWN_ROLE_KEYS) {
    const entries = settings.roles[roleKey];

    if (!Array.isArray(entries)) {
      continue;
    }

    const match = entries.some(
      (entry) => entry.active && normalizeHandleName(entry.handle) === normalizedUserName
    );

    if (match) {
      return roleKey;
    }
  }

  return PERFORMER_ROLE_KEY;
}

async function sendMainMenu(ctx, directId, roleKey) {
  const buttons = MAIN_MENU_BUTTONS[roleKey] || [];

  await sendProductionDirectMessage(ctx, directId, "Выберите тип задач", buttons);
}

// ТЗ п.7: полный поток авторизации по команде "старт".
async function handleStartCommand(ctx, directId, userKey, userName) {
  await saveUserDirectId(ctx, userName, directId);

  await sendProductionDirectMessage(ctx, directId, "Минуту, ищем вас в базе.");

  const roleKey = resolveUserRole(productionWidgetSettingsCache, userName);

  productionUserState[userKey] = { roleKey, userName };

  await sendProductionDirectMessage(
    ctx,
    directId,
    `Вам присвоена роль: ${ROLE_LABELS[roleKey]}`
  );

  await sendMainMenu(ctx, directId, roleKey);
}

// Заглушка для пунктов меню, для которых ТЗ ещё не описывает поведение
// (ТЗ п.20 — такое поведение выдумывать нельзя, ждём продолжения ТЗ).
async function handleMenuPlaceholder(ctx, directId, buttonLabel) {
  await sendProductionDirectMessage(
    ctx,
    directId,
    `Раздел «${buttonLabel}» пока в разработке.`
  );
}

async function handleUnknownCommand(ctx, directId, roleKey) {
  await sendProductionDirectMessage(
    ctx,
    directId,
    "⚠️ Неизвестная команда. Пожалуйста, пользуйтесь кнопками бота или начните " +
      "заново командой «старт»."
  );

  if (roleKey) {
    await sendMainMenu(ctx, directId, roleKey);
  }
}

// ============================================================
// 7. СЦЕНАРИЙ «РАСПРЕДЕЛЕНИЕ» (ТЗ п.9-16)
// ============================================================

// Поля/справочники этого сценария, названные пользователем напрямую по id
// (не вынесены в виджет — в отличие от Исполнителя/Плана/Факта/Цены из
// «Связи этапов и полей», это технические поля одного конкретного процесса,
// а не то, что имеет смысл делать настраиваемым для разных пайплайнов).
const DISTRIBUTION_FLAG_FIELD_ID = 555072; // "[Бот] Распределение Мастера", тип "флаг"
const PROJECT_PDF_FIELD_ID = 543268; // "Проект в производство pdf", тип "ссылка"
const CONTRACT_NUMBER_FIELD_ID = 412776; // "№ договора" — то же поле, что у бота инженеров

const OTK_REJECTED_TAG_NAME = "Не принято ОТК";

const PIPELINE_NAME_METAL = "Производство";
const PIPELINE_NAME_WOOD = "Дерево производства";

// ТЗ п.13.1/13.2 — какая роль мастера согласовывает распределение в какой
// воронке.
const MANAGER_ROLE_BY_PIPELINE_NAME = {
  [PIPELINE_NAME_METAL]: "metalShopForeman",
  [PIPELINE_NAME_WOOD]: "woodShopForeman"
};

// ------------------------------------------------------------
// 7.1 amoCRM: воронки, поля-списки, сделки — читаем только живые данные
// (ТЗ п.18), ничего не кэшируем дольше одного запроса пользователя, кроме
// самого списка воронок (имя/id воронки меняется исключительно редко, а
// запрашивать его на каждый шаг сценария избыточно).
// ------------------------------------------------------------

let pipelinesCache = null; // { [name]: id }

async function getPipelineIdByName(ctx, name) {
  if (!pipelinesCache) {
    const url = `https://${ctx.AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4/leads/pipelines`;
    const response = await ctx.amoCrmGet(url, {});

    if (response.status !== 200) {
      throw new Error(`amoCRM GET /leads/pipelines HTTP ${response.status}`);
    }

    const pipelines =
      (response.data && response.data._embedded && response.data._embedded.pipelines) || [];

    pipelinesCache = {};

    for (const pipeline of pipelines) {
      pipelinesCache[pipeline.name] = pipeline.id;
    }
  }

  return pipelinesCache[name] || null;
}

// Постраничная загрузка сделок amoCRM по воронке (+ опционально статусу).
// Фильтруем по тегу/значению поля-списка уже на своей стороне (см.
// комментарий ниже) — официальный синтаксис фильтра по custom_fields_values
// для полей-списков в v4 недостаточно надёжен, а тег в фильтре вообще не
// задокументирован для /leads, поэтому безопаснее забрать статус-срез и
// проверить условия в коде.
async function getLeadsByPipeline(ctx, pipelineId, { statusId = null, withTags = false } = {}) {
  const url = `https://${ctx.AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4/leads`;
  const allLeads = [];
  let page = 1;

  while (true) {
    const params = {
      limit: 250,
      page,
      "filter[pipeline_id]": pipelineId
    };

    if (statusId) {
      params["filter[statuses][0][pipeline_id]"] = pipelineId;
      params["filter[statuses][0][status_id]"] = statusId;
    }

    if (withTags) {
      params.with = "tags";
    }

    const response = await ctx.amoCrmGet(url, params);

    if (response.status === 204) {
      break;
    }

    if (response.status !== 200) {
      throw new Error(`amoCRM GET /leads HTTP ${response.status}`);
    }

    const leads = (response.data && response.data._embedded && response.data._embedded.leads) || [];

    allLeads.push(...leads);

    if (leads.length < 250 || page > 20) {
      break;
    }

    page++;
  }

  return allLeads;
}

function leadHasTag(lead, tagName) {
  const tags = (lead && lead._embedded && lead._embedded.tags) || [];

  return tags.some((tag) => tag.name === tagName);
}

function isPendingManagerApproval(ctx, lead) {
  const values = ctx.getFieldValues(lead, DISTRIBUTION_FLAG_FIELD_ID);

  return values.some((v) => v === true || v === "true" || v === "1");
}

// ТЗ п.12.2 / п.19 — "значение поля «Исполнитель», соответствующее
// пользователю" определяем по совпадению имени (без явной таблицы
// соответствия amoMessenger-пользователь ↔ amoCRM-пользователь, которой в
// проекте нет). Если совпадения нет — вызывающий код обязан показать ошибку
// и НЕ писать в сделку произвольное значение (ТЗ п.19).
async function findFieldEnumForUserName(ctx, fieldId, userName) {
  if (!fieldId) {
    return null;
  }

  const url = `https://${ctx.AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4/leads/custom_fields/${fieldId}`;
  const response = await ctx.amoCrmGet(url, {});

  if (response.status !== 200) {
    throw new Error(`amoCRM GET /leads/custom_fields/${fieldId} HTTP ${response.status}`);
  }

  const enums = (response.data && response.data.enums) || [];
  const normalizedUserName = normalizeHandleName(userName);

  return enums.find((item) => normalizeHandleName(item.value) === normalizedUserName) || null;
}

async function patchLead(ctx, leadId, body) {
  const url = `https://${ctx.AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4/leads/${leadId}`;
  const response = await ctx.amoCrmPatch(url, body);

  if (response.status >= 400) {
    throw new Error(`amoCRM PATCH /leads/${leadId} HTTP ${response.status}: ${JSON.stringify(response.data)}`);
  }

  return response.data;
}

function findExecutionRows(settings) {
  return ((settings && settings.statusFieldMap) || []).filter((row) => row.botStatus === "execution");
}

// Строит текст с данными сделки для сообщений ТЗ п.12/13/14/15/16:
// "[номер договора], [цена] рублей, [ссылка на PDF проекта]".
function buildDealDescriptionText(ctx, lead) {
  const contractNumber = ctx.getFieldValueJoined(lead, CONTRACT_NUMBER_FIELD_ID) || `Сделка ${lead.id}`;
  const price = ctx.getFieldValueJoined(lead, lead.__priceFieldId) || lead.price || "—";
  const pdfLink = ctx.getFieldValueJoined(lead, PROJECT_PDF_FIELD_ID) || "(ссылка не найдена)";

  return { contractNumber, text: `${contractNumber}, ${price} рублей, ${pdfLink}` };
}

// ------------------------------------------------------------
// 7.2 Redis: куда слать push-уведомления + кто запросил согласование
// ------------------------------------------------------------
// Храним id диалога (direct_id) последнего обращения каждого пользователя —
// нужно, чтобы проактивно написать мастеру/руководителю, который сам сейчас
// ничего не нажимал (ТЗ п.14). Без этого амоMessenger никак не отдаёт
// "адрес" пользователя, который раньше не писал боту.
function directIdRedisKey(userName) {
  return `production_direct_id:${normalizeHandleName(userName)}`;
}

async function saveUserDirectId(ctx, userName, directId) {
  try {
    await ctx.redisRequest(["SET", directIdRedisKey(userName), String(directId)]);
  } catch (error) {
    console.error("[Бот производства] Не удалось сохранить direct_id:", error.message);
  }
}

async function loadUserDirectId(ctx, userName) {
  try {
    const response = await ctx.redisRequest(["GET", directIdRedisKey(userName)]);

    return response.result || null;
  } catch (error) {
    console.error("[Бот производства] Не удалось загрузить direct_id:", error.message);

    return null;
  }
}

// "Кто запросил распределение" — единственное, что не восстановить из
// amoCRM (поле «Исполнитель» ещё не записано на этапе ожидания
// согласования, см. ТЗ п.13), поэтому держим отдельно, по id сделки.
// Переживает перезапуск процесса (в отличие от productionUserState).
function pendingApprovalRedisKey(leadId) {
  return `production_pending_approval:${leadId}`;
}

async function savePendingApproval(ctx, leadId, data) {
  await ctx.redisRequest(["SET", pendingApprovalRedisKey(leadId), JSON.stringify(data)]);
}

async function loadPendingApproval(ctx, leadId) {
  const response = await ctx.redisRequest(["GET", pendingApprovalRedisKey(leadId)]);

  return response.result ? JSON.parse(response.result) : null;
}

async function clearPendingApproval(ctx, leadId) {
  await ctx.redisRequest(["DEL", pendingApprovalRedisKey(leadId)]);
}

// Рассылка сообщения всем активным пользователям роли, у кого есть
// известный direct_id (то есть кто хотя бы раз писал боту "старт" или любое
// сообщение). Для тех, у кого direct_id не известен, сообщение не
// отправляется — amoMessenger не даёт написать пользователю "в холодную".
async function notifyRoleUsers(ctx, settings, roleKey, text, buttons) {
  const entries = (settings && settings.roles && settings.roles[roleKey]) || [];
  let notified = 0;

  for (const entry of entries) {
    if (!entry.active || !entry.handle) {
      continue;
    }

    const directId = await loadUserDirectId(ctx, entry.handle);

    if (!directId) {
      console.log(
        `[Бот производства] Не удалось уведомить «${entry.handle}» (роль ${roleKey}): ` +
          "direct_id неизвестен (пользователь ещё не писал боту)."
      );
      continue;
    }

    try {
      await sendProductionDirectMessage(ctx, directId, text, buttons);
      notified++;
    } catch (error) {
      console.error(
        `[Бот производства] Не удалось отправить уведомление «${entry.handle}»:`,
        error.message
      );
    }
  }

  return notified;
}

// ------------------------------------------------------------
// 7.3 Главный обработчик кнопки "Распределение" (ТЗ п.9)
// ------------------------------------------------------------

async function handleDistributionButton(ctx, directId, userKey, userName, roleKey) {
  const settings = productionWidgetSettingsCache;

  if (!settings) {
    await sendProductionDirectMessage(
      ctx,
      directId,
      "❌ Настройки бота ещё не заполнены администратором. Обратитесь к администратору."
    );
    return;
  }

  try {
    if (roleKey === PERFORMER_ROLE_KEY) {
      await showDistributionListForPerformer(ctx, directId, userName, settings);
    } else if (roleKey === "metalShopForeman") {
      await showApprovalQueueForForeman(ctx, directId, settings, PIPELINE_NAME_METAL);
    } else if (roleKey === "woodShopForeman") {
      await showApprovalQueueForForeman(ctx, directId, settings, PIPELINE_NAME_WOOD);
    }
  } catch (error) {
    console.error("[Бот производства] Ошибка сценария «Распределение»:", error.stack || error.message);

    await sendProductionDirectMessage(
      ctx,
      directId,
      "❌ Не удалось получить список сделок. Попробуйте ещё раз позже или обратитесь к администратору."
    );
  }
}

// ТЗ п.10: у исполнителя — проверка "Не принято ОТК" по ВСЕМ воронкам, где
// у него может быть роль исполнителя, затем список доступных сделок.
async function showDistributionListForPerformer(ctx, directId, userName, settings) {
  const rows = findExecutionRows(settings);

  if (rows.length === 0) {
    await sendProductionDirectMessage(
      ctx,
      directId,
      "❌ В настройках не указан статус «Исполнение». Обратитесь к администратору."
    );
    return;
  }

  let hasOtkRejected = false;

  for (const row of rows) {
    if (!row.amoPipelineId || !row.executorFieldId) {
      continue;
    }

    const enumOption = await findFieldEnumForUserName(ctx, row.executorFieldId, userName);

    if (!enumOption) {
      continue;
    }

    const pipelineLeads = await getLeadsByPipeline(ctx, row.amoPipelineId, { withTags: true });

    const rejected = pipelineLeads.some(
      (lead) =>
        leadHasTag(lead, OTK_REJECTED_TAG_NAME) &&
        ctx.getFieldValues(lead, row.executorFieldId).includes(enumOption.value)
    );

    if (rejected) {
      hasOtkRejected = true;
      break;
    }
  }

  if (hasOtkRejected) {
    await sendProductionDirectMessage(
      ctx,
      directId,
      "У вас есть операции не принятые ОТК, принятие новых операций доступно только " +
        "после согласования с руководителем"
    );
  }

  const available = [];

  for (const row of rows) {
    if (!row.amoPipelineId || !row.amoStatusId) {
      continue;
    }

    const leads = await getLeadsByPipeline(ctx, row.amoPipelineId, { statusId: row.amoStatusId });

    for (const lead of leads) {
      // Сделки, уже ожидающие согласования руководителя (кто-то другой уже
      // нажал "Да"), не должны предлагаться к повторному распределению —
      // иначе два исполнителя могут "принять" одну и ту же сделку.
      if (isPendingManagerApproval(ctx, lead)) {
        continue;
      }

      lead.__priceFieldId = row.priceFieldId;
      available.push(lead);
    }
  }

  if (available.length === 0) {
    await sendProductionDirectMessage(ctx, directId, "Сделки доступные для распределения:\nНет доступных сделок.");
    return;
  }

  const buttons = available.map(
    (lead) => ctx.getFieldValueJoined(lead, CONTRACT_NUMBER_FIELD_ID) || `Сделка ${lead.id}`
  );

  await sendProductionDirectMessage(ctx, directId, "Сделки доступные для распределения:", buttons);
}

// ТЗ п.11: нажатие на кнопку с номером договора из списка выше. Список не
// храним между шагами (ТЗ п.18 — всегда живые данные) — ищем сделку заново
// среди текущих доступных.
async function tryHandlePerformerDealSelection(ctx, directId, userName, settings, trimmedText) {
  const rows = findExecutionRows(settings);

  for (const row of rows) {
    if (!row.amoPipelineId || !row.amoStatusId) {
      continue;
    }

    const leads = await getLeadsByPipeline(ctx, row.amoPipelineId, { statusId: row.amoStatusId });

    const lead = leads.find(
      (item) =>
        ctx.getFieldValueJoined(item, CONTRACT_NUMBER_FIELD_ID) === trimmedText &&
        !isPendingManagerApproval(ctx, item)
    );

    if (lead) {
      await sendProductionDirectMessage(ctx, directId, `Принять сделку ${trimmedText}?`, [
        buildTaggedButtonCompat(ctx, "Да", lead.id),
        buildTaggedButtonCompat(ctx, "Нет", lead.id)
      ]);

      return true;
    }
  }

  return false;
}

function buildTaggedButtonCompat(ctx, label, id) {
  return ctx.buildTaggedButton ? ctx.buildTaggedButton(label, id) : `${label} (${id})`;
}

function parseTaggedButtonCompat(ctx, text, label) {
  if (ctx.parseTaggedButton) {
    return ctx.parseTaggedButton(text, label);
  }

  const match = String(text || "").match(new RegExp(`^${label} \\((.+)\\)$`));

  return match ? match[1] : null;
}

// ТЗ п.11.1/12/13: ответ "Да"/"Нет" на "Принять сделку [X]?" у исполнителя.
async function handlePerformerDealConfirmReply(ctx, directId, userKey, userName, leadId, decision, settings) {
  if (decision === "no") {
    await showDistributionListForPerformer(ctx, directId, userName, settings);
    return;
  }

  const lead = await ctx.getLead(leadId);

  if (!lead) {
    await sendProductionDirectMessage(ctx, directId, "❌ Сделка не найдена. Возможно, она уже была изменена.");
    return;
  }

  const rows = findExecutionRows(settings);
  const row = rows.find((r) => Number(r.amoStatusId) === Number(lead.status_id));

  if (!row || !row.executorFieldId) {
    await sendProductionDirectMessage(
      ctx,
      directId,
      "❌ Не настроено поле «Исполнитель» для текущего статуса сделки. Обратитесь к администратору."
    );
    return;
  }

  const enumOption = await findFieldEnumForUserName(ctx, row.executorFieldId, userName);

  if (!enumOption) {
    await sendProductionDirectMessage(
      ctx,
      directId,
      "❌ Не удалось определить ваше значение в списке «Исполнитель». Обратитесь к администратору."
    );
    return;
  }

  const pipelineLeads = await getLeadsByPipeline(ctx, row.amoPipelineId, { withTags: true });

  const hasOtkRejected = pipelineLeads.some(
    (otherLead) =>
      leadHasTag(otherLead, OTK_REJECTED_TAG_NAME) &&
      ctx.getFieldValues(otherLead, row.executorFieldId).includes(enumOption.value)
  );

  lead.__priceFieldId = row.priceFieldId;

  const { contractNumber, text: dealText } = buildDealDescriptionText(ctx, lead);

  if (!hasOtkRejected) {
    // ТЗ п.12 — прямое назначение.
    if (!row.nextAmoStatusId) {
      await sendProductionDirectMessage(
        ctx,
        directId,
        "❌ Не настроен следующий статус amoCRM для текущего этапа. Обратитесь к администратору."
      );
      return;
    }

    await patchLead(ctx, leadId, {
      custom_fields_values: [
        { field_id: row.executorFieldId, values: [{ value: enumOption.value, enum_id: enumOption.id }] }
      ],
      status_id: Number(row.nextAmoStatusId)
    });

    await sendProductionDirectMessage(ctx, directId, `Сделка ${dealText} назначена вам в исполнение.`);
    return;
  }

  // ТЗ п.13-14 — нужно согласование руководителя.
  await patchLead(ctx, leadId, {
    custom_fields_values: [{ field_id: DISTRIBUTION_FLAG_FIELD_ID, values: [{ value: true }] }]
  });

  const pipeline = (await getPipelineNameById(ctx, row.amoPipelineId)) || PIPELINE_NAME_METAL;
  const managerRoleKey = MANAGER_ROLE_BY_PIPELINE_NAME[pipeline] || "metalShopForeman";

  await savePendingApproval(ctx, leadId, {
    requesterUserKey: String(userKey),
    requesterDirectId: directId,
    requesterUserName: userName
  });

  const notified = await notifyRoleUsers(
    ctx,
    settings,
    managerRoleKey,
    `У исполнителя есть операции не принятые ОТК, согласовать распределение новой сделки:\n${dealText}`,
    [buildTaggedButtonCompat(ctx, "Да", leadId), buildTaggedButtonCompat(ctx, "Нет", leadId)]
  );

  if (notified === 0) {
    console.log(
      `[Бот производства] Запрос согласования по сделке ${leadId} создан, но ни один ` +
        `активный «${managerRoleKey}» сейчас не достижим для push — согласование будет ` +
        "доступно через пункт меню «Распределение»."
    );
  }

  await sendProductionDirectMessage(
    ctx,
    directId,
    `Сделка ${contractNumber} отправлена на согласование руководителю, так как у вас есть ` +
      "операции не принятые ОТК."
  );
}

let pipelineNamesById = null;

async function getPipelineNameById(ctx, pipelineId) {
  await getPipelineIdByName(ctx, PIPELINE_NAME_METAL); // прогреваем pipelinesCache при первом обращении

  if (!pipelineNamesById) {
    pipelineNamesById = {};

    for (const name of Object.keys(pipelinesCache || {})) {
      pipelineNamesById[pipelinesCache[name]] = name;
    }
  }

  return pipelineNamesById[pipelineId] || null;
}

// ТЗ п.15/16: у мастера "Распределение" показывает очередь согласования.
async function showApprovalQueueForForeman(ctx, directId, settings, pipelineName) {
  const pipelineId = await getPipelineIdByName(ctx, pipelineName);

  if (!pipelineId) {
    await sendProductionDirectMessage(
      ctx,
      directId,
      `❌ Не удалось найти воронку «${pipelineName}» в amoCRM. Обратитесь к администратору.`
    );
    return;
  }

  const rows = findExecutionRows(settings);
  const row = rows.find((r) => Number(r.amoPipelineId) === Number(pipelineId));

  if (!row || !row.amoStatusId) {
    await sendProductionDirectMessage(
      ctx,
      directId,
      `❌ Не настроен статус «Исполнение» для воронки «${pipelineName}». Обратитесь к администратору.`
    );
    return;
  }

  const leads = await getLeadsByPipeline(ctx, pipelineId, { statusId: row.amoStatusId });

  const pending = leads.filter((lead) => isPendingManagerApproval(ctx, lead));

  if (pending.length === 0) {
    await sendProductionDirectMessage(ctx, directId, "Согласовать распределение новой сделки:\nНет сделок, ожидающих согласования.");
    return;
  }

  for (const lead of pending) {
    lead.__priceFieldId = row.priceFieldId;
  }

  const buttons = pending.map(
    (lead) => ctx.getFieldValueJoined(lead, CONTRACT_NUMBER_FIELD_ID) || `Сделка ${lead.id}`
  );

  await sendProductionDirectMessage(ctx, directId, "Согласовать распределение новой сделки:", buttons);
}

// Нажатие на кнопку с номером договора из очереди согласования мастера —
// повторно показываем то же "Да/Нет", что ТЗ п.14 присылает проактивно, так
// что дальнейшая обработка (handleApprovalReply) у обоих путей общая.
async function tryHandleForemanDealSelection(ctx, directId, settings, pipelineName, trimmedText) {
  const pipelineId = await getPipelineIdByName(ctx, pipelineName);

  if (!pipelineId) {
    return false;
  }

  const rows = findExecutionRows(settings);
  const row = rows.find((r) => Number(r.amoPipelineId) === Number(pipelineId));

  if (!row || !row.amoStatusId) {
    return false;
  }

  const leads = await getLeadsByPipeline(ctx, pipelineId, { statusId: row.amoStatusId });

  const lead = leads.find((item) => ctx.getFieldValueJoined(item, CONTRACT_NUMBER_FIELD_ID) === trimmedText);

  if (!lead) {
    return false;
  }

  if (!isPendingManagerApproval(ctx, lead)) {
    return false;
  }

  lead.__priceFieldId = row.priceFieldId;

  const { text: dealText } = buildDealDescriptionText(ctx, lead);

  await sendProductionDirectMessage(
    ctx,
    directId,
    `Согласовать распределение новой сделки:\n${dealText}`,
    [buildTaggedButtonCompat(ctx, "Да", lead.id), buildTaggedButtonCompat(ctx, "Нет", lead.id)]
  );

  return true;
}

// ТЗ п.14.1/14.2 — общий обработчик ответа руководителя "Да"/"Нет",
// независимо от того, пришёл ли он в ответ на push (п.14) или на выбор из
// очереди "Распределение" (п.15/16).
async function handleApprovalReply(ctx, directId, leadId, decision, settings) {
  const pending = await loadPendingApproval(ctx, leadId);

  if (!pending) {
    await sendProductionDirectMessage(
      ctx,
      directId,
      "❌ Запрос на согласование по этой сделке не найден — возможно, он уже обработан."
    );
    return;
  }

  const lead = await ctx.getLead(leadId);

  if (!lead) {
    await sendProductionDirectMessage(ctx, directId, "❌ Сделка не найдена.");
    await clearPendingApproval(ctx, leadId);
    return;
  }

  const rows = findExecutionRows(settings);
  const row = rows.find((r) => Number(r.amoStatusId) === Number(lead.status_id));

  lead.__priceFieldId = row && row.priceFieldId;

  const { contractNumber } = buildDealDescriptionText(ctx, lead);

  if (decision === "no") {
    await patchLead(ctx, leadId, {
      custom_fields_values: [{ field_id: DISTRIBUTION_FLAG_FIELD_ID, values: [{ value: false }] }]
    });

    await clearPendingApproval(ctx, leadId);

    await sendProductionDirectMessage(
      ctx,
      pending.requesterDirectId,
      `Распределение сделки ${contractNumber} не согласовано с руководителем`
    );

    await sendProductionDirectMessage(ctx, directId, "Отклонено.");
    return;
  }

  if (!row || !row.executorFieldId || !row.nextAmoStatusId) {
    await sendProductionDirectMessage(
      ctx,
      directId,
      "❌ Не настроены поля «Исполнитель»/«Следующий статус» для текущего этапа сделки. " +
        "Обратитесь к администратору."
    );
    return;
  }

  const enumOption = await findFieldEnumForUserName(ctx, row.executorFieldId, pending.requesterUserName);

  if (!enumOption) {
    await sendProductionDirectMessage(
      ctx,
      directId,
      `❌ Не удалось определить значение «Исполнитель» для «${pending.requesterUserName}». ` +
        "Обратитесь к администратору."
    );
    return;
  }

  await patchLead(ctx, leadId, {
    custom_fields_values: [
      { field_id: row.executorFieldId, values: [{ value: enumOption.value, enum_id: enumOption.id }] },
      { field_id: DISTRIBUTION_FLAG_FIELD_ID, values: [{ value: false }] }
    ],
    status_id: Number(row.nextAmoStatusId)
  });

  await clearPendingApproval(ctx, leadId);

  const { text: dealText } = buildDealDescriptionText(ctx, lead);

  await sendProductionDirectMessage(ctx, pending.requesterDirectId, `Сделка ${dealText} назначена вам в исполнение.`);

  await sendProductionDirectMessage(ctx, directId, "Согласовано.");
}

// ============================================================
// 8. ПЛАНИРОВЩИКИ
// ============================================================
// Фаза 1 сценариев не содержит — фоновых задач пока нет. Функция оставлена
// пустой ради симметрии вызова с designerBot.startSchedulers(ctx) в
// server.js, чтобы при появлении сценариев не пришлось снова менять
// server.js.
function startSchedulers(ctx) {
  console.log("[Бот производства] Планировщики: сценариев пока нет, ничего не запущено.");
}

// ============================================================
// 9. WEBHOOK И МАРШРУТЫ
// ============================================================

function init(app, ctx) {
  app.get("/oauth/amomessenger/production", (req, res) => {
    if (!AMOMESSENGER_PRODUCTION_CLIENT_ID) {
      return res.status(500).send("AMOMESSENGER_PRODUCTION_CLIENT_ID не задан");
    }

    const scope = String(req.query.scope || AMOMESSENGER_PRODUCTION_SCOPE || "").trim();

    if (!scope) {
      return res.status(500).send(
        "Не задан scope. Укажите AMOMESSENGER_PRODUCTION_SCOPE в переменных окружения " +
          "либо откройте /oauth/amomessenger/production?scope=... с нужным значением вручную."
      );
    }

    const url =
      "https://id.amo.tm/oauth2/authorize?" +
      `client_id=${encodeURIComponent(AMOMESSENGER_PRODUCTION_CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(AMOMESSENGER_PRODUCTION_REDIRECT_URI)}` +
      `&scope=${encodeURIComponent(scope)}` +
      "&response_type=code";

    console.log("[Бот производства] amoMessenger OAuth URL:", url);

    res.redirect(url);
  });

  app.get("/oauth/amomessenger/production/callback", async (req, res) => {
    const code = req.query.code;

    if (!code) {
      return res.status(400).send("<h2>Ошибка OAuth</h2><p>Код авторизации не получен.</p>");
    }

    try {
      const response = await axios.post(
        "https://id.amo.tm/oauth2/access_token",
        {
          grant_type: "authorization_code",
          client_id: AMOMESSENGER_PRODUCTION_CLIENT_ID,
          client_secret: AMOMESSENGER_PRODUCTION_CLIENT_SECRET,
          redirect_uri: AMOMESSENGER_PRODUCTION_REDIRECT_URI,
          code
        },
        { headers: { "Content-Type": "application/json" }, timeout: 30000 }
      );

      productionAccessToken = response.data.access_token;
      productionRefreshToken = response.data.refresh_token;

      await saveProductionTokensToRedis(ctx);

      res.send(`
        <!DOCTYPE html>
        <html lang="ru">
        <head><meta charset="UTF-8"><title>Бот производства — OAuth</title></head>
        <body style="font-family:Arial;padding:40px;">
          <h2>Авторизация бота производства выполнена</h2>
          <p>Access Token получен: <b>ДА</b></p>
          <p>Refresh Token получен: <b>ДА</b></p>
          <p>Теперь можно закрыть это окно.</p>
        </body>
        </html>
      `);
    } catch (error) {
      console.error(
        "[Бот производства] OAuth ERROR:",
        error.response ? error.response.data : error.message
      );

      res.status(500).json({
        status: "Ошибка OAuth",
        message: error.response?.data || error.message
      });
    }
  });

  app.get("/oauth/amomessenger/production/status", (req, res) => {
    res.json({
      status: productionAccessToken ? "OK" : "Токен не найден",
      access_token: productionAccessToken ? "ДА" : "НЕТ",
      refresh_token: productionRefreshToken ? "ДА" : "НЕТ"
    });
  });

  // CORS: виджет выполняется прямо на странице amoCRM (например
  // https://zlmk.amocrm.ru), а запросы шлёт на ДРУГОЙ домен (этот backend)
  // — то есть это настоящий межсайтовый (cross-origin) запрос из браузера,
  // и без заголовков ниже браузер блокирует его политикой CORS ещё до
  // отправки (preflight OPTIONS).
  const widgetAllowedOrigin = `https://${ctx.AMOCRM_SUBDOMAIN}.amocrm.ru`;

  function setWidgetCorsHeaders(res) {
    res.set({
      "Access-Control-Allow-Origin": widgetAllowedOrigin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Widget-Secret"
    });
  }

  app.options("/widget/production/settings", (req, res) => {
    setWidgetCorsHeaders(res);
    res.sendStatus(204);
  });

  // Гибридное сохранение настроек виджета: вызывается из onSave() в
  // widget-production/script.js после того, как виджет уже сохранил те же
  // данные через self.set_settings(). Redis — источник истины для бота.
  app.post("/widget/production/settings", async (req, res) => {
    setWidgetCorsHeaders(res);

    if (!isValidWidgetSecret(req)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const validation = validateProductionWidgetSettings(req.body);

    if (!validation.valid) {
      return res.status(400).json({ error: validation.error, field: validation.field });
    }

    try {
      const saved = await saveProductionWidgetSettingsToRedis(ctx, req.body);

      res.json({ status: "OK", updatedAt: saved.updatedAt });
    } catch (error) {
      console.error("[Бот производства] Ошибка сохранения настроек виджета:", error.message);

      res.status(500).json({ error: "Не удалось сохранить настройки." });
    }
  });

  app.get("/widget/production/settings", (req, res) => {
    setWidgetCorsHeaders(res);

    if (!isValidWidgetSecret(req)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    res.json(productionWidgetSettingsCache || null);
  });

  // ВРЕМЕННЫЙ ЭНДПОИНТ (по аналогии с /debug/tokens и /debug/project/registry)
  // — просмотр сохранённых настроек виджета без прямого доступа к Redis.
  app.get("/debug/production/settings", (req, res) => {
    const DEBUG_SECRET = process.env.DEBUG_SECRET || "";

    if (!DEBUG_SECRET) {
      return res.status(500).send(
        "DEBUG_SECRET не задан в Environment Variables. Задайте его, чтобы использовать этот эндпоинт."
      );
    }

    if (req.query.secret !== DEBUG_SECRET) {
      return res.status(403).send("Forbidden");
    }

    res.json({
      settings: productionWidgetSettingsCache,
      updatedAt: productionWidgetSettingsUpdatedAt
    });
  });

  app.get("/status/production", (req, res) => {
    res.json({
      status: "OK",
      service: "amoMessenger production bot",
      bot_id: BOT_ID,
      amomessenger_token: productionAccessToken ? "ДА" : "НЕТ",
      widget_settings_saved: productionWidgetSettingsCache ? "ДА" : "НЕТ",
      widget_settings_updated_at: productionWidgetSettingsUpdatedAt
    });
  });

  // Отдельный webhook-маршрут для отдельного amoMessenger-приложения — по
  // тому же принципу, что и /webhook/project у бота проектировщиков.
  // "старт" запускает авторизацию/главное меню (ТЗ п.7-8); остальные
  // пункты меню, включая "Распределение", — пока заглушки.
  app.post("/webhook/production", async (req, res) => {
    const body = req.body || {};

    res.status(200).json({ status: "OK" });

    console.log("[Бот производства] Webhook получен, event_type:", body.event_type);

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
      const userName = ctx.extractAmoMessengerUserName(message.author, context, message);

      if (!directId || !userKey) {
        console.error("[Бот производства] Не удалось определить direct_id или user_id из вебхука.");
        return;
      }

      console.log(
        "[Бот производства] Входящее сообщение:",
        JSON.stringify({ userKey: String(userKey), userName, text })
      );

      const trimmedText = String(text || "").trim();

      if (ctx.isStartCommand(trimmedText)) {
        await handleStartCommand(ctx, directId, userKey, userName);
        return;
      }

      const state = productionUserState[userKey];

      if (!state) {
        await sendProductionDirectMessage(
          ctx,
          directId,
          "Чтобы начать работу с ботом, напишите «старт»."
        );
        return;
      }

      await saveUserDirectId(ctx, userName, directId);

      const settings = productionWidgetSettingsCache;

      // "Да (id)" / "Нет (id)" — ответ на подтверждение (ТЗ п.11/14), кем бы
      // оно ни было инициировано (сам нажал в списке или пришло по push).
      const yesLeadId = parseTaggedButtonCompat(ctx, trimmedText, "Да");
      const noLeadId = parseTaggedButtonCompat(ctx, trimmedText, "Нет");

      if ((yesLeadId || noLeadId) && settings) {
        const leadId = yesLeadId || noLeadId;
        const decision = yesLeadId ? "yes" : "no";

        try {
          if (state.roleKey === PERFORMER_ROLE_KEY) {
            await handlePerformerDealConfirmReply(ctx, directId, userKey, userName, leadId, decision, settings);
          } else if (state.roleKey === "metalShopForeman" || state.roleKey === "woodShopForeman") {
            await handleApprovalReply(ctx, directId, leadId, decision, settings);
          } else {
            await handleUnknownCommand(ctx, directId, state.roleKey);
          }
        } catch (error) {
          console.error("[Бот производства] Ошибка обработки Да/Нет:", error.stack || error.message);

          await sendProductionDirectMessage(
            ctx,
            directId,
            "❌ Не удалось обработать ответ. Попробуйте ещё раз позже или обратитесь к администратору."
          );
        }

        return;
      }

      const roleButtons = MAIN_MENU_BUTTONS[state.roleKey] || [];

      if (roleButtons.includes(trimmedText)) {
        if (trimmedText === "Распределение" && DISTRIBUTION_ROLE_KEYS.includes(state.roleKey)) {
          await handleDistributionButton(ctx, directId, userKey, userName, state.roleKey);
        } else {
          await handleMenuPlaceholder(ctx, directId, trimmedText);
        }

        return;
      }

      // Не пункт меню — проверяем, не нажатие ли это на номер договора из
      // списка "Распределение" (ТЗ п.11/15/16). Список кнопок с номерами
      // договоров не хранится между шагами, поэтому ищем сделку заново.
      if (settings && DISTRIBUTION_ROLE_KEYS.includes(state.roleKey)) {
        let handled = false;

        try {
          if (state.roleKey === PERFORMER_ROLE_KEY) {
            handled = await tryHandlePerformerDealSelection(ctx, directId, userName, settings, trimmedText);
          } else if (state.roleKey === "metalShopForeman") {
            handled = await tryHandleForemanDealSelection(ctx, directId, settings, PIPELINE_NAME_METAL, trimmedText);
          } else if (state.roleKey === "woodShopForeman") {
            handled = await tryHandleForemanDealSelection(ctx, directId, settings, PIPELINE_NAME_WOOD, trimmedText);
          }
        } catch (error) {
          console.error("[Бот производства] Ошибка выбора сделки:", error.stack || error.message);

          await sendProductionDirectMessage(
            ctx,
            directId,
            "❌ Не удалось обработать выбор сделки. Попробуйте ещё раз позже или обратитесь к администратору."
          );

          return;
        }

        if (handled) {
          return;
        }
      }

      await handleUnknownCommand(ctx, directId, state.roleKey);
    } catch (error) {
      console.error("[Бот производства] WEBHOOK ERROR:", error.stack || error.message);
    }
  });

  console.log(
    "[Бот производства] Маршруты зарегистрированы: /webhook/production, " +
      "/oauth/amomessenger/production(/callback|/status), /widget/production/settings, " +
      "/status/production"
  );
}

// ============================================================
// 10. ЭКСПОРТ
// ============================================================

module.exports = {
  init,
  loadTokens: async (ctx) => {
    await loadProductionTokensFromRedis(ctx);
    await loadProductionWidgetSettingsFromRedis(ctx);
  },
  startSchedulers,
  // Экспортируется для модульной проверки (validateProductionWidgetSettings
  // не завязана на Express/ctx и её удобно проверить отдельно).
  validateProductionWidgetSettings
};
