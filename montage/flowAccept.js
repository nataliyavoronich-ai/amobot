// ============================================================
// БОТ МОНТАЖНИКОВ — T-7 «Принять отчет» (руководитель)
// ============================================================

const amo = require("./amo");
const calc = require("./calc");
const messenger = require("./messenger");
const settingsStore = require("./settings");
const deals = require("./deals");
const { BTN, MSG_NOT_NUMBER, MSG_NOT_INTEGER, say, recalculatePrice, filledKtu, tariffs } = require("./ui");
const { FIELD, RESULT, TASK_TYPE } = require("./constants");

const { mdSafe } = messenger;

const B_ACCEPT_REPORT = "Принять отчет";
const B_SEND_BACK = "Отдать на доработку";
const B_EDIT_KTU = "Внести правки в баллы КТУ";
const B_EDIT_PRICE = "Внести правки стоимость";
const B_ACCEPT = "Принять";
const B_EDIT_KM_DELIVERY = "Внести правки в км доставки";
const B_EDIT_KM = "Внести правки км транспортный";
const B_SKIP_NEXT = "Пропустить/далее";

// T-7.1–7.2: список отчётов к принятию.
async function showList(env, state) {
  const { ctx } = env;
  const names = state.managerRows.map((row) => row.foremanName);
  const found = await deals.findAcceptDeals(ctx, names);

  if (found.length === 0) {
    await say(env, "Задачи по принятию отчета не найдены");
    return;
  }

  const leads = deals.sortByTerms(ctx, found).map((item) => item.lead);
  const lines = [];

  for (let i = 0; i < leads.length; i++) {
    lines.push(`${i + 1}) ${await deals.dealLine(ctx, leads[i], "accept")}`);
  }

  const { map, buttons } = deals.buildDealButtons(ctx, leads);

  state.list = { kind: "accept", map };
  await say(env, `Принять отчет:\n${lines.join("\n")}`, buttons, true);
}

async function loadFlowLead(env, flow) {
  const lead = (await amo.getLeadsByIds(env.ctx, [flow.leadId]))[0];

  if (!lead) {
    throw new Error(`Сделка ${flow.leadId} не найдена`);
  }

  return lead;
}

async function select(env, state, leadId) {
  const { ctx } = env;
  const lead = (await amo.getLeadsByIds(ctx, [leadId]))[0];

  if (!lead) {
    await say(env, "Сделка не найдена.");
    return;
  }

  const row = state.managerRows.find((item) => deals.belongsToForeman(ctx, lead, item.foremanName));
  const foremanName = row ? row.foremanName : deals.leadForemanNames(ctx, lead)[0];
  const slotIndex = amo.findSlotIndex(ctx, lead, foremanName);

  if (slotIndex < 0) {
    await say(env, `В сделке не найдена группа полей монтажника «${mdSafe(foremanName)}».`);
    return;
  }

  const task = (await amo.getTasksForLeads(ctx, [leadId], TASK_TYPE.ACCEPT_REPORT, false))[0];

  if (!task) {
    await say(env, "Задача «Принять отчет» по этой сделке уже закрыта.");
    await showList(env, state);
    return;
  }

  state.flow = { name: "accept", leadId, taskId: task.id, foremanName, slotIndex, step: "card", data: { done: {} } };

  await showCard(env, state, lead);
}

async function showCard(env, state, lead) {
  const { ctx } = env;
  const flow = state.flow;
  const slot = amo.readSlot(ctx, lead, flow.slotIndex);
  const lines = [
    "Отчет принят?",
    `- Монтажник ${mdSafe(flow.foremanName)}`,
    `- ${deals.contractLabel(ctx, lead)}`,
    `- ${await deals.folderLink(ctx, lead, "Папка на яндекс-диске")}`,
    `- ${mdSafe(deals.productText(ctx, lead))}`,
    `- Кол-во этажей: ${mdSafe(deals.floorsText(ctx, lead))}`,
    `- Числовое значение пробега: ${calc.fmt(slot.kmFact)}`,
    `- Числовое значение доставки: ${calc.fmt(slot.kmDelivery)}`,
    `- Бюджет сделки: ${calc.fmt(Number(lead.price) || 0)}`,
    `- Стоимость работ: ${calc.fmt(slot.price)}`,
    `- Сумма баллов КТУ: ${calc.fmt(amo.ktuTotal(slot))}`
  ];

  if (slot.note) {
    lines.push(`- Доп.работы: ${mdSafe(slot.note)}`);
  }

  flow.step = "card";
  await say(env, lines.join("\n"), [B_ACCEPT_REPORT, B_SEND_BACK], true);
}

function ktuText(slot) {
  const items = filledKtu(slot);

  if (items.length === 0) {
    return "Начислены баллы КТУ:\nБаллы КТУ не начислены.\nОбщее кол-во баллов: 0";
  }

  return (
    "Начислены баллы КТУ:\n" +
    items.map((item) => `${item.label}: ${calc.fmt(item.value)}`).join("\n") +
    `\nОбщее кол-во баллов: ${calc.fmt(items.reduce((sum, item) => sum + item.value, 0))}`
  );
}

