// ============================================================
// БОТ МОНТАЖНИКОВ (amoMessenger + раздел «Монтажники» виджета amoCRM)
// ============================================================
//
// Отдельное приложение amoMessenger «Бот Монтажники» (свои OAuth-данные
// AMOMESSENGER_MONTAGE_*, свои токены в Redis, свой webhook
// /webhook/montage) и ОТДЕЛЬНЫЙ процесс (montageBotServer.js) — перезапуск
// этого бота не затрагивает остальные боты.
//
// Модули — в папке montage/:
//   constants.js  ID воронок, задач, полей amoCRM
//   calc.js       расчёты T-8, имена, числа, периоды (чистые функции)
//   settings.js   настройки виджета (Redis) и поиск пользователей/тарифов
//   amo.js        работа с amoCRM (сделки, задачи, примечания)
//   files.js      вложения и загрузка на Яндекс Диск
//   messenger.js  amoMessenger: токены, отправка, состояние, уведомления
//   deals.js      поиск сделок и оформление списков
//   flow*.js      сценарии T-3…T-12
//
// Сценарии: T-1 авторизация, T-2 меню, T-3 предстоящие монтажи, T-4
// подтвердить монтаж, T-6 загрузить отчет, T-7 принять отчет, T-9 внести
// правки, T-10 отчет, T-11 пересмотр стоимости, T-12 уведомления.

const settingsStore = require("./montage/settings");
const messenger = require("./montage/messenger");
const files = require("./montage/files");
const calc = require("./montage/calc");
const deals = require("./montage/deals");
const flowReport = require("./montage/flowReport");
const flowConfirm = require("./montage/flowConfirm");
const flowAccept = require("./montage/flowAccept");
const flowFixes = require("./montage/flowFixes");
const flowCost = require("./montage/flowCost");
const flowInfo = require("./montage/flowInfo");
const { say } = require("./montage/ui");

const MONTAGE_WIDGET_SECRET = process.env.MONTAGE_WIDGET_SECRET || process.env.PRODUCTION_WIDGET_SECRET || "";
const PROCESS_STARTED_AT = new Date().toISOString();

const MENU = {
  foreman: [
    "Предстоящие монтажи",
    "Подтвердить монтаж",
    "Загрузить отчет",
    "Внести правки",
    "Отчет",
    "Пересмотр стоимости",
    "Уведомления"
  ],
  manager: ["Принять отчет", "Предстоящие монтажи", "Отчет", "Пересмотр стоимости", "Уведомления"]
};

const ROLE_LABEL = { foreman: "Бригадир монтажной бригады", manager: "Руководитель монтажной бригады" };
const SWITCH_ROLE = "Сменить роль";

const MSG_NOT_FOUND =
  "Пользователь не найден в настройках бота. Обратитесь в чат технической поддержки";

// ------------------------------------------------------------
// Состояние пользователя
// ------------------------------------------------------------

// Данные, зависящие от настроек, пересчитываем при каждом сообщении —
// правки настроек в виджете подхватываются без «старт».
function hydrate(state) {
  const settings = settingsStore.get();
  const roles = settingsStore.resolveRoles(settings, state.userName);
  const foremanRow = settingsStore.findForemanRow(settings, state.userName);

  state.roleKeys = roles;

  if (!roles.includes(state.roleKey)) {
    state.roleKey = roles[0] || null;
  }

  state.foremanName = foremanRow ? foremanRow.foremanName : "";
  state.managerRows = settingsStore.findManagerRows(settings, state.userName);

  return state;
}

function newState(directId, userKey, userName) {
  return hydrate({ directId, userKey, userName, roleKey: null, flow: null, list: null, drafts: {} });
}

function menuButtons(state) {
  const buttons = [...(MENU[state.roleKey] || [])];

  return state.roleKeys.length > 1 ? [...buttons, SWITCH_ROLE] : buttons;
}

async function sendMenu(env, state) {
  await say(env, `${ROLE_LABEL[state.roleKey]}, выберите тип задач:`, menuButtons(state));
}

// Незавершённый отчёт при уходе в другой пункт меню сохраняем как черновик.
function dropFlow(state) {
  const flow = state.flow;

  if (flow && flow.name === "report" && flow.cur && flow.data && flow.data.progress) {
    state.drafts = state.drafts || {};
    state.drafts[flow.leadId] = flow;
  }

  state.flow = null;
}

// ------------------------------------------------------------
// Обработка сообщения
// ------------------------------------------------------------

