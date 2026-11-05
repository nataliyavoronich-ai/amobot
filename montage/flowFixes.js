// ============================================================
// БОТ МОНТАЖНИКОВ — T-9 «Внести правки» (поиск сделок и выбор).
// Сами шаги правок (комментарий, общее фото, доп. работы, КТУ, пробег,
// «Завершить отчёт») — в общем движке flowReport.js (режим "fixes"),
// потому что блоки доп. работ и КТУ те же, что в Т6.
// ============================================================

const amo = require("./amo");
const messenger = require("./messenger");
const deals = require("./deals");
const flowReport = require("./flowReport");
const { say } = require("./ui");
const { TASK_TYPE } = require("./constants");

async function showList(env, state) {
  const { ctx } = env;
  const found = await deals.findFixesDeals(ctx, state.foremanName);

  if (found.length === 0) {
    await say(env, "Задачи по внесению правок не найдены.");
    return;
  }

  const leads = deals.sortByTerms(ctx, found).map((item) => item.lead);
  const lines = [];

  for (let i = 0; i < leads.length; i++) {
    lines.push(`${i + 1}) ${await deals.dealLine(ctx, leads[i], "fixes")}`);
  }

  const { map, buttons } = deals.buildDealButtons(ctx, leads);

  state.list = { kind: "fixes", map };
  await say(env, `Необходимо дополнить отчет:\n${lines.join("\n")}`, buttons, true);
}

async function select(env, state, leadId) {
  const { ctx } = env;
  const lead = (await amo.getLeadsByIds(ctx, [leadId]))[0];

  if (!lead) {
    await say(env, "Сделка не найдена.");
    return;
  }

  const slotIndex = amo.findSlotIndex(ctx, lead, state.foremanName);

  if (slotIndex < 0) {
    await say(env, "В сделке не найдена ваша группа полей. Обратитесь к руководителю.");
    return;
  }

  const task = (await amo.getTasksForLeads(ctx, [leadId], TASK_TYPE.FIXES, false))[0];

  if (!task) {
    await say(env, "Задача «Правки в отчет» по этой сделке уже закрыта.");
    await showList(env, state);
    return;
  }

  await flowReport.startFixes(env, state, { leadId, taskId: task.id, slotIndex });
}

module.exports = { showList, select, handle: flowReport.handle, messenger };