async function showKtu(env, state, lead) {
  state.flow.step = "ktu";
  await say(env, ktuText(amo.readSlot(env.ctx, lead, state.flow.slotIndex)), [BTN.NEXT, B_EDIT_KTU]);
}

async function showPrice(env, state, lead) {
  const { ctx } = env;
  const flow = state.flow;
  const slot = amo.readSlot(ctx, lead, flow.slotIndex);
  const { calculated } = recalculatePrice(ctx, lead, flow.slotIndex, flow.foremanName);

  flow.step = "price";
  await say(
    env,
    `Стоимость работ: ${calc.fmt(slot.price)}\nОписание расчета:\n` +
      (calculated
        ? calc.describePriceCalc(calculated)
        : "расчет недоступен: продукт не найден в таблице «Расчет стоимости монтажа»"),
    [BTN.NEXT, B_EDIT_PRICE, B_SEND_BACK]
  );
}

async function showMileage(env, state, lead) {
  const { ctx } = env;
  const flow = state.flow;
  const slot = amo.readSlot(ctx, lead, flow.slotIndex);
  const motivation = settingsStore.findMotivation(
    settingsStore.get(),
    settingsStore.findRowByForemanName(settingsStore.get(), flow.foremanName)
  );
  const rates = tariffs(slot, motivation);

  flow.step = "mileage";
  await say(
    env,
    "Стоимость пробега:\n" +
      `Транспортный: ${calc.fmt(slot.kmFact)} км * ${calc.fmt(rates.transport)}\n` +
      `Доставка: ${calc.fmt(slot.kmDelivery)} км * ${calc.fmt(rates.delivery)}`,
    [B_ACCEPT, B_EDIT_KM_DELIVERY, B_EDIT_KM]
  );
}

async function startSendBack(env, state) {
  state.flow.step = "rework_comment";
  await say(env, "Укажите комментарий");
}

// Запись пробега и пересчёт «км × тариф» (T-7.10.2/7.10.3).
async function writeKm(env, flow, lead, key, value) {
  const { ctx } = env;
  const slot = amo.readSlot(ctx, lead, flow.slotIndex);
  const motivation = settingsStore.findMotivation(
    settingsStore.get(),
    settingsStore.findRowByForemanName(settingsStore.get(), flow.foremanName)
  );
  const rates = tariffs(slot, motivation);
  const values =
    key === "kmFact"
      ? { kmFact: value, tariff: rates.transport, kmFactTotal: calc.round2(rates.transport * value) }
      : { kmDelivery: value, tariffDelivery: rates.delivery, kmDeliveryTotal: calc.round2(rates.delivery * value) };

  await amo.patchLead(ctx, lead.id, { custom_fields_values: amo.slotFieldsPayload(flow.slotIndex, values) });
}

async function finishAccepted(env, state, lead) {
  const { ctx } = env;
  const flow = state.flow;
  const slot = amo.readSlot(ctx, lead, flow.slotIndex);
  const settings = settingsStore.get();
  const row = settingsStore.findRowByForemanName(settings, flow.foremanName);
  const rates = tariffs(slot, settingsStore.findMotivation(settings, row));

  if (!flow.data.done.task) {
    await amo.closeTask(ctx, flow.taskId, RESULT.REPORT_ACCEPTED);
    flow.data.done.task = true;
  }

  await say(env, `Задача amoCRM "Принять отчет" закрыта с результатом "${RESULT.REPORT_ACCEPTED}".`);

  if (!flow.data.done.notify) {
    await messenger.notify(
      ctx,
      row ? [row.foremanHandle, row.foremanName] : [flow.foremanName],
      `Ваш отчет по ${mdSafe(amo.contractNumber(ctx, lead))} принят руководителем\n` +
        `Стоимость работ: ${calc.fmt(slot.price)}\n` +
        `Баллы КТУ: ${calc.fmt(amo.ktuTotal(slot))}\n` +
        `${calc.fmt(slot.kmFact)} км * ${calc.fmt(rates.transport)} тариф = ${calc.fmt(slot.kmFactTotal)}\n` +
        `${calc.fmt(slot.kmDelivery)} км * ${calc.fmt(rates.delivery)} = ${calc.fmt(slot.kmDeliveryTotal)}`
    );
    flow.data.done.notify = true;
  }

  state.flow = null;
  await showList(env, state);
}

