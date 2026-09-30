// ============================================================
// ВИДЖЕТ "ПРОИЗВОДСТВО" — РАСШИРЕННЫЕ НАСТРОЙКИ (amoCRM)
// ============================================================
//
// Классический виджет amoCRM (AMD-модуль, jQuery доступен как зависимость).
// Вся конфигурация ТЗ (роли, связь статусов и полей, сценарии, плановая
// готовность) живёт на одной странице "Расширенные настройки"
// (callbacks.advancedSettings), т.к. локация "advanced_settings" указана
// в manifest.json.
//
// ХРАНЕНИЕ (гибрид, см. план Фазы 1):
// 1) self.set_settings()/self.get_settings() — встроенное хранилище
//    amoCRM, только для нативного UX (подгрузка формы при повторном
//    открытии, работает мгновенно, без сетевого запроса к нашему backend).
// 2) POST/GET на BACKEND_BASE + "/widget/production/settings" (наш
//    Node-сервер, Selectel) — источник истины, который читает бот в
//    рантайме. При открытии настроек сначала пробуем backend (сверить с
//    самым актуальным сохранённым состоянием), при ошибке сети падаем на
//    get_settings() как запасной вариант.
//
// ЖИВЫЕ ДАННЫЕ (воронки/статусы/поля/пользователи) виджет читает сам,
// напрямую из браузера администратора, обычным AJAX-запросом к
// "/api/v4/..." — скрипт выполняется на странице amocrm.ru, поэтому запрос
// идёт с той же сессией/куками, что и сам интерфейс amoCRM, без CORS и без
// отдельного токена.
//
// ВАЖНО ПЕРЕД ЗАГРУЗКОЙ АРХИВА В AMOCRM:
// - BACKEND_BASE ниже — заглушка, замените на реальный публичный домен
//   backend'а на Selectel.
// - WIDGET_SECRET ниже должен буквально совпадать со значением
//   PRODUCTION_WIDGET_SECRET, заданным в переменных окружения backend'а.
// - Колбэки/структура манифеста собраны по документации amoCRM/Kommo для
//   классических виджетов; при первой реальной загрузке архива в amoCRM
//   возможны мелкие несовпадения с фактическим рантаймом — тогда
//   потребуется правка по сообщению об ошибке загрузки/валидации.