async function runMenuButton(env, state, text) {
  if (text === "Предстоящие монтажи") {
    await flowInfo.showUpcoming(env, state);
  } else if (text === "Подтвердить монтаж") {
    await flowConfirm.showList(env, state, { fromButton: true });
  } else if (text === "Загрузить отчет") {
    await flowReport.showList(env, state);
  } else if (text === "Внести правки") {
    await flowFixes.showList(env, state);
  } else if (text === "Отчет") {
    await flowInfo.startReport(env, state);
  } else if (text === "Пересмотр стоимости") {
    if (state.roleKey === "manager") {
      await flowCost.showManagerList(env, state);
    } else {
      await flowCost.showForemanList(env, state);
    }
  } else if (text === "Уведомления") {
    await flowInfo.showNotifications(env);
  } else if (text === "Принять отчет") {
    await flowAccept.showList(env, state);
  }

}

async function selectFromList(env, state, kind, leadId) {
  const { ctx } = env;

  if (kind === "report") {
    const found = await deals.findReportDeals(ctx, state.foremanName);
    const item = found.find((entry) => String(entry.lead.id) === String(leadId));

    if (!item) {
      await say(env, "Задача по этой сделке уже закрыта или недоступна. Откройте список заново: «Загрузить отчет».");
      return;
    }

    await flowReport.start(env, state, item.lead, item.task);
  } else if (kind === "confirm") {
    await flowConfirm.select(env, state, leadId);
  } else if (kind === "accept") {
    await flowAccept.select(env, state, leadId);
  } else if (kind === "fixes") {
    await flowFixes.select(env, state, leadId);
  } else if (kind === "cost") {
    await flowCost.selectForForeman(env, state, leadId);
  } else if (kind === "costMgr") {
    await flowCost.selectForManager(env, state, leadId);
  }
}

async function routeFlow(env, state, input) {
  const name = state.flow.name;

  if (name === "report") {
    return flowReport.handle(env, state, input);
  }

  if (name === "confirm") {
    return flowConfirm.handle(env, state, input);
  }

  if (name === "accept") {
    return flowAccept.handle(env, state, input);
  }

  if (name === "fixes") {
    return flowFixes.handle(env, state, input);
  }

  if (name === "cost") {
    return flowCost.handleForeman(env, state, input);
  }

  if (name === "costMgr") {
    return flowCost.handleManager(env, state, input);
  }

  if (name === "report_period") {
    return flowInfo.handleReport(env, state, input);
  }

  return false;
}

async function processMessage(ctx, incoming) {
  const { directId, userKey, userName, text, attachments } = incoming;
  const env = { ctx, directId, sendMenu: (menuState) => sendMenu(env, menuState) };

  await messenger.rememberDirectId(ctx, userName, directId);

  const settings = settingsStore.get();

  if (!settings) {
    await say(env, "Настройки бота ещё не заполнены в виджете amoCRM. Обратитесь к администратору.");
    return;
  }

  let state = await messenger.loadState(ctx, directId);
  const isStart = ctx.isStartCommand(text);

  if (!state) {
    state = newState(directId, userKey, userName);
  } else {
    if (userName) {
      state.userName = userName;
    }

    if (isStart) {
      // «старт» — начинаем с меню, но незавершённые отчёты не теряем.
      state.roleKey = null;
    }

    hydrate(state);
  }

  try {
    if (!state.roleKey) {
      await say(env, MSG_NOT_FOUND);
      return;
    }

    if (isStart) {
      dropFlow(state);
      state.list = null;
      await sendMenu(env, state);
      return;
    }

    const input = { text, attachments };

    // Кнопка главного меню — всегда начинает сценарий заново.
    if (text === SWITCH_ROLE && state.roleKeys.length > 1) {
      dropFlow(state);
      state.roleKey = state.roleKeys.find((key) => key !== state.roleKey);
      await sendMenu(env, state);
      return;
    }

    // «Принять отчет» — и пункт меню, и кнопка в карточке сделки (так в ТЗ):
    // внутри открытой карточки это кнопка карточки.
    const isCardButton = Boolean(state.flow && state.flow.name === "accept" && state.flow.step === "card" && text === "Принять отчет");

    if (!isCardButton && (MENU[state.roleKey] || []).includes(text)) {
      dropFlow(state);
      state.list = null;
      await runMenuButton(env, state, text);
      return;
    }

    if (state.flow) {
      const handled = await routeFlow(env, state, input);

      if (handled) {
        return;
      }
    }

    // Номер договора из последнего списка.
    if (!state.flow && state.list && state.list.map && state.list.map[text] !== undefined) {
      await selectFromList(env, state, state.list.kind, state.list.map[text]);
      return;
    }

    if (attachments.length > 0) {
      await say(env, "Сейчас файлы не ожидаются. Выберите действие в меню.");
    } else {
      await say(env, "⚠️ Неизвестная команда. Пожалуйста, пользуйтесь кнопками бота или начните заново командой «старт».");
    }

    await sendMenu(env, state);
  } catch (error) {
    console.error("[Бот монтажников] Ошибка обработки сообщения:", error.stack || error.message);

    try {
      await say(env, "❌ Не удалось обработать действие. Попробуйте ещё раз позже или обратитесь к администратору.");
    } catch (sendError) {
      console.error("[Бот монтажников] Не удалось отправить сообщение об ошибке:", sendError.message);
    }
  } finally {
    await messenger.saveState(ctx, directId, state);
  }
}

