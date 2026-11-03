// ============================================================
// БОТ МОНТАЖНИКОВ — T-9 «Внести правки» (бригадир)
//
// ВАЖНО: схема переходов T-9 в ТЗ дана ссылкой на BPMN; здесь реализованы
// варианты правок из раздела 6.3 материалов ТЗ: пробег (транспортный /
// доставка), доп. работы, баллы КТУ, комментарий, общее фото; затем
// «Завершить правки» (закрывает «Правки в отчет» результатом «Правки внесены»).
// ============================================================

const amo = require("./amo");
const calc = require("./calc");
const files = require("./files");
const messenger = require("./messenger");
const settingsStore = require("./settings");
const deals = require("./deals");
const { BTN, MSG_NOT_NUMBER, say, recalculatePrice, tariffs } = require("./ui");
const { FIELD, RESULT, TASK_TYPE } = require("./constants");

const { mdSafe } = messenger;

const B_MILEAGE = "Пробег";
const B_EXTRA = "Дополнительные работы";
const B_KTU = "Баллы КТУ";
const B_COMMENT = "Добавить комментарий";
const B_PHOTO = "Загрузить общее фото";
const B_FINISH = "Завершить правки";
const B_TRANSPORT = "Транспортный";
const B_DELIVERY = "Доставка";

const MENU = [B_MILEAGE, B_EXTRA, B_KTU, B_COMMENT, B_PHOTO, B_FINISH];

// Что можно исправить в баллах КТУ: видео — с загрузкой файла, отзыв — «Да/Нет».
const KTU_OPTIONS = [
  { label: "Видео общее", slotKey: "ktuVideo", upload: "Видео общее" },
  { label: "Видео таймлапс", slotKey: "ktuTimelapse", upload: "Видео таймлапс" },
  { label: "Видео-отзыв клиента", slotKey: "ktuReviewVideo", upload: "Видео-отзыв клиента" },
  { label: "Отзыв в отзовике или Яндексе", slotKey: "ktuReviewSite", upload: null }
];

