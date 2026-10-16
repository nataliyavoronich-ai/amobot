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

// Поля справочника "Таблица 2. Поля, используемые в боте" из исходного ТЗ
// v2.0 — технические поля конкретно этого сценария, не вынесенные в виджет
// (в отличие от Исполнителя/Плана/Факта/Цены из "Связи этапов и полей").
const DISTRIBUTION_FLAG_FIELD_ID = 555072; // "[Бот] Распределение Мастера", флаг
const EXECUTOR_PENDING_FIELD_ID = 555074; // "[Бот] Согласование исполнителя", текст
const NOT_ACCEPTED_OTK_FLAG_FIELD_ID = 555166; // "[Бот] Не приняты работы: ОТК", флаг
const NOT_ACCEPTED_MASTER_FLAG_FIELD_ID = 555168; // "[Бот] Не приняты работы: Мастер", флаг
const PRODUCT_FIELD_ID = 172572; // "Продукт", список
const PROJECT_PDF_FIELD_ID = 543268; // "Проект в производство pdf", ссылка
const CONTRACT_NUMBER_FIELD_ID = 412776; // "№ Дог/Зам. листа", текст

const OTK_REJECTED_TAG_NAME = "Не принято ОТК";

// ТЗ п.T-2, группа 3: сделки, чей № договора содержит один из префиксов.
const PRIORITY_CONTRACT_PREFIXES = ["ПД/", "ПМ/", "ПС/"];

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

// ТЗ T-4.2/T-5: "Статус бота" в "Связи этапов и полей" принимает одно из
// двух значений — "Распределение" (сделка ждёт назначения исполнителя) и
// "Исполнение" (уже назначена, в работе). Оба набора строк нужны отдельно
// в разных местах сценария — не взаимозаменяемы.
function findDistributionRows(settings) {
  return ((settings && settings.statusFieldMap) || []).filter((row) => row.botStatus === "distribution");
}

function findExecutionRows(settings) {
  return ((settings && settings.statusFieldMap) || []).filter((row) => row.botStatus === "execution");
}

function fieldIsTruthy(ctx, lead, fieldId) {
  return ctx.getFieldValues(lead, fieldId).some((v) => v === true || v === "true" || v === "1");
}

function getContractNumberText(ctx, lead) {
  return ctx.getFieldValueJoined(lead, CONTRACT_NUMBER_FIELD_ID) || `Сделка ${lead.id}`;
}

function getProductText(ctx, lead) {
  return ctx.getFieldValueJoined(lead, PRODUCT_FIELD_ID) || "—";
}

function getPriceText(ctx, lead, priceFieldId) {
  return ctx.getFieldValueJoined(lead, priceFieldId) || (lead.price != null ? String(lead.price) : "—");
}

// ТЗ, раздел "Ограничения и допущения" к T-2: во ВСЕХ сообщениях с номером
// договора, КРОМЕ сценария T-4 (Распределение у Исполнителей), номер
// договора должен быть гиперссылкой на "Проект в производство pdf".
function getContractNumberDisplay(ctx, lead, { hyperlink = false } = {}) {
  const contractNumber = getContractNumberText(ctx, lead);

  if (!hyperlink) {
    return contractNumber;
  }

  const pdfLink = ctx.getFieldValueJoined(lead, PROJECT_PDF_FIELD_ID);

  return pdfLink ? `[${contractNumber}](${pdfLink})` : contractNumber;
}

// ТЗ T-2 — сортировка кнопок сделок в любом списке:
// 1) есть непринятые работы (ОТК или Мастер);
// 2) сделки к исправлению (тег "Не принято ОТК");
// 3) № договора содержит "ПД/"/"ПМ/"/"ПС/";
// 4) остальные.
function dealSortGroup(ctx, lead) {
  if (fieldIsTruthy(ctx, lead, NOT_ACCEPTED_OTK_FLAG_FIELD_ID) || fieldIsTruthy(ctx, lead, NOT_ACCEPTED_MASTER_FLAG_FIELD_ID)) {
    return 1;
  }

  if (leadHasTag(lead, OTK_REJECTED_TAG_NAME)) {
    return 2;
  }

  const contractNumber = getContractNumberText(ctx, lead);

  if (PRIORITY_CONTRACT_PREFIXES.some((prefix) => contractNumber.includes(prefix))) {
    return 3;
  }

  return 4;
}

function sortDealsForButtons(ctx, leads) {
  return [...leads].sort((a, b) => dealSortGroup(ctx, a) - dealSortGroup(ctx, b));
}

// ------------------------------------------------------------
// 7.2 Redis: куда слать push-уведомления
// ------------------------------------------------------------
// Храним id диалога (direct_id) последнего обращения каждого пользователя —
// нужно, чтобы проактивно написать мастеру, который сам сейчас ничего не
// нажимал (ТЗ T-5, случай "Исполнитель берёт в работу сделку"). Без этого
// amoMessenger никак не отдаёт "адрес" пользователя, который раньше не
// писал боту. "Кто запросил распределение" в Redis не хранится — для этого
// есть amoCRM-поле "[Бот] Согласование исполнителя" (ТЗ T-4.5.2.2).
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

