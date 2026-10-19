// ============================================================
// БОТ ПРОИЗВОДСТВО — ОТДЕЛЬНЫЙ ПРОЦЕСС
// ============================================================
//
// Самостоятельное Express-приложение для productionBot.js, не зависящее
// от server.js (бот инженеров/проектировщиков). Запускается как отдельное
// PM2-приложение на своём порту; nginx пускает на него только пути
// /webhook/production, /oauth/amomessenger/production*, /widget/production/*,
// /debug/production* и /status/production — всё остальное (и сам домен,
// и OAuth-ссылки в amoCRM) остаётся как было, меняется только то, какой
// процесс отвечает за конкретные пути.
//
// Цель переделки: деплой/перезапуск/ошибка в этом процессе никак не
// задевает tasks-bot (инженеры + проектировщики), и наоборот.

const express = require("express");
const ctxUtils = require("./amoSharedUtils");
const productionBot = require("./productionBot");

const PORT = process.env.PRODUCTION_BOT_PORT || 10002;

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const productionBotContext = {
  AMOCRM_SUBDOMAIN: ctxUtils.AMOCRM_SUBDOMAIN,
  redisRequest: ctxUtils.redisRequest,
  isStartCommand: ctxUtils.isStartCommand,
  extractAmoMessengerUserName: ctxUtils.extractAmoMessengerUserName,
  extractImageUrlsFromMessage: ctxUtils.extractImageUrlsFromMessage,
  getMoscowDate: ctxUtils.getMoscowDate,
  todayMoscowDateText: ctxUtils.todayMoscowDateText,
  todayMoscowStartUnix: ctxUtils.todayMoscowStartUnix,
  getUserName: ctxUtils.getUserName,
  amoCrmGet: ctxUtils.amoCrmGet,
  amoCrmPost: ctxUtils.amoCrmPost,
  amoCrmPatch: ctxUtils.amoCrmPatch,
  getFieldValues: ctxUtils.getFieldValues,
  getFieldValueJoined: ctxUtils.getFieldValueJoined,
  formatDateFieldValue: ctxUtils.formatDateFieldValue,
  getLead: ctxUtils.getLead,
  buildTaggedButton: ctxUtils.buildTaggedButton,
  parseTaggedButton: ctxUtils.parseTaggedButton,
  ydEnsureFolderPath: ctxUtils.ydEnsureFolderPath,
  ydEnsureFolder: ctxUtils.ydEnsureFolder,
  ydUploadFromUrlAndWait: ctxUtils.ydUploadFromUrlAndWait,
  ydGetFolderPublicUrl: ctxUtils.ydGetFolderPublicUrl,
  yandexDiskHeaders: ctxUtils.yandexDiskHeaders,
  escapeRegExp: ctxUtils.escapeRegExp,
  getUrlExtension: ctxUtils.getUrlExtension,
  YANDEX_DISK_ROOT_FOLDER: ctxUtils.YANDEX_DISK_ROOT_FOLDER
};

app.get("/", (req, res) => {
  res.json({ status: "OK", service: "production bot (отдельный процесс)" });
});

async function start() {
  // Та же защита, что и при встроенном запуске из server.js — ошибка
  // здесь не должна оставлять процесс в непонятном состоянии без единого
  // работающего маршрута.
  try {
    productionBot.init(app, productionBotContext);
  } catch (error) {
    console.error(
      "[Бот производства] КРИТИЧЕСКАЯ ОШИБКА при регистрации маршрутов:",
      error.stack || error.message
    );
  }

  try {
    await ctxUtils.loadAmoCrmTokensFromRedis();
    await productionBot.loadTokens(productionBotContext);
    productionBot.startSchedulers(productionBotContext);
  } catch (error) {
    console.error(
      "[Бот производства] КРИТИЧЕСКАЯ ОШИБКА при загрузке токенов/планировщиков:",
      error.stack || error.message
    );
  }

  app.listen(PORT, () => {
    console.log("==========================================");
    console.log(`Бот производства (отдельный процесс) запущен на порту ${PORT}`);
    console.log("==========================================");
  });
}

start();
