// ============================================================
// БОТ МОНТАЖНИКОВ — запуск процессов Sensei
// POST https://api.sensei.plus/v1/process/start/{ID процесса}
// Заголовок X-Auth-Sensei-Token, тело {"data":[{"entity_id":<сделка>,"entity_type":1}]}
// Токен — переменная окружения SENSEI_TOKEN (в код не записывается).
// ============================================================

const axios = require("axios");

const PROCESS = {
  WISHES: 72111, // «Доп. хотелки»
  CUSTOMER_ABSENT: 78045 // «Заказчик отсутствует»
};

// true — процесс запущен; false — не запущен (нет токена или ошибка), причина в логе.
async function startProcess(processId, leadId) {
  const token = process.env.SENSEI_TOKEN || "";

  if (!token) {
    console.warn(`[Бот монтажников] SENSEI_TOKEN не задан — процесс ${processId} не запущен.`);
    return false;
  }

  try {
    const response = await axios.post(
      `https://api.sensei.plus/v1/process/start/${processId}`,
      { data: [{ entity_id: Number(leadId), entity_type: 1 }] },
      {
        headers: { "X-Auth-Sensei-Token": token, "Content-Type": "application/json" },
        timeout: 30000,
        validateStatus: () => true
      }
    );

    if (response.status >= 400) {
      console.error(
        `[Бот монтажников] Sensei: процесс ${processId}, сделка ${leadId}: HTTP ${response.status} ` +
          JSON.stringify(response.data).slice(0, 200)
      );
      return false;
    }

    console.log(`[Бот монтажников] Sensei: процесс ${processId} запущен для сделки ${leadId}.`);
    return true;
  } catch (error) {
    console.error(`[Бот монтажников] Sensei: процесс ${processId}: ${error.message}`);
    return false;
  }
}

module.exports = { PROCESS, startProcess };