// Рассылка сообщения всем активным пользователям роли, у кого есть
// известный direct_id (то есть кто хотя бы раз писал боту "старт" или любое
// сообщение). Для тех, у кого direct_id не известен, сообщение не
// отправляется — amoMessenger не даёт написать пользователю "в холодную".
async function notifyRoleUsers(ctx, settings, roleKey, text, buttons, options) {
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
      await sendProductionDirectMessage(ctx, directId, text, buttons, options);
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

// ТЗ T-4.1: проверка "Не принято ОТК" среди собственных сделок исполнителя
// со статусом бота "Исполнение" (не "Распределение" — это две разные группы
// строк настроек, см. findExecutionRows/findDistributionRows).
async function performerHasOtkRejectedDeals(ctx, userName, settings) {
  const executionRows = findExecutionRows(settings);

  for (const row of executionRows) {
    if (!row.amoPipelineId || !row.amoStatusId || !row.executorFieldId) {
      continue;
    }

    const enumOption = await findFieldEnumForUserName(ctx, row.executorFieldId, userName);

    if (!enumOption) {
      continue;
    }

    const leads = await getLeadsByPipeline(ctx, row.amoPipelineId, { statusId: row.amoStatusId, withTags: true });

    const rejected = leads.some(
      (lead) =>
        leadHasTag(lead, OTK_REJECTED_TAG_NAME) &&
        ctx.getFieldValues(lead, row.executorFieldId).includes(enumOption.value)
    );

    if (rejected) {
      return true;
    }
  }

  return false;
}

// ТЗ T-4.1-4.3: у исполнителя — предупреждение про "Не принято ОТК" (если
// есть), затем список сделок, доступных для распределения.
async function showDistributionListForPerformer(ctx, directId, userName, settings) {
  if (await performerHasOtkRejectedDeals(ctx, userName, settings)) {
    await sendProductionDirectMessage(
      ctx,
      directId,
      "У вас есть операции, не принятые ОТК. Принятие новых операций доступно только " +
        "после согласования с мастером"
    );
  }

  // T-4.2: статус бота "Распределение", поле "Исполнитель" этой строки у
  // сделки не заполнено, пользователь — допустимый вариант для этого поля.
  const distributionRows = findDistributionRows(settings);

  if (distributionRows.length === 0) {
    await sendProductionDirectMessage(
      ctx,
      directId,
      "❌ В настройках не указан статус «Распределение». Обратитесь к администратору."
    );
    return;
  }

  let available = [];

  for (const row of distributionRows) {
    if (!row.amoPipelineId || !row.amoStatusId || !row.executorFieldId) {
      continue;
    }

    const enumOption = await findFieldEnumForUserName(ctx, row.executorFieldId, userName);

    if (!enumOption) {
      continue;
    }

    const leads = await getLeadsByPipeline(ctx, row.amoPipelineId, { statusId: row.amoStatusId });

    for (const lead of leads) {
      if (ctx.getFieldValues(lead, row.executorFieldId).length > 0) {
        continue; // уже назначено кому-то
      }

      available.push(lead);
    }
  }

  if (available.length === 0) {
    await sendProductionDirectMessage(ctx, directId, "Сделки, доступные для распределения:\nНет доступных сделок.");
    return;
  }

  available = sortDealsForButtons(ctx, available);

  const buttons = available.map((lead) => getContractNumberText(ctx, lead));

  await sendProductionDirectMessage(ctx, directId, "Сделки, доступные для распределения:", buttons);
}

// ТЗ T-4.3-4.5: нажатие на кнопку с номером договора из списка выше. Список
// не храним между шагами (ТЗ — всегда живые данные) — ищем сделку заново
// среди текущих доступных.
async function tryHandlePerformerDealSelection(ctx, directId, userName, settings, trimmedText) {
  const distributionRows = findDistributionRows(settings);

  for (const row of distributionRows) {
    if (!row.amoPipelineId || !row.amoStatusId) {
      continue;
    }

    const leads = await getLeadsByPipeline(ctx, row.amoPipelineId, { statusId: row.amoStatusId });

    const lead = leads.find((item) => getContractNumberText(ctx, item) === trimmedText);

    if (!lead) {
      continue;
    }

    const contractNumber = getContractNumberText(ctx, lead);

    // T-4.4: сделка уже на согласовании у мастера — показать без кнопок.
    if (fieldIsTruthy(ctx, lead, DISTRIBUTION_FLAG_FIELD_ID)) {
      await sendProductionDirectMessage(
        ctx,
        directId,
        `Сделка № договора ${contractNumber} находится на распределении у мастера`
      );
      return true;
    }

    await sendProductionDirectMessage(ctx, directId, `Принять сделку № договора ${contractNumber}?`, [
      buildTaggedButtonCompat(ctx, "Да", lead.id),
      buildTaggedButtonCompat(ctx, "Нет", lead.id)
    ]);

    return true;
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
  // T-4.5.1
  if (decision === "no") {
    await showDistributionListForPerformer(ctx, directId, userName, settings);
    return;
  }

  const lead = await ctx.getLead(leadId);

  if (!lead) {
    await sendProductionDirectMessage(ctx, directId, "❌ Сделка не найдена. Возможно, она уже была изменена.");
    return;
  }

  // Сделка сейчас в статусе "Распределение" — именно там, в "Связи этапов и
  // полей", указаны нужные для назначения поля (T-4.5.2).
  const distributionRows = findDistributionRows(settings);
  const row = distributionRows.find((r) => Number(r.amoStatusId) === Number(lead.status_id));

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

  // T-4.5.2: та же проверка "Не принято ОТК", что в T-4.1 — заново, т.к.
  // ситуация могла измениться между показом списка и нажатием "Да".
  const hasOtkRejected = await performerHasOtkRejectedDeals(ctx, userName, settings);

  const contractNumber = getContractNumberText(ctx, lead);

  if (!hasOtkRejected) {
    // T-4.5.2.1
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
        { field_id: row.executorFieldId, values: [{ value: enumOption.value, enum_id: enumOption.id }] },
        { field_id: DISTRIBUTION_FLAG_FIELD_ID, values: [{ value: false }] },
        { field_id: EXECUTOR_PENDING_FIELD_ID, values: [{ value: "" }] }
      ],
      status_id: Number(row.nextAmoStatusId)
    });

    const product = getProductText(ctx, lead);
    const price = getPriceText(ctx, lead, row.priceFieldId);

    await sendProductionDirectMessage(
      ctx,
      directId,
      `№ договора: ${contractNumber} Продукт: ${product} Цена: ${price} руб назначена вам в исполнение`
    );
    return;
  }

  // T-4.5.2.2 — нужно согласование мастера.
  await patchLead(ctx, leadId, {
    custom_fields_values: [
      { field_id: DISTRIBUTION_FLAG_FIELD_ID, values: [{ value: true }] },
      { field_id: EXECUTOR_PENDING_FIELD_ID, values: [{ value: userName }] }
    ]
  });

  const pipelineName = (await getPipelineNameById(ctx, row.amoPipelineId)) || PIPELINE_NAME_METAL;
  const managerRoleKey = MANAGER_ROLE_BY_PIPELINE_NAME[pipelineName] || "metalShopForeman";
  const price = getPriceText(ctx, lead, row.priceFieldId);
  const contractNumberLinked = getContractNumberDisplay(ctx, lead, { hyperlink: true });

  // T-5, случай "Исполнитель берёт в работу новую сделку" — мастеру сразу
  // приходит сообщение 45 (т.к. сделка уже известна, промежуточный список не
  // нужен); то же сообщение мастер увидит, открыв "Распределение" сам
  // (tryHandleForemanDealSelection), если push не дошёл ни до кого.
  const notified = await notifyRoleUsers(
    ctx,
    settings,
    managerRoleKey,
    `У ${userName} есть операции, непринятые ОТК. Согласовать распределение новой сделки:\n` +
      `№ ${contractNumberLinked}, Цена ${price}, руб.?`,
    [buildTaggedButtonCompat(ctx, "Да", leadId), buildTaggedButtonCompat(ctx, "Нет", leadId)],
    { markdown: true }
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
    `Сделка № договора ${contractNumber} отправлена на согласование мастеру, так как у вас есть ` +
      "операции, не принятые ОТК."
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

// ТЗ T-5.1: у мастера "Распределение" показывает очередь согласования —
// критерий отбора: статус бота "Распределение" + заполнено поле
// "[Бот] Распределение Мастера" (НЕ статус "Исполнение" — это другая группа
// строк настроек).
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

  const distributionRows = findDistributionRows(settings);
  const row = distributionRows.find((r) => Number(r.amoPipelineId) === Number(pipelineId));

  if (!row || !row.amoStatusId) {
    await sendProductionDirectMessage(
      ctx,
      directId,
      `❌ Не настроен статус «Распределение» для воронки «${pipelineName}». Обратитесь к администратору.`
    );
    return;
  }

  const leads = await getLeadsByPipeline(ctx, pipelineId, { statusId: row.amoStatusId });

  let pending = leads.filter((lead) => fieldIsTruthy(ctx, lead, DISTRIBUTION_FLAG_FIELD_ID));

  const header =
    pipelineName === PIPELINE_NAME_WOOD
      ? "Согласовать распределение новой сделки в Производстве Дерево:"
      : "Согласовать распределение новой сделки в Производстве Металл:";

  if (pending.length === 0) {
    await sendProductionDirectMessage(ctx, directId, `${header}\nНет сделок, ожидающих согласования.`);
    return;
  }

  pending = sortDealsForButtons(ctx, pending);

  const buttons = pending.map((lead) => getContractNumberText(ctx, lead));

  await sendProductionDirectMessage(ctx, directId, header, buttons);
}

// Нажатие на кнопку с номером договора из очереди согласования мастера —
// повторно показываем сообщение 45 (ТЗ T-5.3), которое также приходит
// проактивно (push) из handlePerformerDealConfirmReply — дальнейшая
// обработка (handleApprovalReply) у обоих путей общая.
async function tryHandleForemanDealSelection(ctx, directId, settings, pipelineName, trimmedText) {
  const pipelineId = await getPipelineIdByName(ctx, pipelineName);

  if (!pipelineId) {
    return false;
  }

  const distributionRows = findDistributionRows(settings);
  const row = distributionRows.find((r) => Number(r.amoPipelineId) === Number(pipelineId));

  if (!row || !row.amoStatusId) {
    return false;
  }

  const leads = await getLeadsByPipeline(ctx, pipelineId, { statusId: row.amoStatusId });

  const lead = leads.find((item) => getContractNumberText(ctx, item) === trimmedText);

  if (!lead || !fieldIsTruthy(ctx, lead, DISTRIBUTION_FLAG_FIELD_ID)) {
    return false;
  }

  const requesterUserName = ctx.getFieldValueJoined(lead, EXECUTOR_PENDING_FIELD_ID);
  const price = getPriceText(ctx, lead, row.priceFieldId);
  const contractNumberLinked = getContractNumberDisplay(ctx, lead, { hyperlink: true });

  await sendProductionDirectMessage(
    ctx,
    directId,
    `У ${requesterUserName || "исполнителя"} есть операции, непринятые ОТК. Согласовать распределение новой сделки:\n` +
      `№ ${contractNumberLinked}, Цена ${price}, руб.?`,
    [buildTaggedButtonCompat(ctx, "Да", lead.id), buildTaggedButtonCompat(ctx, "Нет", lead.id)],
    { markdown: true }
  );

  return true;
}