// ------------------------------------------------------------
// Планировщик: подтверждение выезда в 9:00 и 16:00 (МСК)
// ------------------------------------------------------------

async function runConfirmBroadcast(ctx, hour) {
  const settings = settingsStore.get();

  if (!settings || !settings.users || settings.users.length === 0) {
    return;
  }

  const lockKey = `montage_confirm_sent:${ctx.todayMoscowDateText()}:${hour}`;
  const lock = await ctx.redisRequest(["SET", lockKey, "1", "NX", "EX", 86400]);

  if (!lock || lock.result !== "OK") {
    return;
  }

  console.log(`[Бот монтажников] Рассылка «Подтвердить монтаж» (${hour}:00).`);

  for (const row of settings.users) {
    const directId = await messenger.findDirectId(ctx, [row.foremanHandle, row.foremanName]);

    if (!directId) {
      continue;
    }

    await messenger.runInQueue(directId, async () => {
      try {
        let state = await messenger.loadState(ctx, directId);

        if (!state) {
          state = newState(directId, null, row.foremanHandle);
        }

        hydrate(state);
        state.foremanName = row.foremanName;

        if (state.flow) {
          // Человек сейчас занят другим сценарием — не перебиваем.
          return;
        }

        const shown = await flowConfirm.showList({ ctx, directId }, state, { fromButton: false });

        if (shown) {
          await messenger.saveState(ctx, directId, state);
        }
      } catch (error) {
        console.error(`[Бот монтажников] Рассылка для «${row.foremanName}»:`, error.message);
      }
    });
  }
}

function startSchedulers(ctx) {
  setInterval(async () => {
    try {
      const moscow = ctx.getMoscowDate();
      const hour = moscow.getUTCHours();

      if ((hour === 9 || hour === 16) && moscow.getUTCMinutes() < 5) {
        await runConfirmBroadcast(ctx, hour);
      }
    } catch (error) {
      console.error("[Бот монтажников] Ошибка планировщика:", error.message);
    }
  }, 60 * 1000);

  console.log("[Бот монтажников] Планировщик «Подтвердить монтаж»: ежедневно в 9:00 и 16:00 (Москва).");
}

// ------------------------------------------------------------
// Маршруты
// ------------------------------------------------------------

function isValidWidgetSecret(req) {
  return Boolean(MONTAGE_WIDGET_SECRET) && req.get("X-Widget-Secret") === MONTAGE_WIDGET_SECRET;
}

function messageIdOf(message) {
  return message.id || message.message_id || message.msg_id || null;
}