async function showList(env, state) {
  const { ctx } = env;
  const found = await deals.findFixesDeals(ctx, state.foremanName);

  if (found.length === 0) {
    await say(env, "Задачи по внесению правок не найдены");
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

  state.flow = { name: "fixes", leadId, taskId: task.id, slotIndex, step: "menu", data: { done: {}, files: [] } };

  await say(
    env,
    `${deals.contractLabel(ctx, lead)}\nКомментарий руководителя: ${mdSafe(amo.fieldText(ctx, lead, FIELD.MASTER_COMMENT) || "—")}\nЧто нужно исправить?`,
    MENU,
    true
  );
}

async function showMenu(env, state, text = "Что ещё нужно исправить?") {
  state.flow.step = "menu";
  await say(env, text, MENU);
}

async function loadLead(env, flow) {
  const lead = (await amo.getLeadsByIds(env.ctx, [flow.leadId]))[0];

  if (!lead) {
    throw new Error(`Сделка ${flow.leadId} не найдена`);
  }

  return lead;
}

async function recalcAndWritePrice(env, flow) {
  const lead = await loadLead(env, flow);
  const { calculated } = recalculatePrice(env.ctx, lead, flow.slotIndex, flow.foremanName || env.state.foremanName);

  if (calculated) {
    await amo.patchLead(env.ctx, lead.id, {
      custom_fields_values: amo.slotFieldsPayload(flow.slotIndex, { price: calculated.price })
    });
    return calculated.price;
  }

  return null;
}

async function handle(env, state, input) {
  const { ctx } = env;
  const flow = state.flow;
  const text = input.text;

  env.state = state;
  flow.foremanName = state.foremanName;

  if (flow.step === "menu") {
    if (text === B_MILEAGE) {
      flow.step = "mileage_kind";
      await say(env, "Что изменить?", [B_TRANSPORT, B_DELIVERY]);
    } else if (text === B_EXTRA) {
      flow.step = "extra_hours";
      await say(env, "Введите количество часов дополнительных работ.");
    } else if (text === B_KTU) {
      flow.step = "ktu_kind";
      await say(env, "Для каких баллов КТУ внести правки?", KTU_OPTIONS.map((item) => item.label));
    } else if (text === B_COMMENT) {
      flow.step = "comment";
      await say(env, "Введите комментарий");
    } else if (text === B_PHOTO) {
      flow.step = "photo";
      flow.data.files = [];
      await say(env, "Прикрепите общее фото.");
    } else if (text === B_FINISH) {
      await finish(env, state);
    } else {
      await showMenu(env, state, "Выберите действие кнопкой.");
    }

    return true;
  }

  if (flow.step === "mileage_kind") {
    if (text !== B_TRANSPORT && text !== B_DELIVERY) {
      await say(env, "Что изменить?", [B_TRANSPORT, B_DELIVERY]);
      return true;
    }

    flow.data.mileageKind = text === B_TRANSPORT ? "kmFact" : "kmDelivery";
    flow.step = "mileage_value";
    await say(env, text === B_TRANSPORT ? "Введите новое значение kм факт" : "Введите новое значение км доставки");
    return true;
  }

  if (flow.step === "mileage_value") {
    const value = calc.parseNumber(text);

    if (value === null) {
      await say(env, MSG_NOT_NUMBER);
      return true;
    }

    const lead = await loadLead(env, flow);
    const slot = amo.readSlot(ctx, lead, flow.slotIndex);
    const settings = settingsStore.get();
    const motivation = settingsStore.findMotivation(settings, settingsStore.findRowByForemanName(settings, state.foremanName));
    const rates = tariffs(slot, motivation);
    const values =
      flow.data.mileageKind === "kmFact"
        ? { kmFact: value, tariff: rates.transport, kmFactTotal: calc.round2(rates.transport * value) }
        : { kmDelivery: value, tariffDelivery: rates.delivery, kmDeliveryTotal: calc.round2(rates.delivery * value) };

    await amo.patchLead(ctx, lead.id, { custom_fields_values: amo.slotFieldsPayload(flow.slotIndex, values) });
    await showMenu(env, state, "Правки сохранены. Что ещё нужно исправить?");
    return true;
  }

  if (flow.step === "extra_hours") {
    const value = calc.parseNumber(text);

    if (value === null) {
      await say(env, MSG_NOT_NUMBER);
      return true;
    }

    const lead = await loadLead(env, flow);

    await amo.patchLead(ctx, lead.id, {
      custom_fields_values: amo.slotFieldsPayload(flow.slotIndex, { extraHours: value })
    });

    const price = await recalcAndWritePrice(env, flow);

    await showMenu(
      env,
      state,
      price === null
        ? "Правки сохранены (стоимость не пересчитана: продукт не найден в таблице расчёта). Что ещё нужно исправить?"
        : `Правки сохранены. Стоимость работ пересчитана: ${calc.fmt(price)}. Что ещё нужно исправить?`
    );
    return true;
  }

  if (flow.step === "ktu_kind") {
    const option = KTU_OPTIONS.find((item) => item.label === text);

    if (!option) {
      await say(env, "Для каких баллов КТУ внести правки?", KTU_OPTIONS.map((item) => item.label));
      return true;
    }

    flow.data.ktu = option;
    flow.data.files = [];

    if (option.upload) {
      flow.step = "ktu_upload";
      await say(env, `Прикрепите видео: «${option.upload}».`);
    } else {
      flow.step = "ktu_review";
      await say(env, "Клиент оставил отзыв в отзовике или на Яндексе?", [BTN.YES, BTN.NO]);
    }

    return true;
  }

  if (flow.step === "ktu_upload" || flow.step === "photo") {
    const isKtu = flow.step === "ktu_upload";
    const category = isKtu ? flow.data.ktu.upload : "Фото общее";
    const kind = isKtu ? "video" : "image";

    if (input.attachments.length > 0) {
      const fitting = input.attachments.filter((item) => files.attachmentFits(item, kind));

      if (fitting.length === 0) {
        await say(env, kind === "video" ? "Нужно прислать видео." : "Нужно прислать фото.");
        return true;
      }

      await say(env, "Файлы получены, загружаю на Яндекс Диск");

      let uploaded = 0;

      for (const attachment of fitting) {
        try {
          flow.data.files.push(await files.uploadFile(ctx, flow.leadId, category, attachment));
          uploaded += 1;
        } catch (error) {
          console.error("[Бот монтажников] Ошибка загрузки файла (правки):", error.message);
          await say(env, `❌ Не удалось загрузить файл на Яндекс.Диск (${error.message.slice(0, 120)}). Отправьте его ещё раз.`);
        }
      }

      if (uploaded > 0) {
        await say(env, "Файл сохранен на Яндекс.Диске.\nДополните или завершите загрузку.", [BTN.FINISH_UPLOAD]);
      }

      return true;
    }

    if (text !== BTN.FINISH_UPLOAD || flow.data.files.length === 0) {
      await say(env, "Прикрепите файл и нажмите «Завершить загрузку».", flow.data.files.length ? [BTN.FINISH_UPLOAD] : undefined);
      return true;
    }

    if (isKtu) {
      await amo.patchLead(ctx, flow.leadId, {
        custom_fields_values: amo.slotFieldsPayload(flow.slotIndex, {
          [flow.data.ktu.slotKey]: settingsStore.ktuPoints(settingsStore.get(), flow.data.ktu.label)
        })
      });
    }

    flow.data.files = [];
    await showMenu(env, state, "Файлы сохранены. Что ещё нужно исправить?");
    return true;
  }

  if (flow.step === "ktu_review") {
    if (text !== BTN.YES && text !== BTN.NO) {
      await say(env, "Клиент оставил отзыв в отзовике или на Яндексе?", [BTN.YES, BTN.NO]);
      return true;
    }

    await amo.patchLead(ctx, flow.leadId, {
      custom_fields_values: amo.slotFieldsPayload(flow.slotIndex, {
        ktuReviewSite: text === BTN.YES ? settingsStore.ktuPoints(settingsStore.get(), flow.data.ktu.label) : 0
      })
    });
    await showMenu(env, state, "Правки сохранены. Что ещё нужно исправить?");
    return true;
  }

  if (flow.step === "comment") {
    if (!text) {
      await say(env, "Введите комментарий");
      return true;
    }

    await amo.patchLead(ctx, flow.leadId, {
      custom_fields_values: amo.slotFieldsPayload(flow.slotIndex, { note: text })
    });
    await showMenu(env, state, "Комментарий сохранён. Что ещё нужно исправить?");
    return true;
  }

  return false;
}

async function finish(env, state) {
  const { ctx } = env;
  const flow = state.flow;
  const lead = await loadLead(env, flow);
  const row = settingsStore.findRowByForemanName(settingsStore.get(), state.foremanName);

  if (!flow.data.done.task) {
    await amo.closeTask(ctx, flow.taskId, RESULT.FIXES_DONE);
    flow.data.done.task = true;
  }

  if (!flow.data.done.notify) {
    await messenger.notify(
      ctx,
      row ? [row.managerHandle] : [],
      `Монтажник ${mdSafe(state.foremanName)} внес правки в отчет по договору № ${mdSafe(amo.contractNumber(ctx, lead))}`
    );
    flow.data.done.notify = true;
  }

  state.flow = null;
  await say(env, "Ваши комментарии приняты");
}

module.exports = { showList, select, handle };
