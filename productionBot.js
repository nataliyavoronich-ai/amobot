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

// Время запуска процесса — удобно для /status/production: по этому можно
// на глаз проверить, что деплой реально перезапустил именно этот процесс
// (а не просто подхватился "как будто").
const PROCESS_STARTED_AT = new Date().toISOString();

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

// Служебные кнопки вида «Да (35562322)», «Да (cost:35562322:74635057)»,
// «Вернуть на Сварка (35562322:90)» показываем пользователю как
// «Да (№ ПД/77)». Исходный текст кнопки запоминаем в Redis (по получателю и
// новому тексту), а при нажатии подставляем обратно (см. restoreTaggedButtonText),
// поэтому остальной код продолжает работать со служебным текстом.
const TAGGED_BUTTON_PATTERN = /^(.+?) \(((?:[a-z]+:)?(\d+)(?::\d+)?)\)$/;

function taggedButtonRedisKey(directId, buttonText) {
  return `production_btn:${directId}:${normalizeHandleName(buttonText)}`;
}

async function humanizeTaggedButtons(ctx, directId, buttons) {
  if (!buttons || buttons.length === 0 || !ctx.getLead) {
    return buttons;
  }

  const numbersByLeadId = new Map();
  const result = [];

  for (const button of buttons) {
    const match = TAGGED_BUTTON_PATTERN.exec(String(button));

    if (!match) {
      result.push(button);
      continue;
    }

    const leadId = match[3];

    if (!numbersByLeadId.has(leadId)) {
      let contractNumber = "";

      try {
        const lead = await ctx.getLead(leadId);

        contractNumber = lead ? getContractNumberText(ctx, lead) : "";
      } catch (error) {
        console.error("[Бот производства] Не удалось получить номер договора для кнопки:", error.message);
      }

      numbersByLeadId.set(leadId, contractNumber);
    }

    const contractNumber = numbersByLeadId.get(leadId);

    if (!contractNumber) {
      result.push(button);
      continue;
    }

    const shownText = `${match[1]} (№ ${contractNumber})`;

    try {
      await ctx.redisRequest(["SET", taggedButtonRedisKey(directId, shownText), String(button), "EX", 2592000]);
      result.push(shownText);
    } catch (error) {
      console.error("[Бот производства] Не удалось сохранить кнопку:", error.message);
      result.push(button);
    }
  }

  return result;
}

// Обратная подстановка: «Да (№ ПД/77)» → исходный служебный текст кнопки.
async function restoreTaggedButtonText(ctx, directId, text) {
  if (!/\(№ .+\)$/.test(text)) {
    return text;
  }

  try {
    const response = await ctx.redisRequest(["GET", taggedButtonRedisKey(directId, text)]);

    return response && response.result ? String(response.result) : text;
  } catch (error) {
    return text;
  }
}

const MAX_MESSAGE_LENGTH = 3500;

// Режем длинный текст по строкам: amoMessenger отвечает ошибкой на слишком
// большие сообщения. Кнопки уходят с последней частью.
function splitLongMessage(text) {
  const parts = [];
  let current = "";

  for (const line of String(text).split("\n")) {
    if (current && current.length + line.length + 1 > MAX_MESSAGE_LENGTH) {
      parts.push(current);
      current = "";
    }

    current = current ? `${current}\n${line}` : line;

    while (current.length > MAX_MESSAGE_LENGTH) {
      parts.push(current.slice(0, MAX_MESSAGE_LENGTH));
      current = current.slice(MAX_MESSAGE_LENGTH);
    }
  }

  if (current) {
    parts.push(current);
  }

  return parts;
}

async function sendProductionDirectMessage(ctx, directId, text, buttons, options) {
  if (!productionAccessToken) {
    throw new Error("Токен amoMessenger бота производства не найден");
  }

  if (String(text).length > MAX_MESSAGE_LENGTH) {
    const parts = splitLongMessage(text);
    let last = null;

    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1;

      last = await sendProductionDirectMessage(ctx, directId, parts[i], isLast ? buttons : undefined, options);
    }

    return last;
  }

  buttons = await humanizeTaggedButtons(ctx, directId, buttons);

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
    throw new Error(
      `amoMessenger (производство) DIRECT HTTP ${response.status}` +
        ` (длина текста ${String(text).length}, кнопок ${buttons ? buttons.length : 0}): ` +
        JSON.stringify(response.data).slice(0, 300)
    );
  }

  return response;
}