define(["jquery"], function ($) {
  return function () {
    var self = this;

    // ------------------------------------------------------------
    // КОНФИГ
    // ------------------------------------------------------------

    var BACKEND_BASE = "https://REPLACE-WITH-REAL-DOMAIN.example"; // TODO: реальный домен backend'а на Selectel
    var WIDGET_SECRET = "REPLACE-WITH-PRODUCTION_WIDGET_SECRET"; // TODO: то же значение, что в env PRODUCTION_WIDGET_SECRET

    var ROLE_DEFS = [
      { key: "productionDirector", label: "Директор производства" },
      { key: "metalShopForeman", label: "Мастер металлического цеха" },
      { key: "woodShopForeman", label: "Мастер столярного цеха" },
      { key: "otk", label: "ОТК" }
    ];

    var BOT_STATUS_OPTIONS = [
      { value: "", label: "— не выбрано —" },
      { value: "execution", label: "Исполнение" },
      { value: "distribution", label: "Распределение" }
    ];

    // ------------------------------------------------------------
    // СОСТОЯНИЕ (в памяти, пока открыт экран настроек)
    // ------------------------------------------------------------

    var liveData = {
      pipelines: [], // [{id, name, statuses: [{id, name, pipeline_id}]}]
      statusesById: {}, // amoStatusId -> {id, name, pipeline_id, pipeline_name}
      fields: [], // [{id, name, type, enums: [{id, value}]}]
      users: [] // [{id, name}]
    };

    var settingsState = null; // текущее состояние формы (объект схемы настроек)
    var $root = null; // корневой контейнер расширенных настроек
    var activeTab = "roles";

    // ------------------------------------------------------------
    // ЗАГРУЗКА ЖИВЫХ ДАННЫХ AMOCRM (напрямую из браузера админа)
    // ------------------------------------------------------------

    function amoApiGet(path, params) {
      return $.ajax({
        url: path,
        method: "GET",
        data: params || {},
        dataType: "json"
      });
    }

    function loadPipelines() {
      return amoApiGet("/api/v4/leads/pipelines").then(function (response) {
        var pipelines = (response && response._embedded && response._embedded.pipelines) || [];

        liveData.pipelines = pipelines.map(function (p) {
          var statuses = (p._embedded && p._embedded.statuses) || [];

          statuses.forEach(function (s) {
            liveData.statusesById[s.id] = {
              id: s.id,
              name: s.name,
              pipeline_id: p.id,
              pipeline_name: p.name
            };
          });

          return {
            id: p.id,
            name: p.name,
            statuses: statuses.map(function (s) {
              return { id: s.id, name: s.name, pipeline_id: p.id };
            })
          };
        });
      });
    }

    // Список статусов обеих воронок одним плоским списком (ТЗ: без
    // отдельного переключателя воронки — см. план Фазы 1).
    function allLiveStatuses() {
      var result = [];

      liveData.pipelines.forEach(function (p) {
        p.statuses.forEach(function (s) {
          result.push({ id: s.id, name: s.name, pipelineName: p.name });
        });
      });

      return result;
    }

    function loadCustomFields() {
      liveData.fields = [];

      function loadPage(page) {
        return amoApiGet("/api/v4/leads/custom_fields", { page: page, limit: 250 }).then(function (
          response
        ) {
          var fields = (response && response._embedded && response._embedded.custom_fields) || [];

          fields.forEach(function (f) {
            liveData.fields.push({
              id: f.id,
              name: f.name,
              type: f.type,
              enums: Array.isArray(f.enums)
                ? f.enums.map(function (e) {
                    return { id: e.id, value: e.value };
                  })
                : []
            });
          });

          var hasNext = response && response._links && response._links.next;

          if (hasNext) {
            return loadPage(page + 1);
          }
        });
      }

      return loadPage(1);
    }

    function loadUsers() {
      liveData.users = [];

      function loadPage(page) {
        return amoApiGet("/api/v4/users", { page: page, limit: 250 }).then(function (response) {
          var users = (response && response._embedded && response._embedded.users) || [];

          users.forEach(function (u) {
            liveData.users.push({ id: u.id, name: u.name });
          });

          var hasNext = response && response._links && response._links.next;

          if (hasNext) {
            return loadPage(page + 1);
          }
        });
      }

      return loadPage(1);
    }

    function loadAllLiveData() {
      return $.when(loadPipelines(), loadCustomFields(), loadUsers());
    }

    // ------------------------------------------------------------
    // ЗАГРУЗКА/СОХРАНЕНИЕ НАСТРОЕК (гибрид)
    // ------------------------------------------------------------

    function emptySettings() {
      return {
        schemaVersion: 1,
        roles: {},
        statusFieldMap: [],
        readinessMatrix: { productFieldId: null, cells: {} },
        scenarios: {}
      };
    }

    function backendRequest(method, body) {
      return $.ajax({
        url: BACKEND_BASE + "/widget/production/settings",
        method: method,
        headers: { "X-Widget-Secret": WIDGET_SECRET },
        contentType: "application/json",
        data: body ? JSON.stringify(body) : undefined,
        dataType: "json"
      });
    }

    function loadSettings() {
      return backendRequest("GET")
        .then(function (data) {
          return data || self.get_settings() || emptySettings();
        })
        .catch(function () {
          console.warn(
            "[Виджет Производство] Не удалось получить настройки с backend — " +
              "использую встроенное хранилище amoCRM как запасной вариант."
          );

          return self.get_settings() || emptySettings();
        });
    }

    // Клиентская валидация — быстрая обратная связь до отправки на backend.
    // Финальная проверка всё равно выполняется на backend
    // (productionBot.js: validateProductionWidgetSettings) — именно её
    // результат блокирует реальное сохранение.
    function validateClientSide(settings) {
      var activeUserIds = {};

      for (var i = 0; i < ROLE_DEFS.length; i++) {
        var entries = settings.roles[ROLE_DEFS[i].key] || [];

        for (var j = 0; j < entries.length; j++) {
          if (entries[j].active) {
            if (activeUserIds[entries[j].userId]) {
              return "Один пользователь не может одновременно состоять в двух активных ролях.";
            }

            activeUserIds[entries[j].userId] = true;
          }
        }
      }

      for (var k = 0; k < settings.statusFieldMap.length; k++) {
        var row = settings.statusFieldMap[k];

        if (!row.botStatus) {
          return "Не для всех статусов указан статус бота (Исполнение/Распределение).";
        }
      }

      var cells = (settings.readinessMatrix && settings.readinessMatrix.cells) || {};

      for (var cellKey in cells) {
        if (Object.prototype.hasOwnProperty.call(cells, cellKey)) {
          var value = cells[cellKey];

          if (typeof value !== "number" || isNaN(value) || value < 0) {
            return "Плановая готовность содержит некорректное значение (должно быть 0 или больше).";
          }
        }
      }

      return null;
    }

    function saveSettings() {
      var error = validateClientSide(settingsState);

      showSaveMessage("");

      if (error) {
        showSaveMessage(error, true);
        return;
      }

      // 1) Встроенное хранилище amoCRM — для нативного UX при переоткрытии.
      self.set_settings(settingsState);

      // 2) Backend / Redis — источник истины для бота в рантайме.
      backendRequest("POST", settingsState)
        .then(function () {
          showSaveMessage("Настройки сохранены.", false);
        })
        .catch(function (xhr) {
          var message =
            (xhr && xhr.responseJSON && xhr.responseJSON.error) ||
            "Не удалось сохранить настройки на сервере.";

          showSaveMessage(message, true);
        });
    }

    function showSaveMessage(text, isError) {
      if (!$root) {
        return;
      }

      var $el = $root.find(".production-widget__save-message");

      $el
        .text(text || "")
        .css("color", isError ? "#c0392b" : "#27ae60");
    }

    // ------------------------------------------------------------
    // ОБЩИЕ УТИЛИТЫ РЕНДЕРА
    // ------------------------------------------------------------

    function fieldOptionsHtml(selectedId, allowedTypes) {
      var html = '<option value="">— не выбрано —</option>';

      liveData.fields.forEach(function (f) {
        if (allowedTypes && allowedTypes.length && allowedTypes.indexOf(f.type) === -1) {
          return;
        }

        var selected = String(f.id) === String(selectedId) ? " selected" : "";

        html += '<option value="' + f.id + '"' + selected + ">" + escapeHtml(f.name) + "</option>";
      });

      return html;
    }

    function statusOptionsHtml(selectedId) {
      var html = '<option value="">— не выбрано —</option>';

      allLiveStatuses().forEach(function (s) {
        var selected = String(s.id) === String(selectedId) ? " selected" : "";

        html +=
          '<option value="' +
          s.id +
          '"' +
          selected +
          ">" +
          escapeHtml(s.name) +
          " (" +
          escapeHtml(s.pipelineName) +
          ")</option>";
      });

      return html;
    }

    function userOptionsHtml(excludeIds) {
      var html = '<option value="">— выбрать пользователя —</option>';

      liveData.users.forEach(function (u) {
        if (excludeIds && excludeIds.indexOf(u.id) !== -1) {
          return;
        }

        html += '<option value="' + u.id + '">' + escapeHtml(u.name) + "</option>";
      });

      return html;
    }

    function escapeHtml(text) {
      return String(text == null ? "" : text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    // ------------------------------------------------------------
    // ВКЛАДКА "РОЛИ"
    // ------------------------------------------------------------

    function renderRolesTab() {
      var $tab = $('<div class="production-widget__roles"></div>');
      $tab.css({ display: "flex", gap: "32px", flexWrap: "wrap" });

      ROLE_DEFS.forEach(function (role) {
        var entries = settingsState.roles[role.key] || (settingsState.roles[role.key] = []);

        var $col = $('<div class="production-widget__role-col"></div>');
        $col.css({ minWidth: "220px" });

        $col.append('<div style="font-weight:600;margin-bottom:8px;">' + escapeHtml(role.label) + "</div>");

        var $list = $('<div class="production-widget__role-list"></div>');

        function renderList() {
          $list.empty();

          entries.forEach(function (entry, idx) {
            var user = liveData.users.filter(function (u) {
              return u.id === entry.userId;
            })[0];

            var $row = $('<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;"></div>');

            $row.append(
              '<span style="flex:1;">' + escapeHtml(user ? user.name : "#" + entry.userId) + "</span>"
            );

            var $checkbox = $(
              '<input type="checkbox"' + (entry.active ? " checked" : "") + " />"
            ).on("change", function () {
              entry.active = $(this).is(":checked");
            });

            $row.append($checkbox);

            var $delete = $('<span style="cursor:pointer;color:#c0392b;" title="Удалить">🗑</span>').on(
              "click",
              function () {
                if (window.confirm("Удалить пользователя «" + (user ? user.name : entry.userId) + "» из роли «" + role.label + "»?")) {
                  entries.splice(idx, 1);
                  renderList();
                }
              }
            );

            $row.append($delete);

            $list.append($row);
          });
        }

        renderList();

        $col.append($list);

        var $addRow = $('<div style="margin-top:8px;"></div>');
        var $select = $("<select></select>").css({ width: "100%", marginBottom: "4px" });

        function refreshAddSelect() {
          var excludeIds = entries.map(function (e) {
            return e.userId;
          });

          $select.html(userOptionsHtml(excludeIds));
        }

        refreshAddSelect();

        var $addBtn = $('<button type="button">+ Добавить пользователя</button>').on("click", function () {
          var userId = Number($select.val());

          if (!userId) {
            return;
          }

          entries.push({ userId: userId, active: true });
          refreshAddSelect();
          renderList();
        });

        $addRow.append($select).append($addBtn);
        $col.append($addRow);

        $tab.append($col);
      });

      return $tab;
    }

    // ------------------------------------------------------------
    // ВКЛАДКА "СВЯЗЬ ЭТАПОВ И ПОЛЕЙ"
    // ------------------------------------------------------------

    function ensureStatusFieldMapRows() {
      var existingById = {};

      settingsState.statusFieldMap.forEach(function (row) {
        existingById[row.amoStatusId] = row;
      });

      var merged = [];

      allLiveStatuses().forEach(function (s) {
        if (existingById[s.id]) {
          merged.push(existingById[s.id]);
        } else {
          merged.push({
            amoStatusId: s.id,
            amoPipelineId: liveData.statusesById[s.id] ? liveData.statusesById[s.id].pipeline_id : null,
            botStatus: "",
            executorFieldId: null,
            planDateFieldId: null,
            factDateFieldId: null,
            priceFieldId: null,
            nextAmoStatusId: null
          });
        }
      });

      settingsState.statusFieldMap = merged;
    }

    function renderStatusFieldMapTab() {
      ensureStatusFieldMapRows();

      var $tab = $('<div class="production-widget__status-map"></div>');
      var $table = $("<table></table>").css({ width: "100%", borderCollapse: "collapse" });

      var headers = [
        "Текущий статус amoCRM",
        "Статус бота",
        "Поле «Исполнитель»",
        "Поле «План готовности»",
        "Поле «Факт готовности»",
        "Поле «Цена»",
        "Следующий статус amoCRM"
      ];

      var $thead = $("<thead><tr></tr></thead>");

      headers.forEach(function (h) {
        $thead
          .find("tr")
          .append('<th style="text-align:left;border-bottom:1px solid #ccc;padding:6px;">' + h + "</th>");
      });

      $table.append($thead);

      var $tbody = $("<tbody></tbody>");

      settingsState.statusFieldMap.forEach(function (row) {
        var statusInfo = liveData.statusesById[row.amoStatusId];
        var $tr = $("<tr></tr>").css({ borderBottom: "1px solid #eee" });

        $tr.append(
          '<td style="padding:6px;">' +
            escapeHtml(statusInfo ? statusInfo.name : "#" + row.amoStatusId) +
            '<div style="color:#999;font-size:11px;">' +
            escapeHtml(statusInfo ? statusInfo.pipeline_name : "") +
            "</div></td>"
        );

        var $botStatusTd = $('<td style="padding:6px;"></td>');
        var $botStatusSelect = $("<select></select>");

        BOT_STATUS_OPTIONS.forEach(function (opt) {
          var selected = opt.value === row.botStatus ? " selected" : "";

          $botStatusSelect.append(
            '<option value="' + opt.value + '"' + selected + ">" + opt.label + "</option>"
          );
        });

        $botStatusSelect.on("change", function () {
          row.botStatus = $(this).val();
        });

        $botStatusTd.append($botStatusSelect);
        $tr.append($botStatusTd);

        [
          { key: "executorFieldId", types: null },
          { key: "planDateFieldId", types: ["date", "date_time"] },
          { key: "factDateFieldId", types: ["date", "date_time"] },
          { key: "priceFieldId", types: ["numeric", "price", "monetary"] }
        ].forEach(function (fieldDef) {
          var $td = $('<td style="padding:6px;"></td>');
          var $select = $("<select></select>").html(fieldOptionsHtml(row[fieldDef.key], fieldDef.types));

          $select.on("change", function () {
            var value = $(this).val();
            row[fieldDef.key] = value ? Number(value) : null;
          });

          $td.append($select);
          $tr.append($td);
        });

        var $nextStatusTd = $('<td style="padding:6px;"></td>');
        var $nextStatusSelect = $("<select></select>").html(statusOptionsHtml(row.nextAmoStatusId));

        $nextStatusSelect.on("change", function () {
          var value = $(this).val();
          row.nextAmoStatusId = value ? Number(value) : null;
        });

        $nextStatusTd.append($nextStatusSelect);
        $tr.append($nextStatusTd);

        $tbody.append($tr);
      });

      $table.append($tbody);
      $tab.append($table);

      return $tab;
    }

    // ------------------------------------------------------------
    // ВКЛАДКА "СЦЕНАРИИ"
    // ------------------------------------------------------------

    function renderScenariosTab() {
      var $tab = $('<div class="production-widget__scenarios"></div>');

      settingsState.scenarios.metalRestock = settingsState.scenarios.metalRestock || { amoStatusId: null };
      settingsState.scenarios.woodRestock = settingsState.scenarios.woodRestock || { amoStatusId: null };

      [
        { key: "metalRestock", label: "Дозакупка Металл" },
        { key: "woodRestock", label: "Дозакупка Дерево" }
      ].forEach(function (scenario) {
        var $row = $('<div style="margin-bottom:16px;"></div>');

        $row.append('<div style="font-weight:600;margin-bottom:4px;">' + scenario.label + "</div>");

        var entry = settingsState.scenarios[scenario.key];
        var $select = $("<select></select>").html(statusOptionsHtml(entry.amoStatusId));

        $select.on("change", function () {
          var value = $(this).val();
          entry.amoStatusId = value ? Number(value) : null;
        });

        $row.append($select);
        $tab.append($row);
      });

      return $tab;
    }

    // ------------------------------------------------------------
    // ВКЛАДКА "ПЛАНОВАЯ ГОТОВНОСТЬ"
    // ------------------------------------------------------------

    function renderReadinessTab() {
      var $tab = $('<div class="production-widget__readiness"></div>');

      var $productFieldRow = $('<div style="margin-bottom:12px;"></div>');
      $productFieldRow.append('<div style="font-weight:600;margin-bottom:4px;">Поле «Продукт»</div>');

      var $productFieldSelect = $("<select></select>").html(
        fieldOptionsHtml(settingsState.readinessMatrix.productFieldId, ["select", "multiselect"])
      );

      $productFieldSelect.on("change", function () {
        var value = $(this).val();
        settingsState.readinessMatrix.productFieldId = value ? Number(value) : null;
        renderReadinessMatrixTable();
      });

      $productFieldRow.append($productFieldSelect);
      $tab.append($productFieldRow);

      var $matrixContainer = $('<div class="production-widget__readiness-matrix"></div>');
      $tab.append($matrixContainer);

      function renderReadinessMatrixTable() {
        $matrixContainer.empty();

        var productField = liveData.fields.filter(function (f) {
          return f.id === settingsState.readinessMatrix.productFieldId;
        })[0];

        if (!productField) {
          $matrixContainer.append(
            '<div style="color:#999;">Выберите поле «Продукт», чтобы увидеть таблицу.</div>'
          );
          return;
        }

        var products = productField.enums || [];
        var statuses = settingsState.statusFieldMap
          .filter(function (row) {
            return row.botStatus;
          })
          .map(function (row) {
            return liveData.statusesById[row.amoStatusId];
          })
          .filter(Boolean);

        var cells = settingsState.readinessMatrix.cells || (settingsState.readinessMatrix.cells = {});

        var $table = $("<table></table>").css({ width: "100%", borderCollapse: "collapse" });
        var $thead = $("<thead><tr><th></th></tr></thead>");

        statuses.forEach(function (s) {
          $thead
            .find("tr")
            .append(
              '<th style="border-bottom:1px solid #ccc;padding:6px;text-align:left;">' +
                escapeHtml(s.name) +
                "</th>"
            );
        });

        $table.append($thead);

        var $tbody = $("<tbody></tbody>");

        products.forEach(function (product) {
          var $tr = $("<tr></tr>");

          $tr.append(
            '<td style="padding:6px;font-weight:600;">' + escapeHtml(product.value) + "</td>"
          );

          statuses.forEach(function (status) {
            var cellKey = product.id + ":" + status.id;
            var value = Object.prototype.hasOwnProperty.call(cells, cellKey) ? cells[cellKey] : 0;

            var $td = $('<td style="padding:6px;"></td>');
            var $input = $('<input type="number" min="0" step="0.01" />').val(value);

            $input.on("change", function () {
              var num = parseFloat($(this).val());
              cells[cellKey] = isNaN(num) || num < 0 ? 0 : Math.round(num * 100) / 100;
              $(this).val(cells[cellKey]);
            });

            $td.append($input);
            $tr.append($td);
          });

          $tbody.append($tr);
        });

        $table.append($tbody);
        $matrixContainer.append($table);
      }

      renderReadinessMatrixTable();

      return $tab;
    }

    // ------------------------------------------------------------
    // ОБЩИЙ КАРКАС: ЛЕВЫЙ СПИСОК БОТОВ + ВЕРХНИЕ ВКЛАДКИ ТЗ
    // ------------------------------------------------------------

    var TABS = [
      { key: "roles", label: "Роли", render: renderRolesTab },
      { key: "statusMap", label: "Связь этапов и полей", render: renderStatusFieldMapTab },
      { key: "scenarios", label: "Сценарии", render: renderScenariosTab },
      { key: "readiness", label: "Плановая готовность", render: renderReadinessTab }
    ];

    function renderShell() {
      $root.empty();

      var $layout = $('<div style="display:flex;"></div>');

      // Левый список ботов — сейчас работает только "Производство".
      // "Монтажники" — задел на будущий бот (см. план Фазы 1), пункт
      // неактивен до тех пор, пока для него не появится своя реализация.
      var $sidebar = $('<div style="width:160px;flex-shrink:0;padding-right:16px;"></div>');

      $sidebar.append(
        '<div style="padding:8px;font-weight:600;color:#2d7ff9;border-left:3px solid #2d7ff9;">Производство</div>'
      );

      $sidebar.append(
        '<div style="padding:8px;color:#bbb;cursor:not-allowed;" title="Появится позже">Монтажники</div>'
      );

      $layout.append($sidebar);

      var $content = $('<div style="flex:1;min-width:0;"></div>');

      var $tabsBar = $('<div style="display:flex;gap:16px;border-bottom:1px solid #ddd;margin-bottom:16px;"></div>');
      var $tabBody = $('<div class="production-widget__tab-body"></div>');

      TABS.forEach(function (tab) {
        var $tabBtn = $(
          '<div style="padding:8px 4px;cursor:pointer;' +
            (tab.key === activeTab ? "border-bottom:2px solid #2d7ff9;font-weight:600;" : "color:#666;") +
            '">' +
            tab.label +
            "</div>"
        ).on("click", function () {
          activeTab = tab.key;
          renderShell();
        });

        $tabsBar.append($tabBtn);
      });

      $content.append($tabsBar).append($tabBody);

      var currentTab = TABS.filter(function (t) {
        return t.key === activeTab;
      })[0];

      $tabBody.append(currentTab.render());

      var $footer = $('<div style="margin-top:20px;display:flex;align-items:center;gap:12px;"></div>');
      var $saveBtn = $('<button type="button" style="padding:8px 16px;">Сохранить</button>').on(
        "click",
        saveSettings
      );

      $footer.append($saveBtn);
      $footer.append('<span class="production-widget__save-message"></span>');

      $content.append($footer);
      $layout.append($content);

      $root.append($layout);
    }

    // ------------------------------------------------------------
    // ЖИЗНЕННЫЙ ЦИКЛ ВИДЖЕТА (требуется amoCRM)
    // ------------------------------------------------------------

    this.callbacks = {
      render: function () {
        return true;
      },

      init: function () {
        return true;
      },

      bind_actions: function () {
        return true;
      },

      // Вызывается при переходе на страницу "Расширенные настройки"
      // (см. manifest.json: locations содержит "advanced_settings").
      advancedSettings: function () {
        $root = $('<div class="production-widget"></div>');

        $root.append('<div style="padding:16px;color:#999;">Загрузка…</div>');

        $(".advanced-settings-holder, #advanced_settings").empty().append($root); // фактический контейнер уточняется amoCRM при рендере страницы

        $.when(loadAllLiveData(), loadSettings())
          .then(function (liveResult, loadedSettings) {
            settingsState = loadedSettings || emptySettings();
            settingsState.roles = settingsState.roles || {};
            settingsState.statusFieldMap = settingsState.statusFieldMap || [];
            settingsState.readinessMatrix =
              settingsState.readinessMatrix || { productFieldId: null, cells: {} };
            settingsState.scenarios = settingsState.scenarios || {};

            renderShell();
          })
          .catch(function (error) {
            $root.empty();
            $root.append(
              '<div style="color:#c0392b;padding:16px;">Не удалось загрузить данные amoCRM: ' +
                escapeHtml(error && error.statusText ? error.statusText : "неизвестная ошибка") +
                "</div>"
            );
          });

        return true;
      },

      onSave: function () {
        return true;
      },

      destroy: function () {
        return true;
      }
    };

    return this;
  };
});
