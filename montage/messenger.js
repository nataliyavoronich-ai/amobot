// ============================================================
// БОТ МОНТАЖНИКОВ — amoMessenger: токены, отправка, состояние в Redis,
// уведомления, защита от повторных вебхуков.
// Приложение amoMessenger — своё («Бот Монтажники»), переменные окружения
// AMOMESSENGER_MONTAGE_*, ключи в Redis — с префиксом montage_.
// ============================================================

const axios = require("axios");
const calc = require("./calc");

const CLIENT_ID = process.env.AMOMESSENGER_MONTAGE_CLIENT_ID || "";
const CLIENT_SECRET = process.env.AMOMESSENGER_MONTAGE_CLIENT_SECRET || "";
const REDIRECT_URI = process.env.AMOMESSENGER_MONTAGE_REDIRECT_URI || "";
const SCOPE = process.env.AMOMESSENGER_MONTAGE_SCOPE || "";

let accessToken = process.env.AMOMESSENGER_MONTAGE_ACCESS_TOKEN || "";
let refreshToken = process.env.AMOMESSENGER_MONTAGE_REFRESH_TOKEN || "";

const MAX_MESSAGE_LENGTH = 3500;
const MAX_BUTTONS_PER_MESSAGE = 20;

// ------------------------------------------------------------
// Токены
// ------------------------------------------------------------

function hasToken() {
  return Boolean(accessToken);
}

function hasRefreshToken() {
  return Boolean(refreshToken);
}

async function saveTokens(ctx) {
  if (!accessToken || !refreshToken) {
    return;
  }

  await ctx.redisRequest(["SET", "amomessenger_montage_access_token", accessToken]);
  await ctx.redisRequest(["SET", "amomessenger_montage_refresh_token", refreshToken]);
  console.log("[Бот монтажников] Токены amoMessenger сохранены в Redis.");
}

async function loadTokens(ctx) {
  try {
    const a = await ctx.redisRequest(["GET", "amomessenger_montage_access_token"]);
    const r = await ctx.redisRequest(["GET", "amomessenger_montage_refresh_token"]);

    if (a.result && r.result) {
      accessToken = a.result;
      refreshToken = r.result;
      console.log("[Бот монтажников] Токены amoMessenger загружены из Redis.");
    } else {
      console.log("[Бот монтажников] В Redis пока нет токенов amoMessenger — нужна авторизация.");
    }
  } catch (error) {
    console.error("[Бот монтажников] Ошибка загрузки токенов amoMessenger:", error.message);
  }
}

async function exchangeCode(ctx, code) {
  const response = await axios.post(
    "https://id.amo.tm/oauth2/access_token",
    {
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      code
    },
    { headers: { "Content-Type": "application/json" }, timeout: 30000 }
  );

  accessToken = response.data.access_token;
  refreshToken = response.data.refresh_token;
  await saveTokens(ctx);
}

async function refresh(ctx) {
  if (!refreshToken) {
    throw new Error("Refresh Token бота монтажников не найден");
  }

  const response = await axios.post(
    "https://id.amo.tm/oauth2/access_token",
    {
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
      redirect_uri: REDIRECT_URI
    },
    { headers: { "Content-Type": "application/json" }, timeout: 30000 }
  );

  accessToken = response.data.access_token;

  if (response.data.refresh_token) {
    refreshToken = response.data.refresh_token;
  }

  await saveTokens(ctx);
  console.log("[Бот монтажников] Токен amoMessenger обновлён.");
}

function authorizeUrl(scopeOverride) {
  const scope = String(scopeOverride || SCOPE || "").trim();

  if (!CLIENT_ID) {
    return { error: "AMOMESSENGER_MONTAGE_CLIENT_ID не задан" };
  }

  if (!scope) {
    return { error: "Не задан scope: укажите AMOMESSENGER_MONTAGE_SCOPE или откройте ссылку с ?scope=..." };
  }

  return {
    url:
      "https://id.amo.tm/oauth2/authorize?" +
      `client_id=${encodeURIComponent(CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&scope=${encodeURIComponent(scope)}` +
      "&response_type=code"
  };
}

// ------------------------------------------------------------
// Отправка сообщений
// ------------------------------------------------------------

