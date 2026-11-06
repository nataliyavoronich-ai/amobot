// ============================================================
// БОТ МОНТАЖНИКОВ — T-11 «Пересмотр стоимости»
//   бригадир — запрос в течение 24 часов после принятия отчёта;
//   руководитель — рассмотрение запросов.
//
// ВАЖНО: схема T-11 — по материалам ТЗ (раздел 7). Запросы руководителю
// ищутся по списку запросов в Redis (его пополняет бот при запросе) с
// проверкой значения поля «[Бот] Согласование стоимости(new)» в сделке.
// ============================================================

const amo = require("./amo");
const calc = require("./calc");
const files = require("./files");
const messenger = require("./messenger");
const settingsStore = require("./settings");
const deals = require("./deals");
const { BTN, MSG_NOT_NUMBER, MSG_NOT_INTEGER, say, filledKtu, tariffs } = require("./ui");
const {
  COST_APPROVAL_REQUESTED,
  COST_APPROVAL_NOT_NEEDED,
  SALES_PIPELINE_IDS
} = require("./constants");

const { mdSafe } = messenger;

const INDEX_KEY = "montage_cost_requests";

// ============================================================
// Бригадир
// ============================================================

async function showForemanList(env, state) {
  const { ctx } = env;
  const found = await deals.findCostRevisionDeals(ctx, state.foremanName);

  if (found.length === 0) {
    await say(env, "Сделки не найдены.");
    return;
  }

  const leads = deals.sortByTerms(ctx, found).map((item) => item.lead);
  const lines = [];

  for (let i = 0; i < leads.length; i++) {
    lines.push(`${i + 1}) ${await deals.dealLine(ctx, leads[i], "accept")}`);
  }

  const { map, buttons } = deals.buildDealButtons(ctx, leads);

  state.list = { kind: "cost", map };
  await say(
    env,
    "Пересмотр стоимости работ доступен в течение 24 часов, по истечении срока стоимость считается принятой.\n\n" +
      `Пересмотр доступен в сделках:\n${lines.join("\n")}`,
    buttons,
    true
  );
}

async function selectForForeman(env, state, leadId) {
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

  const slot = amo.readSlot(ctx, lead, slotIndex);
  const settings = settingsStore.get();
  const rates = tariffs(slot, settingsStore.findMotivation(settings, settingsStore.findRowByForemanName(settings, state.foremanName)));

  state.flow = { name: "cost", leadId, slotIndex, step: "info", data: { done: {}, files: [] } };
  await say(
    env,
    `Ваш отчёт по договору № ${mdSafe(amo.contractNumber(ctx, lead))} принят руководителем.\n\n` +
      `Стоимость работ: ${calc.fmt(slot.price)}\n\n` +
      `Баллы КТУ: ${calc.fmt(amo.ktuTotal(slot))}\n\n` +
      `${calc.fmt(slot.kmFact)} км * ${calc.fmt(rates.transport)} тариф = ${calc.fmt(slot.kmFactTotal)}\n\n` +
      `${calc.fmt(slot.kmDelivery)} км * ${calc.fmt(rates.delivery)} = ${calc.fmt(slot.kmDeliveryTotal)}`,
    ["Запросить пересмотр"],
    true
  );
}

async function handleForeman(env, state, input) {
  const { ctx } = env;
  const flow = state.flow;
  const d = flow.data;
  const text = input.text;

  if (flow.step === "info") {
    if (text === "Запросить пересмотр") {
      flow.step = "request";
      await say(env, "Введите желаемую стоимость работы и обоснование для пересмотра.\n\nСтоимость:");
    } else {
      await say(env, "Нажмите «Запросить пересмотр».", ["Запросить пересмотр"]);
    }

    return true;
  }

  if (flow.step === "request") {
    if (!text) {
      await say(env, "Введите желаемую стоимость работы и обоснование для пересмотра.\n\nСтоимость:");
      return true;
    }

    d.request = text;
    flow.step = "files";
    await say(env, "Дополните запрос файлами или воспользуйтесь кнопкой ниже для перехода на следующий шаг.", [BTN.CONTINUE]);
    return true;
  }

  if (flow.step === "files") {
    if (input.attachments.length > 0) {
      await say(env, "Файлы получены, загружаю на Яндекс Диск");

      let uploaded = 0;

      for (const attachment of input.attachments) {
        try {
          d.files.push(await files.uploadFile(ctx, flow.leadId, "Обоснование пересмотра", attachment));
          uploaded += 1;
        } catch (error) {
          console.error("[Бот монтажников] Ошибка загрузки файла обоснования:", error.message);
          await say(env, `❌ Не удалось загрузить файл на Яндекс.Диск (${error.message.slice(0, 120)}). Отправьте его ещё раз.`);
        }
      }

      if (uploaded > 0) {
        await say(env, "Дополните запрос файлами или воспользуйтесь кнопкой ниже для перехода на следующий шаг.", [BTN.CONTINUE]);
      }

      return true;
    }

    if (text !== BTN.CONTINUE) {
      await say(env, "Прикрепите файлы или нажмите «Продолжить»", [BTN.CONTINUE]);
      return true;
    }

    await finishForeman(env, state);
    return true;
  }

  return false;
}