// Имя пользователя по его user_id через API amoMessenger — для случаев, когда
// вебхук не содержит имени (перенесено с сервера, правка по определению роли).
async function getProductionAmoMessengerUserName(ctx, userId) {
  if (!userId) {
    return "";
  }

  const doRequest = () =>
    axios.get("https://api.amo.tm/v1.3/users", {
      params: { "user_id[]": userId },
      headers: {
        Authorization: `Bearer ${productionAccessToken}`,
        "Content-Type": "application/json"
      },
      timeout: 30000,
      validateStatus: () => true
    });

  try {
    let response = await doRequest();

    if (response.status === 401 || response.status === 403) {
      await refreshProductionMessengerToken(ctx);
      response = await doRequest();
    }

    const items = response.data?._embedded?.items || [];

    if (!Array.isArray(items) || items.length === 0) {
      console.error(
        "[Бот производства] API не вернул пользователя:",
        response.status
      );
      return "";
    }

    const user = items.find(
      (item) => String(item.id) === String(userId)
    ) || items[0];

    return String(user?.name || "").trim();
  } catch (error) {
    console.error(
      "[Бот производства] Ошибка получения имени пользователя:",
      error.response?.status || error.message
    );
    return "";
  }
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
  // Один человек может быть одновременно директором и мастером (обоих
  // цехов); остальные сочетания ролей, как и повтор внутри роли, запрещены.
  const COMBINABLE_ROLE_KEYS = ["productionDirector", "metalShopForeman", "woodShopForeman"];
  const activeHandles = new Map(); // имя → роли, в которых он активен

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
        const previousRoles = activeHandles.get(handle) || [];
        const allRoles = [...previousRoles, roleKey];

        if (
          previousRoles.includes(roleKey) ||
          (allRoles.length > 1 && allRoles.some((key) => !COMBINABLE_ROLE_KEYS.includes(key)))
        ) {
          return {
            valid: false,
            error:
              "Один пользователь может совмещать только роли директора и мастеров; " +
              "в других сочетаниях (например, с ОТК) и дважды в одной роли — нельзя.",
            field: `roles.${roleKey}`
          };
        }

        activeHandles.set(handle, allRoles);
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
  // Актуализация 2.1, п.2.1-2.4: порядок и названия кнопок.
  [PERFORMER_ROLE_KEY]: [
    "Распределение",
    "Исполнение",
    "В ОТК",
    "Контроль сроков",
    "Непринятые работы",
    "Отчёт"
  ],
  // «ОТК перед монтажом» (T-21) — самостоятельная функция, ТЗ будет позже;
  // пока обрабатывается заглушкой handleMenuPlaceholder.
  otk: ["Промежуточный ОТК", "Финальный ОТК", "Непринятые работы", "ОТК перед монтажом"],
  metalShopForeman: [
    "Распределение",
    "Пересмотреть стоимость",
    "Непринятые работы",
    "Отчёт",
    "Контроль сроков",
    "Вопрос от продаж",
    "Не принято ОТК",
    "Ожидание решения"
  ],
  woodShopForeman: [
    "Распределение",
    "Пересмотреть стоимость",
    "Непринятые работы",
    "Отчёт",
    "Контроль сроков",
    "Вопрос от продаж",
    "Не принято ОТК",
    "Ожидание решения"
  ],
  productionDirector: ["Контроль сроков", "Вопросы от продаж", "Отчёт"]
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

// Все роли пользователя (директор + мастера могут совпадать в одном человеке).
function resolveUserRoles(settings, userName) {
  const normalizedUserName = normalizeHandleName(userName);
  const roles = [];

  if (settings && settings.roles && normalizedUserName) {
    for (const roleKey of KNOWN_ROLE_KEYS) {
      const entries = settings.roles[roleKey];

      if (
        Array.isArray(entries) &&
        entries.some((entry) => entry.active && normalizeHandleName(entry.handle) === normalizedUserName)
      ) {
        roles.push(roleKey);
      }
    }
  }

  return roles.length > 0 ? roles : [PERFORMER_ROLE_KEY];
}

function buildUserState(settings, userName, directId) {
  const roleKeys = resolveUserRoles(settings, userName);

  rolesByDirectId.set(String(directId), roleKeys);

  return { roleKey: roleKeys[0], roleKeys, userName };
}

// directId → роли пользователя: нужно меню (кнопка «Сменить роль»), которое
// строится без доступа к состоянию пользователя.
const rolesByDirectId = new Map();
const SWITCH_ROLE_BUTTON = "Сменить роль";

// У пользователя несколько ролей — действия по сделке выполняем от роли
// мастера той воронки, в которой лежит сделка (а не только от выбранной).
function roleForLead(state, lead) {
  const needed = lead && MANAGER_ROLE_BY_PIPELINE_ID[Number(lead.pipeline_id)];

  return needed && state.roleKeys && state.roleKeys.includes(needed) && (FOREMAN_ROLE_KEYS.includes(state.roleKey) || state.roleKey === "productionDirector")
    ? needed
    : state.roleKey;
}

// ТЗ T-3.2.3.1: если активного ОТК нет, мастеру доступен «Финальный ОТК»
// (после «Пересмотреть стоимость»). Проверяется на момент запроса меню.
function getMenuButtons(roleKey, settings) {
  const buttons = MAIN_MENU_BUTTONS[roleKey] || [];

  if (!FOREMAN_ROLE_KEYS.includes(roleKey) || hasActiveOtk(settings)) {
    return buttons;
  }

  const index = buttons.indexOf("Пересмотреть стоимость");

  return [...buttons.slice(0, index + 1), "Финальный ОТК", ...buttons.slice(index + 1)];
}

async function sendMainMenu(ctx, directId, roleKey) {
  const roleKeys = rolesByDirectId.get(String(directId)) || [];
  const buttons = getMenuButtons(roleKey, productionWidgetSettingsCache);

  await sendProductionDirectMessage(
    ctx,
    directId,
    `${ROLE_LABELS[roleKey] ? `${ROLE_LABELS[roleKey]}, в` : "В"}ыберите тип задач:`,
    roleKeys.length > 1 ? [...buttons, SWITCH_ROLE_BUTTON] : buttons
  );
}

async function showRoleChoice(ctx, directId, state) {
  state.awaitingRoleChoice = true;
  delete state.listContext;
  delete state.designMenuStage;

  await sendProductionDirectMessage(
    ctx,
    directId,
    "Выберите роль",
    state.roleKeys.map((key) => ROLE_LABELS[key])
  );
}

async function applyRoleChoice(ctx, directId, state, label) {
  const roleKey = state.roleKeys.find((key) => ROLE_LABELS[key] === label);

  delete state.awaitingRoleChoice;
  delete state.pendingCard;
  delete state.pendingTextInput;
  delete state.awaitingReportPeriod;

  if (roleKey) {
    state.roleKey = roleKey;
  }

  await sendMainMenu(ctx, directId, state.roleKey);
}

// ТЗ п.7: полный поток авторизации по команде "старт".
async function handleStartCommand(ctx, directId, userKey, userName) {
  await saveUserDirectId(ctx, userName, directId);

  const state = buildUserState(productionWidgetSettingsCache, userName, directId);

  productionUserState[userKey] = state;

  await sendMainMenu(ctx, directId, state.roleKey);
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

// Номер договора для текстов сообщений: после номера в скобках ссылка на
// «Проект в производство pdf» (если она есть). Для кнопок и сравнения номеров
// используется getContractNumberText без ссылки.
function getContractNumberWithLink(ctx, lead) {
  const contractNumber = getContractNumberText(ctx, lead);
  const pdfLink = ctx.getFieldValueJoined(lead, PROJECT_PDF_FIELD_ID);

  return pdfLink ? `${contractNumber} (проект PDF: ${pdfLink})` : contractNumber;
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
// Значения из amoCRM и от пользователей в сообщениях с разметкой (formatting_mode
// md): экранируем спецсимволы (* _ ~ | `), чтобы они не ломали жирный шрифт.
function mdSafe(ctx, value) {
  if (ctx.sanitizeForMarkdown) {
    return ctx.sanitizeForMarkdown(value);
  }

  return String(value === null || value === undefined ? "" : value);
}

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
      console.log(
        `[Бот производства] Распределение: «${userName}» не найден в списке значений поля ${row.executorFieldId} ` +
          `(воронка ${row.amoPipelineId}, статус ${row.amoStatusId})`
      );
      continue;
    }

    const leads = await getLeadsByPipeline(ctx, row.amoPipelineId, { statusId: row.amoStatusId });
    let assignedCount = 0;

    for (const lead of leads) {
      if (ctx.getFieldValues(lead, row.executorFieldId).length > 0) {
        assignedCount++;
        continue; // уже назначено кому-то
      }

      available.push(lead);
    }

    console.log(
      `[Бот производства] Распределение: «${userName}», воронка ${row.amoPipelineId}, статус ${row.amoStatusId}, ` +
        `поле ${row.executorFieldId}: сделок в статусе ${leads.length}, уже с исполнителем ${assignedCount}`
    );
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

    const contractNumber = getContractNumberWithLink(ctx, lead);

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

// Кнопки решения мастера по стоимости: на кнопке только действие и номер
// договора («Подтвердить ПД/77»), без служебных id. Соответствие номера
// договора и «сделка:этап» хранится в Redis.
const COST_DECISION_LABELS = ["Подтвердить", "Отклонить", "Изменить"];

function costDecisionRedisKey(contractNumber) {
  return `production_cost_decision:${normalizeHandleName(contractNumber)}`;
}

async function buildCostDecisionButtons(ctx, lead, identifier) {
  const contractNumber = getContractNumberText(ctx, lead);

  await ctx.redisRequest(["SET", costDecisionRedisKey(contractNumber), String(identifier), "EX", 2592000]);

  return COST_DECISION_LABELS.map((label) => `${label} ${contractNumber}`);
}

// Разбор кнопки «Подтвердить ПД/77»: { label, identifier } либо
// { label, identifier: null }, если запись уже не найдена; null — это не
// кнопка решения по стоимости (в том числе служебные «Отклонить (id)»).
async function resolveCostDecisionButton(ctx, text) {
  const match = String(text || "").match(/^(Подтвердить|Отклонить|Изменить) (.+)$/);

  if (!match || /^\(.*\)$/.test(match[2])) {
    return null;
  }

  const response = await ctx.redisRequest(["GET", costDecisionRedisKey(match[2])]);
  const identifier = response && response.result ? String(response.result) : null;

  return { label: match[1], identifier };
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

  const contractNumber = getContractNumberWithLink(ctx, lead);

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
  const contractNumberLinked = getContractNumberWithLink(ctx, lead);

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
  const contractNumberLinked = getContractNumberWithLink(ctx, lead);

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

  const contractNumber = getContractNumberWithLink(ctx, lead);

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
const SCENARIO_FIELD_ID = 564075; // "[Бот] Сценарий производства", список
const SCENARIO_RETURN_TO_DESIGN = "Вернуть в проектный отдел";
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
      // Только свои сделки: исполнитель этого этапа = пользователь.
      if (!ctx.getFieldValues(lead, row.executorFieldId).includes(enumOption.value)) {
        continue;
      }

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

    lines.push(`${i + 1}. № ${getContractNumberWithLink(ctx, lead)}, Цена ${price}, руб. Срок изготовления ${planDate}`);
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
  const contractNumber = getContractNumberWithLink(ctx, lead);
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
        getContractNumberText(ctx, item) === trimmedText &&
        ctx.getFieldValues(item, row.executorFieldId).includes(enumOption.value) &&
        !fieldIsTruthy(ctx, item, INTERMEDIATE_OTK_FLAG_FIELD_ID)
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

  // Актуализация п.1 («повторное нажатие не должно повторно менять
  // статус/файл»): карточку забираем сразу, до первого await.
  delete state.pendingCard;

  const lead = await ctx.getLead(pendingCard.leadId);

  if (!lead) {
    await sendProductionDirectMessage(ctx, directId, "❌ Сделка не найдена. Возможно, она уже была изменена.");
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

  // Актуализация п.3.5: ход загрузки. «Успешно» — только после ответа
  // Яндекс.Диска (ydUploadFromUrlAndWait ждёт завершения операции).
  await sendProductionDirectMessage(ctx, directId, "Файлы получены, загружаю на Яндекс Диск");

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

  // Забираем состояние до первого await: повторная доставка «Завершить
  // загрузку» не должна повторно менять сделку и счётчики (актуализация
  // п.1). Если шаг упал ДО записи в amoCRM — возвращаем состояние, чтобы
  // пользователь мог повторить.
  delete state.pendingUpload;

  try {
    if (pending.kind === "done") {
      await finishDoneUpload(ctx, directId, settings, pending);
    } else if (pending.kind === "defect") {
      await finishDefectUpload(ctx, directId, settings, pending);
    } else if (pending.kind === "otk_defect") {
      await finishOtkRejectUpload(ctx, directId, settings, pending);
    } else if (pending.kind === "final_otk_defect") {
      await finishFinalOtkRejectUpload(ctx, directId, settings, pending);
    } else if (pending.kind === "project_return_defect") {
      await finishProjectReturnUpload(ctx, directId, settings, userName, pending);
    }
  } catch (error) {
    state.pendingUpload = pending;
    throw error;
  }
}

// T-6.5.1.4.1.2 → T-6.5.1.5: завершение загрузки фото готового изделия,
// передача на промежуточный ОТК (T-12 — заглушка) либо смена статуса.
async function finishDoneUpload(ctx, directId, settings, pending) {
  const lead = await ctx.getLead(pending.leadId);
  const contractNumber = lead ? getContractNumberText(ctx, lead) : `Сделка ${pending.leadId}`;

  // Актуализация п.7.1: наличие активного ОТК проверяем на момент
  // завершения, по свежим настройкам.
  const currentSettings = productionWidgetSettingsCache || settings;

  if (hasActiveOtk(currentSettings)) {
    const alreadyHandedOver = lead && fieldIsTruthy(ctx, lead, INTERMEDIATE_OTK_FLAG_FIELD_ID);

    if (!alreadyHandedOver) {
      await patchLead(ctx, pending.leadId, {
        custom_fields_values: [{ field_id: INTERMEDIATE_OTK_FLAG_FIELD_ID, values: [{ value: true }] }]
      });

      // Актуализация п.3.5: ОТК получает «Принять изделие [№]», ссылку на
      // PDF-проект и «Да»/«Нет». Решение — T-12 (handleOtkAcceptReply).
      const pdfLink = lead ? ctx.getFieldValueJoined(lead, PROJECT_PDF_FIELD_ID) : "";

      await notifyRoleUsers(
        ctx,
        currentSettings,
        "otk",
        `Принять изделие ${contractNumber}${pdfLink ? `\nПроект: ${pdfLink}` : ""}`,
        [buildTaggedButtonCompat(ctx, "Да", pending.leadId), buildTaggedButtonCompat(ctx, "Нет", pending.leadId)]
      );
    }
  } else {
    // Активного ОТК нет — по T-6.5.1.5.1 сделка идёт на следующий статус из
    // настроек (ветка прямо описана в исходном ТЗ; см. вопрос №1 раздела 10
    // актуализации — на согласовании у заказчика).
    const row = pending.row;

    if (row.nextAmoStatusId) {
      await patchLead(ctx, pending.leadId, { status_id: Number(row.nextAmoStatusId) });
    }
  }

  const handedTo = hasActiveOtk(currentSettings)
    ? "Сделка передана ОТК"
    : "Сделка передана на следующий этап производства";
  const contractLabel = lead ? getContractNumberWithLink(ctx, lead) : contractNumber;

  await sendProductionDirectMessage(ctx, directId, `Работа по сделке № ${contractLabel}. ${handedTo}`);
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
    `Запрос новой стоимости передан мастеру (${activeManager ? activeManager.handle : "не назначен"}).`
  );

  const contractNumber = getContractNumberText(ctx, lead);
  const currentPrice = getPriceText(ctx, lead, pending.row.priceFieldId);
  const pdfLink = ctx.getFieldValueJoined(lead, PROJECT_PDF_FIELD_ID) || "(ссылка не найдена)";

  const notified = await notifyRoleUsers(
    ctx,
    settings,
    managerRoleKey,
    `№ договора: ${mdSafe(ctx, contractNumber)} Цена: ${mdSafe(ctx, currentPrice)} рублей Проект: ${pdfLink} ` +
      `Исполнитель: ${mdSafe(ctx, userName)} предлагает следующую стоимость: **${mdSafe(ctx, price)}**.`,
    await buildCostDecisionButtons(ctx, lead, `${lead.id}:${lead.status_id}`),
    { markdown: true }
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
// Идентификатор в кнопках — «idСделки:idСтатуса» (в сделке может быть
// несколько ожидающих решений, актуализация п.3.8.4). Старые сообщения с
// одним id сделки обрабатываются по текущему статусу.
function parseCostIdentifier(identifier) {
  const [leadId, statusId] = String(identifier).split(":");

  return { leadId, statusId: statusId ? Number(statusId) : null };
}

async function handleCostRevisionReply(ctx, directId, userKey, identifier, action, settings) {
  const parsed = parseCostIdentifier(identifier);
  const leadId = parsed.leadId;
  const lead = await ctx.getLead(leadId);

  if (!lead) {
    await sendProductionDirectMessage(ctx, directId, "❌ Сделка не найдена.");
    return;
  }

  const statusId = parsed.statusId || Number(lead.status_id);
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
  const contractNumber = getContractNumberWithLink(ctx, lead);
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

    // Актуализация п.3.8.1: сначала подтверждение «Да»/«Нет».
    const stageName = await getStatusNameById(ctx, lead.pipeline_id, statusId);
    const confirmId = `cost:${leadId}:${statusId}`;

    await sendProductionDirectMessage(
      ctx,
      directId,
      `Установить этапу ${stageName} стоимость работ ${entry.new_price}?`,
      [buildTaggedButtonCompat(ctx, "Да", confirmId), buildTaggedButtonCompat(ctx, "Нет", confirmId)]
    );
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

// Ответ «Да»/«Нет» на «Установить этапу … стоимость работ …?» (п.3.8.1).
async function handleCostSetConfirm(ctx, directId, userKey, identifier, decision, settings) {
  const { leadId, statusId } = parseCostIdentifier(identifier);

  if (decision === "no") {
    // «Нет» — возврат к предыдущему сообщению мастера.
    await showCostEntryCard(ctx, directId, leadId, statusId, settings);
    return;
  }

  await runExclusive(leadId, async () => {
    const lead = await ctx.getLead(leadId);
    const entry = lead ? getCostRevisionEntry(await getCostRevisionEntries(ctx, lead), statusId) : null;
    const row = findExecutionRows(settings).find((r) => Number(r.amoStatusId) === Number(statusId));

    if (!entry) {
      await sendProductionDirectMessage(ctx, directId, "Запрос на пересмотр стоимости уже обработан.");
      return;
    }

    if (!row || !row.priceFieldId) {
      await sendProductionDirectMessage(
        ctx,
        directId,
        "❌ Не настроено поле «Цена» для этого этапа. Обратитесь к администратору."
      );
      return;
    }

    await patchLead(ctx, lead.id, {
      custom_fields_values: [{ field_id: row.priceFieldId, values: [{ value: entry.new_price }] }]
    });
    await removeCostRevisionEntry(ctx, lead, statusId);

    await sendProductionDirectMessage(ctx, directId, "Новая стоимость установлена.");
    await notifyUserByName(
      ctx,
      entry.username,
      `Согласована новая стоимость работ по сделке № ${getContractNumberWithLink(ctx, lead)}, цена ${entry.new_price} рублей`
    );
  });
}

// Карточка одного запроса (T-8.5 / п.3.8): текущая цена, проект, исполнитель и
// предложенная им стоимость, кнопки решения.
async function showCostEntryCard(ctx, directId, leadId, statusId, settings) {
  const lead = await ctx.getLead(leadId);
  const entry = lead ? getCostRevisionEntry(await getCostRevisionEntries(ctx, lead), statusId) : null;

  if (!entry) {
    await sendProductionDirectMessage(ctx, directId, "Запрос на пересмотр стоимости уже обработан.");
    return;
  }

  const row = findExecutionRows(settings).find((r) => Number(r.amoStatusId) === Number(statusId));
  const currentPrice = row ? getPriceText(ctx, lead, row.priceFieldId) : "—";
  const pdfLink = ctx.getFieldValueJoined(lead, PROJECT_PDF_FIELD_ID) || "(ссылка не найдена)";
  const identifier = `${leadId}:${statusId}`;

  await sendProductionDirectMessage(
    ctx,
    directId,
    `№ договора: ${mdSafe(ctx, getContractNumberText(ctx, lead))}\nЦена: ${mdSafe(ctx, currentPrice)} рублей\nПроект: ${pdfLink}\n` +
      `Исполнитель: ${mdSafe(ctx, entry.username)} предлагает следующую стоимость: **${mdSafe(ctx, entry.new_price)}**.`,
    await buildCostDecisionButtons(ctx, lead, identifier),
    { markdown: true }
  );
}

// «Пересмотреть стоимость» в меню мастера (T-8.1-8.3): список сделок его
// воронки с ожидающими решениями, затем выбор этапа.
async function showCostRevisionListForForeman(ctx, directId, userKey, roleKey, settings) {
  const state = productionUserState[userKey];
  const pipelineId = PIPELINE_ID_BY_FOREMAN_ROLE[roleKey];
  const leads = [];
  const seen = new Set();

  for (const row of settings.statusFieldMap || []) {
    if (!row.amoStatusId || Number(row.amoPipelineId) !== pipelineId) {
      continue;
    }

    for (const lead of await getLeadsByPipeline(ctx, pipelineId, { statusId: row.amoStatusId, withTags: true })) {
      if (seen.has(lead.id) || leadHasTag(lead, PM_DEAL_TAG_NAME)) {
        continue;
      }

      seen.add(lead.id);

      if ((await getCostRevisionEntries(ctx, lead)).length > 0) {
        lead.__contractNumber = getContractNumberText(ctx, lead);
        leads.push(lead);
      }
    }
  }

  if (leads.length === 0) {
    delete state.listContext;
    await sendProductionDirectMessage(ctx, directId, "Пересмотреть стоимость работ:\nНет запросов.");
    return;
  }

  const sorted = sortDealsForButtons(ctx, leads);
  const lines = ["Пересмотреть стоимость работ:"];

  sorted.forEach((lead, i) => lines.push(`${i + 1}. № договора ${getContractNumberWithLink(ctx, lead)}.`));

  await sendProductionDirectMessage(ctx, directId, lines.join("\n"), registerLeadList(state, "cost_lead", sorted));
}

// Выбрана сделка со списка: перечень этапов с запросами (в порядке строк
// настроек), кнопки «1», «2»…
async function showCostStageChoice(ctx, directId, userKey, lead, settings) {
  const state = productionUserState[userKey];
  const entries = await getCostRevisionEntries(ctx, lead);

  const rows = (settings.statusFieldMap || []).filter((row) =>
    entries.some((entry) => Number(entry.status_id) === Number(row.amoStatusId))
  );

  if (entries.length === 0 || rows.length === 0) {
    await sendProductionDirectMessage(ctx, directId, "Запрос на пересмотр стоимости уже обработан.");
    return;
  }

  const lines = [`Пересмотреть стоимость работ в сделке № договора ${getContractNumberWithLink(ctx, lead)}:`];
  const items = {};

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const entry = getCostRevisionEntry(entries, row.amoStatusId);
    const stageName = await getStatusNameById(ctx, row.amoPipelineId, row.amoStatusId);

    lines.push(`\nСтатус сделки ${stageName}`);
    lines.push(`${i + 1}. Исполнитель ${entry.username}, Цена ${getPriceText(ctx, lead, row.priceFieldId)}, руб.`);
    items[String(i + 1)] = `${lead.id}:${row.amoStatusId}`;
  }

  if (rows.length === 1) {
    delete state.listContext;
    await showCostEntryCard(ctx, directId, lead.id, rows[0].amoStatusId, settings);
    return;
  }

  state.listContext = { kind: "cost_stage", items };
  await sendProductionDirectMessage(ctx, directId, lines.join("\n"), Object.keys(items));
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

  const contractNumber = getContractNumberWithLink(ctx, lead);
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
  const links = await collectPublicLinks(ctx, pending.uploadedPaths);
  const currentSettings = productionWidgetSettingsCache || settings;
  const otkAvailable = hasActiveOtk(currentSettings);

  // T-6.5.4.6.1.3-4: ссылки на фото + флаг для ОТК (T-9) либо, если активного
  // ОТК нет (актуализация п.7, ветка прямо описана в T-6.5.4.6.1.4.2), —
  // флаг для Мастера (T-11). Одна запись в amoCRM, затем уведомления.
  const fields = [
    {
      field_id: otkAvailable ? NOT_ACCEPTED_OTK_FLAG_FIELD_ID : NOT_ACCEPTED_MASTER_FLAG_FIELD_ID,
      values: [{ value: true }]
    }
  ];

  if (links.length > 0) {
    fields.push({ field_id: DEFECT_PHOTO_LINK_FIELD_ID, values: [{ value: links.join(", ") }] });
  }

  await patchLead(ctx, pending.leadId, { custom_fields_values: fields });

  await sendProductionDirectMessage(ctx, directId, "Ваше замечание принято");

  const lead = await ctx.getLead(pending.leadId);

  if (!lead) {
    return;
  }

  if (otkAvailable) {
    const { comment, photos } = getRejectDetails(ctx, lead);

    await notifyRoleUsers(
      ctx,
      currentSettings,
      "otk",
      `${buildNotAcceptedHeadline(ctx, lead, comment)}\n` +
        `Фото дефекта: ${photos}\nПримите решение о дальнейших работах.`,
      [
        buildTaggedButtonCompat(ctx, "Продолжить работу", lead.id),
        buildTaggedButtonCompat(ctx, "Отдать на доработку", lead.id)
      ]
    );
  } else {
    await notifyMasterAboutDecision(ctx, currentSettings, lead);
  }
}

// ------------------------------------------------------------
// 8.9 Карточка: "Не хватает материалов" (ТЗ T-6.5.5) → T-20 (заглушка)
// ------------------------------------------------------------

async function getLeadTags(ctx, leadId) {
  const url = `https://${ctx.AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4/leads/${leadId}`;
  const response = await ctx.amoCrmGet(url, { with: "tags" });

  if (response.status !== 200) {
    throw new Error(`amoCRM GET /leads/${leadId}?with=tags HTTP ${response.status}`);
  }

  return (response.data._embedded && response.data._embedded.tags) || [];
}

async function addTagToLead(ctx, leadId, tagName) {
  const existingTags = await getLeadTags(ctx, leadId);

  if (existingTags.some((tag) => tag.name === tagName)) {
    return;
  }

  const tags = [...existingTags.map((tag) => ({ name: tag.name })), { name: tagName }];

  await patchLead(ctx, leadId, { _embedded: { tags } });
}

async function removeTagFromLead(ctx, leadId, tagName) {
  const existingTags = await getLeadTags(ctx, leadId);
  const remaining = existingTags.filter((tag) => tag.name !== tagName).map((tag) => ({ name: tag.name }));

  if (remaining.length === existingTags.length) {
    return;
  }

  await patchLead(ctx, leadId, { _embedded: { tags: remaining } });
}

// "Кто сообщил о нехватке материалов" — как и у "Распределения" с полем
// "Согласование исполнителя", но для этого случая в ТЗ не предусмотрено
// отдельное amoCRM-поле, поэтому храним в Redis, по id сделки.
function materialsReporterRedisKey(leadId) {
  return `production_materials_reporter:${leadId}`;
}

async function saveMaterialsReporter(ctx, leadId, userName) {
  await ctx.redisRequest(["SET", materialsReporterRedisKey(leadId), userName]);
}

async function loadMaterialsReporter(ctx, leadId) {
  const response = await ctx.redisRequest(["GET", materialsReporterRedisKey(leadId)]);

  return response.result || null;
}

async function clearMaterialsReporter(ctx, leadId) {
  await ctx.redisRequest(["DEL", materialsReporterRedisKey(leadId)]);
}

// Дополнение к ТЗ (пользователь, 2026-10-16): статус сценария "Дозакупка"
// теперь настраивается в виджете (раздел "Сценарии", F-5 — уже реализован
// на Фазе 1), вместо захардкоженных id статусов "Закупка материалов" из
// исходного T-20.2.5.
async function handleMaterialsDecision(ctx, directId, leadId, decision, settings) {
  const reporterUserName = await loadMaterialsReporter(ctx, leadId);

  if (!reporterUserName) {
    await sendProductionDirectMessage(
      ctx,
      directId,
      "❌ Запрос на закупку материалов по этой сделке не найден — возможно, он уже обработан."
    );
    return;
  }

  const lead = await ctx.getLead(leadId);

  if (!lead) {
    await sendProductionDirectMessage(ctx, directId, "❌ Сделка не найдена.");
    await clearMaterialsReporter(ctx, leadId);
    return;
  }

  const contractNumber = getContractNumberWithLink(ctx, lead);
  const reporterDirectId = await loadUserDirectId(ctx, reporterUserName);

  if (decision === "send") {
    const pipelineName = (await getPipelineNameById(ctx, Number(lead.pipeline_id))) || PIPELINE_NAME_METAL;
    const scenarioKey = pipelineName === PIPELINE_NAME_WOOD ? "woodRestock" : "metalRestock";
    const scenario = settings.scenarios && settings.scenarios[scenarioKey];

    if (!scenario || !scenario.amoStatusId) {
      await sendProductionDirectMessage(
        ctx,
        directId,
        `❌ В настройках не указан статус для сценария «Дозакупка ${
          pipelineName === PIPELINE_NAME_WOOD ? "Дерево" : "Металл"
        }». Обратитесь к администратору.`
      );
      return;
    }

    await patchLead(ctx, leadId, { status_id: Number(scenario.amoStatusId) });
    await clearMaterialsReporter(ctx, leadId);

    const text = `Сделка № ${contractNumber} отправлена на закупку материалов`;

    await sendProductionDirectMessage(ctx, directId, text);

    if (reporterDirectId) {
      await sendProductionDirectMessage(ctx, reporterDirectId, text);
    }

    return;
  }

  // "Отклонить" (ТЗ T-20.2.5 "Отклонить"): очистить комментарий и тег.
  await patchLead(ctx, leadId, {
    custom_fields_values: [{ field_id: NOT_ACCEPTED_TEXT_FIELD_ID, values: [{ value: "" }] }]
  });
  await removeTagFromLead(ctx, leadId, DOZAKUPKA_TAG_NAME);
  await clearMaterialsReporter(ctx, leadId);

  await sendProductionDirectMessage(ctx, directId, "Отклонено.");

  if (reporterDirectId) {
    await sendProductionDirectMessage(
      ctx,
      reporterDirectId,
      `Запрос на закупку материалов по сделке № ${contractNumber} отклонён.`
    );
  }
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
  await saveMaterialsReporter(ctx, pending.leadId, userName);

  delete state.pendingTextInput;

  const lead = await ctx.getLead(pending.leadId);
  const contractNumber = lead ? getContractNumberText(ctx, lead) : `Сделка ${pending.leadId}`;
  const pdfLink = lead ? ctx.getFieldValueJoined(lead, PROJECT_PDF_FIELD_ID) : "";

  const pipelineName = (await getPipelineNameById(ctx, pending.row.amoPipelineId)) || PIPELINE_NAME_METAL;
  const managerRoleKey = MANAGER_ROLE_BY_PIPELINE_NAME[pipelineName] || "metalShopForeman";

  // ТЗ T-20.2.5: мастер решает, отправлять ли сделку на закупку (целевой
  // статус — из настроек виджета, раздел "Сценарии", см.
  // handleMaterialsDecision) или отклонить запрос.
  const notified = await notifyRoleUsers(
    ctx,
    settings,
    managerRoleKey,
    `№ договора: ${contractNumber}${pdfLink ? ` (${pdfLink})` : ""}. ${userName} не хватает деталей: ${trimmedText}`,
    [
      buildTaggedButtonCompat(ctx, "Отправить на закупку", pending.leadId),
      buildTaggedButtonCompat(ctx, "Отклонить", pending.leadId)
    ]
  );

  if (notified === 0) {
    console.log(
      `[Бот производства] Сделка ${pending.leadId}: мастер сейчас не достижим для push о нехватке материалов.`
    );
  }

  await sendProductionDirectMessage(ctx, directId, "Комментарий сохранён, мастер уведомлён.");
}

// ------------------------------------------------------------
// 8.10 Карточка: "Вернуть в проектный отдел" (ТЗ T-6.5.6)
// ------------------------------------------------------------
// Вместо флага 555172 заполняется список 564075 «[Бот] Сценарий производства».

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

async function finishProjectReturnUpload(ctx, directId, settings, userName, pending) {
  const links = await collectPublicLinks(ctx, pending.uploadedPaths);
  const fields = [];

  if (links.length > 0) {
    fields.push({ field_id: DEFECT_PHOTO_LINK_FIELD_ID, values: [{ value: links.join(", ") }] });
  }

  // T-6.5.6: вместо флага 555172 заполняем список «[Бот] Сценарий производства»
  // значением «Вернуть в проектный отдел». Значение не найдено — ничего не пишем.
  const scenarioOption = await findFieldEnumForUserName(ctx, SCENARIO_FIELD_ID, SCENARIO_RETURN_TO_DESIGN);

  if (!scenarioOption) {
    console.error(
      `[Бот производства] В списке поля ${SCENARIO_FIELD_ID} нет значения «${SCENARIO_RETURN_TO_DESIGN}»: ` +
        `сделка ${pending.leadId}, сценарий возврата в проектный отдел не записан.`
    );

    if (fields.length > 0) {
      await patchLead(ctx, pending.leadId, { custom_fields_values: fields });
    }

    await sendProductionDirectMessage(
      ctx,
      directId,
      "Замечания и фото сохранены, но передать в проектный отдел не удалось: в amoCRM нет значения " +
        `«${SCENARIO_RETURN_TO_DESIGN}» в поле «[Бот] Сценарий производства». Сообщите администратору.`
    );
    return;
  }

  fields.push({ field_id: SCENARIO_FIELD_ID, values: [{ value: scenarioOption.value, enum_id: scenarioOption.id }] });
  await patchLead(ctx, pending.leadId, { custom_fields_values: fields });

  await sendProductionDirectMessage(ctx, directId, "Ваши замечания приняты.");

  const lead = await ctx.getLead(pending.leadId);
  const foremanRole = lead && MANAGER_ROLE_BY_PIPELINE_ID[Number(lead.pipeline_id)];
  const currentSettings = productionWidgetSettingsCache || settings;

  if (foremanRole) {
    await notifyRoleUsers(
      ctx,
      currentSettings,
      foremanRole,
      `${userName} запросил ${getContractNumberWithLink(ctx, lead)} вернуть в проектный отдел.`
    );
  }
}

// ============================================================
// 8b. ОТК И НЕПРИНЯТЫЕ РАБОТЫ
// (ТЗ T-9…T-12a, T-19; актуализация 2.1 п.3.6-3.7, 4.1, 4.3, 5, 6.1, 7)
// ============================================================
// Списки строятся по живым данным amoCRM при каждом открытии пункта меню —
// не зависят от push-уведомлений (актуализация п.1). Состояние «чьё сейчас
// решение» хранится только в флагах сделки:
//   555172 — ждёт промежуточного ОТК
//   555166 — ждёт решения ОТК по замечанию исполнителя (T-9)
//   555170 — ждёт решения исполнителя (T-10)
//   555168 — ждёт решения мастера (T-11)
// Каждое решение перед выполнением сверяется с этими флагами, поэтому
// повторное нажатие кнопки из старого сообщения ничего не меняет.

const NOT_ACCEPTED_EXECUTOR_FLAG_FIELD_ID = 555170; // "[Бот] Не приняты работы: Исполнитель", флаг
const INTERMEDIATE_OTK_REJECT_COUNTER_FIELD_ID = 560134; // "[Бот] Кол-во не принято промежуточн. ОТК", число
const PM_DEAL_TAG_NAME = "РМ-сделка"; // ТЗ: не выводить в списках при любом запросе

// Мастер определяется по воронке сделки (ТЗ «Ограничения и допущения»). По id,
// а не по названию: названия воронок в amoCRM и в ТЗ расходятся.
const PIPELINE_ID_METAL = 3285168;
const PIPELINE_ID_WOOD = 3797814;

const MANAGER_ROLE_BY_PIPELINE_ID = {
  [PIPELINE_ID_METAL]: "metalShopForeman",
  [PIPELINE_ID_WOOD]: "woodShopForeman"
};

const PIPELINE_ID_BY_FOREMAN_ROLE = {
  metalShopForeman: PIPELINE_ID_METAL,
  woodShopForeman: PIPELINE_ID_WOOD
};

const FOREMAN_ROLE_KEYS = Object.keys(PIPELINE_ID_BY_FOREMAN_ROLE);

// Защита от одновременной обработки одной сделки (повторная доставка
// события вебхука, двойное нажатие). Процесс один, поэтому достаточно памяти.
const leadLocks = new Set();

async function runExclusive(leadId, task) {
  const key = String(leadId);

  if (leadLocks.has(key)) {
    console.log(`[Бот производства] Сделка ${key}: действие уже выполняется, повтор проигнорирован.`);
    return false;
  }

  leadLocks.add(key);

  try {
    await task();
    return true;
  } finally {
    leadLocks.delete(key);
  }
}

function hasActiveOtk(settings) {
  const entries = (settings && settings.roles && settings.roles.otk) || [];

  return entries.some((entry) => entry.active && entry.handle);
}

async function notifyUserByName(ctx, userName, text, buttons) {
  if (!userName) {
    return false;
  }

  const directId = await loadUserDirectId(ctx, userName);

  if (!directId) {
    console.log(`[Бот производства] Не удалось уведомить «${userName}»: direct_id неизвестен.`);
    return false;
  }

  try {
    await sendProductionDirectMessage(ctx, directId, text, buttons);
    return true;
  } catch (error) {
    console.error(`[Бот производства] Не удалось отправить уведомление «${userName}»:`, error.message);
    return false;
  }
}

async function collectPublicLinks(ctx, paths) {
  const links = [];

  for (const path of paths) {
    try {
      links.push(await ctx.ydGetFolderPublicUrl(path));
    } catch (error) {
      console.error("[Бот производства] Не удалось получить ссылку на фото:", error.message);
    }
  }

  return links;
}

function findExecutionRowForLead(settings, lead) {
  return (
    findExecutionRows(settings).find(
      (row) =>
        Number(row.amoStatusId) === Number(lead.status_id) &&
        (!row.amoPipelineId || Number(row.amoPipelineId) === Number(lead.pipeline_id))
    ) || null
  );
}

function getLeadExecutorName(ctx, lead, row) {
  return row && row.executorFieldId ? ctx.getFieldValueJoined(lead, row.executorFieldId) : "";
}

function leadExecutorIs(ctx, lead, row, userName) {
  if (!row || !row.executorFieldId) {
    return false;
  }

  const target = normalizeHandleName(userName);

  return ctx.getFieldValues(lead, row.executorFieldId).some((value) => normalizeHandleName(value) === target);
}

function getLeadNumber(ctx, lead, fieldId) {
  const value = Number(ctx.getFieldValues(lead, fieldId)[0]);

  return Number.isFinite(value) ? value : 0;
}

function buildNotAcceptedHeadline(ctx, lead, comment) {
  const row = productionWidgetSettingsCache ? findExecutionRowForLead(productionWidgetSettingsCache, lead) : null;
  const executorName = getLeadExecutorName(ctx, lead, row);
  const who = executorName ? `исполнителем (${executorName})` : "исполнителем";

  return `НЕ ПРИНЯТО ${who} производство № ${getContractNumberWithLink(ctx, lead)} к исправлению: ${comment}`;
}

function getRejectDetails(ctx, lead) {
  return {
    comment: ctx.getFieldValueJoined(lead, NOT_ACCEPTED_TEXT_FIELD_ID) || "—",
    photos: ctx.getFieldValueJoined(lead, DEFECT_PHOTO_LINK_FIELD_ID) || "—"
  };
}

// Поля текущего цикла отказа (актуализация п.5.6). Счётчики отказов и записи
// согласования стоимости не трогаем.
function buildClearCycleFields(extraFlagIds = []) {
  const flagIds = [
    NOT_ACCEPTED_EXECUTOR_FLAG_FIELD_ID,
    NOT_ACCEPTED_MASTER_FLAG_FIELD_ID,
    NOT_ACCEPTED_OTK_FLAG_FIELD_ID,
    ...extraFlagIds
  ];

  return [
    ...flagIds.map((fieldId) => ({ field_id: fieldId, values: [{ value: false }] })),
    { field_id: NOT_ACCEPTED_TEXT_FIELD_ID, values: [{ value: "" }] },
    { field_id: DEFECT_PHOTO_LINK_FIELD_ID, values: null }
  ];
}

// Сделки на статусах бота «Исполнение» (опционально — одной воронки), без
// «РМ-сделок». Каждой сделке приписываем __row (строку настроек её этапа).
async function loadExecutionLeads(ctx, settings, { pipelineId = null } = {}) {
  const result = [];
  const seen = new Set();

  for (const row of findExecutionRows(settings)) {
    if (!row.amoPipelineId || !row.amoStatusId) {
      continue;
    }

    if (pipelineId && Number(row.amoPipelineId) !== Number(pipelineId)) {
      continue;
    }

    const leads = await getLeadsByPipeline(ctx, row.amoPipelineId, { statusId: row.amoStatusId, withTags: true });

    for (const lead of leads) {
      if (seen.has(lead.id) || leadHasTag(lead, PM_DEAL_TAG_NAME)) {
        continue;
      }

      seen.add(lead.id);
      lead.__row = row;
      lead.__contractNumber = getContractNumberText(ctx, lead);
      result.push(lead);
    }
  }

  return result;
}

// Запоминаем, какая кнопка какой сделке соответствует, и в каком списке
// пользователь сейчас находится — одинаковые номера договоров в разных
// списках не должны путаться.
function registerLeadList(state, kind, leads) {
  const items = {};
  const buttons = [];

  for (const lead of leads) {
    let label = lead.__contractNumber;

    if (items[label]) {
      label = `${label} #${lead.id}`;
    }

    items[label] = lead.id;
    buttons.push(label);
  }

  state.listContext = { kind, items };

  return buttons;
}

// Актуализация п.5.4: «ранее завершённый этап» — по дате «Факт готовности»,
// а не по заполненному «Исполнителю». Текущий этап исключаем.
function getCompletedStageRows(ctx, settings, lead) {
  const rows = [];
  const seen = new Set();

  for (const row of findExecutionRows(settings)) {
    if (!row.amoStatusId || !row.factDateFieldId) {
      continue;
    }

    if (Number(row.amoPipelineId) !== Number(lead.pipeline_id)) {
      continue;
    }

    if (Number(row.amoStatusId) === Number(lead.status_id) || seen.has(Number(row.amoStatusId))) {
      continue;
    }

    if (ctx.getFieldValues(lead, row.factDateFieldId).length === 0) {
      continue;
    }

    seen.add(Number(row.amoStatusId));
    rows.push(row);
  }

  return rows;
}

async function buildMasterDecisionRequest(ctx, settings, lead) {
  const { comment, photos } = getRejectDetails(ctx, lead);
  const contractNumber = getContractNumberWithLink(ctx, lead);
  const stageButtons = [];

  for (const row of getCompletedStageRows(ctx, settings, lead)) {
    const stageName = await getStatusNameById(ctx, row.amoPipelineId, row.amoStatusId);

    stageButtons.push(buildTaggedButtonCompat(ctx, `Вернуть на ${stageName}`, `${lead.id}:${row.amoStatusId}`));
  }

  // Финальный ОТК (T-13.4.2.7.2.1 / T-20.2.1): «Продолжить работу» нет —
  // только выбор этапа возврата.
  if (isAtFinalOtkStatus(lead) || isAtFinalOtkFailedStatus(lead)) {
    stageButtons.push(buildTaggedButtonCompat(ctx, "Вернуть в проектный отдел", `${DESIGN_TAG_PREFIX}${lead.id}`));

    return {
      text:
        `Производство № ${contractNumber} НЕ принято.\nК исправлению: ${comment}. Фото дефекта: ${photos}\n` +
        "Выберите этап, на который нужно вернуть сделку в работу:",
      buttons: stageButtons
    };
  }

  return {
    text:
      `${buildNotAcceptedHeadline(ctx, lead, comment)}\n` +
      `Фото дефекта: ${photos}\nПримите решение о дальнейших работах.`,
    buttons: [buildTaggedButtonCompat(ctx, "Продолжить работу", lead.id), ...stageButtons]
  };
}

async function notifyMasterAboutDecision(ctx, settings, lead) {
  const roleKey = MANAGER_ROLE_BY_PIPELINE_ID[Number(lead.pipeline_id)];

  if (!roleKey) {
    console.error(`[Бот производства] Сделка ${lead.id}: воронка ${lead.pipeline_id} не относится ни к одному мастеру.`);
    return 0;
  }

  const { text, buttons } = await buildMasterDecisionRequest(ctx, settings, lead);

  return notifyRoleUsers(ctx, settings, roleKey, text, buttons);
}

function parseStageReturnButton(text) {
  const match = String(text || "").match(/^Вернуть на (.+) \((\d+):(\d+)\)$/);

  return match ? { leadId: match[2], statusId: match[3] } : null;
}

// ------------------------------------------------------------
// Списки (актуализация п.4.1, 4.3, 5.1, 6.1; T-9/T-10/T-11/T-12/T-12a/T-19)
// ------------------------------------------------------------

// 4.1 / T-12a: «В ОТК» у исполнителя — информационный список без кнопок.
async function showInOtkListForPerformer(ctx, directId, userKey, userName, settings) {
  delete productionUserState[userKey].listContext;

  const leads = (await loadExecutionLeads(ctx, settings)).filter(
    (lead) =>
      fieldIsTruthy(ctx, lead, INTERMEDIATE_OTK_FLAG_FIELD_ID) && leadExecutorIs(ctx, lead, lead.__row, userName)
  );

  if (leads.length === 0) {
    await sendProductionDirectMessage(ctx, directId, "Сделки, ожидающие прохождения контроля\nНет сделок.");
    return;
  }

  const lines = ["Сделки, ожидающие прохождения контроля"];

  sortDealsForButtons(ctx, leads).forEach((lead, i) => {
    const price = getPriceText(ctx, lead, lead.__row.priceFieldId);
    const planDate = ctx.formatDateFieldValue(lead, lead.__row.planDateFieldId) || "—";

    lines.push(`${i + 1}. № ${getContractNumberWithLink(ctx, lead)}, Цена ${price} руб., Срок изготовления ${planDate}`);
  });

  await sendProductionDirectMessage(ctx, directId, lines.join("\n"));
}

// T-12.1: «Промежуточный ОТК», сделки сгруппированы по статусу сделки.
async function showIntermediateOtkList(ctx, directId, userKey, settings) {
  const state = productionUserState[userKey];
  const leads = sortDealsForButtons(
    ctx,
    (await loadExecutionLeads(ctx, settings)).filter((lead) => fieldIsTruthy(ctx, lead, INTERMEDIATE_OTK_FLAG_FIELD_ID))
  );

  if (leads.length === 0) {
    delete state.listContext;
    await sendProductionDirectMessage(ctx, directId, "Сделки, ожидающие прохождения контроля\nНет сделок.");
    return;
  }

  const stageOrder = [];
  const byStage = new Map();

  for (const lead of leads) {
    const stageName = await getStatusNameById(ctx, lead.pipeline_id, lead.status_id);

    if (!byStage.has(stageName)) {
      byStage.set(stageName, []);
      stageOrder.push(stageName);
    }

    byStage.get(stageName).push(lead);
  }

  const ordered = [];
  const lines = ["Сделки, ожидающие прохождения контроля"];

  for (const stageName of stageOrder) {
    lines.push(stageName);

    for (const lead of byStage.get(stageName)) {
      lines.push(`№ ${getContractNumberWithLink(ctx, lead)}.`);
      ordered.push(lead);
    }
  }

  const buttons = registerLeadList(state, "otk_intermediate", ordered);

  await sendProductionDirectMessage(ctx, directId, lines.join("\n"), buttons);
}

async function formatUnacceptedLine(ctx, lead, index) {
  const { comment, photos } = getRejectDetails(ctx, lead);
  const stageName = await getStatusNameById(ctx, lead.pipeline_id, lead.status_id);

  return `${index}. № ${getContractNumberWithLink(ctx, lead)}, Этап: ${stageName}, К исправлению: ${comment}, Фото дефекта: ${photos}`;
}

async function showUnacceptedList(ctx, directId, userKey, title, kind, leads) {
  const state = productionUserState[userKey];

  if (leads.length === 0) {
    delete state.listContext;
    await sendProductionDirectMessage(ctx, directId, `${title}\nНет сделок.`);
    return;
  }

  const sorted = sortDealsForButtons(ctx, leads);
  const lines = [title];

  for (let i = 0; i < sorted.length; i++) {
    lines.push(await formatUnacceptedLine(ctx, sorted[i], i + 1));
  }

  await sendProductionDirectMessage(ctx, directId, lines.join("\n"), registerLeadList(state, kind, sorted));
}

// 5.1 / T-9: решение ОТК по замечанию исполнителя.
async function showUnacceptedListForOtk(ctx, directId, userKey, settings) {
  const leads = (await loadExecutionLeads(ctx, settings)).filter((lead) =>
    fieldIsTruthy(ctx, lead, NOT_ACCEPTED_OTK_FLAG_FIELD_ID)
  );

  await showUnacceptedList(ctx, directId, userKey, "Работы, непринятые исполнителем", "otk_unaccepted", leads);
}

// 4.3 / T-10: только то, что ждёт решения именно этого исполнителя.
async function showUnacceptedListForPerformer(ctx, directId, userKey, userName, settings) {
  const leads = (await loadExecutionLeads(ctx, settings)).filter(
    (lead) =>
      fieldIsTruthy(ctx, lead, NOT_ACCEPTED_EXECUTOR_FLAG_FIELD_ID) && leadExecutorIs(ctx, lead, lead.__row, userName)
  );

  await showUnacceptedList(ctx, directId, userKey, "Работы, непринятые вами", "performer_unaccepted", leads);
}

// T-11: решение мастера (только его воронка).
async function showUnacceptedListForForeman(ctx, directId, userKey, roleKey, settings) {
  const leads = (await loadExecutionLeads(ctx, settings, { pipelineId: PIPELINE_ID_BY_FOREMAN_ROLE[roleKey] })).filter(
    (lead) => fieldIsTruthy(ctx, lead, NOT_ACCEPTED_MASTER_FLAG_FIELD_ID)
  );

  // Сделки, не принятые на финальном ОТК (статус «ОТК не пройдено», T-20.2.1),
  // тоже ждут решения мастера. Объединение со списком T-11 — вопрос №4
  // раздела 10 актуализации (точные фильтры «Непринятые работы»).
  leads.push(...(await loadFinalFailedLeads(ctx, roleKey)));

  await showUnacceptedList(ctx, directId, userKey, "Работы не приняты исполнителем:", "foreman_unaccepted", leads);
}

// ------------------------------------------------------------
// T-20 «Ожидание решения» (мастер): подменю с направлениями.
// Реализованы «Сделки, не принятые на Финальном ОТК» и «Сделки в закупку».
// Направления с проектным отделом и «ОТК перед монтажом» зависят от
// нерешённых вопросов ТЗ (ID 555172, процесс Sensei, T-21) — заглушки.
// ------------------------------------------------------------
const WAITING_DECISION_FINAL_FAILED = "Не приняты Финальным ОТК";
const WAITING_DECISION_DESIGN = "Доработка проектным отделом";
const WAITING_DECISION_BEFORE_MOUNT = "Не прошли ОТК перед монтажом";
const WAITING_DECISION_PROCUREMENT = "Сделки в закупку";
const WAITING_DECISION_BUTTONS = [
  WAITING_DECISION_FINAL_FAILED,
  WAITING_DECISION_DESIGN,
  WAITING_DECISION_BEFORE_MOUNT,
  WAITING_DECISION_PROCUREMENT
];

async function showWaitingDecisionMenu(ctx, directId) {
  await sendProductionDirectMessage(
    ctx,
    directId,
    "Выберите направление, где хотели бы принять решение по поводу сделки",
    WAITING_DECISION_BUTTONS
  );
}

async function showProcurementListForForeman(ctx, directId, userKey, roleKey) {
  const state = productionUserState[userKey];
  const leads = (await getLeadsByPipeline(ctx, PIPELINE_ID_BY_FOREMAN_ROLE[roleKey], { withTags: true })).filter(
    (lead) => leadHasTag(lead, DOZAKUPKA_TAG_NAME)
  );

  if (leads.length === 0) {
    delete state.listContext;
    await sendProductionDirectMessage(ctx, directId, "Сделки, у которых не хватает материала\nНет сделок.");
    return;
  }

  leads.forEach((lead) => {
    lead.__contractNumber = getContractNumberText(ctx, lead);
  });

  const sorted = sortDealsForButtons(ctx, leads);
  const lines = ["Сделки, у которых не хватает материала"];

  sorted.forEach((lead, i) => lines.push(`${i + 1}. № ${getContractNumberWithLink(ctx, lead)}.`));

  await sendProductionDirectMessage(ctx, directId, lines.join("\n"), registerLeadList(state, "materials_lead", sorted));
}

async function handleWaitingDecisionChoice(ctx, directId, userKey, roleKey, settings, choice) {
  const state = productionUserState[userKey];

  delete state.listContext;
  delete state.designMenuStage;

  if (choice === WAITING_DECISION_FINAL_FAILED) {
    const leads = await loadFinalFailedLeads(ctx, roleKey);

    await showUnacceptedList(ctx, directId, userKey, "Сделки, не прошедшие финальный контроль", "foreman_unaccepted", leads);
  } else if (choice === WAITING_DECISION_DESIGN) {
    await showDesignMenu(ctx, directId, userKey);
  } else if (choice === WAITING_DECISION_PROCUREMENT) {
    await showProcurementListForForeman(ctx, directId, userKey, roleKey);
  } else {
    // «Не прошли ОТК перед монтажом» (T-20.2.4 / T-21): этапы возврата и
    // шаги не определены однозначно — ждём ТЗ.
    await handleMenuPlaceholder(ctx, directId, choice);
  }
}

// ------------------------------------------------------------
// T-20.2.6 «Доработка проектным отделом» и возврат в проектный отдел
// ------------------------------------------------------------
// Состояние сделки хранится в списке «[Бот] Сценарий производства» (564075):
// «Вернуть в проектный отдел» — исполнитель просит мастера передать сделку,
// «Передано в проектный отдел» — мастер принял решение.
const SCENARIO_TRANSFERRED_TO_DESIGN = "Передано в проектный отдел";
const REWORK_STATUS_BY_PIPELINE = {
  [PIPELINE_ID_METAL]: 62531197, // «На доработке», Производство
  [PIPELINE_ID_WOOD]: 62531165 // «На доработке», Дерево Производство
};
const DESIGN_SUBMENU_TRANSFER = "Передать на доработку";
const DESIGN_SUBMENU_IN_WORK = "В работе";
const DESIGN_SUBMENU_BACK = "Назад";
const DESIGN_TAG_PREFIX = "design:";

function leadScenarioIs(ctx, lead, value) {
  const target = normalizeHandleName(value);

  return ctx.getFieldValues(lead, SCENARIO_FIELD_ID).some((v) => normalizeHandleName(v) === target);
}

async function buildScenarioField(ctx, value) {
  const option = await findFieldEnumForUserName(ctx, SCENARIO_FIELD_ID, value);

  if (!option) {
    throw new Error(`В поле ${SCENARIO_FIELD_ID} нет значения «${value}»`);
  }

  return { field_id: SCENARIO_FIELD_ID, values: [{ value: option.value, enum_id: option.id }] };
}

async function showDesignMenu(ctx, directId, userKey) {
  const state = productionUserState[userKey];

  state.designMenuStage = "menu";
  await sendProductionDirectMessage(ctx, directId, "Выберите нужный статус", [
    DESIGN_SUBMENU_TRANSFER,
    DESIGN_SUBMENU_IN_WORK
  ]);
}

function isDesignSubmenuInput(state, text) {
  if (!state || !state.designMenuStage) {
    return false;
  }

  return state.designMenuStage === "menu"
    ? text === DESIGN_SUBMENU_TRANSFER || text === DESIGN_SUBMENU_IN_WORK
    : text === DESIGN_SUBMENU_BACK;
}

async function handleDesignSubmenu(ctx, directId, userKey, roleKey, text) {
  const state = productionUserState[userKey];
  const pipelineId = PIPELINE_ID_BY_FOREMAN_ROLE[roleKey];

  delete state.listContext;

  if (text === DESIGN_SUBMENU_BACK) {
    await showDesignMenu(ctx, directId, userKey);
    return;
  }

  if (text === DESIGN_SUBMENU_TRANSFER) {
    const leads = (await getLeadsByPipeline(ctx, pipelineId, { withTags: true })).filter(
      (lead) => !leadHasTag(lead, PM_DEAL_TAG_NAME) && leadScenarioIs(ctx, lead, SCENARIO_RETURN_TO_DESIGN)
    );
    const title = "Сделки, находящиеся на рассмотрение на передачу на доработку";

    if (leads.length === 0) {
      await sendProductionDirectMessage(ctx, directId, `${title}\nНет сделок.`);
      return;
    }

    leads.forEach((lead) => {
      lead.__contractNumber = getContractNumberText(ctx, lead);
    });

    const sorted = sortDealsForButtons(ctx, leads);
    const lines = [title];

    sorted.forEach((lead, i) => lines.push(`${i + 1}.№ ${getContractNumberWithLink(ctx, lead)}.`));

    await sendProductionDirectMessage(ctx, directId, lines.join("\n"), registerLeadList(state, "design_request", sorted));
    return;
  }

  // «В работе»: сделки на этапе «На доработке» (T-20.2.2).
  const leads = (
    await getLeadsByPipeline(ctx, pipelineId, { statusId: REWORK_STATUS_BY_PIPELINE[pipelineId], withTags: true })
  ).filter((lead) => !leadHasTag(lead, PM_DEAL_TAG_NAME));
  const lines = ["Сделки, переданные в проектный отдел:"];

  if (leads.length === 0) {
    lines.push("Нет сделок.");
  }

  sortDealsForButtons(ctx, leads).forEach((lead, i) => lines.push(`${i + 1}.№ ${getContractNumberWithLink(ctx, lead)}.`));

  state.designMenuStage = "inwork";
  await sendProductionDirectMessage(ctx, directId, lines.join("\n"), [DESIGN_SUBMENU_BACK]);
}

function isDesignDecisionValid(ctx, lead, roleKey, { allowFinalFailed }) {
  return (
    lead &&
    FOREMAN_ROLE_KEYS.includes(roleKey) &&
    Number(lead.pipeline_id) === PIPELINE_ID_BY_FOREMAN_ROLE[roleKey] &&
    (leadScenarioIs(ctx, lead, SCENARIO_RETURN_TO_DESIGN) || (allowFinalFailed && isAtFinalOtkFailedStatus(lead)))
  );
}

// Мастер нажал «Вернуть в проектный отдел» (T-20.2.3.3.1.1): спрашиваем, что
// не принято. Сам перевод делает handleDesignMasterCommentInput.
async function handleDesignReturnButton(ctx, directId, userKey, leadId, settings) {
  const state = productionUserState[userKey];

  await runExclusive(leadId, async () => {
    const lead = await ctx.getLead(leadId);

    if (!isDesignDecisionValid(ctx, lead, roleForLead(state, lead), { allowFinalFailed: true })) {
      await sendProductionDirectMessage(ctx, directId, "По этой сделке решение уже принято или не требуется.");
      return;
    }

    state.pendingTextInput = { kind: "design_master_comment", leadId: lead.id };
    await sendProductionDirectMessage(ctx, directId, "Укажите, что не принято");
  });
}

async function handleDesignMasterCommentInput(ctx, directId, userKey, settings, trimmedText) {
  const state = productionUserState[userKey];
  const pending = state.pendingTextInput;

  if (!trimmedText) {
    await sendProductionDirectMessage(ctx, directId, "Укажите, что не принято");
    return;
  }

  delete state.pendingTextInput;

  try {
    await runExclusive(pending.leadId, async () => {
      const lead = await ctx.getLead(pending.leadId);

      if (!isDesignDecisionValid(ctx, lead, roleForLead(state, lead), { allowFinalFailed: true })) {
        await sendProductionDirectMessage(ctx, directId, "По этой сделке решение уже принято или не требуется.");
        return;
      }

      const executorName = getLeadExecutorName(ctx, lead, findExecutionRowForLead(settings, lead));
      const contractNumber = getContractNumberWithLink(ctx, lead);

      await patchLead(ctx, lead.id, {
        status_id: REWORK_STATUS_BY_PIPELINE[Number(lead.pipeline_id)],
        custom_fields_values: [
          await buildScenarioField(ctx, SCENARIO_TRANSFERRED_TO_DESIGN),
          { field_id: NOT_ACCEPTED_TEXT_FIELD_ID, values: [{ value: trimmedText }] }
        ]
      });

      const text = `Решение руководителя по ${contractNumber}: вернуть в проектный отдел.`;

      await sendProductionDirectMessage(ctx, directId, text);
      await notifyRoleUsers(ctx, settings, "otk", text);
      await notifyUserByName(ctx, executorName, text);
    });
  } catch (error) {
    state.pendingTextInput = pending;
    throw error;
  }
}

async function handleDesignDecline(ctx, directId, userKey, leadId, settings) {
  const state = productionUserState[userKey];

  await runExclusive(leadId, async () => {
    const lead = await ctx.getLead(leadId);

    if (!isDesignDecisionValid(ctx, lead, roleForLead(state, lead), { allowFinalFailed: false })) {
      await sendProductionDirectMessage(ctx, directId, "По этой сделке решение уже принято или не требуется.");
      return;
    }

    const executorName = getLeadExecutorName(ctx, lead, findExecutionRowForLead(settings, lead));
    const text = `Решение руководителя по ${getContractNumberWithLink(ctx, lead)}: не передавать на доработку в проектный отдел.`;

    await patchLead(ctx, lead.id, {
      custom_fields_values: [
        { field_id: SCENARIO_FIELD_ID, values: null },
        { field_id: NOT_ACCEPTED_TEXT_FIELD_ID, values: [{ value: "" }] },
        { field_id: DEFECT_PHOTO_LINK_FIELD_ID, values: null }
      ]
    });

    await sendProductionDirectMessage(ctx, directId, text);
    await notifyUserByName(ctx, executorName, text);
  });
}

// T-19: «Не принято ОТК» у мастера — информационный список без кнопок.
async function showOtkRejectedInfoForForeman(ctx, directId, userKey, roleKey, settings) {
  delete productionUserState[userKey].listContext;

  const leads = (await loadExecutionLeads(ctx, settings, { pipelineId: PIPELINE_ID_BY_FOREMAN_ROLE[roleKey] })).filter(
    (lead) =>
      fieldIsTruthy(ctx, lead, NOT_ACCEPTED_OTK_FLAG_FIELD_ID) || fieldIsTruthy(ctx, lead, NOT_ACCEPTED_MASTER_FLAG_FIELD_ID)
  );

  if (leads.length === 0) {
    await sendProductionDirectMessage(ctx, directId, "Сделки не принятые ОТК:\nНет сделок.");
    return;
  }

  const lines = ["Сделки не принятые ОТК:"];

  for (const lead of sortDealsForButtons(ctx, leads)) {
    const stageName = await getStatusNameById(ctx, lead.pipeline_id, lead.status_id);
    const maker = getLeadExecutorName(ctx, lead, lead.__row) || "—";

    lines.push(`№ ${getContractNumberWithLink(ctx, lead)}, Статус сделки: ${stageName}, Изготовитель: ${maker}`);
  }

  await sendProductionDirectMessage(ctx, directId, lines.join("\n"));
}

// ------------------------------------------------------------
// Выбор сделки из списка → карточка с решением
// ------------------------------------------------------------

async function tryHandleOtkListSelection(ctx, directId, userKey, userName, settings, text) {
  const state = productionUserState[userKey];
  const listContext = state && state.listContext;

  if (!listContext || !Object.prototype.hasOwnProperty.call(listContext.items, text)) {
    return false;
  }

  // Пересмотр стоимости: выбор этапа внутри сделки хранит «idСделки:idСтатуса».
  if (listContext.kind === "cost_stage") {
    const { leadId, statusId } = parseCostIdentifier(listContext.items[text]);

    await showCostEntryCard(ctx, directId, leadId, statusId, settings);
    return true;
  }

  const lead = await ctx.getLead(listContext.items[text]);

  if (!lead) {
    await sendProductionDirectMessage(ctx, directId, "❌ Сделка не найдена. Возможно, она уже была изменена.");
    return true;
  }

  const contractNumber = getContractNumberText(ctx, lead);
  const row = findExecutionRowForLead(settings, lead);
  const stale = () =>
    sendProductionDirectMessage(ctx, directId, `По сделке № ${getContractNumberWithLink(ctx, lead)} решение уже принято или не требуется.`);

  if (listContext.kind === "cost_lead") {
    await showCostStageChoice(ctx, directId, userKey, lead, settings);
    return true;
  }

  if (listContext.kind === "otk_intermediate") {
    if (!row || !fieldIsTruthy(ctx, lead, INTERMEDIATE_OTK_FLAG_FIELD_ID)) {
      await stale();
      return true;
    }

    const pdfLink = ctx.getFieldValueJoined(lead, PROJECT_PDF_FIELD_ID);

    await sendProductionDirectMessage(
      ctx,
      directId,
      `Принять изделие?\n№ ${contractNumber}${pdfLink ? `, ${pdfLink}` : ""}`,
      [buildTaggedButtonCompat(ctx, "Да", lead.id), buildTaggedButtonCompat(ctx, "Нет", lead.id)]
    );
    return true;
  }

  if (listContext.kind === "otk_unaccepted") {
    if (!fieldIsTruthy(ctx, lead, NOT_ACCEPTED_OTK_FLAG_FIELD_ID)) {
      await stale();
      return true;
    }

    const { comment, photos } = getRejectDetails(ctx, lead);

    await sendProductionDirectMessage(
      ctx,
      directId,
      `${buildNotAcceptedHeadline(ctx, lead, comment)}\n` +
        `Фото дефекта: ${photos}\nПримите решение о дальнейших работах.`,
      [
        buildTaggedButtonCompat(ctx, "Продолжить работу", lead.id),
        buildTaggedButtonCompat(ctx, "Отдать на доработку", lead.id)
      ]
    );
    return true;
  }

  if (listContext.kind === "performer_unaccepted") {
    if (!fieldIsTruthy(ctx, lead, NOT_ACCEPTED_EXECUTOR_FLAG_FIELD_ID) || !leadExecutorIs(ctx, lead, row, userName)) {
      await stale();
      return true;
    }

    await sendProductionDirectMessage(ctx, directId, buildPerformerDecisionText(ctx, lead), [
      buildTaggedButtonCompat(ctx, "Продолжить работу", lead.id),
      buildTaggedButtonCompat(ctx, "Не принять", lead.id)
    ]);
    return true;
  }

  if (listContext.kind === "materials_lead") {
    if (!leadHasTag(lead, DOZAKUPKA_TAG_NAME)) {
      await stale();
      return true;
    }

    const comment = ctx.getFieldValueJoined(lead, NOT_ACCEPTED_TEXT_FIELD_ID) || "—";

    await sendProductionDirectMessage(
      ctx,
      directId,
      `№ договора: ${getContractNumberWithLink(ctx, lead)}. Не хватает деталей: ${comment}`,
      [buildTaggedButtonCompat(ctx, "Отправить на закупку", lead.id), buildTaggedButtonCompat(ctx, "Отклонить", lead.id)]
    );
    return true;
  }

  if (listContext.kind === "design_request") {
    if (!leadScenarioIs(ctx, lead, SCENARIO_RETURN_TO_DESIGN)) {
      await stale();
      return true;
    }

    const { comment, photos } = getRejectDetails(ctx, lead);
    const executorName = getLeadExecutorName(ctx, lead, row) || "Исполнитель";

    await sendProductionDirectMessage(
      ctx,
      directId,
      `${executorName} указал, что № ${getContractNumberWithLink(ctx, lead)} необходимо отправить на доработку.\n${comment}\n${photos}`,
      [
        buildTaggedButtonCompat(ctx, "Вернуть в проектный отдел", `${DESIGN_TAG_PREFIX}${lead.id}`),
        buildTaggedButtonCompat(ctx, "Отклонить", `${DESIGN_TAG_PREFIX}${lead.id}`)
      ]
    );
    return true;
  }

  if (listContext.kind === "final_otk") {
    await showFinalOtkCard(ctx, directId, lead, settings, roleForLead(state, lead));
    return true;
  }

  if (listContext.kind === "foreman_unaccepted") {
    if (!fieldIsTruthy(ctx, lead, NOT_ACCEPTED_MASTER_FLAG_FIELD_ID) && !isAtFinalOtkFailedStatus(lead)) {
      await stale();
      return true;
    }

    const request = await buildMasterDecisionRequest(ctx, settings, lead);

    await sendProductionDirectMessage(ctx, directId, request.text, request.buttons);
    return true;
  }

  return false;
}

// Актуализация п.5.2: сообщение исполнителю о решении ОТК.
function buildPerformerDecisionText(ctx, lead) {
  const { comment, photos } = getRejectDetails(ctx, lead);

  return (
    `№ ${getContractNumberWithLink(ctx, lead)}\nК исправлению: ${comment}\nФото дефекта: ${photos}\n` +
    "Решение специалиста ОТК: продолжить работу.\nПринять сделку?"
  );
}

// ------------------------------------------------------------
// T-12.4: решение промежуточного ОТК «Да» / «Нет»
// ------------------------------------------------------------

async function handleOtkAcceptReply(ctx, directId, userKey, leadId, decision, settings) {
  await runExclusive(leadId, async () => {
    const lead = await ctx.getLead(leadId);
    const row = lead ? findExecutionRowForLead(settings, lead) : null;

    if (!lead || !row || !fieldIsTruthy(ctx, lead, INTERMEDIATE_OTK_FLAG_FIELD_ID)) {
      await sendProductionDirectMessage(ctx, directId, "По этой сделке решение уже принято или не требуется.");
      return;
    }

    const contractNumber = getContractNumberWithLink(ctx, lead);

    if (decision === "no") {
      productionUserState[userKey].pendingTextInput = { kind: "otk_reject_comment", leadId: lead.id, row };
      await sendProductionDirectMessage(ctx, directId, "Укажите что не принято");
      return;
    }

    // T-12.4.1 / актуализация п.3.6.
    if (!row.nextAmoStatusId) {
      await sendProductionDirectMessage(
        ctx,
        directId,
        "❌ Не настроен следующий статус amoCRM для текущего этапа. Обратитесь к администратору."
      );
      return;
    }

    const executorName = getLeadExecutorName(ctx, lead, row);

    await patchLead(ctx, lead.id, {
      status_id: Number(row.nextAmoStatusId),
      custom_fields_values: buildClearCycleFields([INTERMEDIATE_OTK_FLAG_FIELD_ID])
    });

    try {
      await removeTagFromLead(ctx, lead.id, OTK_REJECTED_TAG_NAME);
    } catch (error) {
      console.error(`[Бот производства] Сделка ${lead.id}: не удалось снять тег «${OTK_REJECTED_TAG_NAME}»:`, error.message);
    }

    await sendProductionDirectMessage(ctx, directId, `Изделие по сделке № ${contractNumber} принято.`);
    await notifyUserByName(ctx, executorName, `Производство ${contractNumber} принято`);
  });
}

// T-12.4.2.1-3: комментарий ОТК → фото дефекта.
async function handleOtkRejectCommentInput(ctx, directId, userKey, trimmedText) {
  const state = productionUserState[userKey];
  const pending = state.pendingTextInput;

  if (!trimmedText) {
    await sendProductionDirectMessage(ctx, directId, "Укажите что не принято");
    return;
  }

  delete state.pendingTextInput;

  state.pendingUpload = {
    leadId: pending.leadId,
    row: pending.row,
    kind: "otk_defect",
    baseName: "Дефект изделия",
    comment: trimmedText,
    uploadedPaths: []
  };

  await sendProductionDirectMessage(ctx, directId, "Прикрепите фото дефекта");
}

// T-12.4.2.6-9 и актуализация п.3.7/6.1: одна запись в amoCRM (комментарий,
// ссылки, счётчик +1, флаг исполнителя, сброс флага ОТК), затем тег и
// уведомления. Бросать исключение можно только ДО записи — иначе повторная
// попытка увеличила бы счётчик второй раз (см. handleFinishUpload).
async function finishOtkRejectUpload(ctx, directId, settings, pending) {
  const lead = await ctx.getLead(pending.leadId);

  if (!lead || !fieldIsTruthy(ctx, lead, INTERMEDIATE_OTK_FLAG_FIELD_ID)) {
    await sendProductionDirectMessage(ctx, directId, "По этой сделке решение уже принято или не требуется.");
    return;
  }

  const links = await collectPublicLinks(ctx, pending.uploadedPaths);
  const row = findExecutionRowForLead(settings, lead) || pending.row;
  const executorName = getLeadExecutorName(ctx, lead, row);
  const contractNumber = getContractNumberWithLink(ctx, lead);
  const counter = getLeadNumber(ctx, lead, INTERMEDIATE_OTK_REJECT_COUNTER_FIELD_ID) + 1;

  const fields = [
    { field_id: NOT_ACCEPTED_TEXT_FIELD_ID, values: [{ value: pending.comment }] },
    { field_id: INTERMEDIATE_OTK_REJECT_COUNTER_FIELD_ID, values: [{ value: counter }] },
    { field_id: NOT_ACCEPTED_EXECUTOR_FLAG_FIELD_ID, values: [{ value: true }] },
    // Работа больше не ждёт контроля: сделка снова в списке «Исполнение»
    // (группа «непринятые ОТК»), факт готовности не очищаем.
    { field_id: INTERMEDIATE_OTK_FLAG_FIELD_ID, values: [{ value: false }] }
  ];

  if (links.length > 0) {
    fields.push({ field_id: DEFECT_PHOTO_LINK_FIELD_ID, values: [{ value: links.join(", ") }] });
  }

  await patchLead(ctx, lead.id, { custom_fields_values: fields });

  try {
    await addTagToLead(ctx, lead.id, OTK_REJECTED_TAG_NAME);
  } catch (error) {
    console.error(`[Бот производства] Сделка ${lead.id}: не удалось поставить тег «${OTK_REJECTED_TAG_NAME}»:`, error.message);
  }

  await sendProductionDirectMessage(ctx, directId, "Ваши замечания приняты.");

  const photos = links.length > 0 ? links.join(", ") : "—";
  const base = `Производство № ${contractNumber} НЕ принято.\nК исправлению: ${pending.comment}. Фото дефекта: ${photos}`;
  const foremanRoleKey = MANAGER_ROLE_BY_PIPELINE_ID[Number(lead.pipeline_id)];

  if (foremanRoleKey) {
    await notifyRoleUsers(ctx, settings, foremanRoleKey, `${base}\nИзготовитель: ${executorName || "—"}`);
  }

  await notifyUserByName(ctx, executorName, base);
}

// ------------------------------------------------------------
// Кнопки решений: «Продолжить работу» / «Отдать на доработку» / «Не принять»
// / «Вернуть на [этап]» — смысл зависит от роли нажавшего (T-9.4, T-10.4,
// T-11.4), актуальность проверяется по флагам сделки.
// ------------------------------------------------------------

async function handleUnacceptedDecision(ctx, directId, userKey, userName, leadId, action, settings) {
  const state = productionUserState[userKey];

  await runExclusive(leadId, async () => {
    const lead = await ctx.getLead(leadId);
    const roleKey = roleForLead(state, lead);
    const row = lead ? findExecutionRowForLead(settings, lead) : null;
    const stale = () => sendProductionDirectMessage(ctx, directId, "По этой сделке решение уже принято или не требуется.");

    if (!lead) {
      await sendProductionDirectMessage(ctx, directId, "❌ Сделка не найдена. Возможно, она уже была изменена.");
      return;
    }

    const contractNumber = getContractNumberWithLink(ctx, lead);

    // --- ОТК (T-9.4) ---
    if (roleKey === "otk") {
      if (!fieldIsTruthy(ctx, lead, NOT_ACCEPTED_OTK_FLAG_FIELD_ID)) {
        await stale();
        return;
      }

      if (action === "continue") {
        await patchLead(ctx, lead.id, {
          custom_fields_values: [
            { field_id: NOT_ACCEPTED_OTK_FLAG_FIELD_ID, values: [{ value: false }] },
            { field_id: NOT_ACCEPTED_EXECUTOR_FLAG_FIELD_ID, values: [{ value: true }] }
          ]
        });

        await sendProductionDirectMessage(ctx, directId, "Решение передано исполнителю.");
        await notifyUserByName(ctx, getLeadExecutorName(ctx, lead, row), buildPerformerDecisionText(ctx, lead), [
          buildTaggedButtonCompat(ctx, "Продолжить работу", lead.id),
          buildTaggedButtonCompat(ctx, "Не принять", lead.id)
        ]);
        return;
      }

      if (action === "handover") {
        await patchLead(ctx, lead.id, {
          custom_fields_values: [
            { field_id: NOT_ACCEPTED_OTK_FLAG_FIELD_ID, values: [{ value: false }] },
            { field_id: NOT_ACCEPTED_MASTER_FLAG_FIELD_ID, values: [{ value: true }] }
          ]
        });

        await sendProductionDirectMessage(ctx, directId, "Решение передано мастеру.");
        await notifyMasterAboutDecision(ctx, settings, lead);
        return;
      }

      await stale();
      return;
    }

    // --- Исполнитель (T-10.4) ---
    if (roleKey === PERFORMER_ROLE_KEY) {
      if (!fieldIsTruthy(ctx, lead, NOT_ACCEPTED_EXECUTOR_FLAG_FIELD_ID) || !leadExecutorIs(ctx, lead, row, userName)) {
        await stale();
        return;
      }

      if (action === "continue") {
        await patchLead(ctx, lead.id, { custom_fields_values: buildClearCycleFields() });
        await sendProductionDirectMessage(
          ctx,
          directId,
          `Работа по сделке № ${contractNumber} продолжается. Сделка остаётся в «Исполнении».`
        );
        return;
      }

      if (action === "refuse") {
        await patchLead(ctx, lead.id, {
          custom_fields_values: [
            { field_id: NOT_ACCEPTED_EXECUTOR_FLAG_FIELD_ID, values: [{ value: false }] },
            { field_id: NOT_ACCEPTED_MASTER_FLAG_FIELD_ID, values: [{ value: true }] }
          ]
        });

        await sendProductionDirectMessage(ctx, directId, "Решение передано мастеру.");
        await notifyMasterAboutDecision(ctx, settings, lead);
        return;
      }

      await stale();
      return;
    }

    // --- Мастер (T-11.4 / актуализация п.5.5) ---
    if (FOREMAN_ROLE_KEYS.includes(roleKey)) {
      if (
        action !== "continue" ||
        !fieldIsTruthy(ctx, lead, NOT_ACCEPTED_MASTER_FLAG_FIELD_ID) ||
        Number(lead.pipeline_id) !== PIPELINE_ID_BY_FOREMAN_ROLE[roleKey]
      ) {
        await stale();
        return;
      }

      const decisionText = `Решение Мастера по № ${contractNumber}: продолжить работу`;
      const executorName = getLeadExecutorName(ctx, lead, row);

      // Сначала сообщения (им нужны данные цикла), затем очистка — п.5.6.
      await sendProductionDirectMessage(
        ctx,
        directId,
        `Сделку вернули в работу, исполнитель (${executorName || "—"}) уведомлен.`
      );
      await notifyRoleUsers(ctx, settings, "otk", decisionText);
      await notifyUserByName(ctx, executorName, decisionText);
      await patchLead(ctx, lead.id, { custom_fields_values: buildClearCycleFields() });
      return;
    }

    await stale();
  });
}

// T-11.4.2 / актуализация п.5.6: мастер возвращает сделку на ранее
// завершённый этап.
async function handleForemanReturnToStage(ctx, directId, userKey, leadId, statusId, settings) {
  const state = productionUserState[userKey];

  await runExclusive(leadId, async () => {
    const lead = await ctx.getLead(leadId);
    const roleKey = roleForLead(state, lead);
    const stale = () => sendProductionDirectMessage(ctx, directId, "По этой сделке решение уже принято или не требуется.");

    // Решение мастера: либо флаг «Не приняты работы: Мастер», либо финальный
    // ОТК (сделка на «ОТК не пройдено» или — без активного ОТК — на самом
    // этапе ОТК).
    const isFinalCase =
      lead && (isAtFinalOtkFailedStatus(lead) || (isAtFinalOtkStatus(lead) && !hasActiveOtk(settings)));

    if (
      !lead ||
      !FOREMAN_ROLE_KEYS.includes(roleKey) ||
      Number(lead.pipeline_id) !== PIPELINE_ID_BY_FOREMAN_ROLE[roleKey] ||
      !(isFinalCase || fieldIsTruthy(ctx, lead, NOT_ACCEPTED_MASTER_FLAG_FIELD_ID))
    ) {
      await stale();
      return;
    }

    const currentRow = findExecutionRowForLead(settings, lead);
    const targetRow = getCompletedStageRows(ctx, settings, lead).find(
      (row) => Number(row.amoStatusId) === Number(statusId)
    );

    if (!targetRow) {
      await sendProductionDirectMessage(ctx, directId, "Этот этап недоступен для возврата. Откройте сделку заново.");
      return;
    }

    const contractNumber = getContractNumberWithLink(ctx, lead);
    const { comment, photos } = getRejectDetails(ctx, lead);
    const stageName = await getStatusNameById(ctx, targetRow.amoPipelineId, targetRow.amoStatusId);
    const newExecutorName = getLeadExecutorName(ctx, lead, targetRow);
    const previousExecutorName = getLeadExecutorName(ctx, lead, currentRow);

    await patchLead(ctx, lead.id, { status_id: Number(targetRow.amoStatusId) });

    // Финальный ОТК: сделка возвращается «к исправлению» (T-13.4.2.7.2.2.1.2).
    if (isFinalCase) {
      try {
        await addTagToLead(ctx, lead.id, OTK_REJECTED_TAG_NAME);
      } catch (error) {
        console.error(`[Бот производства] Сделка ${lead.id}: не удалось поставить тег:`, error.message);
      }
    }

    const decisionText = `Решение Мастера по № ${contractNumber}: вернуть на этап ${stageName}`;

    await sendProductionDirectMessage(ctx, directId, decisionText);
    await notifyRoleUsers(ctx, settings, "otk", decisionText);

    if (normalizeHandleName(previousExecutorName) !== normalizeHandleName(newExecutorName)) {
      await notifyUserByName(ctx, previousExecutorName, decisionText);
    }

    await notifyUserByName(
      ctx,
      newExecutorName,
      `Производство № ${contractNumber} НЕ принято.\nК исправлению: ${comment}. Фото дефекта: ${photos}`
    );

    // Только после переходов и сообщений — п.5.6.
    await patchLead(ctx, lead.id, { custom_fields_values: buildClearCycleFields() });
  });
}

// ============================================================
// 8b2. ФИНАЛЬНЫЙ ОТК (ТЗ T-13; актуализация 2.1 п.6.2, 7)
// ============================================================
// Сделка на статусе «ОТК Металл» / «ОТК дерево» без тега «Не принято ОТК».
// Проверяет активный ОТК; если активного ОТК нет — тот же сценарий доступен
// мастеру (T-3.2.3.1), а при отказе он сразу выбирает этап возврата
// (T-13.4.2.7.2, единственная описанная ветка для отсутствия ОТК).

const FINAL_OTK_STATUS_BY_PIPELINE = {
  [PIPELINE_ID_METAL]: 41835627, // «ОТК Металл»
  [PIPELINE_ID_WOOD]: 41835516 // «ОТК дерево»
};

const FINAL_OTK_FAILED_STATUS_BY_PIPELINE = {
  [PIPELINE_ID_METAL]: 58274773, // «ОТК не пройдено», воронка Производство
  [PIPELINE_ID_WOOD]: 58274701 // «ОТК не пройдено», воронка Дерево производство
};

const FINAL_OTK_REJECT_COUNTER_FIELD_ID = 560094; // "[Бот] Кол-во не принято ОТК", число

function isAtFinalOtkStatus(lead) {
  return Number(lead.status_id) === FINAL_OTK_STATUS_BY_PIPELINE[Number(lead.pipeline_id)];
}

function isAtFinalOtkFailedStatus(lead) {
  return Number(lead.status_id) === FINAL_OTK_FAILED_STATUS_BY_PIPELINE[Number(lead.pipeline_id)];
}

// Кто может выполнять финальный ОТК: ОТК; мастер — только пока нет активного ОТК.
function canDoFinalOtk(roleKey, settings, lead) {
  if (roleKey === "otk") {
    return true;
  }

  return (
    FOREMAN_ROLE_KEYS.includes(roleKey) &&
    !hasActiveOtk(settings) &&
    Number(lead.pipeline_id) === PIPELINE_ID_BY_FOREMAN_ROLE[roleKey]
  );
}

async function loadFinalLeads(ctx, pipelineIds, statusMap, { withOtkTag }) {
  const result = [];

  for (const pipelineId of pipelineIds) {
    const leads = await getLeadsByPipeline(ctx, pipelineId, { statusId: statusMap[pipelineId], withTags: true });

    for (const lead of leads) {
      if (leadHasTag(lead, PM_DEAL_TAG_NAME) || leadHasTag(lead, OTK_REJECTED_TAG_NAME) !== withOtkTag) {
        continue;
      }

      lead.__contractNumber = getContractNumberText(ctx, lead);
      result.push(lead);
    }
  }

  return result;
}

function getFinalOtkPipelineIds(roleKey) {
  return roleKey === "otk" ? [PIPELINE_ID_METAL, PIPELINE_ID_WOOD] : [PIPELINE_ID_BY_FOREMAN_ROLE[roleKey]];
}

// T-13.1: «Финальный ОТК» — список сделок.
async function showFinalOtkList(ctx, directId, userKey, roleKey, settings) {
  const state = productionUserState[userKey];

  if (roleKey !== "otk" && hasActiveOtk(settings)) {
    await sendProductionDirectMessage(ctx, directId, "Финальный ОТК сейчас выполняет специалист ОТК.");
    return;
  }

  const leads = sortDealsForButtons(
    ctx,
    await loadFinalLeads(ctx, getFinalOtkPipelineIds(roleKey), FINAL_OTK_STATUS_BY_PIPELINE, { withOtkTag: false })
  );

  if (leads.length === 0) {
    delete state.listContext;
    await sendProductionDirectMessage(ctx, directId, "Сделки, ожидающие прохождения контроля\nНет сделок.");
    return;
  }

  const lines = ["Сделки, ожидающие прохождения контроля"];

  leads.forEach((lead, i) => lines.push(`${i + 1}. № ${getContractNumberWithLink(ctx, lead)}.`));

  await sendProductionDirectMessage(ctx, directId, lines.join("\n"), registerLeadList(state, "final_otk", leads));
}

// Сделки «ОТК не пройдено» с тегом — ждут решения мастера (T-20.2.1).
async function loadFinalFailedLeads(ctx, roleKey) {
  return loadFinalLeads(ctx, getFinalOtkPipelineIds(roleKey), FINAL_OTK_FAILED_STATUS_BY_PIPELINE, {
    withOtkTag: true
  });
}

async function showFinalOtkCard(ctx, directId, lead, settings, roleKey) {
  if (
    !isAtFinalOtkStatus(lead) ||
    !canDoFinalOtk(roleKey, settings, lead) ||
    (await leadHasOtkRejectedTag(ctx, lead.id))
  ) {
    await sendProductionDirectMessage(ctx, directId, "По этой сделке решение уже принято или не требуется.");
    return;
  }

  const pdfLink = ctx.getFieldValueJoined(lead, PROJECT_PDF_FIELD_ID);
  const id = `final:${lead.id}`;

  await sendProductionDirectMessage(
    ctx,
    directId,
    `Финальный контроль сделки. Изделие готово?\n№ ${getContractNumberText(ctx, lead)}${pdfLink ? `, ${pdfLink}` : ""}`,
    [buildTaggedButtonCompat(ctx, "Да", id), buildTaggedButtonCompat(ctx, "Нет", id)]
  );
}

// getLead не возвращает теги — проверяем их отдельным запросом.
async function leadHasOtkRejectedTag(ctx, leadId) {
  return (await getLeadTags(ctx, leadId)).some((tag) => tag.name === OTK_REJECTED_TAG_NAME);
}

// T-13.4: «Да» / «Нет» финального ОТК.
async function handleFinalOtkReply(ctx, directId, userKey, leadId, decision, settings) {
  const state = productionUserState[userKey];

  await runExclusive(leadId, async () => {
    const lead = await ctx.getLead(leadId);
    const roleKey = roleForLead(state, lead);
    const stale = () => sendProductionDirectMessage(ctx, directId, "По этой сделке решение уже принято или не требуется.");

    if (
      !lead ||
      !isAtFinalOtkStatus(lead) ||
      !canDoFinalOtk(roleKey, settings, lead) ||
      (await leadHasOtkRejectedTag(ctx, lead.id))
    ) {
      await stale();
      return;
    }

    if (decision === "no") {
      productionUserState[userKey].pendingTextInput = { kind: "final_otk_reject_comment", leadId: lead.id };
      await sendProductionDirectMessage(ctx, directId, "Укажите что не принято");
      return;
    }

    // T-13.4.1: следующий статус — из строки настроек этого этапа.
    const row = (settings.statusFieldMap || []).find(
      (r) => Number(r.amoStatusId) === Number(lead.status_id) && r.nextAmoStatusId
    );

    if (!row) {
      await sendProductionDirectMessage(
        ctx,
        directId,
        "❌ Не настроен следующий статус amoCRM для этапа финального ОТК. Обратитесь к администратору."
      );
      return;
    }

    await patchLead(ctx, lead.id, { status_id: Number(row.nextAmoStatusId) });

    try {
      await removeTagFromLead(ctx, lead.id, OTK_REJECTED_TAG_NAME);
    } catch (error) {
      console.error(`[Бот производства] Сделка ${lead.id}: не удалось снять тег:`, error.message);
    }

    await sendProductionDirectMessage(ctx, directId, `Изделие по сделке № ${getContractNumberWithLink(ctx, lead)} принято.`);
  });
}

async function handleFinalOtkRejectCommentInput(ctx, directId, userKey, trimmedText) {
  const state = productionUserState[userKey];
  const pending = state.pendingTextInput;

  if (!trimmedText) {
    await sendProductionDirectMessage(ctx, directId, "Укажите что не принято");
    return;
  }

  delete state.pendingTextInput;

  state.pendingUpload = {
    leadId: pending.leadId,
    kind: "final_otk_defect",
    baseName: "Дефект изделия",
    comment: trimmedText,
    uploadedPaths: []
  };

  await sendProductionDirectMessage(ctx, directId, "Прикрепите фото дефекта");
}

// T-13.4.2.4-7: одна запись (комментарий, ссылки, счётчик +1), затем ветка по
// активному ОТК. Исключения — только до записи (см. handleFinishUpload).
async function finishFinalOtkRejectUpload(ctx, directId, settings, pending) {
  const lead = await ctx.getLead(pending.leadId);

  if (!lead || !isAtFinalOtkStatus(lead)) {
    await sendProductionDirectMessage(ctx, directId, "По этой сделке решение уже принято или не требуется.");
    return;
  }

  const links = await collectPublicLinks(ctx, pending.uploadedPaths);
  const currentSettings = productionWidgetSettingsCache || settings;
  const otkAvailable = hasActiveOtk(currentSettings);
  const counter = getLeadNumber(ctx, lead, FINAL_OTK_REJECT_COUNTER_FIELD_ID) + 1;

  const fields = [
    { field_id: NOT_ACCEPTED_TEXT_FIELD_ID, values: [{ value: pending.comment }] },
    { field_id: FINAL_OTK_REJECT_COUNTER_FIELD_ID, values: [{ value: counter }] }
  ];

  if (links.length > 0) {
    fields.push({ field_id: DEFECT_PHOTO_LINK_FIELD_ID, values: [{ value: links.join(", ") }] });
  }

  const body = { custom_fields_values: fields };

  // T-13.4.2.7.1.3: при активном ОТК сделка уходит на «ОТК не пройдено».
  if (otkAvailable) {
    body.status_id = FINAL_OTK_FAILED_STATUS_BY_PIPELINE[Number(lead.pipeline_id)];
  }

  await patchLead(ctx, lead.id, body);

  const fresh = (await ctx.getLead(lead.id)) || lead;
  const contractNumber = getContractNumberWithLink(ctx, fresh);

  if (otkAvailable) {
    try {
      await addTagToLead(ctx, lead.id, OTK_REJECTED_TAG_NAME);
    } catch (error) {
      console.error(`[Бот производства] Сделка ${lead.id}: не удалось поставить тег:`, error.message);
    }

    const foremanRoleKey = MANAGER_ROLE_BY_PIPELINE_ID[Number(lead.pipeline_id)];
    const foremanNames = (((currentSettings.roles || {})[foremanRoleKey]) || [])
      .filter((entry) => entry.active && entry.handle)
      .map((entry) => entry.handle)
      .join(", ");

    await sendProductionDirectMessage(
      ctx,
      directId,
      `Ваши замечания приняты, сделка передана Мастеру${foremanNames ? ` (${foremanNames})` : ""}.`
    );

    if (foremanRoleKey) {
      await notifyRoleUsers(
        ctx,
        currentSettings,
        foremanRoleKey,
        `Вам необходимо принять решение по сделке № ${contractNumber}. Изделие НЕ принято ОТК на Финальном ОТК.`
      );
    }

    return;
  }

  // Активного ОТК нет — T-13.4.2.7.2.1: выбор этапа возврата.
  await sendProductionDirectMessage(ctx, directId, "Ваши замечания приняты.");

  const request = await buildMasterDecisionRequest(ctx, currentSettings, fresh);

  await sendProductionDirectMessage(ctx, directId, request.text, request.buttons);
}

// ============================================================
// 8c. КОНТРОЛЬ СРОКОВ (ТЗ T-16; актуализация 2.1 п.4.2)
// ============================================================

const PRODUCT_PLAN_DATE_FIELD_ID = 550764; // "Плановая готовность изделия", дата
const CLOSED_STATUS_IDS = [142, 143]; // «Успешно реализовано» / «Закрыто и не реализовано»

const PIPELINE_TITLE_BY_ID = {
  [PIPELINE_ID_METAL]: "Производство Металл",
  [PIPELINE_ID_WOOD]: "Производство Дерево"
};

// Просрочка — плановая дата СТРОГО раньше сегодняшнего дня по Москве; дней
// просрочки = сегодня минус плановая дата.
function getOverdueDays(todayStart, rawValue) {
  const unix = Number(rawValue);

  if (!Number.isFinite(unix) || unix <= 0 || unix >= todayStart) {
    return 0;
  }

  return Math.max(1, Math.round((todayStart - unix) / 86400));
}

// Этапы (строки «Связи этапов и полей» со статусом бота «Исполнение»),
// у которых плановая дата этапа просрочена. userName — только его сделки
// (исполнитель); без него — все (мастер/директор).
async function collectOverdueStages(ctx, settings, { pipelineId = null, userName = null } = {}) {
  const todayStart = ctx.todayMoscowStartUnix();
  const result = [];

  for (const lead of await loadExecutionLeads(ctx, settings, { pipelineId })) {
    const row = lead.__row;

    if (!row.planDateFieldId || (userName && !leadExecutorIs(ctx, lead, row, userName))) {
      continue;
    }

    const days = getOverdueDays(todayStart, ctx.getFieldValues(lead, row.planDateFieldId)[0]);

    if (days > 0) {
      result.push({
        lead,
        days,
        stageName: await getStatusNameById(ctx, lead.pipeline_id, lead.status_id),
        maker: getLeadExecutorName(ctx, lead, row) || "—"
      });
    }
  }

  return result.sort((a, b) => b.days - a.days);
}

// Сделки воронки целиком: просрочена «Плановая готовность изделия».
async function collectOverdueDeals(ctx, settings, pipelineId) {
  const todayStart = ctx.todayMoscowStartUnix();
  const result = [];

  for (const lead of await getLeadsByPipeline(ctx, pipelineId, { withTags: true })) {
    if (CLOSED_STATUS_IDS.includes(Number(lead.status_id)) || leadHasTag(lead, PM_DEAL_TAG_NAME)) {
      continue;
    }

    const days = getOverdueDays(todayStart, ctx.getFieldValues(lead, PRODUCT_PLAN_DATE_FIELD_ID)[0]);

    if (days > 0) {
      const row = findExecutionRowForLead(settings, lead);

      result.push({
        lead,
        days,
        stageName: await getStatusNameById(ctx, lead.pipeline_id, lead.status_id),
        maker: (row && getLeadExecutorName(ctx, lead, row)) || "—"
      });
    }
  }

  return result.sort((a, b) => b.days - a.days);
}

function formatOverdueLine(ctx, item, index) {
  return (
    `${index + 1}. № ${getContractNumberWithLink(ctx, item.lead)}. Статус сделки amoCRM: ${item.stageName}. ` +
    `Изготовитель: ${item.maker}. Кол-во дней просрочки: ${item.days}`
  );
}

// Тексты сообщений для пользователя по его роли; пустой массив — нарушений
// нет (сделки без просрочки не выводим).
async function buildDeadlineMessages(ctx, settings, roleKey, userName) {
  const messages = [];

  if (roleKey === PERFORMER_ROLE_KEY) {
    const stages = await collectOverdueStages(ctx, settings, { userName });

    if (stages.length > 0) {
      messages.push(
        ["Добрый день! Зафиксированы нарушения сроков у сделок:", ...stages.map((s, i) => formatOverdueLine(ctx, s, i))].join(
          "\n"
        )
      );
    }

    return messages;
  }

  const pipelineIds =
    roleKey === "productionDirector"
      ? [PIPELINE_ID_METAL, PIPELINE_ID_WOOD]
      : PIPELINE_ID_BY_FOREMAN_ROLE[roleKey]
        ? [PIPELINE_ID_BY_FOREMAN_ROLE[roleKey]]
        : [];

  for (const pipelineId of pipelineIds) {
    const deals = await collectOverdueDeals(ctx, settings, pipelineId);
    const stages = await collectOverdueStages(ctx, settings, { pipelineId });

    if (deals.length === 0 && stages.length === 0) {
      continue;
    }

    const lines = [`Воронка “${PIPELINE_TITLE_BY_ID[pipelineId]}”`];

    if (deals.length > 0) {
      lines.push("Нарушение сроков у сделок:", ...deals.map((d, i) => formatOverdueLine(ctx, d, i)));
    }

    if (stages.length > 0) {
      lines.push("Нарушение сроков у этапов:", ...stages.map((s, i) => formatOverdueLine(ctx, s, i)));
    }

    messages.push(lines.join("\n"));
  }

  return messages;
}

// Кнопка «Контроль сроков» — информационный список без кнопок действий.
async function showDeadlineControl(ctx, directId, userName, roleKey, settings) {
  const messages = await buildDeadlineMessages(ctx, settings, roleKey, userName);

  if (messages.length === 0) {
    await sendProductionDirectMessage(ctx, directId, "Нарушений сроков нет.");
    return;
  }

  for (const text of messages) {
    await sendProductionDirectMessage(ctx, directId, text);
  }
}

// Ежедневная рассылка в 10:30 по Москве (T-16). Дедупликация по дате в Redis
// — перезапуск процесса или два запуска не дублируют рассылку; окно 10:30-10:34,
// чтобы деплой днём не вызвал внеплановую отправку.
const DEADLINE_BROADCAST_KEY_PREFIX = "production_deadline_broadcast:";

async function runDailyDeadlineBroadcast(ctx) {
  const settings = productionWidgetSettingsCache;

  if (!settings) {
    return;
  }

  const marker = await ctx.redisRequest([
    "SET",
    `${DEADLINE_BROADCAST_KEY_PREFIX}${ctx.todayMoscowDateText()}`,
    "1",
    "NX",
    "EX",
    172800
  ]);

  if (!marker || marker.result !== "OK") {
    return;
  }

  const keysResponse = await ctx.redisRequest(["KEYS", "production_direct_id:*"]);
  const keys = (keysResponse && keysResponse.result) || [];
  const prefix = "production_direct_id:";

  console.log(`[Бот производства] Рассылка «Контроль сроков»: получателей ${keys.length}.`);

  for (const key of keys) {
    try {
      const userName = String(key).slice(prefix.length);
      const directId = (await ctx.redisRequest(["GET", key])).result;

      if (!directId) {
        continue;
      }

      // Директор видит обе воронки сразу — отдельные сообщения мастеров не нужны.
      const roleKeys = resolveUserRoles(settings, userName);
      const roles = roleKeys.includes("productionDirector") ? ["productionDirector"] : roleKeys;

      for (const roleKey of roles) {
        for (const text of await buildDeadlineMessages(ctx, settings, roleKey, userName)) {
          await sendProductionDirectMessage(ctx, directId, text);
        }
      }
    } catch (error) {
      console.error(`[Бот производства] Рассылка «Контроль сроков» ${key}:`, error.message);
    }
  }
}

// ============================================================
// 8d. ОТЧЁТ (ТЗ T-14 исполнитель, T-15 мастер/директор)
// ============================================================

const PRODUCT_READY_DATE_FIELD_ID = 445999; // "Лестница изготовлена" (в ТЗ — «Изделие готово»), дата
const SALES_PIPELINE_ID_METAL = 207259; // воронка «Металл»
const SALES_PIPELINE_ID_WOOD = 585508; // воронка «Дерево»
const PIPELINE_ID_RECLAMATION = 4689981; // воронка «Рекламация»

// Воронки поиска выполненных операций (T-14: Производство Металл/Дерево,
// Металл, Дерево, Рекламация) — сделка после производства уходит в
// «продающие» воронки, а операция при этом остаётся выполненной.
const REPORT_PIPELINE_IDS = [
  PIPELINE_ID_METAL,
  PIPELINE_ID_WOOD,
  SALES_PIPELINE_ID_METAL,
  SALES_PIPELINE_ID_WOOD,
  PIPELINE_ID_RECLAMATION
];

const REPORT_BUTTON_FIRST_HALF = "1-15";
const REPORT_BUTTON_SECOND_HALF = "16-конец месяца";
const REPORT_BUTTON_CUSTOM = "Выбрать период";
const REPORT_PERIOD_BUTTONS = [REPORT_BUTTON_FIRST_HALF, REPORT_BUTTON_SECOND_HALF, REPORT_BUTTON_CUSTOM];

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatReportDate(year, month, day) {
  return `${pad2(day)}.${pad2(month + 1)}.${year}`;
}

// Границы дней — по Москве (UTC+3).
function moscowDayStartUnix(year, month, day) {
  return Date.UTC(year, month, day) / 1000 - 3 * 3600;
}

function buildReportPeriod(from, to) {
  const label =
    from.y === to.y && from.m === to.m && from.d === to.d
      ? formatReportDate(from.y, from.m, from.d)
      : `${formatReportDate(from.y, from.m, from.d)} - ${formatReportDate(to.y, to.m, to.d)}`;

  return {
    label,
    fromUnix: moscowDayStartUnix(from.y, from.m, from.d),
    toUnix: moscowDayStartUnix(to.y, to.m, to.d) + 86400 - 1
  };
}

// «1-15» / «16-конец месяца» — в рамках текущего месяца.
function buildMonthHalfPeriod(ctx, secondHalf) {
  const now = ctx.getMoscowDate();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

  return secondHalf
    ? buildReportPeriod({ y, m, d: 16 }, { y, m, d: lastDay })
    : buildReportPeriod({ y, m, d: 1 }, { y, m, d: 15 });
}

// «ДД.ММ.ГГГГ - ДД.ММ.ГГГГ» или «ДД.ММ.ГГГГ»; null — не распознано.
function parseReportPeriodText(text) {
  const match = String(text || "")
    .trim()
    .match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s*-\s*(\d{2})\.(\d{2})\.(\d{4}))?$/);

  if (!match) {
    return null;
  }

  const toPart = (d, m, y) => {
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    const valid =
      date.getUTCFullYear() === Number(y) && date.getUTCMonth() === Number(m) - 1 && date.getUTCDate() === Number(d);

    return valid ? { y: Number(y), m: Number(m) - 1, d: Number(d) } : null;
  };

  const from = toPart(match[1], match[2], match[3]);
  const to = match[4] ? toPart(match[4], match[5], match[6]) : from;

  if (!from || !to) {
    return null;
  }

  const period = buildReportPeriod(from, to);

  return period.toUnix >= period.fromUnix ? period : null;
}

function formatReportMoney(value) {
  return (Math.round(Number(value) * 100) / 100).toLocaleString("ru-RU").replace(/\s/g, " ");
}

// Сделки из указанных воронок, у которых дата-поле попадает в период.
// Фильтр по периоду отдаём amoCRM, но результат всё равно проверяем сами.
// Фильтр amoCRM по пользовательскому полю-дате отвечает 400, поэтому
// просматриваем сделки воронки с отбором по дате изменения (ограничено по
// числу страниц и времени), а дату в поле проверяем сами. Выгрузка воронки
// одна на все поля отчёта: раньше она повторялась на каждую строку настроек.
const reportScanCache = new Map(); // ключ → { at, promise }
const REPORT_SCAN_MAX_PAGES = 40;
const REPORT_SCAN_MAX_MS = 90000;
const REPORT_SCAN_TTL_MS = 120000;

function filterLeadsByDateField(ctx, leads, fieldId, period) {
  return leads.filter((lead) => {
    const value = Number(ctx.getFieldValues(lead, fieldId)[0]);

    return Number.isFinite(value) && value >= period.fromUnix && value <= period.toUnix;
  });
}

async function fetchLeadPages(ctx, baseParams, { maxPages, deadline }) {
  const url = `https://${ctx.AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4/leads`;
  const all = [];

  for (let page = 1; page <= maxPages; page++) {
    if (Date.now() > deadline) {
      console.error("[Бот производства] Отчёт: превышено время просмотра сделок, результат может быть неполным.");
      break;
    }

    const response = await ctx.amoCrmGet(url, { ...baseParams, limit: 250, page });

    if (response.status === 204) {
      break;
    }

    if (response.status !== 200) {
      throw new Error(
        `amoCRM GET /leads (отчёт) HTTP ${response.status}: ${JSON.stringify(response.data).slice(0, 300)}`
      );
    }

    const leads = (response.data && response.data._embedded && response.data._embedded.leads) || [];

    all.push(...leads);

    if (leads.length < 250) {
      break;
    }
  }

  return all;
}

function scanPipelineForReport(ctx, pipelineId, period, byUpdatedAt) {
  const key = `${pipelineId}|${byUpdatedAt ? period.fromUnix : "all"}`;
  const cached = reportScanCache.get(key);

  if (cached && Date.now() - cached.at < REPORT_SCAN_TTL_MS) {
    return cached.promise;
  }

  const params = { "filter[pipeline_id]": pipelineId };

  if (byUpdatedAt) {
    params["filter[updated_at][from]"] = period.fromUnix;
  }

  const startedAt = Date.now();
  const promise = fetchLeadPages(ctx, params, {
    maxPages: REPORT_SCAN_MAX_PAGES,
    deadline: startedAt + REPORT_SCAN_MAX_MS
  }).then((leads) => {
    console.log(
      `[Бот производства] Отчёт: воронка ${pipelineId}, просмотрено сделок ${leads.length} ` +
        `за ${Math.round((Date.now() - startedAt) / 100) / 10} с.`
    );

    return leads;
  });

  reportScanCache.set(key, { at: startedAt, promise });
  promise.catch(() => reportScanCache.delete(key));

  return promise;
}

async function getLeadsByFieldDateRange(ctx, pipelineIds, fieldId, period, { byUpdatedAt = true } = {}) {
  // Воронки грузим параллельно (amoCRM допускает до ~7 запросов в секунду).
  const scanned = await Promise.all(
    pipelineIds.map((pipelineId) => scanPipelineForReport(ctx, pipelineId, period, byUpdatedAt))
  );

  return filterLeadsByDateField(ctx, scanned.flat(), fieldId, period);
}

// Выполненные операции: строки «Исполнение», у сделки в период заполнен
// «Факт готовности» и сделка уже ушла с этого статуса. Возвращает
// Map «исполнитель → { count, sum }».
async function collectCompletedOperations(ctx, settings, period, { pipelineId = null, userName = null } = {}) {
  const result = new Map();
  const target = userName ? normalizeHandleName(userName) : null;

  for (const row of findExecutionRows(settings)) {
    if (pipelineId && Number(row.amoPipelineId) !== Number(pipelineId)) {
      continue;
    }

    if (!row.factDateFieldId || !row.amoStatusId || !row.executorFieldId) {
      console.log(
        `[Бот производства] Отчёт: строка настроек «Исполнение» (воронка ${row.amoPipelineId}, статус ${row.amoStatusId}) ` +
          "пропущена — не заполнены «Исполнитель» или «Факт готовности»."
      );
      continue;
    }

    const rowStats = { withFact: 0, leftStage: 0, withExecutor: 0 };

    for (const lead of await getLeadsByFieldDateRange(ctx, REPORT_PIPELINE_IDS, row.factDateFieldId, period)) {
      rowStats.withFact += 1;

      if (Number(lead.status_id) === Number(row.amoStatusId)) {
        continue;
      }

      rowStats.leftStage += 1;

      const names = ctx.getFieldValues(lead, row.executorFieldId);

      if (names.length === 0 || (target && !names.some((name) => normalizeHandleName(name) === target))) {
        continue;
      }

      rowStats.withExecutor += 1;

      const key = target ? userName : names.join(", ");
      const price = row.priceFieldId ? Number(ctx.getFieldValues(lead, row.priceFieldId)[0]) || 0 : 0;
      const entry = result.get(key) || { count: 0, sum: 0 };

      entry.count += 1;
      entry.sum += price;
      result.set(key, entry);
    }

    console.log(
      `[Бот производства] Отчёт: этап ${row.amoStatusId} (факт ${row.factDateFieldId}, исполнитель ${row.executorFieldId}): ` +
        `с датой в периоде ${rowStats.withFact}, уже ушли с этапа ${rowStats.leftStage}, с исполнителем ${rowStats.withExecutor}.`
    );
  }

  return result;
}

async function buildPerformerReport(ctx, settings, userName, period) {
  const operations = (await collectCompletedOperations(ctx, settings, period, { userName })).get(userName) || {
    count: 0,
    sum: 0
  };

  return (
    `Отчет за ${period.label}\nКол-во выполненных операций: ${operations.count}\n` +
    `Стоимость выполненных операций: ${formatReportMoney(operations.sum)}, руб`
  );
}

async function buildForemanReport(ctx, settings, pipelineId, period) {
  const isMetal = pipelineId === PIPELINE_ID_METAL;
  const [operations, deals] = await Promise.all([
    collectCompletedOperations(ctx, settings, period, { pipelineId }),
    getLeadsByFieldDateRange(
      ctx,
      [isMetal ? SALES_PIPELINE_ID_METAL : SALES_PIPELINE_ID_WOOD, PIPELINE_ID_RECLAMATION],
      PRODUCT_READY_DATE_FIELD_ID,
      period
    )
  ]);

  const products = new Map();
  let dealsSum = 0;

  for (const lead of deals) {
    dealsSum += Number(lead.price) || 0;

    const product = getProductText(ctx, lead);

    products.set(product, (products.get(product) || 0) + 1);
  }

  const lines = [`Отчет за ${period.label} по Производству (${isMetal ? "Металл" : "Дерево"})`];

  for (const [name, entry] of operations) {
    lines.push(
      `${name}:`,
      `Кол-во выполненных операций: ${entry.count}`,
      `Стоимость выполненных операций: ${formatReportMoney(entry.sum)}, руб`
    );
  }

  lines.push(
    "",
    `Кол-во выполненных сделок: ${deals.length}`,
    `Стоимость выполненных сделок: ${formatReportMoney(dealsSum)}, руб`,
    "",
    "Кол-во выполненных продуктов"
  );

  for (const [product, count] of products) {
    lines.push(`${product}: ${count}`);
  }

  return lines.join("\n");
}

// Директор — по воронкам металл и дерево последовательно; мастер — по своей.
async function sendReportForRole(ctx, directId, userName, roleKey, settings, period) {
  await sendProductionDirectMessage(ctx, directId, `Ожидайте, формируем отчет за период ${period.label}`);

  if (roleKey === PERFORMER_ROLE_KEY) {
    await sendProductionDirectMessage(ctx, directId, await buildPerformerReport(ctx, settings, userName, period));
    return;
  }

  const pipelineIds =
    roleKey === "productionDirector" ? [PIPELINE_ID_METAL, PIPELINE_ID_WOOD] : [PIPELINE_ID_BY_FOREMAN_ROLE[roleKey]];

  for (const pipelineId of pipelineIds.filter(Boolean)) {
    await sendProductionDirectMessage(ctx, directId, await buildForemanReport(ctx, settings, pipelineId, period));
  }
}

async function startReport(ctx, directId, userKey) {
  const state = productionUserState[userKey];

  state.awaitingReportPeriod = true;
  delete state.pendingTextInput;

  await sendProductionDirectMessage(ctx, directId, "Выберите период отчета", REPORT_PERIOD_BUTTONS);
}

async function handleReportPeriodChoice(ctx, directId, userKey, userName, settings, choice) {
  const state = productionUserState[userKey];

  delete state.awaitingReportPeriod;

  if (choice === REPORT_BUTTON_CUSTOM) {
    state.pendingTextInput = { kind: "report_period" };
    await sendProductionDirectMessage(ctx, directId, "Укажите период для отчета");
    return;
  }

  const period = buildMonthHalfPeriod(ctx, choice === REPORT_BUTTON_SECOND_HALF);

  await sendReportForRole(ctx, directId, userName, state.roleKey, settings, period);
}

async function handleReportPeriodInput(ctx, directId, userKey, userName, settings, trimmedText) {
  const state = productionUserState[userKey];
  const period = parseReportPeriodText(trimmedText);

  if (!period) {
    await sendProductionDirectMessage(
      ctx,
      directId,
      state.roleKey === PERFORMER_ROLE_KEY
        ? "Не удалось распознать указанную дату. Пожалуйста, введите период в формате:\n" +
            "ХХ.ХХ.ХХХХ - ХХ.ХХ.ХХХХ\nили\nХХ.ХХ.ХХХХ."
        : "Не удалось распознать указанную дату. Пожалуйста, введите дату в формате ХХ.ХХ.ХХХХ."
    );
    return;
  }

  delete state.pendingTextInput;

  await sendReportForRole(ctx, directId, userName, state.roleKey, settings, period);
}

// ============================================================
// 9. ПЛАНИРОВЩИКИ
// ============================================================
// Ежедневная рассылка «Контроль сроков» (T-16) в 10:30 по Москве.
function startSchedulers(ctx) {
  setInterval(async () => {
    try {
      const moscow = ctx.getMoscowDate();

      if (moscow.getUTCHours() === 10 && moscow.getUTCMinutes() >= 30 && moscow.getUTCMinutes() < 35) {
        await runDailyDeadlineBroadcast(ctx);
      }
    } catch (error) {
      console.error("[Бот производства] Ошибка планировщика «Контроль сроков»:", error.message);
    }
  }, 60 * 1000);

  console.log("[Бот производства] Планировщик «Контроль сроков»: ежедневно в 10:30 (Москва).");
}

// ============================================================
// 10. WEBHOOK И МАРШРУТЫ
// ============================================================

// ============================================================
// F-4. ПЛАНОВЫЕ ДАТЫ ГОТОВНОСТИ (ТЗ F-3, F-4)
// ============================================================
// amoCRM шлёт вебхук о смене статуса сделки на тот же адрес, что и
// amoMessenger (/webhook/production). Дата = округлённое вверх (кол-во
// этажей × коэффициент продукта) дней от сегодняшнего дня; выходные не
// учитываются. Уже заполненное поле не перезаписываем.

const FLOORS_FIELD_ID = 415782; // "Количество этажей?", список с числами 1–10
const PLANNED_READY_FIELD_ID = 550764; // "Плановая дата готовности"
const PLANNED_READY_STATUS_IDS = [33139332, 36642552]; // ЛАЗЕР исполнение, РАСКРОЙ исполнение

function extractStatusChangeEvents(body) {
  const leads = (body && body.leads) || {};
  const events = [];

  for (const kind of ["status", "add"]) {
    const items = leads[kind];
    const list = Array.isArray(items) ? items : items && typeof items === "object" ? Object.values(items) : [];

    for (const item of list) {
      if (item && item.id && item.status_id) {
        events.push({ leadId: Number(item.id), statusId: Number(item.status_id) });
      }
    }
  }

  return events;
}

// Возвращает список правил { fieldId, coefficient } либо { skip: причина }.
// Для статусов ЛАЗЕР/РАСКРОЙ заполняются ДВА поля: общая плановая дата изделия
// (коэффициент «Готовность изделия») и поле «План готовности» самого этапа
// (коэффициент из столбца этого статуса). Для остальных статусов — только
// поле этапа.
function resolvePlannedDateRules(settings, lead, statusId) {
  const matrix = (settings && settings.readinessMatrix) || {};
  const productValue = ((lead.custom_fields_values || []).find(
    (field) => Number(field.field_id) === Number(matrix.productFieldId || PRODUCT_FIELD_ID)
  ) || { values: [] }).values[0];
  const enumId = productValue && productValue.enum_id;
  const product = (matrix.products || []).find((item) => Number(item.enumId) === Number(enumId));
  const rules = [];

  if (!product) {
    return [{ skip: `продукт сделки (enum ${enumId || "—"}) не найден в таблице «Плановая готовность»` }];
  }

  if (PLANNED_READY_STATUS_IDS.includes(statusId)) {
    rules.push({ fieldId: PLANNED_READY_FIELD_ID, coefficient: Number(product.readinessValue) });
  }

  if (PLANNED_READY_STATUS_IDS.includes(statusId) && !(matrix.statusIds || []).map(Number).includes(statusId)) {
    rules.push({
      skip:
        `статуса ${statusId} нет среди столбцов таблицы «Плановая готовность» ` +
        `(там: ${(matrix.statusIds || []).join(", ") || "пусто"}) — поле плана этапа не заполняем`
    });
  } else if ((matrix.statusIds || []).map(Number).includes(statusId)) {
    const row = ((settings && settings.statusFieldMap) || []).find(
      (item) => Number(item.amoStatusId) === statusId && item.planDateFieldId
    );

    if (!row) {
      rules.push({ skip: `для статуса ${statusId} в «Связи этапов и полей» не указано поле «План готовности»` });
    } else if (Number(row.planDateFieldId) !== PLANNED_READY_FIELD_ID || rules.length === 0) {
      rules.push({
        fieldId: Number(row.planDateFieldId),
        coefficient: Number((matrix.cells || {})[`${enumId}:${statusId}`])
      });
    }
  }

  return rules;
}

async function fillPlannedReadyDate(ctx, leadId, statusId) {
  const settings = productionWidgetSettingsCache;

  if (!settings || !settings.readinessMatrix) {
    return;
  }

  await runExclusive(leadId, async () => {
    const lead = await ctx.getLead(leadId);

    if (!lead) {
      return;
    }

    const log = (reason) =>
      console.log(`[Бот производства] Плановая дата: сделка ${leadId}, статус ${statusId} — пропуск: ${reason}`);
    const floors = parseFloat(String(ctx.getFieldValueJoined(lead, FLOORS_FIELD_ID)).replace(",", "."));
    const fields = [];
    const done = [];

    for (const rule of resolvePlannedDateRules(settings, lead, statusId)) {
      if (rule.skip) {
        log(rule.skip);
        continue;
      }

      if (ctx.getFieldValues(lead, rule.fieldId).length > 0) {
        log(`поле ${rule.fieldId} уже заполнено`);
        continue;
      }

      if (!Number.isFinite(floors) || floors <= 0 || !Number.isFinite(rule.coefficient) || rule.coefficient <= 0) {
        log(`поле ${rule.fieldId}: не хватает данных (этажей: ${floors}, коэффициент: ${rule.coefficient})`);
        continue;
      }

      // round(…, 6) — чтобы 2 × 0,6 = 1,2000000000000002 не превращалось в лишний день.
      const days = Math.ceil(Math.round(floors * rule.coefficient * 1e6) / 1e6);

      fields.push({ field_id: rule.fieldId, values: [{ value: ctx.todayMoscowStartUnix() + days * 86400 }] });
      done.push(`поле ${rule.fieldId}: ${floors} × ${rule.coefficient} → +${days} дн.`);
    }

    if (fields.length === 0) {
      return;
    }

    await patchLead(ctx, leadId, { custom_fields_values: fields });

    console.log(`[Бот производства] Плановая дата: сделка ${leadId}, статус ${statusId}: ${done.join("; ")}.`);
  });
}

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

    res.set("Cache-Control", "no-store");
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
      pid: process.pid,
      process_started_at: PROCESS_STARTED_AT,
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

    // Вебхук amoCRM о смене статуса сделки (F-4).
    if (body.leads) {
      for (const event of extractStatusChangeEvents(body)) {
        fillPlannedReadyDate(ctx, event.leadId, event.statusId).catch((error) =>
          console.error(`[Бот производства] Плановая дата, сделка ${event.leadId}:`, error.stack || error.message)
        );
      }

      return;
    }

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
      let userName = ctx.extractAmoMessengerUserName(message.author, context, message);

      // Если имя отсутствует в вебхуке, получаем его через API amoMessenger.
      if (!userName && userKey) {
        userName = await getProductionAmoMessengerUserName(ctx, userKey);
      }

      const imageUrls = ctx.extractImageUrlsFromMessage(message);
      console.log(
  "[Бот производства] Диагностика пользователя:",
  JSON.stringify({
    contextKeys: Object.keys(context),
    messageKeys: Object.keys(message),
    authorKeys:
      message.author && typeof message.author === "object"
        ? Object.keys(message.author)
        : [],
    userName,
  })
);

      if (!directId || !userKey) {
        console.error("[Бот производства] Не удалось определить direct_id или user_id из вебхука.");
        return;
      }

      console.log(
        "[Бот производства] Входящее сообщение:",
        JSON.stringify({ userKey: String(userKey), userName, text })
      );

      const trimmedText = await restoreTaggedButtonText(ctx, directId, String(text || "").trim());

      if (ctx.isStartCommand(trimmedText)) {
        await handleStartCommand(ctx, directId, userKey, userName);
        return;
      }

      let state = productionUserState[userKey];

      // После перезапуска бота память очищается. Роль восстанавливаем молча по
      // имени пользователя (как при «старт»), чтобы кнопки из прежних
      // сообщений продолжали работать без повторного «старт».
      if (!state && userName && productionWidgetSettingsCache) {
        state = buildUserState(productionWidgetSettingsCache, userName, directId);
        productionUserState[userKey] = state;
      }

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
          } else if (kind === "design_master_comment") {
            await handleDesignMasterCommentInput(ctx, directId, userKey, settings, trimmedText);
          } else if (kind === "otk_reject_comment") {
            await handleOtkRejectCommentInput(ctx, directId, userKey, trimmedText);
          } else if (kind === "final_otk_reject_comment") {
            await handleFinalOtkRejectCommentInput(ctx, directId, userKey, trimmedText);
          } else if (kind === "report_period" && settings) {
            await handleReportPeriodInput(ctx, directId, userKey, userName, settings, trimmedText);
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
          if (String(leadId).startsWith("final:")) {
            // Финальный ОТК (T-13.4): «Да»/«Нет» ОТК или мастера без ОТК.
            await handleFinalOtkReply(ctx, directId, userKey, String(leadId).slice(6), decision, settings);
          } else if (String(leadId).startsWith("cost:")) {
            // «Установить этапу … стоимость работ …?» (мастер, п.3.8.1)
            await handleCostSetConfirm(ctx, directId, userKey, String(leadId).slice(5), decision, settings);
          } else if (state.roleKey === PERFORMER_ROLE_KEY) {
            await handlePerformerDealConfirmReply(ctx, directId, userKey, userName, leadId, decision, settings);
          } else if (state.roleKey === "metalShopForeman" || state.roleKey === "woodShopForeman") {
            await handleApprovalReply(ctx, directId, leadId, decision, settings);
          } else if (state.roleKey === "otk") {
            await handleOtkAcceptReply(ctx, directId, userKey, leadId, decision, settings);
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

      // Решения по непринятым работам (T-9.4 / T-10.4 / T-11.4): кнопки с id
      // сделки; роль нажавшего определяет смысл («Продолжить работу» у ОТК,
      // исполнителя и мастера — разные шаги).
      const continueLeadId = parseTaggedButtonCompat(ctx, trimmedText, "Продолжить работу");
      const handoverLeadId = parseTaggedButtonCompat(ctx, trimmedText, "Отдать на доработку");
      const refuseLeadId = parseTaggedButtonCompat(ctx, trimmedText, "Не принять");
      const stageReturn = parseStageReturnButton(trimmedText);

      if ((continueLeadId || handoverLeadId || refuseLeadId || stageReturn) && settings) {
        try {
          if (stageReturn) {
            await handleForemanReturnToStage(ctx, directId, userKey, stageReturn.leadId, stageReturn.statusId, settings);
          } else {
            await handleUnacceptedDecision(
              ctx,
              directId,
              userKey,
              userName,
              continueLeadId || handoverLeadId || refuseLeadId,
              continueLeadId ? "continue" : handoverLeadId ? "handover" : "refuse",
              settings
            );
          }
        } catch (error) {
          console.error("[Бот производства] Ошибка решения по непринятым работам:", error.stack || error.message);

          await sendProductionDirectMessage(
            ctx,
            directId,
            "❌ Не удалось обработать решение. Попробуйте ещё раз позже или обратитесь к администратору."
          );
        }

        return;
      }

      // Возврат в проектный отдел / отказ (T-20.2.6): id вида design:<сделка>.
      const designReturnTag = parseTaggedButtonCompat(ctx, trimmedText, "Вернуть в проектный отдел");
      const designDeclineTag = parseTaggedButtonCompat(ctx, trimmedText, "Отклонить");

      if (
        settings &&
        ((designReturnTag && String(designReturnTag).startsWith(DESIGN_TAG_PREFIX)) ||
          (designDeclineTag && String(designDeclineTag).startsWith(DESIGN_TAG_PREFIX)))
      ) {
        try {
          if (designReturnTag) {
            await handleDesignReturnButton(ctx, directId, userKey, String(designReturnTag).slice(DESIGN_TAG_PREFIX.length), settings);
          } else {
            await handleDesignDecline(ctx, directId, userKey, String(designDeclineTag).slice(DESIGN_TAG_PREFIX.length), settings);
          }
        } catch (error) {
          console.error("[Бот производства] Ошибка решения по проектному отделу:", error.stack || error.message);

          await sendProductionDirectMessage(
            ctx,
            directId,
            "❌ Не удалось обработать решение. Попробуйте ещё раз позже или обратитесь к администратору."
          );
        }

        return;
      }

      // "Подтвердить (id)" / "Отклонить (id)" / "Изменить (id)" — ответ
      // мастера на пересмотр стоимости (ТЗ T-6.5.3/T-8, актуализация 3.5).
      // "Отклонить" также используется в решении по закупке материалов
      // (ниже) — при совпадении текста сначала проверяем, относится ли
      // кнопка к пересмотру стоимости, и только если нет — к закупке.
      const costButton = await resolveCostDecisionButton(ctx, trimmedText);

      if (costButton && !costButton.identifier) {
        await sendProductionDirectMessage(ctx, directId, "Запрос на пересмотр стоимости уже обработан или устарел.");
        return;
      }

      const confirmCostLeadId =
        parseTaggedButtonCompat(ctx, trimmedText, "Подтвердить") ||
        (costButton && costButton.label === "Подтвердить" ? costButton.identifier : null);
      const changeCostLeadId =
        parseTaggedButtonCompat(ctx, trimmedText, "Изменить") ||
        (costButton && costButton.label === "Изменить" ? costButton.identifier : null);
      const declineLeadId =
        parseTaggedButtonCompat(ctx, trimmedText, "Отклонить") ||
        (costButton && costButton.label === "Отклонить" ? costButton.identifier : null);
      const sendToProcurementLeadId = parseTaggedButtonCompat(ctx, trimmedText, "Отправить на закупку");

      if ((confirmCostLeadId || changeCostLeadId) && settings) {
        const leadId = confirmCostLeadId || changeCostLeadId;
        const action = confirmCostLeadId ? "confirm" : "change";

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

      if (declineLeadId && settings) {
        try {
          const lead = await ctx.getLead(parseCostIdentifier(declineLeadId).leadId);
          const hasCostEntry =
            lead &&
            getCostRevisionEntry(
              await getCostRevisionEntries(ctx, lead),
              parseCostIdentifier(declineLeadId).statusId || Number(lead.status_id)
            );

          if (hasCostEntry) {
            await handleCostRevisionReply(ctx, directId, userKey, declineLeadId, "reject", settings);
          } else {
            await handleMaterialsDecision(ctx, directId, declineLeadId, "decline", settings);
          }
        } catch (error) {
          console.error("[Бот производства] Ошибка обработки «Отклонить»:", error.stack || error.message);

          await sendProductionDirectMessage(
            ctx,
            directId,
            "❌ Не удалось обработать ответ. Попробуйте ещё раз позже или обратитесь к администратору."
          );
        }

        return;
      }

      if (sendToProcurementLeadId && settings) {
        try {
          await handleMaterialsDecision(ctx, directId, sendToProcurementLeadId, "send", settings);
        } catch (error) {
          console.error("[Бот производства] Ошибка отправки на закупку:", error.stack || error.message);

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

      // Выбор периода отчёта (T-14.1 / T-15.1) — после нажатия «Отчёт».
      if (state.awaitingReportPeriod && REPORT_PERIOD_BUTTONS.includes(trimmedText) && settings) {
        try {
          await handleReportPeriodChoice(ctx, directId, userKey, userName, settings, trimmedText);
        } catch (error) {
          console.error("[Бот производства] Ошибка формирования отчёта:", error.stack || error.message);

          await sendProductionDirectMessage(
            ctx,
            directId,
            "❌ Не удалось сформировать отчёт. Попробуйте ещё раз позже или обратитесь к администратору."
          );
        }

        return;
      }

      // Несколько ролей у одного человека: «Сменить роль» → выбор роли.
      rolesByDirectId.set(String(directId), state.roleKeys || [state.roleKey]);

      if (trimmedText === SWITCH_ROLE_BUTTON && state.roleKeys && state.roleKeys.length > 1) {
        await showRoleChoice(ctx, directId, state);
        return;
      }

      if (state.awaitingRoleChoice && state.roleKeys && state.roleKeys.some((key) => ROLE_LABELS[key] === trimmedText)) {
        await applyRoleChoice(ctx, directId, state, trimmedText);
        return;
      }

      if (settings && FOREMAN_ROLE_KEYS.includes(state.roleKey) && isDesignSubmenuInput(state, trimmedText)) {
        try {
          await handleDesignSubmenu(ctx, directId, userKey, state.roleKey, trimmedText);
        } catch (error) {
          console.error("[Бот производства] Ошибка «Доработка проектным отделом»:", error.stack || error.message);

          await sendProductionDirectMessage(
            ctx,
            directId,
            "❌ Не удалось получить список сделок. Попробуйте ещё раз позже или обратитесь к администратору."
          );
        }

        return;
      }

      if (settings && FOREMAN_ROLE_KEYS.includes(state.roleKey) && WAITING_DECISION_BUTTONS.includes(trimmedText)) {
        try {
          await handleWaitingDecisionChoice(ctx, directId, userKey, state.roleKey, settings, trimmedText);
        } catch (error) {
          console.error("[Бот производства] Ошибка «Ожидание решения»:", error.stack || error.message);

          await sendProductionDirectMessage(
            ctx,
            directId,
            "❌ Не удалось получить список сделок. Попробуйте ещё раз позже или обратитесь к администратору."
          );
        }

        return;
      }

      const roleButtons = getMenuButtons(state.roleKey, settings);

      if (roleButtons.includes(trimmedText)) {
        // Новый пункт меню — прежний список больше не актуален.
        delete state.listContext;
        delete state.awaitingReportPeriod;
        delete state.designMenuStage;

        try {
          if (trimmedText === "Отчёт") {
            await startReport(ctx, directId, userKey);
          } else if (trimmedText === "Распределение" && DISTRIBUTION_ROLE_KEYS.includes(state.roleKey)) {
            await handleDistributionButton(ctx, directId, userKey, userName, state.roleKey);
          } else if (trimmedText === "Исполнение" && state.roleKey === PERFORMER_ROLE_KEY && settings) {
            await showExecutionListForPerformer(ctx, directId, userName, settings);
          } else if (trimmedText === "В ОТК" && state.roleKey === PERFORMER_ROLE_KEY && settings) {
            await showInOtkListForPerformer(ctx, directId, userKey, userName, settings);
          } else if (trimmedText === "Промежуточный ОТК" && state.roleKey === "otk" && settings) {
            await showIntermediateOtkList(ctx, directId, userKey, settings);
          } else if (trimmedText === "Финальный ОТК" && settings && (state.roleKey === "otk" || FOREMAN_ROLE_KEYS.includes(state.roleKey))) {
            await showFinalOtkList(ctx, directId, userKey, state.roleKey, settings);
          } else if (trimmedText === "Непринятые работы" && settings) {
            if (state.roleKey === "otk") {
              await showUnacceptedListForOtk(ctx, directId, userKey, settings);
            } else if (state.roleKey === PERFORMER_ROLE_KEY) {
              await showUnacceptedListForPerformer(ctx, directId, userKey, userName, settings);
            } else if (FOREMAN_ROLE_KEYS.includes(state.roleKey)) {
              await showUnacceptedListForForeman(ctx, directId, userKey, state.roleKey, settings);
            } else {
              await handleMenuPlaceholder(ctx, directId, trimmedText);
            }
          } else if (trimmedText === "Пересмотреть стоимость" && FOREMAN_ROLE_KEYS.includes(state.roleKey) && settings) {
            await showCostRevisionListForForeman(ctx, directId, userKey, state.roleKey, settings);
          } else if (trimmedText === "Контроль сроков" && settings) {
            await showDeadlineControl(ctx, directId, userName, state.roleKey, settings);
          } else if (trimmedText === "Ожидание решения" && FOREMAN_ROLE_KEYS.includes(state.roleKey)) {
            await showWaitingDecisionMenu(ctx, directId);
          } else if (trimmedText === "Не принято ОТК" && FOREMAN_ROLE_KEYS.includes(state.roleKey) && settings) {
            await showOtkRejectedInfoForForeman(ctx, directId, userKey, state.roleKey, settings);
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

      // Номер договора из списка ОТК / непринятых работ — по запомненному
      // списку (state.listContext), раньше «Распределения»/«Исполнения».
      if (settings && state.listContext) {
        try {
          if (await tryHandleOtkListSelection(ctx, directId, userKey, userName, settings, trimmedText)) {
            return;
          }
        } catch (error) {
          console.error("[Бот производства] Ошибка выбора сделки из списка:", error.stack || error.message);

          await sendProductionDirectMessage(
            ctx,
            directId,
            "❌ Не удалось обработать выбор сделки. Попробуйте ещё раз позже или обратитесь к администратору."
          );

          return;
        }
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