// Значения из amoCRM и от пользователей в сообщениях с разметкой: убираем
// символы, ломающие разметку (как sanitizeForMarkdown в server.js).
function mdSafe(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/\*/g, "＊")
    .replace(/_/g, "＿")
    .replace(/~/g, "～")
    .replace(/`/g, "｀")
    .replace(/\|/g, "｜")
    .replace(/\[/g, "［")
    .replace(/\]/g, "］");
}

function mdLink(text, url) {
  return url ? `[${mdSafe(text)}](${url})` : mdSafe(text);
}

async function send(ctx, directId, text, buttons, options) {
  if (!accessToken) {
    throw new Error("Токен amoMessenger бота монтажников не найден");
  }

  if (String(text).length > MAX_MESSAGE_LENGTH) {
    const parts = calc.splitText(text, MAX_MESSAGE_LENGTH);
    let last = null;

    for (let i = 0; i < parts.length; i++) {
      last = await send(ctx, directId, parts[i], i === parts.length - 1 ? buttons : undefined, options);
    }

    return last;
  }

  // amoMessenger принимает не более 20 кнопок в сообщении.
  if (buttons && buttons.length > MAX_BUTTONS_PER_MESSAGE) {
    let last = null;

    for (let i = 0; i < buttons.length; i += MAX_BUTTONS_PER_MESSAGE) {
      last = await send(
        ctx,
        directId,
        i === 0 ? text : "Продолжение списка:",
        buttons.slice(i, i + MAX_BUTTONS_PER_MESSAGE),
        options
      );
    }

    return last;
  }

  const body = { text };

  if (options && options.markdown) {
    body.formatting_mode = "md";
  }

  if (buttons && buttons.length > 0) {
    body.reply_markup = { inline_keyboard: { buttons: buttons.map((buttonText) => ({ text: buttonText })) } };
  }

  const doRequest = () =>
    axios.post(`https://api.amo.tm/v1.3/direct/${directId}/sendMessage`, body, {
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      timeout: 30000,
      validateStatus: () => true
    });

  let response = await doRequest();

  if (response.status === 401 || response.status === 403) {
    await refresh(ctx);
    response = await doRequest();
  }

  if (response.status >= 400) {
    throw new Error(
      `amoMessenger (монтажники) HTTP ${response.status} (длина ${String(text).length}, кнопок ${
        buttons ? buttons.length : 0
      }): ${JSON.stringify(response.data).slice(0, 300)}`
    );
  }

  return response;
}

// Запрос с токеном приложения; при 401 токен обновляем и повторяем один раз.
async function withToken(ctx, doRequest) {
  if (!accessToken) {
    throw new Error("Токен amoMessenger бота монтажников не найден");
  }

  let response = await doRequest(accessToken);

  if (response.status === 401) {
    await refresh(ctx);
    response = await doRequest(accessToken);
  }

  return response;
}

async function getUserNameById(ctx, userId) {
  if (!userId) {
    return "";
  }

  const doRequest = () =>
    axios.get("https://api.amo.tm/v1.3/users", {
      params: { "user_id[]": userId },
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      timeout: 30000,
      validateStatus: () => true
    });

  try {
    let response = await doRequest();

    if (response.status === 401 || response.status === 403) {
      await refresh(ctx);
      response = await doRequest();
    }

    const items = (response.data && response.data._embedded && response.data._embedded.items) || [];
    const user = items.find((item) => String(item.id) === String(userId)) || items[0];

    return String((user && user.name) || "").trim();
  } catch (error) {
    console.error("[Бот монтажников] Ошибка получения имени пользователя:", error.message);
    return "";
  }
}

// ------------------------------------------------------------
// Состояние пользователя — в Redis (переживает перезапуск)
// ------------------------------------------------------------

const STATE_TTL_SECONDS = 30 * 24 * 3600;
const stateCache = new Map(); // directId → состояние

function stateKey(directId) {
  return `montage_state:${directId}`;
}

async function loadState(ctx, directId) {
  const key = String(directId);

  if (stateCache.has(key)) {
    return stateCache.get(key);
  }

  try {
    const response = await ctx.redisRequest(["GET", stateKey(key)]);

    if (response && response.result) {
      const state = JSON.parse(response.result);

      stateCache.set(key, state);
      return state;
    }
  } catch (error) {
    console.error("[Бот монтажников] Не удалось загрузить состояние:", error.message);
  }

  return null;
}

async function saveState(ctx, directId, state) {
  const key = String(directId);

  state.updatedAt = new Date().toISOString();
  stateCache.set(key, state);

  try {
    await ctx.redisRequest(["SET", stateKey(key), JSON.stringify(state), "EX", STATE_TTL_SECONDS]);
  } catch (error) {
    console.error("[Бот монтажников] Не удалось сохранить состояние:", error.message);
  }
}

// ------------------------------------------------------------
// Защита от повторов и гонок
// ------------------------------------------------------------

