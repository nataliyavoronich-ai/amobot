// ============================================================
// БОТ МОНТАЖНИКОВ — T-4 «Подтвердить монтаж»
// Запускается кнопкой «Подтвердить монтаж» и автоматически в 9:00 и 16:00
// (МСК) — только тем, кто уже писал боту.
// ============================================================

const amo = require("./amo");
const files = require("./files");
const messenger = require("./messenger");
const deals = require("./deals");
const { BTN, say } = require("./ui");
const { FIELD, PIPELINE, RESULT, TASK_TYPE } = require("./constants");

const { mdSafe } = messenger;

const BUTTON_CONFIRMED = "Выезд подтвержден";
const BUTTON_MOVED = "Выезд перенесен";
const BUTTON_DEFECT = "Дефект изделия";

// T-4.1–4.3: найти задачи и показать список. fromButton=false — молча выйти,
// если ничего нет (запуск по расписанию).
async function showList(env, state, { fromButton }) {
  const { ctx } = env;
  const found = await deals.findConfirmDeals(ctx, state.foremanName);

  if (found.length === 0) {
    if (fromButton) {
      await say(env, "Задач по подтверждению монтажей не найдено");
    }

    return false;
  }

  const leads = deals.sortByTerms(ctx, found).map((item) => item.lead);
  const lines = [];

  for (let i = 0; i < leads.length; i++) {
    lines.push(`${i + 1}) ${await deals.dealLine(ctx, leads[i], "confirm")}`);
  }

  const { map, buttons } = deals.buildDealButtons(ctx, leads);

  state.list = { kind: "confirm", map };
  await say(env, `Подтвердите выезд:\n${lines.join("\n")}`, buttons, true);

  return true;
}

async function select(env, state, leadId) {
  const { ctx } = env;
  const lead = (await amo.getLeadsByIds(ctx, [leadId]))[0];

  if (!lead) {
    await say(env, "Сделка не найдена.");
    return;
  }

  const contact = await amo.getContactInfo(ctx, lead);

  state.flow = { name: "confirm", leadId, step: "choose", data: { done: {}, files: [] } };

  await say(
    env,
    "Подтвердите выезд:\n" +
      `- ${mdSafe(amo.fieldText(ctx, lead, FIELD.ADDRESS) || "—")}\n` +
      `- ${deals.contractLabel(ctx, lead)}\n` +
      `- ${mdSafe(deals.productText(ctx, lead))}\n` +
      `- Кол-во этажей: ${mdSafe(deals.floorsText(ctx, lead))}\n` +
      `- ${mdSafe(contact.name)},\n` +
      `- ${mdSafe(contact.phones.join(", "))}\n` +
      "❗️ Уточнить у Заказчика:\n" +
      "- о возможности подключения для монтажа оборудования к энергосети;\n" +
      "- температуру помещения, где предстоит монтаж;\n" +
      "- доступность для подъезда на автомобиле к разгрузочной площадке;\n" +
      "- свободное пространство для перемещения изделий от места разгрузки к месту монтажа;\n" +
      "- вид отделки помещения, где будет производиться монтаж;\n" +
      "- необходимость в оформлении пропуска.",
    [BUTTON_CONFIRMED, BUTTON_MOVED, BUTTON_DEFECT],
    true
  );
}

// В сделке может быть несколько открытых задач «Подт-ть монтаж» (старые
// просроченные и сегодняшняя) — закрываем ту, срок которой «сегодня».
async function findTask(ctx, leadId) {
  const tasks = await amo.getTasksForLeads(ctx, [leadId], TASK_TYPE.CONFIRM_MONTAGE, false);
  const start = ctx.todayMoscowStartUnix();
  const today = tasks.find((task) => Number(task.complete_till) >= start && Number(task.complete_till) < start + 86400);

  return today || tasks[0] || null;
}

