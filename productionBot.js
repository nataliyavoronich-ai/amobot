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
// ФАЗА 1: реализованы только приватная интеграция/виджет и минимальный
// каркас бота (обработка "старт" заглушкой). Ролевая логика, сценарий
// "Распределение" и остальные сценарии ТЗ — предмет следующих фаз.

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

  const activeUserIds = new Set();

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
      if (!entry || !isPositiveInteger(entry.userId)) {
        return {
          valid: false,
          error: `В роли «${roleKey}» указан некорректный пользователь.`,
          field: `roles.${roleKey}`
        };
      }

      if (entry.active) {
        if (activeUserIds.has(entry.userId)) {
          return {
            valid: false,
            error: "Один пользователь не может одновременно состоять в двух активных ролях.",
            field: `roles.${roleKey}`
          };
        }

        activeUserIds.add(entry.userId);
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
// 6. ПЛАНИРОВЩИКИ
// ============================================================
// Фаза 1 сценариев не содержит — фоновых задач пока нет. Функция оставлена
// пустой ради симметрии вызова с designerBot.startSchedulers(ctx) в
// server.js, чтобы при появлении сценариев не пришлось снова менять
// server.js.
function startSchedulers(ctx) {
  console.log("[Бот производства] Планировщики: сценариев пока нет, ничего не запущено.");
}

// ============================================================
// 7. WEBHOOK И МАРШРУТЫ
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
  // ФАЗА 1: только заглушка на "старт", подтверждающая, что маршрут и
  // исходящая отправка сообщений реально работают. Полноценная ролевая
  // логика (авторизация пользователя, главное меню, сценарии ТЗ) —
  // предмет следующих фаз.
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

      if (ctx.isStartCommand(text)) {
        await sendProductionDirectMessage(
          ctx,
          directId,
          "Бот «Производство» в разработке. Минуту, ищем вас в базе.\n\n" +
            "(Заглушка Фазы 1 — полноценная логика появится в следующих обновлениях.)"
        );
      }
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
// 8. ЭКСПОРТ
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