async function handle(env, state, input) {
  const { ctx } = env;
  const flow = state.flow;
  const text = input.text;
  const lead = await loadFlowLead(env, flow);

  if (flow.step === "card") {
    if (text === B_ACCEPT_REPORT) {
      await showKtu(env, state, lead);
    } else if (text === B_SEND_BACK) {
      await startSendBack(env, state);
    } else {
      await showCard(env, state, lead);
    }

    return true;
  }

  if (flow.step === "rework_comment") {
    if (!text) {
      await say(env, "Укажите комментарий");
      return true;
    }

    if (!flow.data.done.comment) {
      await amo.patchLead(ctx, lead.id, { custom_fields_values: [amo.setValue(FIELD.MASTER_COMMENT, text)] });
      flow.data.done.comment = true;
    }

    if (!flow.data.done.task) {
      await amo.closeTask(ctx, flow.taskId, RESULT.SEND_BACK);
      flow.data.done.task = true;
    }

    await say(env, `Задача amoCRM "Принять отчет" закрыта с результатом "${RESULT.SEND_BACK}".`);

    const row = settingsStore.findRowByForemanName(settingsStore.get(), flow.foremanName);

    await messenger.notify(
      ctx,
      row ? [row.foremanHandle, row.foremanName] : [flow.foremanName],
      `Отчет по ${mdSafe(amo.contractNumber(ctx, lead))} НЕ принят руководителем.`
    );

    state.flow = null;
    await showList(env, state);
    return true;
  }

  if (flow.step === "ktu") {
    if (text === BTN.NEXT) {
      await showPrice(env, state, lead);
    } else if (text === B_EDIT_KTU) {
      await showKtuPick(env, state, lead);
    } else {
      await showKtu(env, state, lead);
    }

    return true;
  }

  if (flow.step === "ktu_pick") {
    const slot = amo.readSlot(ctx, lead, flow.slotIndex);
    const chosen = filledKtu(slot).find((item) => item.label === text);

    if (text === B_SKIP_NEXT) {
      await showPrice(env, state, lead);
    } else if (chosen) {
      flow.data.ktuKey = chosen.slotKey;
      flow.step = "ktu_value";
      await say(env, "Введите новое значение");
    } else {
      await showKtuPick(env, state, lead);
    }

    return true;
  }

  if (flow.step === "ktu_value") {
    const value = calc.parseInteger(text);

    if (value === null) {
      await say(env, "Не удалось распознать введенное значение. Пожалуйста, введите значение, состоящее только из цифр.");
      return true;
    }

    await amo.patchLead(ctx, lead.id, {
      custom_fields_values: amo.slotFieldsPayload(flow.slotIndex, { [flow.data.ktuKey]: value })
    });

    const fresh = await loadFlowLead(env, flow);
    const total = amo.ktuTotal(amo.readSlot(ctx, fresh, flow.slotIndex));

    await say(env, `Правки внесены.\nОбщее кол-во баллов: ${calc.fmt(total)}`);
    await showKtuPick(env, state, fresh);
    return true;
  }

  if (flow.step === "price") {
    if (text === BTN.NEXT) {
      await showMileage(env, state, lead);
    } else if (text === B_EDIT_PRICE) {
      flow.step = "price_value";
      await say(env, "Введите новую стоимость");
    } else if (text === B_SEND_BACK) {
      await startSendBack(env, state);
    } else {
      await showPrice(env, state, lead);
    }

    return true;
  }

  if (flow.step === "price_value") {
    const value = calc.parseInteger(text);

    if (value === null) {
      await say(env, "Не удалось распознать введенное значение. Пожалуйста, введите значение, состоящее только из цифр.");
      return true;
    }

    await amo.patchLead(ctx, lead.id, { custom_fields_values: amo.slotFieldsPayload(flow.slotIndex, { price: value }) });
    await say(env, "Правки внесены");
    await showMileage(env, state, await loadFlowLead(env, flow));
    return true;
  }

  if (flow.step === "mileage") {
    if (text === B_ACCEPT) {
      await finishAccepted(env, state, lead);
    } else if (text === B_EDIT_KM_DELIVERY) {
      flow.step = "km_delivery_value";
      await say(env, "Введите новое значение км доставки");
    } else if (text === B_EDIT_KM) {
      flow.step = "km_value";
      await say(env, "Введите новое значение kм факт");
    } else {
      await showMileage(env, state, lead);
    }

    return true;
  }

  if (flow.step === "km_delivery_value" || flow.step === "km_value") {
    const value = calc.parseNumber(text);

    if (value === null) {
      await say(env, MSG_NOT_NUMBER);
      return true;
    }

    await writeKm(env, flow, lead, flow.step === "km_value" ? "kmFact" : "kmDelivery", value);
    await say(env, "Правки внесены");
    await showMileage(env, state, await loadFlowLead(env, flow));
    return true;
  }

  return false;
}

async function showKtuPick(env, state, lead) {
  const slot = amo.readSlot(env.ctx, lead, state.flow.slotIndex);

  state.flow.step = "ktu_pick";
  await say(env, "Выберите баллы КТУ для правок", [B_SKIP_NEXT, ...filledKtu(slot).map((item) => item.label)]);
}

module.exports = { showList, select, handle, MSG_NOT_INTEGER };