async function closeAndContinue(env, state, flow, result) {
  const { ctx } = env;
  const task = await findTask(ctx, flow.leadId);

  if (task) {
    await amo.closeTask(ctx, task.id, result);
  }

  state.flow = null;
  await say(env, `Задача amoCRM "Подтвердить выезд" закрыта с результатом "${result}"${result === RESULT.CONFIRMED ? "." : ""}`);
  await showList(env, state, { fromButton: true });
}

async function handle(env, state, input) {
  const { ctx } = env;
  const flow = state.flow;
  const text = input.text;

  if (flow.step === "choose") {
    if (text === BUTTON_CONFIRMED) {
      await closeAndContinue(env, state, flow, RESULT.CONFIRMED);
    } else if (text === BUTTON_MOVED) {
      flow.step = "moved_comment";
      await say(env, "Укажите комментарий");
    } else if (text === BUTTON_DEFECT) {
      flow.step = "defect_comment";
      await say(env, "Укажите комментарий");
    } else {
      await say(env, "Выберите действие кнопкой.", [BUTTON_CONFIRMED, BUTTON_MOVED, BUTTON_DEFECT]);
    }

    return true;
  }

  if (flow.step === "moved_comment") {
    if (!text) {
      await say(env, "Укажите комментарий");
      return true;
    }

    if (!flow.data.done.note) {
      await amo.addNote(ctx, flow.leadId, text);
      flow.data.done.note = true;
    }

    await closeAndContinue(env, state, flow, RESULT.TRIP_MOVED);
    return true;
  }

  if (flow.step === "defect_comment") {
    if (!text) {
      await say(env, "Укажите комментарий");
      return true;
    }

    flow.data.comment = text;

    // T-4.6.3.1: очищаем [Бот] Ссылка на фото перед загрузкой файлов дефекта.
    await amo.patchLead(ctx, flow.leadId, { custom_fields_values: [amo.clearField(FIELD.PHOTO_LINK)] });

    flow.step = "defect_upload";
    await say(env, "Прикрепите фото дефекта");
    return true;
  }

  if (flow.step === "defect_upload") {
    if (input.attachments.length > 0) {
      const fitting = input.attachments.filter((item) => files.attachmentFits(item, "image"));

      if (fitting.length === 0) {
        await say(env, "Нужно прислать фото дефекта.");
        return true;
      }

      await say(env, "Файлы получены, загружаю на Яндекс Диск");

      let uploaded = 0;

      for (const attachment of fitting) {
        try {
          flow.data.files.push(await files.uploadFile(ctx, flow.leadId, "Дефект изделия", attachment));
          uploaded += 1;
        } catch (error) {
          console.error("[Бот монтажников] Ошибка загрузки файла дефекта:", error.message);
          await say(env, `❌ Не удалось загрузить файл на Яндекс.Диск (${error.message.slice(0, 120)}). Отправьте его ещё раз.`);
        }
      }

      if (uploaded > 0) {
        await say(env, "Файл сохранен на Яндекс.Диске.\nДополните или завершите загрузку.", [BTN.FINISH_UPLOAD]);
      }

      return true;
    }

    if (text !== BTN.FINISH_UPLOAD) {
      await say(env, "Прикрепите фото дефекта или нажмите «Завершить загрузку».", flow.data.files.length ? [BTN.FINISH_UPLOAD] : undefined);
      return true;
    }

    if (flow.data.files.length === 0) {
      await say(env, "Вы ещё не прикрепили ни одного файла.");
      return true;
    }

    await say(env, "Ваши замечания приняты.");

    if (!flow.data.done.links) {
      flow.data.links = await files.publicLinks(ctx, flow.data.files);
      await amo.patchLead(ctx, flow.leadId, {
        custom_fields_values: [amo.setValue(FIELD.PHOTO_LINK, flow.data.links.join(", "))]
      });
      flow.data.done.links = true;
    }

    if (!flow.data.done.note) {
      await amo.addNote(ctx, flow.leadId, `${flow.data.comment}\nФото дефекта: ${flow.data.links.join(", ")}`);
      flow.data.done.note = true;
    }

    await closeAndContinue(env, state, flow, RESULT.DEFECT);
    return true;
  }

  return false;
}

module.exports = { showList, select, handle };