// Один и тот же вебхук (повторная доставка) обрабатываем один раз.
async function claimMessage(ctx, messageId) {
  if (!messageId) {
    return true;
  }

  try {
    const response = await ctx.redisRequest(["SET", `montage_msg:${messageId}`, "1", "NX", "EX", 86400]);

    return response && response.result === "OK";
  } catch (error) {
    // Redis недоступен — лучше обработать, чем потерять сообщение.
    return true;
  }
}

// Сообщения одного пользователя обрабатываем строго по очереди: несколько
// файлов приходят отдельными вебхуками почти одновременно и не должны
// перетирать состояние и номера файлов друг друга.
const userQueues = new Map();

function runInQueue(directId, task) {
  const key = String(directId);
  const previous = userQueues.get(key) || Promise.resolve();
  const next = previous.then(task, task).catch((error) => {
    console.error("[Бот монтажников] Ошибка в очереди пользователя:", error.stack || error.message);
  });

  userQueues.set(key, next);
  next.then(() => {
    if (userQueues.get(key) === next) {
      userQueues.delete(key);
    }
  });

  return next;
}

// ------------------------------------------------------------
// Адреса пользователей (direct_id) и уведомления
// ------------------------------------------------------------

function directKey(name) {
  return `montage_direct:${calc.normalizeName(name)}`;
}

async function rememberDirectId(ctx, name, directId) {
  if (!name) {
    return;
  }

  try {
    await ctx.redisRequest(["SET", directKey(name), String(directId)]);
  } catch (error) {
    console.error("[Бот монтажников] Не удалось сохранить direct_id:", error.message);
  }
}

// direct_id по любому из имён (ник, имя в amoCRM): точное совпадение,
// затем — по частичному совпадению слов среди сохранённых ключей.
async function findDirectId(ctx, names) {
  try {
    for (const name of names.filter(Boolean)) {
      const exact = await ctx.redisRequest(["GET", directKey(name)]);

      if (exact && exact.result) {
        return exact.result;
      }
    }

    const keys = ((await ctx.redisRequest(["KEYS", "montage_direct:*"])).result) || [];
    const prefix = "montage_direct:";

    for (const name of names.filter(Boolean)) {
      const matched = keys.filter((key) => {
        const stored = key.slice(prefix.length);

        return calc.namesMatch(stored, name) || calc.namesMatch(name, stored);
      });

      if (matched.length === 1) {
        const found = await ctx.redisRequest(["GET", matched[0]]);

        if (found && found.result) {
          return found.result;
        }
      }
    }
  } catch (error) {
    console.error("[Бот монтажников] Не удалось найти direct_id:", error.message);
  }

  return null;
}

const NOTIFICATIONS_LIMIT = 30;

async function storeNotification(ctx, directId, text) {
  try {
    const entry = JSON.stringify({ at: new Date().toISOString(), text });

    await ctx.redisRequest(["LPUSH", `montage_notif:${directId}`, entry]);
    await ctx.redisRequest(["LTRIM", `montage_notif:${directId}`, 0, NOTIFICATIONS_LIMIT - 1]);
    await ctx.redisRequest(["EXPIRE", `montage_notif:${directId}`, 90 * 24 * 3600]);
  } catch (error) {
    console.error("[Бот монтажников] Не удалось сохранить уведомление:", error.message);
  }
}

async function loadNotifications(ctx, directId, limit) {
  try {
    const response = await ctx.redisRequest(["LRANGE", `montage_notif:${directId}`, 0, limit - 1]);

    return ((response && response.result) || [])
      .map((raw) => {
        try {
          return JSON.parse(raw);
        } catch (error) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (error) {
    return [];
  }
}

// Уведомить человека по любому из его имён. Уведомление запоминаем — его
// покажет кнопка «Уведомления».
async function notify(ctx, names, text, options) {
  const directId = await findDirectId(ctx, Array.isArray(names) ? names : [names]);

  if (!directId) {
    console.log(`[Бот монтажников] Не удалось уведомить «${[].concat(names).join(" / ")}»: direct_id неизвестен.`);
    return false;
  }

  try {
    await send(ctx, directId, text, undefined, options);
    await storeNotification(ctx, directId, text.replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1 ($2)"));
    return true;
  } catch (error) {
    console.error("[Бот монтажников] Не удалось отправить уведомление:", error.message);
    return false;
  }
}

module.exports = {
  mdSafe,
  mdLink,
  hasToken,
  hasRefreshToken,
  loadTokens,
  exchangeCode,
  authorizeUrl,
  send,
  withToken,
  getUserNameById,
  loadState,
  saveState,
  claimMessage,
  runInQueue,
  rememberDirectId,
  findDirectId,
  storeNotification,
  loadNotifications,
  notify
};
