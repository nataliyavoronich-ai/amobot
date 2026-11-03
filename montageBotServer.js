// ============================================================
// БОТ МОНТАЖНИКОВ — ОТДЕЛЬНЫЙ ПРОЦЕСС
// ============================================================
//
// Самостоятельное Express-приложение для montageBot.js, не зависящее от
// server.js (инженеры/проектировщики) и productionBotServer.js (производство).
// Запускается как отдельное PM2-приложение на своём порту; nginx пускает на
// него только пути /webhook/montage, /oauth/amomessenger/montage*,
// /widget/montage/*, /debug/montage* и /status/montage. Перезапуск этого
// процесса не затрагивает остальные боты, и наоборот.

const express = require("express");
const ctxUtils = require("./amoSharedUtils");
const montageBot = require("./montageBot");

const PORT = process.env.MONTAGE_BOT_PORT || 10003;

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const montageContext = {
  AMOCRM_SUBDOMAIN: ctxUtils.AMOCRM_SUBDOMAIN,
  YANDEX_DISK_ROOT_FOLDER: ctxUtils.YANDEX_DISK_ROOT_FOLDER,
  redisRequest: ctxUtils.redisRequest,
  isStartCommand: ctxUtils.isStartCommand,
  extractAmoMessengerUserName: ctxUtils.extractAmoMessengerUserName,
  extractImageUrlsFromMessage: ctxUtils.extractImageUrlsFromMessage,
  getUrlExtension: ctxUtils.getUrlExtension,
  escapeRegExp: ctxUtils.escapeRegExp,
  getMoscowDate: ctxUtils.getMoscowDate,
  todayMoscowDateText: ctxUtils.todayMoscowDateText,
  todayMoscowStartUnix: ctxUtils.todayMoscowStartUnix,
  getUserName: ctxUtils.getUserName,
  amoCrmGet: ctxUtils.amoCrmGet,
  amoCrmPost: ctxUtils.amoCrmPost,
  amoCrmPatch: ctxUtils.amoCrmPatch,
  getLead: ctxUtils.getLead,
  getFieldValues: ctxUtils.getFieldValues,
  getFieldValueJoined: ctxUtils.getFieldValueJoined,
  formatDateFieldValue: ctxUtils.formatDateFieldValue,
  yandexDiskHeaders: ctxUtils.yandexDiskHeaders,
  ydEnsureFolderPath: ctxUtils.ydEnsureFolderPath,
  ydEnsureFolder: ctxUtils.ydEnsureFolder,
  ydUploadFromUrlAndWait: ctxUtils.ydUploadFromUrlAndWait,
  ydGetFolderPublicUrl: ctxUtils.ydGetFolderPublicUrl
};

app.get("/", (req, res) => {
  res.json({ status: "OK", service: "montage bot (отдельный процесс)" });
});

async function start() {
  try {
    montageBot.init(app, montageContext);
  } catch (error) {
    console.error("[Бот монтажников] КРИТИЧЕСКАЯ ОШИБКА при регистрации маршрутов:", error.stack || error.message);
  }

  try {
    await ctxUtils.loadAmoCrmTokensFromRedis();
    await montageBot.loadTokens(montageContext);
    montageBot.startSchedulers(montageContext);
  } catch (error) {
    console.error("[Бот монтажников] КРИТИЧЕСКАЯ ОШИБКА при загрузке токенов/планировщиков:", error.stack || error.message);
  }

  app.listen(PORT, () => {
    console.log("==========================================");
    console.log(`Бот монтажников (отдельный процесс) запущен на порту ${PORT}`);
    console.log("==========================================");
  });
}

start();
