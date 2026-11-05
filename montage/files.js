// ============================================================
// БОТ МОНТАЖНИКОВ — файлы: разбор вложений и загрузка на Яндекс Диск
// Папка: amoCRM/Сделка (id …)/Отчеты и проекты/Монтаж; ссылка — в поле 557522.
// Файлы грузим ТОЛЬКО на Яндекс Диск (дублирования на Selectel нет).
// ============================================================

const axios = require("axios");
const { FIELD } = require("./constants");
const amo = require("./amo");

const VIDEO_EXTENSIONS = ["mp4", "mov", "avi", "mkv", "webm", "m4v", "3gp", "mpeg", "mpg", "wmv", "flv"];
const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "tif", "tiff"];

const REPORTS_FOLDER_NAME = "Отчеты и проекты";
const MONTAGE_FOLDER_NAME = "Монтаж";

// Вложения сообщения: [{url, kind: "video"|"image"|"other", ext}].
function extractAttachments(ctx, message) {
  const result = [];
  const seen = new Set();

  function push(url, type) {
    if (!url || seen.has(url)) {
      return;
    }

    seen.add(url);

    const ext = ctx.getUrlExtension(url) || "";
    const typeText = String(type || "").toLowerCase();
    let kind = "other";

    if (typeText.includes("video") || VIDEO_EXTENSIONS.includes(ext)) {
      kind = "video";
    } else if (typeText.includes("pic") || typeText.includes("image") || typeText.includes("photo") || IMAGE_EXTENSIONS.includes(ext)) {
      kind = "image";
    }

    result.push({ url, kind, ext });
  }

  const attachments = (message && message.attachments) || [];

  if (Array.isArray(attachments)) {
    for (const attachment of attachments) {
      const container = attachment && attachment.type && attachment[attachment.type];
      const link = container && container.link;

      if (typeof link === "string" && link) {
        const match = link.match(/(https?:\/\/[^\s\])]+)/);

        push(match ? match[1] : link, attachment.type);
      }
    }
  }

  // Запасной разбор «любая ссылка в сообщении» — только для сообщений без
  // текста. Нажатие кнопки («Завершить отчёт») приходит с текстом и может
  // содержать ссылки на прежние сообщения — файлом это не считаем.
  if (result.length === 0 && !String((message && message.text) || "").trim()) {
    for (const url of ctx.extractImageUrlsFromMessage(message)) {
      push(url, "");
    }
  }

  return result;
}

// Подходит ли вложение шагу: acceptKind = "video" | "image".
function attachmentFits(attachment, acceptKind) {
  if (acceptKind === "video") {
    return attachment.kind === "video";
  }

  // Фото принимаем и без точно определённого расширения; чужие видео — нет.
  return attachment.kind === "image" || attachment.kind === "other";
}

function folderPaths(ctx, leadId) {
  const leadPath = `${ctx.YANDEX_DISK_ROOT_FOLDER}/Сделка (id ${leadId})`;
  const reportsPath = `${leadPath}/${REPORTS_FOLDER_NAME}`;

  return { leadPath, reportsPath, montagePath: `${reportsPath}/${MONTAGE_FOLDER_NAME}` };
}

// T-5.1–5.3: папка сделки, папка «Монтаж», ссылка на неё в поле 557522.
async function ensureMontageFolder(ctx, leadId) {
  const { reportsPath, montagePath } = folderPaths(ctx, leadId);

  await ctx.ydEnsureFolderPath(reportsPath);
  await ctx.ydEnsureFolder(montagePath);

  return montagePath;
}

async function ensureFolderLink(ctx, lead) {
  const montagePath = await ensureMontageFolder(ctx, lead.id);
  const url = await ctx.ydGetFolderPublicUrl(montagePath);

  if (amo.fieldText(ctx, lead, FIELD.MONTAGE_FOLDER) !== url) {
    await amo.patchLead(ctx, lead.id, { custom_fields_values: [amo.setValue(FIELD.MONTAGE_FOLDER, url)] });
  }

  return url;
}

async function nextFileNumber(ctx, folderPath, baseName, extension) {
  const response = await axios.get("https://cloud-api.yandex.net/v1/disk/resources", {
    params: { path: folderPath, limit: 1000, fields: "_embedded.items.name" },
    headers: ctx.yandexDiskHeaders(),
    timeout: 30000,
    validateStatus: () => true
  });

  if (response.status !== 200) {
    throw new Error(`Яндекс.Диск: не удалось получить список файлов "${folderPath}". HTTP ${response.status}`);
  }

  const items = (response.data && response.data._embedded && response.data._embedded.items) || [];
  const pattern = new RegExp(`^${ctx.escapeRegExp(baseName)}(?: \\((\\d+)\\))?\\.${ctx.escapeRegExp(extension)}$`, "i");
  let max = -1;

  for (const item of items) {
    const match = String((item && item.name) || "").match(pattern);

    if (match) {
      max = Math.max(max, match[1] === undefined ? 0 : Number(match[1]));
    }
  }

  return max + 1;
}

// Загрузить один файл; возвращает путь на Диске. Имя — по категории, при
// совпадении — (1), (2)… (T-5.4). Файлы не перезаписываются.
async function uploadFile(ctx, leadId, baseName, attachment) {
  const montagePath = await ensureMontageFolder(ctx, leadId);
  const extension = attachment.ext || (attachment.kind === "video" ? "mp4" : "jpg");
  const number = await nextFileNumber(ctx, montagePath, baseName, extension);
  const fileName = `${baseName}${number > 0 ? ` (${number})` : ""}.${extension}`;
  const path = `${montagePath}/${fileName}`;

  await ctx.ydUploadFromUrlAndWait(path, attachment.url);

  return path;
}

async function publicLinks(ctx, paths) {
  const links = [];

  for (const path of paths) {
    try {
      links.push(await ctx.ydGetFolderPublicUrl(path));
    } catch (error) {
      console.error("[Бот монтажников] Не удалось получить ссылку на файл:", error.message);
    }
  }

  return links;
}

module.exports = {
  extractAttachments,
  attachmentFits,
  ensureFolderLink,
  uploadFile,
  publicLinks
};
