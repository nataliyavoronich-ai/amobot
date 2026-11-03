// ============================================================
// БОТ МОНТАЖНИКОВ — публикация отчёта в канал amoMessenger (вместо Telegram)
// По документации developers.amo.tm:
//   1) POST https://api.amo.tm/v1.3/files/upload (multipart, scope files:w,
//      до 100 МБ) → file_id;
//   2) POST https://api.amo.io/v1.3/channels/{CHANNEL_ID}/sendMessage,
//      вложение — {"file_id": …}; в сообщении одно вложение, поэтому текст
//      и каждый файл идут отдельными сообщениями.
// Файлы берём с Яндекс.Диска (они уже там). Файл больше 100 МБ в канал
// не отправляется — в тексте остаётся ссылка на папку.
// ============================================================

const axios = require("axios");
const messenger = require("./messenger");

const CHANNEL_ID = process.env.AMOMESSENGER_MONTAGE_CHANNEL_ID || "a825eb4a-d764-11f1-8a0e-3e32d30acdd5";
const CHANNEL_API = process.env.AMOMESSENGER_CHANNEL_API || "https://api.amo.io";
const FILES_API = "https://api.amo.tm";
const MAX_FILE_BYTES = 100 * 1024 * 1024;

async function downloadFromDisk(ctx, path) {
  const link = await axios.get("https://cloud-api.yandex.net/v1/disk/resources/download", {
    params: { path },
    headers: ctx.yandexDiskHeaders(),
    timeout: 30000,
    validateStatus: () => true
  });

  if (link.status !== 200 || !link.data || !link.data.href) {
    throw new Error(`Яндекс.Диск: нет ссылки на скачивание «${path}», HTTP ${link.status}`);
  }

  const file = await axios.get(link.data.href, {
    responseType: "arraybuffer",
    timeout: 300000,
    maxContentLength: MAX_FILE_BYTES,
    maxBodyLength: MAX_FILE_BYTES,
    validateStatus: () => true
  });

  if (file.status !== 200) {
    throw new Error(`Яндекс.Диск: не удалось скачать «${path}», HTTP ${file.status}`);
  }

  return Buffer.from(file.data);
}

async function uploadToMessenger(ctx, buffer, filename) {
  if (typeof FormData === "undefined" || typeof Blob === "undefined") {
    throw new Error("На сервере нужен Node.js 18 или новее (FormData).");
  }

  const response = await messenger.withToken(ctx, (token) => {
    const form = new FormData();

    form.append("filename", filename);
    form.append("file", new Blob([buffer]), filename);

    return axios.post(`${FILES_API}/v1.3/files/upload`, form, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 300000,
      maxBodyLength: Infinity,
      validateStatus: () => true
    });
  });

  if (response.status !== 200 || !response.data || !response.data.file_id) {
    throw new Error(
      `amoMessenger: загрузка файла HTTP ${response.status} ${JSON.stringify(response.data).slice(0, 200)}` +
        (response.status === 403 ? " (у приложения нет разрешения files:w?)" : "")
    );
  }

  return response.data.file_id;
}

async function sendToChannel(ctx, body) {
  const response = await messenger.withToken(ctx, (token) =>
    axios.post(`${CHANNEL_API}/v1.3/channels/${CHANNEL_ID}/sendMessage`, body, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      timeout: 60000,
      validateStatus: () => true
    })
  );

  if (response.status >= 400) {
    throw new Error(`amoMessenger: канал HTTP ${response.status} ${JSON.stringify(response.data).slice(0, 200)}`);
  }

  return response.data && response.data.msg_id;
}

// done — объект {ключ: true} из состояния отчёта: уже отправленное не повторяем.
async function publishReport(ctx, { text, paths, done }) {
  const skipped = [];

  if (!done.text) {
    await sendToChannel(ctx, { text, formatting_mode: "md" });
    done.text = true;
  }

  for (const path of paths) {
    if (done[path]) {
      continue;
    }

    const buffer = await downloadFromDisk(ctx, path);

    if (buffer.length > MAX_FILE_BYTES) {
      skipped.push(path);
      done[path] = true;
      continue;
    }

    const fileId = await uploadToMessenger(ctx, buffer, path.split("/").pop());

    await sendToChannel(ctx, { attachments: [{ file_id: fileId }] });
    done[path] = true;
  }

  return skipped;
}

module.exports = { publishReport };