// ТЗ T-5.3.1/T-5.3.2 — общий обработчик ответа мастера "Да"/"Нет",
// независимо от того, пришёл ли он в ответ на push (из
// handlePerformerDealConfirmReply) или на выбор сделки из очереди
// "Распределение" (tryHandleForemanDealSelection). Кто запросил
// распределение, читаем из самой сделки (поле "[Бот] Согласование
// исполнителя", id 555074) — отдельное хранилище для этого не нужно.
async function handleApprovalReply(ctx, directId, leadId, decision, settings) {
  const lead = await ctx.getLead(leadId);

  if (!lead) {
    await sendProductionDirectMessage(ctx, directId, "❌ Сделка не найдена.");
    return;
  }

  const requesterUserName = ctx.getFieldValueJoined(lead, EXECUTOR_PENDING_FIELD_ID);
  const requesterDirectId = requesterUserName ? await loadUserDirectId(ctx, requesterUserName) : null;

  if (!fieldIsTruthy(ctx, lead, DISTRIBUTION_FLAG_FIELD_ID) || !requesterUserName) {
    await sendProductionDirectMessage(
      ctx,
      directId,
      "❌ Запрос на согласование по этой сделке не найден — возможно, он уже обработан."
    );
    return;
  }

  const distributionRows = findDistributionRows(settings);
  const row = distributionRows.find((r) => Number(r.amoStatusId) === Number(lead.status_id));

  const contractNumber = getContractNumberText(ctx, lead);

  // T-5.3.2
  if (decision === "no") {
    await patchLead(ctx, leadId, {
      custom_fields_values: [
        { field_id: DISTRIBUTION_FLAG_FIELD_ID, values: [{ value: false }] },
        { field_id: EXECUTOR_PENDING_FIELD_ID, values: [{ value: "" }] }
      ]
    });

    if (requesterDirectId) {
      await sendProductionDirectMessage(
        ctx,
        requesterDirectId,
        `Распределение сделки: № ${contractNumber} НЕ согласовано с Мастером.`
      );
    }

    await sendProductionDirectMessage(ctx, directId, "Сделка не распределена");
    return;
  }

  // T-5.3.1
  if (!row || !row.executorFieldId || !row.nextAmoStatusId) {
    await sendProductionDirectMessage(
      ctx,
      directId,
      "❌ Не настроены поля «Исполнитель»/«Следующий статус» для текущего этапа сделки. " +
        "Обратитесь к администратору."
    );
    return;
  }

  const enumOption = await findFieldEnumForUserName(ctx, row.executorFieldId, requesterUserName);

  if (!enumOption) {
    await sendProductionDirectMessage(
      ctx,
      directId,
      `❌ Не удалось определить значение «Исполнитель» для «${requesterUserName}». ` +
        "Обратитесь к администратору."
    );
    return;
  }

  await patchLead(ctx, leadId, {
    custom_fields_values: [
      { field_id: row.executorFieldId, values: [{ value: enumOption.value, enum_id: enumOption.id }] },
      { field_id: DISTRIBUTION_FLAG_FIELD_ID, values: [{ value: false }] },
      { field_id: EXECUTOR_PENDING_FIELD_ID, values: [{ value: "" }] }
    ],
    status_id: Number(row.nextAmoStatusId)
  });

  const price = getPriceText(ctx, lead, row.priceFieldId);

  if (requesterDirectId) {
    await sendProductionDirectMessage(
      ctx,
      requesterDirectId,
      `Сделка №${contractNumber}, Цена: ${price}, руб. назначена вам в исполнение`
    );
  }

  await sendProductionDirectMessage(ctx, directId, "Сделка распределена");
}

// ============================================================
// 8. СЦЕНАРИЙ «ИСПОЛНЕНИЕ» У ИСПОЛНИТЕЛЕЙ (ТЗ T-6/T-7, частично T-8/T-9/T-11/T-20)
// ============================================================
// T-9 (решение ОТК по непринятой работе), T-11 (решение Мастера по
// непринятой работе), T-12 (Промежуточный ОТК) и T-20 (Ожидание решения) —
// отдельные сценарии, которые ссылаются сюда, но сами ещё не реализованы.
// Везде, где T-6 должен передать работу одному из них, ниже — заглушка:
// нужные поля/теги в сделке выставляются по ТЗ, пользователю показывается
// понятное сообщение, но собственного списка/UI у этих сценариев пока нет.

// --- Поля (см. "Таблица 2. Поля, используемые в боте" в ТЗ v2.0) ---
const DEFECT_PHOTO_LINK_FIELD_ID = 555164; // "[Бот] Ссылка на фото", ссылка — фото дефекта (T-6.5.4/T-6.5.6); у фото готового изделия (T-6.5.1) своего поля-ссылки в ТЗ нет
const NOT_ACCEPTED_TEXT_FIELD_ID = 555162; // "[Бот] Не принято", текстовая область
const INTERMEDIATE_OTK_FLAG_FIELD_ID = 555172; // "[Бот] Промежуточный ОТК", флаг
const COST_REVISION_FIELD_ID = 557156; // "[Бот] Согласование стоимости 1", текстовая область — JSON-массив {status_id, new_price, username}
const DXF_LINK_FIELD_ID = 543270; // "Проект в производство dxf", ссылка
const PLASMA_EXECUTION_STATUS_ID = 33139332; // статус "Плазма исполнение"
const DOZAKUPKA_TAG_NAME = "Дозакупка";

const PRODUCTION_UPLOAD_FOLDER_NAME = "Производство";
const FINISH_UPLOAD_BUTTON = "Завершить загрузку";

// ------------------------------------------------------------
// 8.1 amoCRM: название статуса по id (для карточек/сообщений с {{Название
// статуса сделки}}) — кэшируем по pipelineId, т.к. список статусов воронки
// меняется так же редко, как сам список воронок.
// ------------------------------------------------------------

const statusNamesByPipelineId = {};

async function getStatusNameById(ctx, pipelineId, statusId) {
  if (!statusNamesByPipelineId[pipelineId]) {
    const url = `https://${ctx.AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4/leads/pipelines/${pipelineId}/statuses`;
    const response = await ctx.amoCrmGet(url, {});

    if (response.status !== 200) {
      throw new Error(`amoCRM GET /leads/pipelines/${pipelineId}/statuses HTTP ${response.status}`);
    }

    const statuses = (response.data && response.data._embedded && response.data._embedded.statuses) || [];
    const map = {};

    for (const status of statuses) {
      map[status.id] = status.name;
    }

    statusNamesByPipelineId[pipelineId] = map;
  }

  return statusNamesByPipelineId[pipelineId][statusId] || "—";
}

// ------------------------------------------------------------
// 8.2 Яндекс.Диск — папка "Производство" внутри папки сделки (ТЗ T-7)
// ------------------------------------------------------------

function buildProductionFolderPaths(ctx, leadId) {
  const leadFolderPath = `${ctx.YANDEX_DISK_ROOT_FOLDER}/Сделка (id ${leadId})`;
  const reportsPath = `${leadFolderPath}/Отчеты и проекты`;

  return { reportsPath, productionPath: `${reportsPath}/${PRODUCTION_UPLOAD_FOLDER_NAME}` };
}

async function ensureProductionFolder(ctx, reportsPath, productionPath) {
  await ctx.ydEnsureFolderPath(reportsPath);
  await ctx.ydEnsureFolder(productionPath);
}