async function finishForeman(env, state) {
  const { ctx } = env;
  const flow = state.flow;
  const d = flow.data;
  const lead = (await amo.getLeadsByIds(ctx, [flow.leadId]))[0];
  const slot = amo.readSlot(ctx, lead, flow.slotIndex);
  const settings = settingsStore.get();
  const row = settingsStore.findRowByForemanName(settings, state.foremanName);
  const rates = tariffs(slot, settingsStore.findMotivation(settings, row));

  if (!d.done.fields) {
    d.links = await files.publicLinks(ctx, d.files);

    const field = await amo.getCostApprovalField(ctx);
    const noteParts = [d.request + (d.links.length ? `\nФайлы: ${d.links.join(", ")}` : "")];

    await amo.patchLead(ctx, lead.id, {
      custom_fields_values: [
        ...amo.slotFieldsPayload(flow.slotIndex, { note: noteParts.join("\n") }),
        amo.costApprovalPayload(field, true, COST_APPROVAL_REQUESTED, COST_APPROVAL_NOT_NEEDED)
      ]
    });
    await ctx.redisRequest(["SADD", INDEX_KEY, String(lead.id)]);
    d.done.fields = true;
  }

  if (!d.done.notify) {
    await messenger.notify(
      ctx,
      row ? [row.managerHandle] : [],
      `Монтажник ${mdSafe(state.foremanName)} просит пересмотреть стоимость работ.\n\n` +
        `${deals.contractLabel(ctx, lead)}\n\n` +
        `${deals.folderLink(ctx, lead)}\n\n` +
        `Стоимость работ: ${calc.fmt(slot.price)}\n\n` +
        `Баллы КТУ: ${calc.fmt(amo.ktuTotal(slot))}\n\n` +
        `${calc.fmt(slot.kmFact)} км * ${calc.fmt(rates.transport)} тариф = ${calc.fmt(slot.kmFactTotal)}\n\n` +
        `${calc.fmt(slot.kmDelivery)} км * ${calc.fmt(rates.delivery)} = ${calc.fmt(slot.kmDeliveryTotal)}\n\n` +
        `Обоснование для пересмотра: ${mdSafe(d.request)}`,
      { markdown: true }
    );
    d.done.notify = true;
  }

  state.flow = null;
  await say(env, "Ваш запрос принят");
}

// ============================================================
// Руководитель
// ============================================================

async function showManagerList(env, state) {
  const { ctx } = env;
  const field = await amo.getCostApprovalField(ctx);
  const members = ((await ctx.redisRequest(["SMEMBERS", INDEX_KEY])).result) || [];
  const leads = members.length ? await amo.getLeadsByIds(ctx, members) : [];
  const names = state.managerRows.map((row) => row.foremanName);
  const mine = [];

  for (const id of members) {
    const lead = leads.find((item) => String(item.id) === String(id));

    // Запрос уже обработан (или сделка пропала) — убираем из списка.
    if (!lead || !amo.isCostApprovalRequested(ctx, lead, field, COST_APPROVAL_REQUESTED)) {
      await ctx.redisRequest(["SREM", INDEX_KEY, String(id)]);
      continue;
    }

    if (SALES_PIPELINE_IDS.includes(Number(lead.pipeline_id)) && names.some((name) => deals.belongsToForeman(ctx, lead, name))) {
      mine.push(lead);
    }
  }

  if (mine.length === 0) {
    await say(env, "Запросов на пересмотр стоимости нет.");
    return;
  }

  const lines = [];

  for (let i = 0; i < mine.length; i++) {
    lines.push(`${i + 1}) ${await deals.dealLine(ctx, mine[i], "accept")}`);
  }

  const { map, buttons } = deals.buildDealButtons(ctx, mine);

  state.list = { kind: "costMgr", map };
  await say(env, `Требуется пересмотр стоимости работ в сделках:\n${lines.join("\n")}`, buttons, true);
}

async function selectForManager(env, state, leadId) {
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

  state.flow = { name: "costMgr", leadId, foremanName, slotIndex, step: "card", edited: false, data: { done: {} } };
  await showManagerCard(env, state, lead);
}