function init(app, ctx) {
  app.get("/oauth/amomessenger/montage", (req, res) => {
    const result = messenger.authorizeUrl(req.query.scope);

    if (result.error) {
      return res.status(500).send(result.error);
    }

    res.redirect(result.url);
  });

  app.get("/oauth/amomessenger/montage/callback", async (req, res) => {
    if (!req.query.code) {
      return res.status(400).send("<h2>Ошибка OAuth</h2><p>Код авторизации не получен.</p>");
    }

    try {
      await messenger.exchangeCode(ctx, req.query.code);
      res.send(
        '<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>Бот монтажников — OAuth</title></head>' +
          '<body style="font-family:Arial;padding:40px;"><h2>Авторизация бота монтажников выполнена</h2>' +
          "<p>Теперь можно закрыть это окно.</p></body></html>"
      );
    } catch (error) {
      console.error("[Бот монтажников] OAuth ERROR:", error.response ? error.response.data : error.message);
      res.status(500).json({ status: "Ошибка OAuth", message: error.response?.data || error.message });
    }
  });

  app.get("/oauth/amomessenger/montage/status", (req, res) => {
    res.json({
      status: messenger.hasToken() ? "OK" : "Токен не найден",
      access_token: messenger.hasToken() ? "ДА" : "НЕТ",
      refresh_token: messenger.hasRefreshToken() ? "ДА" : "НЕТ"
    });
  });

  // Виджет (страница amoCRM) обращается к другому домену — нужен CORS.
  const allowedOrigin = `https://${ctx.AMOCRM_SUBDOMAIN}.amocrm.ru`;

  function cors(res) {
    res.set({
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Widget-Secret"
    });
  }

  app.options("/widget/montage/settings", (req, res) => {
    cors(res);
    res.sendStatus(204);
  });

  app.get("/widget/montage/settings", (req, res) => {
    cors(res);

    if (!isValidWidgetSecret(req)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    res.set("Cache-Control", "no-store");
    res.json(settingsStore.get() || null);
  });

  app.post("/widget/montage/settings", async (req, res) => {
    cors(res);

    if (!isValidWidgetSecret(req)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const validation = settingsStore.validate(req.body);

    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    try {
      const saved = await settingsStore.save(ctx, req.body);

      res.json({ status: "OK", updatedAt: saved.updatedAt });
    } catch (error) {
      console.error("[Бот монтажников] Ошибка сохранения настроек:", error.message);
      res.status(500).json({ error: "Не удалось сохранить настройки." });
    }
  });

  app.get("/debug/montage/settings", (req, res) => {
    const secret = process.env.DEBUG_SECRET || "";

    if (!secret) {
      return res.status(500).send("DEBUG_SECRET не задан.");
    }

    if (req.query.secret !== secret) {
      return res.status(403).send("Forbidden");
    }

    res.json({ settings: settingsStore.get() });
  });

  app.get("/status/montage", (req, res) => {
    const settings = settingsStore.get();

    res.json({
      status: "OK",
      service: "amoMessenger montage bot",
      pid: process.pid,
      process_started_at: PROCESS_STARTED_AT,
      amomessenger_token: messenger.hasToken() ? "ДА" : "НЕТ",
      widget_secret_set: MONTAGE_WIDGET_SECRET ? "ДА" : "НЕТ",
      widget_settings_saved: settings ? "ДА" : "НЕТ",
      widget_settings_updated_at: (settings && settings.updatedAt) || null
    });
  });

  app.post("/webhook/montage", async (req, res) => {
    const body = req.body || {};

    res.status(200).json({ status: "OK" });

    try {
      if (body.event_type !== "income_message") {
        return;
      }

      const data = body._embedded || {};
      const context = data.context || {};
      const message = data.message || {};
      const directId = (data.conversation_identity || {}).direct_id;
      const userKey = context.user_id || (message.author && message.author.user_id);

      if (!directId || !userKey) {
        console.error("[Бот монтажников] Не удалось определить direct_id или user_id из вебхука.");
        return;
      }

      // Один и тот же вебхук (повтор доставки) обрабатываем один раз.
      if (!(await messenger.claimMessage(ctx, messageIdOf(message)))) {
        console.log(`[Бот монтажников] Повторная доставка сообщения ${messageIdOf(message)} — пропуск.`);
        return;
      }

      // Все сообщения одного диалога — строго по очереди.
      await messenger.runInQueue(directId, async () => {
        let userName = ctx.extractAmoMessengerUserName(message.author, context, message);

        if (!userName) {
          userName = await messenger.getUserNameById(ctx, userKey);
        }

        const attachments = files.extractAttachments(ctx, message);
        const text = String(message.text || "").trim();

        console.log(
          "[Бот монтажников] Входящее сообщение:",
          JSON.stringify({
            userKey: String(userKey),
            userName,
            text: text.slice(0, 100),
            attachments: attachments.map((item) => item.kind),
            messageKeys: Object.keys(message)
          })
        );

        await processMessage(ctx, { directId, userKey, userName, text, attachments });
      });
    } catch (error) {
      console.error("[Бот монтажников] WEBHOOK ERROR:", error.stack || error.message);
    }
  });

  console.log(
    "[Бот монтажников] Маршруты: /webhook/montage, /oauth/amomessenger/montage(/callback|/status), " +
      "/widget/montage/settings, /debug/montage/settings, /status/montage"
  );
}

module.exports = {
  init,
  loadTokens: async (ctx) => {
    await messenger.loadTokens(ctx);
    await settingsStore.load(ctx);
  },
  startSchedulers,
  // Для автоматических проверок (montageBot.test.js).
  processMessage
};