// ТЗ T-7.3: имя файла = название текущего статуса сделки, при совпадении —
// "(1)", "(2)"... Как и у бота проектировщиков — отдельно по каждому
// расширению (иначе фото .jpg и .png с одного статуса конфликтовали бы
// номерами без причины).
function buildProductionFileName(baseName, number, extension) {
  const suffix = Number(number) > 0 ? ` (${Number(number)})` : "";
  const ext = (extension && String(extension).trim()) || "jpg";

  return `${baseName}${suffix}.${ext}`;
}

async function getNextProductionFileNumber(ctx, folderPath, baseName, extension) {
  const response = await axios.get("https://cloud-api.yandex.net/v1/disk/resources", {
    params: { path: folderPath, limit: 1000, fields: "_embedded.items.name" },
    headers: ctx.yandexDiskHeaders(),
    timeout: 30000,
    validateStatus: () => true
  });

  if (response.status !== 200) {
    throw new Error(`Яндекс.Диск: не удалось получить список файлов "${folderPath}". HTTP ${response.status}`);
  }

  const items =
    response.data && response.data._embedded && Array.isArray(response.data._embedded.items)
      ? response.data._embedded.items
      : [];

  const escapedBase = ctx.escapeRegExp(baseName);
  const escapedExt = ctx.escapeRegExp(extension || "jpg");
  const pattern = new RegExp(`^${escapedBase}(?: \\((\\d+)\\))?\\.${escapedExt}$`, "i");

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

// Общий цикл загрузки файлов в папку "Производство" — используется и для
// фото готового изделия (T-6.5.1), и для фото дефекта (T-6.5.4/T-6.5.6).
// baseName — то, что ТЗ называет "[Название этапа] [дата]" или "Дефект
// изделия [дата]" и т.п.; extension берём из ссылки amoMessenger, со
// стандартным запасным вариантом "jpg" (фото).
async function uploadProductionFile(ctx, leadId, baseName, fileUrl) {
  const { reportsPath, productionPath } = buildProductionFolderPaths(ctx, leadId);

  await ensureProductionFolder(ctx, reportsPath, productionPath);

  const extension = ctx.getUrlExtension(fileUrl) || "jpg";
  const number = await getNextProductionFileNumber(ctx, productionPath, baseName, extension);
  const fileName = buildProductionFileName(baseName, number, extension);
  const uploadedPath = `${productionPath}/${fileName}`;

  await ctx.ydUploadFromUrlAndWait(uploadedPath, fileUrl);

  return uploadedPath;
}

// ------------------------------------------------------------
// 8.3 Список "Сделки к исполнению" (ТЗ T-6.2, сортировка — по актуализации
// п.3.1/п.10: сначала непринятые ОТК, затем ПД/ПМ, затем остальные; внутри
// группы — по плановой готовности, раньше срок — выше).
// ------------------------------------------------------------

function sortExecutionDeals(leads) {
  function group(lead) {
    if (leadHasTag(lead, OTK_REJECTED_TAG_NAME)) {
      return 1;
    }

    const contractNumber = lead.__contractNumber || "";

    if (contractNumber.startsWith("ПД") || contractNumber.startsWith("ПМ")) {
      return 2;
    }

    return 3;
  }

  return [...leads].sort((a, b) => {
    const diff = group(a) - group(b);

    return diff !== 0 ? diff : (a.__planDateUnix ?? Infinity) - (b.__planDateUnix ?? Infinity);
  });
}

// Актуализация п.1.1/п.3.1: сделка попадает в список, если текущий
// пользователь доступен как ВАРИАНТ в поле "Исполнитель" — поле сделки не
// обязано уже содержать его имя (в отличие от "Распределения", где поле
// проверяется строго).
async function showExecutionListForPerformer(ctx, directId, userName, settings) {
  const executionRows = findExecutionRows(settings);

  if (executionRows.length === 0) {
    await sendProductionDirectMessage(
      ctx,
      directId,
      "❌ В настройках не указан статус «Исполнение». Обратитесь к администратору."
    );
    return;
  }

  let deals = [];

  for (const row of executionRows) {
    if (!row.amoPipelineId || !row.amoStatusId || !row.executorFieldId) {
      continue;
    }

    const enumOption = await findFieldEnumForUserName(ctx, row.executorFieldId, userName);

    if (!enumOption) {
      continue;
    }

    const leads = await getLeadsByPipeline(ctx, row.amoPipelineId, { statusId: row.amoStatusId, withTags: true });

    for (const lead of leads) {
      // Актуализация п.2.1/§4.1: сделки, уже переданные на промежуточный
      // ОТК, показываются в отдельном пункте меню "В ОТК" (пока не
      // реализован) — здесь их пропускаем, чтобы не путать с активной
      // работой.
      if (fieldIsTruthy(ctx, lead, INTERMEDIATE_OTK_FLAG_FIELD_ID)) {
        continue;
      }

      const planValues = ctx.getFieldValues(lead, row.planDateFieldId);
      const planUnix = Number(planValues[0]);

      lead.__planDateUnix = Number.isFinite(planUnix) ? planUnix : Infinity;
      lead.__contractNumber = getContractNumberText(ctx, lead);
      lead.__row = row;

      deals.push(lead);
    }
  }

  if (deals.length === 0) {
    await sendProductionDirectMessage(ctx, directId, "Сделки к исполнению:\nНет сделок.");
    return;
  }

  deals = sortExecutionDeals(deals);

  const lines = ["Сделки к исполнению:"];

  deals.forEach((lead, i) => {
    const row = lead.__row;
    const price = getPriceText(ctx, lead, row.priceFieldId);
    const planDate = ctx.formatDateFieldValue(lead, row.planDateFieldId) || "—";

    lines.push(`${i + 1}. № ${lead.__contractNumber}, Цена ${price}, руб. Срок изготовления ${planDate}`);
  });

  const buttons = deals.map((lead) => lead.__contractNumber);

  await sendProductionDirectMessage(ctx, directId, lines.join("\n"), buttons);
}

// ------------------------------------------------------------
// 8.4 Карточка сделки (ТЗ T-6.3/T-6.4)
// ------------------------------------------------------------

const EXECUTION_CARD_BUTTONS = [
  "Да",
  "Нет",
  "Вернуть на доработку",
  "Обсудить стоимость с Мастером",
  "Не хватает материалов",
  "Вернуть в проектный отдел"
];

async function showExecutionDealCard(ctx, directId, userKey, lead, row) {
  const contractNumber = getContractNumberText(ctx, lead);
  const price = getPriceText(ctx, lead, row.priceFieldId);
  const planDate = ctx.formatDateFieldValue(lead, row.planDateFieldId) || "—";

  // T-6.4.1/6.4.2: ссылка на dxf-проект — только на статусе "Плазма исполнение".
  let dxfLine = "";

  if (Number(lead.status_id) === PLASMA_EXECUTION_STATUS_ID) {
    const dxfLink = ctx.getFieldValueJoined(lead, DXF_LINK_FIELD_ID);

    if (dxfLink) {
      dxfLine = ` Проект dxf:\n${dxfLink}`;
    }
  }

  productionUserState[userKey].pendingCard = { leadId: lead.id, row };

  await sendProductionDirectMessage(
    ctx,
    directId,
    `№ договора: ${contractNumber}, Цена ${price}, руб. Срок изготовления ${planDate}.${dxfLine} готова?`,
    EXECUTION_CARD_BUTTONS
  );
}

// ТЗ T-6.3: нажатие на кнопку с номером договора из списка T-6.2. Как и в
// "Распределении" — список не храним, ищем сделку заново среди текущих
// подходящих.
async function tryHandleExecutionDealSelection(ctx, directId, userKey, userName, settings, trimmedText) {
  const executionRows = findExecutionRows(settings);

  for (const row of executionRows) {
    if (!row.amoPipelineId || !row.amoStatusId || !row.executorFieldId) {
      continue;
    }

    const enumOption = await findFieldEnumForUserName(ctx, row.executorFieldId, userName);

    if (!enumOption) {
      continue;
    }

    const leads = await getLeadsByPipeline(ctx, row.amoPipelineId, { statusId: row.amoStatusId });

    const lead = leads.find(
      (item) =>
        getContractNumberText(ctx, item) === trimmedText && !fieldIsTruthy(ctx, item, INTERMEDIATE_OTK_FLAG_FIELD_ID)
    );

    if (!lead) {
      continue;
    }

    await showExecutionDealCard(ctx, directId, userKey, lead, row);
    return true;
  }

  return false;
}

// ------------------------------------------------------------
// 8.5 Карточка: "Да" (ТЗ T-6.5.1) — факт готовности, загрузка фото, передача
// на промежуточный ОТК (T-12, заглушка) или следующий статус.
// ------------------------------------------------------------

async function handleExecutionDealYes(ctx, directId, userKey) {
  const state = productionUserState[userKey];
  const pendingCard = state && state.pendingCard;

  if (!pendingCard) {
    await handleUnknownCommand(ctx, directId, state && state.roleKey);
    return;
  }

  const lead = await ctx.getLead(pendingCard.leadId);

  if (!lead) {
    await sendProductionDirectMessage(ctx, directId, "❌ Сделка не найдена. Возможно, она уже была изменена.");
    delete state.pendingCard;
    return;
  }

  const row = pendingCard.row;

  if (!row.factDateFieldId) {
    await sendProductionDirectMessage(
      ctx,
      directId,
      "❌ Не настроено поле «Факт готовности» для текущего этапа. Обратитесь к администратору."
    );
    return;
  }

  await patchLead(ctx, lead.id, {
    custom_fields_values: [{ field_id: row.factDateFieldId, values: [{ value: ctx.todayMoscowStartUnix() }] }]
  });

  const statusName = await getStatusNameById(ctx, row.amoPipelineId, row.amoStatusId);
  const baseName = `${statusName} ${ctx.todayMoscowDateText()}`;

  state.pendingUpload = { leadId: lead.id, row, kind: "done", baseName, uploadedPaths: [] };
  delete state.pendingCard;

  await sendProductionDirectMessage(ctx, directId, "Прикрепите фото готового изделия");
}

async function handleExecutionDealNo(ctx, directId, userKey, userName, settings) {
  const state = productionUserState[userKey];

  if (state) {
    delete state.pendingCard;
  }

  await showExecutionListForPerformer(ctx, directId, userName, settings);
}

// ------------------------------------------------------------
// 8.6 Загрузка файлов — общий цикл для "Да" (фото готового изделия),
// "Вернуть на доработку" и "Вернуть в проектный отдел" (фото дефекта).
// ------------------------------------------------------------

async function handleProductionUploadMessage(ctx, directId, userKey, imageUrls) {
  const state = productionUserState[userKey];
  const pending = state && state.pendingUpload;

  if (!pending || !imageUrls || imageUrls.length === 0) {
    return false;
  }

  for (const fileUrl of imageUrls) {
    try {
      const uploadedPath = await uploadProductionFile(ctx, pending.leadId, pending.baseName, fileUrl);

      pending.uploadedPaths.push(uploadedPath);

      await sendProductionDirectMessage(
        ctx,
        directId,
        "Файл сохранен на Яндекс.Диске.\nДополните или завершите загрузку.",
        [FINISH_UPLOAD_BUTTON]
      );
    } catch (error) {
      console.error("[Бот производства] Ошибка загрузки файла на Яндекс.Диск:", error.message);

      await sendProductionDirectMessage(
        ctx,
        directId,
        "❌ Не удалось загрузить файл на Яндекс.Диск. Попробуйте отправить его ещё раз."
      );
    }
  }

  return true;
}

async function handleFinishUpload(ctx, directId, userKey, userName, settings) {
  const state = productionUserState[userKey];
  const pending = state && state.pendingUpload;

  if (!pending) {
    await handleUnknownCommand(ctx, directId, state && state.roleKey);
    return;
  }

  if (pending.uploadedPaths.length === 0) {
    await sendProductionDirectMessage(
      ctx,
      directId,
      "Вы ещё не прикрепили ни одного файла. Прикрепите файл или начните заново."
    );
    return;
  }

  if (pending.kind === "done") {
    await finishDoneUpload(ctx, directId, settings, pending);
  } else if (pending.kind === "defect") {
    await finishDefectUpload(ctx, directId, settings, pending);
  } else if (pending.kind === "project_return_defect") {
    await finishProjectReturnUpload(ctx, directId, pending);
  }

  delete state.pendingUpload;
}

// T-6.5.1.4.1.2 → T-6.5.1.5: завершение загрузки фото готового изделия,
// передача на промежуточный ОТК (T-12 — заглушка) либо смена статуса.
async function finishDoneUpload(ctx, directId, settings, pending) {
  const lead = await ctx.getLead(pending.leadId);
  const contractNumber = lead ? getContractNumberText(ctx, lead) : `Сделка ${pending.leadId}`;

  await sendProductionDirectMessage(ctx, directId, `Работа по сделке № ${contractNumber} завершена.`);

  const otkEntries = (settings.roles && settings.roles.otk) || [];
  const hasActiveOtk = otkEntries.some((entry) => entry.active && entry.handle);

  if (hasActiveOtk) {
    await patchLead(ctx, pending.leadId, {
      custom_fields_values: [{ field_id: INTERMEDIATE_OTK_FLAG_FIELD_ID, values: [{ value: true }] }]
    });

    // T-12 (Промежуточный ОТК) пока не реализован — заглушка: только
    // уведомляем ОТК, собственного списка/UI сценария нет.
    await notifyRoleUsers(
      ctx,
      settings,
      "otk",
      `Сделка № ${contractNumber} готова, ожидает промежуточного ОТК.`
    );
  } else {
    const row = pending.row;

    if (row.nextAmoStatusId) {
      await patchLead(ctx, pending.leadId, { status_id: Number(row.nextAmoStatusId) });
    }
  }
}

// ------------------------------------------------------------
// 8.7 Карточка: "Обсудить стоимость с Мастером" (ТЗ T-6.5.3, актуализация
// п.3.5) — предложение новой стоимости и решение мастера.
// ------------------------------------------------------------

// Актуализация п.8.3: целое или дробное число, запятая или точка как
// разделитель, никаких пробелов/валюты/текста.
function parseRublePrice(text) {
  const trimmed = String(text || "").trim();

  if (!/^\d+([.,]\d{1,2})?$/.test(trimmed)) {
    return null;
  }

  return Number(trimmed.replace(",", "."));
}

async function getCostRevisionEntries(ctx, lead) {
  const raw = ctx.getFieldValueJoined(lead, COST_REVISION_FIELD_ID);

  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);

    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function getCostRevisionEntry(entries, statusId) {
  return entries.find((entry) => Number(entry.status_id) === Number(statusId)) || null;
}

// ТЗ T-6.5.3.2 "Ограничения и допущения" — хранит отдельную запись на
// каждый статус; при повторном запросе на том же статусе перезаписывает её.
async function upsertCostRevisionEntry(ctx, lead, statusId, newPrice, userName) {
  const entries = await getCostRevisionEntries(ctx, lead);
  const idx = entries.findIndex((entry) => Number(entry.status_id) === Number(statusId));
  const entry = { status_id: Number(statusId), new_price: newPrice, username: userName };

  if (idx >= 0) {
    entries[idx] = entry;
  } else {
    entries.push(entry);
  }

  await patchLead(ctx, lead.id, {
    custom_fields_values: [{ field_id: COST_REVISION_FIELD_ID, values: [{ value: JSON.stringify(entries) }] }]
  });
}

async function removeCostRevisionEntry(ctx, lead, statusId) {
  const entries = (await getCostRevisionEntries(ctx, lead)).filter(
    (entry) => Number(entry.status_id) !== Number(statusId)
  );

  await patchLead(ctx, lead.id, {
    custom_fields_values: [{ field_id: COST_REVISION_FIELD_ID, values: [{ value: JSON.stringify(entries) }] }]
  });
}

async function handleExecutionDiscussCost(ctx, directId, userKey) {
  const state = productionUserState[userKey];
  const pendingCard = state && state.pendingCard;

  if (!pendingCard) {
    await handleUnknownCommand(ctx, directId, state && state.roleKey);
    return;
  }

  state.pendingTextInput = { kind: "cost_propose", leadId: pendingCard.leadId, row: pendingCard.row };
  delete state.pendingCard;

  await sendProductionDirectMessage(ctx, directId, "Укажите стоимость работ");
}

async function handleCostProposeInput(ctx, directId, userKey, userName, settings, trimmedText) {
  const state = productionUserState[userKey];
  const pending = state.pendingTextInput;

  const price = parseRublePrice(trimmedText);

  if (price === null) {
    await sendProductionDirectMessage(ctx, directId, "Ожидается только числовое значение без комментария");
    return;
  }

  const lead = await ctx.getLead(pending.leadId);

  if (!lead) {
    await sendProductionDirectMessage(ctx, directId, "❌ Сделка не найдена.");
    delete state.pendingTextInput;
    return;
  }

  await upsertCostRevisionEntry(ctx, lead, Number(lead.status_id), price, userName);

  delete state.pendingTextInput;

  const pipelineName = (await getPipelineNameById(ctx, pending.row.amoPipelineId)) || PIPELINE_NAME_METAL;
  const managerRoleKey = MANAGER_ROLE_BY_PIPELINE_NAME[pipelineName] || "metalShopForeman";
  const activeManager = ((settings.roles && settings.roles[managerRoleKey]) || []).find(
    (entry) => entry.active && entry.handle
  );

  await sendProductionDirectMessage(
    ctx,
    directId,
    `Работа по сделке передана Мастеру (${activeManager ? activeManager.handle : "не назначен"}).`
  );

  const contractNumber = getContractNumberText(ctx, lead);
  const currentPrice = getPriceText(ctx, lead, pending.row.priceFieldId);
  const pdfLink = ctx.getFieldValueJoined(lead, PROJECT_PDF_FIELD_ID) || "(ссылка не найдена)";

  const notified = await notifyRoleUsers(
    ctx,
    settings,
    managerRoleKey,
    `№ договора: ${contractNumber} Цена: ${currentPrice} рублей Проект: ${pdfLink} ` +
      `Исполнитель: ${userName} предлагает следующую стоимость: ${price}.`,
    [
      buildTaggedButtonCompat(ctx, "Подтвердить", lead.id),
      buildTaggedButtonCompat(ctx, "Отклонить", lead.id),
      buildTaggedButtonCompat(ctx, "Изменить", lead.id)
    ]
  );

  if (notified === 0) {
    console.log(
      `[Бот производства] Запрос пересмотра стоимости по сделке ${lead.id} создан, но мастер ` +
        "сейчас не достижим для push."
    );
  }
}

// ТЗ T-6.5.3.5 → T-8 (Согласование стоимости мастером) — реализован только
// прямой ответ мастера на push выше (Подтвердить/Отклонить/Изменить);
// собственный пункт меню мастера "Пересмотреть стоимость" (T-8.1, список
// всех ожидающих сделок) пока не реализован.
async function handleCostRevisionReply(ctx, directId, userKey, leadId, action, settings) {
  const lead = await ctx.getLead(leadId);

  if (!lead) {
    await sendProductionDirectMessage(ctx, directId, "❌ Сделка не найдена.");
    return;
  }

  const statusId = Number(lead.status_id);
  const entries = await getCostRevisionEntries(ctx, lead);
  const entry = getCostRevisionEntry(entries, statusId);

  if (!entry) {
    await sendProductionDirectMessage(
      ctx,
      directId,
      "❌ Запрос на пересмотр стоимости по этой сделке не найден — возможно, он уже обработан."
    );
    return;
  }

  const executionRows = findExecutionRows(settings);
  const row = executionRows.find((r) => Number(r.amoStatusId) === statusId);
  const contractNumber = getContractNumberText(ctx, lead);
  const requesterDirectId = await loadUserDirectId(ctx, entry.username);

  if (action === "confirm") {
    if (!row || !row.priceFieldId) {
      await sendProductionDirectMessage(
        ctx,
        directId,
        "❌ Не настроено поле «Цена» для текущего этапа. Обратитесь к администратору."
      );
      return;
    }

    await patchLead(ctx, leadId, {
      custom_fields_values: [{ field_id: row.priceFieldId, values: [{ value: entry.new_price }] }]
    });
    await removeCostRevisionEntry(ctx, lead, statusId);

    if (requesterDirectId) {
      await sendProductionDirectMessage(
        ctx,
        requesterDirectId,
        `Согласована новая стоимость работ по сделке № ${contractNumber}, цена ${entry.new_price} рублей`
      );
    }

    await sendProductionDirectMessage(ctx, directId, "Согласовано.");
    return;
  }

  if (action === "reject") {
    await removeCostRevisionEntry(ctx, lead, statusId);

    if (requesterDirectId) {
      await sendProductionDirectMessage(
        ctx,
        requesterDirectId,
        `Изменение стоимости работ по сделке № ${contractNumber} не согласовано руководителем`
      );
    }

    await sendProductionDirectMessage(ctx, directId, "Отклонено.");
    return;
  }

  if (action === "change") {
    productionUserState[userKey].pendingTextInput = {
      kind: "cost_master_change",
      leadId,
      statusId,
      row
    };

    await sendProductionDirectMessage(ctx, directId, "Укажите стоимость работ");
  }
}

async function handleCostMasterChangeInput(ctx, directId, userKey, settings, trimmedText) {
  const state = productionUserState[userKey];
  const pending = state.pendingTextInput;

  const price = parseRublePrice(trimmedText);

  if (price === null) {
    await sendProductionDirectMessage(ctx, directId, "Укажите только число");
    return;
  }

  const lead = await ctx.getLead(pending.leadId);

  if (!lead) {
    await sendProductionDirectMessage(ctx, directId, "❌ Сделка не найдена.");
    delete state.pendingTextInput;
    return;
  }

  const row =
    pending.row || findExecutionRows(settings).find((r) => Number(r.amoStatusId) === pending.statusId);

  if (!row || !row.priceFieldId) {
    await sendProductionDirectMessage(
      ctx,
      directId,
      "❌ Не настроено поле «Цена» для текущего этапа. Обратитесь к администратору."
    );
    delete state.pendingTextInput;
    return;
  }

  const entries = await getCostRevisionEntries(ctx, lead);
  const entry = getCostRevisionEntry(entries, pending.statusId);

  await patchLead(ctx, lead.id, {
    custom_fields_values: [{ field_id: row.priceFieldId, values: [{ value: price }] }]
  });
  await removeCostRevisionEntry(ctx, lead, pending.statusId);

  const contractNumber = getContractNumberText(ctx, lead);
  const requesterDirectId = entry ? await loadUserDirectId(ctx, entry.username) : null;

  if (requesterDirectId) {
    await sendProductionDirectMessage(
      ctx,
      requesterDirectId,
      `Согласована новая стоимость работ по сделке № ${contractNumber}, цена ${price} рублей`
    );
  }

  await sendProductionDirectMessage(ctx, directId, "Сохранено.");
  delete state.pendingTextInput;
}

// ------------------------------------------------------------
// 8.8 Карточка: "Вернуть на доработку" (ТЗ T-6.5.4) → T-9/T-11 (заглушка)
// ------------------------------------------------------------

async function handleExecutionReturnForRework(ctx, directId, userKey) {
  const state = productionUserState[userKey];
  const pendingCard = state && state.pendingCard;

  if (!pendingCard) {
    await handleUnknownCommand(ctx, directId, state && state.roleKey);
    return;
  }

  state.pendingTextInput = { kind: "rework_comment", leadId: pendingCard.leadId, row: pendingCard.row };
  delete state.pendingCard;

  await sendProductionDirectMessage(ctx, directId, "Укажите что не принято");
}

async function handleReworkCommentInput(ctx, directId, userKey, trimmedText) {
  const state = productionUserState[userKey];
  const pending = state.pendingTextInput;

  await patchLead(ctx, pending.leadId, {
    custom_fields_values: [{ field_id: NOT_ACCEPTED_TEXT_FIELD_ID, values: [{ value: trimmedText }] }]
  });

  state.pendingUpload = {
    leadId: pending.leadId,
    row: pending.row,
    kind: "defect",
    baseName: "Дефект изделия",
    uploadedPaths: []
  };
  delete state.pendingTextInput;

  await sendProductionDirectMessage(ctx, directId, "Прикрепите фото дефекта");
}

async function finishDefectUpload(ctx, directId, settings, pending) {
  const lead = await ctx.getLead(pending.leadId);

  await sendProductionDirectMessage(ctx, directId, "Ваши замечания приняты.");

  const links = [];

  for (const path of pending.uploadedPaths) {
    try {
      links.push(await ctx.ydGetFolderPublicUrl(path));
    } catch (error) {
      console.error("[Бот производства] Не удалось получить ссылку на фото дефекта:", error.message);
    }
  }

  if (links.length > 0) {
    await patchLead(ctx, pending.leadId, {
      custom_fields_values: [{ field_id: DEFECT_PHOTO_LINK_FIELD_ID, values: [{ value: links.join(", ") }] }]
    });
  }

  const contractNumber = lead ? getContractNumberText(ctx, lead) : `Сделка ${pending.leadId}`;
  const otkEntries = (settings.roles && settings.roles.otk) || [];
  const hasActiveOtk = otkEntries.some((entry) => entry.active && entry.handle);

  if (hasActiveOtk) {
    await patchLead(ctx, pending.leadId, {
      custom_fields_values: [{ field_id: NOT_ACCEPTED_OTK_FLAG_FIELD_ID, values: [{ value: true }] }]
    });

    // T-9 (решение ОТК по непринятой работе) пока не реализован — заглушка.
    await notifyRoleUsers(
      ctx,
      settings,
      "otk",
      `Производство № ${contractNumber} не принято к исправлению. Примите решение о дальнейших работах.`
    );
  } else {
    await patchLead(ctx, pending.leadId, {
      custom_fields_values: [{ field_id: NOT_ACCEPTED_MASTER_FLAG_FIELD_ID, values: [{ value: true }] }]
    });

    const pipelineName = (await getPipelineNameById(ctx, pending.row.amoPipelineId)) || PIPELINE_NAME_METAL;
    const managerRoleKey = MANAGER_ROLE_BY_PIPELINE_NAME[pipelineName] || "metalShopForeman";

    // T-11 (решение Мастера по непринятой работе) пока не реализован —
    // заглушка.
    await notifyRoleUsers(
      ctx,
      settings,
      managerRoleKey,
      `Производство № ${contractNumber} не принято к исправлению. Примите решение о дальнейших работах.`
    );
  }
}

// ------------------------------------------------------------
// 8.9 Карточка: "Не хватает материалов" (ТЗ T-6.5.5) → T-20 (заглушка)
// ------------------------------------------------------------

async function addTagToLead(ctx, leadId, tagName) {
  const url = `https://${ctx.AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4/leads/${leadId}`;
  const response = await ctx.amoCrmGet(url, { with: "tags" });

  if (response.status !== 200) {
    throw new Error(`amoCRM GET /leads/${leadId}?with=tags HTTP ${response.status}`);
  }

  const existingTags = (response.data._embedded && response.data._embedded.tags) || [];

  if (existingTags.some((tag) => tag.name === tagName)) {
    return;
  }

  const tags = [...existingTags.map((tag) => ({ name: tag.name })), { name: tagName }];

  await patchLead(ctx, leadId, { _embedded: { tags } });
}

async function handleExecutionMaterialsShortage(ctx, directId, userKey) {
  const state = productionUserState[userKey];
  const pendingCard = state && state.pendingCard;

  if (!pendingCard) {
    await handleUnknownCommand(ctx, directId, state && state.roleKey);
    return;
  }

  state.pendingTextInput = { kind: "materials_comment", leadId: pendingCard.leadId, row: pendingCard.row };
  delete state.pendingCard;

  await sendProductionDirectMessage(ctx, directId, "Укажите комментарий");
}

async function handleMaterialsCommentInput(ctx, directId, userKey, userName, settings, trimmedText) {
  const state = productionUserState[userKey];
  const pending = state.pendingTextInput;

  await patchLead(ctx, pending.leadId, {
    custom_fields_values: [{ field_id: NOT_ACCEPTED_TEXT_FIELD_ID, values: [{ value: trimmedText }] }]
  });

  await addTagToLead(ctx, pending.leadId, DOZAKUPKA_TAG_NAME);

  delete state.pendingTextInput;

  const lead = await ctx.getLead(pending.leadId);
  const contractNumber = lead ? getContractNumberText(ctx, lead) : `Сделка ${pending.leadId}`;

  const pipelineName = (await getPipelineNameById(ctx, pending.row.amoPipelineId)) || PIPELINE_NAME_METAL;
  const managerRoleKey = MANAGER_ROLE_BY_PIPELINE_NAME[pipelineName] || "metalShopForeman";

  // T-20 (Ожидание решения) пока не реализован — заглушка: только
  // уведомляем мастера.
  await notifyRoleUsers(
    ctx,
    settings,
    managerRoleKey,
    `${userName} указал, что в № ${contractNumber} не хватает материалов.`
  );

  await sendProductionDirectMessage(ctx, directId, "Комментарий сохранён, мастер уведомлён.");
}

// ------------------------------------------------------------
// 8.10 Карточка: "Вернуть в проектный отдел" (ТЗ T-6.5.6)
// ------------------------------------------------------------
// Последний шаг (флаг "[Бот] Передано в проектный отдел") заблокирован: в
// ТЗ у этого поля указан тот же id (555172), что и у "Промежуточный ОТК"
// (см. открытый вопрос №5 актуализации — "нужно сверить фактические id и
// типы полей в amoCRM"). Угадывать id нельзя, поэтому комментарий и фото
// сохраняются, а дальше сценарий останавливается с явным сообщением.

async function handleExecutionReturnToDesign(ctx, directId, userKey) {
  const state = productionUserState[userKey];
  const pendingCard = state && state.pendingCard;

  if (!pendingCard) {
    await handleUnknownCommand(ctx, directId, state && state.roleKey);
    return;
  }

  state.pendingTextInput = { kind: "project_return_comment", leadId: pendingCard.leadId, row: pendingCard.row };
  delete state.pendingCard;

  await sendProductionDirectMessage(ctx, directId, "Укажите, что не принято");
}

async function handleProjectReturnCommentInput(ctx, directId, userKey, trimmedText) {
  const state = productionUserState[userKey];
  const pending = state.pendingTextInput;

  await patchLead(ctx, pending.leadId, {
    custom_fields_values: [{ field_id: NOT_ACCEPTED_TEXT_FIELD_ID, values: [{ value: trimmedText }] }]
  });

  state.pendingUpload = {
    leadId: pending.leadId,
    row: pending.row,
    kind: "project_return_defect",
    baseName: "Дефект изделия",
    uploadedPaths: []
  };
  delete state.pendingTextInput;

  await sendProductionDirectMessage(ctx, directId, "Прикрепите фото дефекта");
}

async function finishProjectReturnUpload(ctx, directId, pending) {
  await sendProductionDirectMessage(ctx, directId, "Ваши замечания приняты.");

  const links = [];

  for (const path of pending.uploadedPaths) {
    try {
      links.push(await ctx.ydGetFolderPublicUrl(path));
    } catch (error) {
      console.error("[Бот производства] Не удалось получить ссылку на фото дефекта:", error.message);
    }
  }

  if (links.length > 0) {
    await patchLead(ctx, pending.leadId, {
      custom_fields_values: [{ field_id: DEFECT_PHOTO_LINK_FIELD_ID, values: [{ value: links.join(", ") }] }]
    });
  }

  console.error(
    `[Бот производства] "Вернуть в проектный отдел": сделка ${pending.leadId} — остановлено перед записью ` +
      "флага «Передано в проектный отдел» (конфликт id полей, см. открытый вопрос №5 в актуализации ТЗ)."
  );

  await sendProductionDirectMessage(
    ctx,
    directId,
    "Замечания и фото сохранены. Передача в проектный отдел требует уточнения у администратора " +
      "(в ТЗ конфликт id технических полей) — сообщите, пожалуйста, об этом администратору."
  );
}

// ============================================================
// 9. ПЛАНИРОВЩИКИ
// ============================================================
// Фоновых задач пока нет (у этого бота нет сценариев с таймерами/опросом —
// T-16 "Контроль сроков" выводится только по запросу пользователя).
// Функция оставлена пустой ради симметрии вызова с
// designerBot.startSchedulers(ctx) в server.js.
function startSchedulers(ctx) {
  console.log("[Бот производства] Планировщики: сценариев пока нет, ничего не запущено.");
}

// ============================================================
// 10. WEBHOOK И МАРШРУТЫ
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
      const imageUrls = ctx.extractImageUrlsFromMessage(message);

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

      // Ждём файл(ы) или "Завершить загрузку" (ТЗ T-6.5.1.3-4/6.5.4.5-6) —
      // проверяем раньше кнопок меню, иначе присланный файл не с чем
      // сопоставить.
      if (state.pendingUpload) {
        try {
          if (imageUrls.length > 0) {
            await handleProductionUploadMessage(ctx, directId, userKey, imageUrls);
          } else if (trimmedText === FINISH_UPLOAD_BUTTON) {
            await handleFinishUpload(ctx, directId, userKey, userName, settings);
          } else {
            await sendProductionDirectMessage(
              ctx,
              directId,
              `Прикрепите файл или нажмите «${FINISH_UPLOAD_BUTTON}».`
            );
          }
        } catch (error) {
          console.error("[Бот производства] Ошибка загрузки файла:", error.stack || error.message);

          await sendProductionDirectMessage(
            ctx,
            directId,
            "❌ Не удалось обработать загрузку. Попробуйте ещё раз позже или обратитесь к администратору."
          );
        }

        return;
      }

      // Ждём текстовый ввод (комментарий/стоимость) — ТЗ T-6.5.3-6.5.6.
      if (state.pendingTextInput) {
        try {
          const kind = state.pendingTextInput.kind;

          if (kind === "cost_propose") {
            await handleCostProposeInput(ctx, directId, userKey, userName, settings, trimmedText);
          } else if (kind === "cost_master_change") {
            await handleCostMasterChangeInput(ctx, directId, userKey, settings, trimmedText);
          } else if (kind === "rework_comment") {
            await handleReworkCommentInput(ctx, directId, userKey, trimmedText);
          } else if (kind === "materials_comment") {
            await handleMaterialsCommentInput(ctx, directId, userKey, userName, settings, trimmedText);
          } else if (kind === "project_return_comment") {
            await handleProjectReturnCommentInput(ctx, directId, userKey, trimmedText);
          }
        } catch (error) {
          console.error("[Бот производства] Ошибка обработки ввода:", error.stack || error.message);

          await sendProductionDirectMessage(
            ctx,
            directId,
            "❌ Не удалось сохранить данные. Попробуйте ещё раз позже или обратитесь к администратору."
          );
        }

        return;
      }

      // "Да (id)" / "Нет (id)" — ответ на подтверждение распределения (ТЗ
      // п.11/14), кем бы оно ни было инициировано (сам нажал в списке или
      // пришло по push).
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

      // "Подтвердить (id)" / "Отклонить (id)" / "Изменить (id)" — ответ
      // мастера на пересмотр стоимости (ТЗ T-6.5.3/T-8, актуализация 3.5).
      const confirmCostLeadId = parseTaggedButtonCompat(ctx, trimmedText, "Подтвердить");
      const rejectCostLeadId = parseTaggedButtonCompat(ctx, trimmedText, "Отклонить");
      const changeCostLeadId = parseTaggedButtonCompat(ctx, trimmedText, "Изменить");

      if ((confirmCostLeadId || rejectCostLeadId || changeCostLeadId) && settings) {
        const leadId = confirmCostLeadId || rejectCostLeadId || changeCostLeadId;
        const action = confirmCostLeadId ? "confirm" : rejectCostLeadId ? "reject" : "change";

        try {
          await handleCostRevisionReply(ctx, directId, userKey, leadId, action, settings);
        } catch (error) {
          console.error("[Бот производства] Ошибка согласования стоимости:", error.stack || error.message);

          await sendProductionDirectMessage(
            ctx,
            directId,
            "❌ Не удалось обработать ответ. Попробуйте ещё раз позже или обратитесь к администратору."
          );
        }

        return;
      }

      // Кнопки карточки сделки T-6.4 ("Да"/"Нет"/... без тэгов — карточка
      // открыта ровно одна за раз на пользователя, см. state.pendingCard).
      if (state.pendingCard && EXECUTION_CARD_BUTTONS.includes(trimmedText) && settings) {
        try {
          if (trimmedText === "Да") {
            await handleExecutionDealYes(ctx, directId, userKey);
          } else if (trimmedText === "Нет") {
            await handleExecutionDealNo(ctx, directId, userKey, userName, settings);
          } else if (trimmedText === "Вернуть на доработку") {
            await handleExecutionReturnForRework(ctx, directId, userKey);
          } else if (trimmedText === "Обсудить стоимость с Мастером") {
            await handleExecutionDiscussCost(ctx, directId, userKey);
          } else if (trimmedText === "Не хватает материалов") {
            await handleExecutionMaterialsShortage(ctx, directId, userKey);
          } else if (trimmedText === "Вернуть в проектный отдел") {
            await handleExecutionReturnToDesign(ctx, directId, userKey);
          }
        } catch (error) {
          console.error("[Бот производства] Ошибка обработки карточки сделки:", error.stack || error.message);

          await sendProductionDirectMessage(
            ctx,
            directId,
            "❌ Не удалось обработать действие. Попробуйте ещё раз позже или обратитесь к администратору."
          );
        }

        return;
      }

      const roleButtons = MAIN_MENU_BUTTONS[state.roleKey] || [];

      if (roleButtons.includes(trimmedText)) {
        try {
          if (trimmedText === "Распределение" && DISTRIBUTION_ROLE_KEYS.includes(state.roleKey)) {
            await handleDistributionButton(ctx, directId, userKey, userName, state.roleKey);
          } else if (trimmedText === "Исполнение" && state.roleKey === PERFORMER_ROLE_KEY && settings) {
            await showExecutionListForPerformer(ctx, directId, userName, settings);
          } else {
            await handleMenuPlaceholder(ctx, directId, trimmedText);
          }
        } catch (error) {
          console.error("[Бот производства] Ошибка пункта меню:", error.stack || error.message);

          await sendProductionDirectMessage(
            ctx,
            directId,
            "❌ Не удалось получить список сделок. Попробуйте ещё раз позже или обратитесь к администратору."
          );
        }

        return;
      }

      // Не пункт меню — проверяем, не нажатие ли это на номер договора из
      // списка "Распределение" (ТЗ п.11/15/16) или "Исполнение" (ТЗ T-6.3).
      // Списки кнопок с номерами договоров не хранятся между шагами,
      // поэтому ищем сделку заново.
      if (settings && (DISTRIBUTION_ROLE_KEYS.includes(state.roleKey) || state.roleKey === PERFORMER_ROLE_KEY)) {
        let handled = false;

        try {
          if (state.roleKey === PERFORMER_ROLE_KEY) {
            handled =
              (await tryHandlePerformerDealSelection(ctx, directId, userName, settings, trimmedText)) ||
              (await tryHandleExecutionDealSelection(ctx, directId, userKey, userName, settings, trimmedText));
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
// 11. ЭКСПОРТ
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