async function loadLead(env, flow) {
  const lead = (await amo.getLeadsByIds(env.ctx, [flow.leadId]))[0];

  if (!lead) {
    throw new Error(`Сделка ${flow.leadId} не найдена`);
  }

  return lead;
}

const M_PRICE = "Изменить стоимость работ";
const M_KM = "Изменить километры";
const M_TARIFF = "Изменить тариф";
const M_KTU = "Изменить баллы КТУ";
const M_REJECT = "Отклонить";
const M_FINISH = "Завершить правки";
const B_TRANSPORT = "Транспортный";
const B_DELIVERY = "Доставка";
const B_SKIP = "Пропустить";
const B_NEXT = "Далее";

// «КТУ видео общее», «КТУ отзывы» — названия кнопок без технических обозначений.
function ktuButton(label) {
  return `КТУ ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}

async function showKtuPick(env, flow, items) {
  flow.step = "ktu_pick";
  await say(env, "Укажите новое значение баллов КТУ.", [
    flow.data.ktuTouched ? B_NEXT : B_SKIP,
    ...items.map((item) => ktuButton(item.label))
  ]);
}

async function showManagerCard(env, state, lead) {
  const { ctx } = env;
  const flow = state.flow;
  const slot = amo.readSlot(ctx, lead, flow.slotIndex);
  const settings = settingsStore.get();
  const row = settingsStore.findRowByForemanName(settings, flow.foremanName);
  const rates = tariffs(slot, settingsStore.findMotivation(settings, row));

  flow.step = "card";
  await say(
    env,
    `Монтажник ${mdSafe(flow.foremanName)} просит пересмотреть стоимость работ.\n\n` +
      `${deals.contractLabel(ctx, lead)}\n\n` +
      `${deals.folderLink(ctx, lead)}\n\n` +
      `Стоимость работ: ${calc.fmt(slot.price)}\n\n` +
      `Баллы КТУ: ${calc.fmt(amo.ktuTotal(slot))}\n\n` +
      `${calc.fmt(slot.kmFact)} км * ${calc.fmt(rates.transport)} тариф = ${calc.fmt(slot.kmFactTotal)}\n\n` +
      `${calc.fmt(slot.kmDelivery)} км * ${calc.fmt(rates.delivery)} = ${calc.fmt(slot.kmDeliveryTotal)}\n\n` +
      `Обоснование для пересмотра: ${mdSafe(slot.note || "—")}`,
    [M_PRICE, M_KM, M_KTU, M_TARIFF, flow.edited ? M_FINISH : M_REJECT],
    true
  );
}

async function setApproval(env, lead, wanted) {
  const field = await amo.getCostApprovalField(env.ctx);

  await amo.patchLead(env.ctx, lead.id, {
    custom_fields_values: [amo.costApprovalPayload(field, wanted, COST_APPROVAL_REQUESTED, COST_APPROVAL_NOT_NEEDED)]
  });
  await env.ctx.redisRequest(["SREM", INDEX_KEY, String(lead.id)]);
}

async function handleManager(env, state, input) {
  const { ctx } = env;
  const flow = state.flow;
  const text = input.text;
  const lead = await loadLead(env, flow);
  const settings = settingsStore.get();
  const row = settingsStore.findRowByForemanName(settings, flow.foremanName);
  const foremanNames = row ? [row.foremanHandle, row.foremanName] : [flow.foremanName];
  const number = mdSafe(amo.contractNumber(ctx, lead));

  if (flow.step === "card") {
    if (text === M_PRICE) {
      flow.step = "price_value";
      await say(env, "Введите новую стоимость работ.");
    } else if (text === M_KM) {
      flow.step = "km_kind";
      flow.data.after = "km";
      await say(env, "Какой километраж вы хотите изменить?", [B_TRANSPORT, B_DELIVERY]);
    } else if (text === M_TARIFF) {
      flow.step = "km_kind";
      flow.data.after = "tariff";
      await say(env, "Какой тариф вы хотите изменить?", [B_TRANSPORT, B_DELIVERY]);
    } else if (text === M_KTU) {
      const items = filledKtu(amo.readSlot(ctx, lead, flow.slotIndex));

      if (items.length === 0) {
        await say(env, "Баллы КТУ в сделке не начислены.");
        await showManagerCard(env, state, lead);
      } else {
        flow.step = "ktu_pick";
        await showKtuPick(env, flow, items);
      }
    } else if (text === M_REJECT && !flow.edited) {
      await setApproval(env, lead, false);
      await messenger.notify(ctx, foremanNames, `Руководитель отклонил пересмотр стоимости.\n\nДоговор № ${number}.`);
      state.flow = null;
      await say(env, "Пересмотр стоимости отклонён.");
      await showManagerList(env, state);
    } else if (text === M_FINISH && flow.edited) {
      await setApproval(env, lead, false);

      const slot = amo.readSlot(ctx, lead, flow.slotIndex);
      const rates = tariffs(slot, settingsStore.findMotivation(settings, row));

      await messenger.notify(
        ctx,
        foremanNames,
        [
          `Стоимость по договору № ${number} пересмотрена.`,
          "",
          "Финальные значения:",
          `- Стоимость работ: ${calc.fmt(slot.price)}`,
          `- Баллы КТУ: ${calc.fmt(amo.ktuTotal(slot))}`,
          `- ${calc.fmt(slot.kmFact)} км * ${calc.fmt(rates.transport)} тариф = ${calc.fmt(slot.kmFactTotal)}`,
          `${calc.fmt(slot.kmDelivery)} км * ${calc.fmt(rates.delivery)} = ${calc.fmt(slot.kmDeliveryTotal)}`,
          "#уведомление"
        ].join("\n")
      );
      state.flow = null;
      await say(env, "Правки сохранены, монтажник уведомлён.");
      await showManagerList(env, state);
    } else {
      await showManagerCard(env, state, lead);
    }

    return true;
  }

  if (flow.step === "price_value") {
    const value = calc.parseNumber(text);

    if (value === null) {
      await say(env, MSG_NOT_NUMBER);
      return true;
    }

    await amo.patchLead(ctx, lead.id, { custom_fields_values: amo.slotFieldsPayload(flow.slotIndex, { price: value }) });
    flow.edited = true;
    await say(env, `Стоимость работы изменена.\n\nНовая стоимость работ: ${calc.fmt(value)}.`);
    await showManagerCard(env, state, await loadLead(env, flow));
    return true;
  }

  if (flow.step === "km_kind") {
    if (text !== B_TRANSPORT && text !== B_DELIVERY) {
      await say(env, flow.data.after === "km" ? "Какой километраж вы хотите изменить?" : "Какой тариф вы хотите изменить?", [B_TRANSPORT, B_DELIVERY]);
      return true;
    }

    flow.data.kind = text === B_TRANSPORT ? "transport" : "delivery";
    flow.step = "km_value";
    await say(env, flow.data.after === "km" ? "Введите новое значение км" : "Введите новое значение тарифа");
    return true;
  }

  if (flow.step === "km_value") {
    const value = calc.parseNumber(text);

    if (value === null) {
      await say(env, MSG_NOT_NUMBER);
      return true;
    }

    const slot = amo.readSlot(ctx, lead, flow.slotIndex);
    const rates = tariffs(slot, settingsStore.findMotivation(settings, row));
    const transport = flow.data.kind === "transport";
    let values;

    if (flow.data.after === "km") {
      values = transport
        ? { kmFact: value, tariff: rates.transport, kmFactTotal: calc.round2(rates.transport * value) }
        : { kmDelivery: value, tariffDelivery: rates.delivery, kmDeliveryTotal: calc.round2(rates.delivery * value) };
    } else {
      values = transport
        ? { tariff: value, kmFactTotal: calc.round2(value * slot.kmFact) }
        : { tariffDelivery: value, kmDeliveryTotal: calc.round2(value * slot.kmDelivery) };
    }

    await amo.patchLead(ctx, lead.id, { custom_fields_values: amo.slotFieldsPayload(flow.slotIndex, values) });
    flow.edited = true;
    await say(env, "Правки внесены");
    await showManagerCard(env, state, await loadLead(env, flow));
    return true;
  }

  if (flow.step === "ktu_pick") {
    const items = filledKtu(amo.readSlot(ctx, lead, flow.slotIndex));
    const chosen = items.find((item) => ktuButton(item.label) === text);

    if (chosen) {
      flow.data.ktuKey = chosen.slotKey;
      flow.step = "ktu_value";
      await say(env, "Введите новое значение баллов КТУ.");
    } else if (text === B_SKIP || text === B_NEXT) {
      await showManagerCard(env, state, lead);
    } else {
      await showKtuPick(env, flow, items);
    }

    return true;
  }

  if (flow.step === "ktu_value") {
    const value = calc.parseInteger(text);

    if (value === null) {
      await say(env, MSG_NOT_INTEGER);
      return true;
    }

    await amo.patchLead(ctx, lead.id, {
      custom_fields_values: amo.slotFieldsPayload(flow.slotIndex, { [flow.data.ktuKey]: value })
    });
    flow.edited = true;
    flow.data.ktuTouched = true;
    await say(env, "Правки внесены");
    await showKtuPick(env, flow, filledKtu(amo.readSlot(ctx, await loadLead(env, flow), flow.slotIndex)));
    return true;
  }

  return false;
}

module.exports = { showForemanList, selectForForeman, handleForeman, showManagerList, selectForManager, handleManager };
