const SETTINGS_KEY = "checkin-settings";
const LAST_ATTEMPT_KEY = "last-checkin-date";
const LAST_RESULT_KEY = "last-checkin-result";
const AUTO_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_SETTINGS = {
  autoCheckin: true,
  autoUpgrade: true,
  notify: true,
};

let activeRun = false;
let autoRuntime = null;

export const normalizeCheckinSettings = (value) => {
  const source = value && typeof value === "object" ? value : {};
  return {
    autoCheckin: source.autoCheckin !== false,
    autoUpgrade: source.autoUpgrade !== false,
    notify: source.notify !== false,
  };
};

export const formatDateKey = (date = new Date()) => {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

export const parseCheckinErrorCode = (error) => {
  const response = error?.response;
  const body = response?.body ?? response?.data ?? error ?? {};
  const code = body?.error_code ?? body?.err_code ?? body?.errcode ?? body?.data?.error_code ?? 0;
  const number = Number(code);
  return Number.isFinite(number) ? number : 0;
};

export const describeCheckinCode = (code) => {
  switch (Number(code)) {
    case 131001:
      return "你今天已经签到过了";
    case 20028:
      return "当前账号风控，请前往手机端领取";
    case 20018:
      return "登录已过期，请重新登录";
    default:
      return Number(code) ? `签到失败（错误码 ${code}）` : "签到失败";
  }
};

export const describeAward = (claim) => {
  const data = claim?.data ?? claim ?? {};
  const hours = Number(
    data.award_vip_hour ?? data.vip_hour ?? data.award_hour ?? data.hour ?? 0,
  );
  const days = Number(data.award_vip_day ?? data.vip_day ?? data.award_day ?? data.day ?? 0);
  if (Number.isFinite(hours) && hours > 0) return `获得 ${hours} 小时畅听VIP`;
  if (Number.isFinite(days) && days > 0) return `获得 ${days} 天畅听VIP`;
  return "签到成功";
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const loadSettings = async (ctx) => {
  const saved = await ctx.storage.get(SETTINGS_KEY).catch(() => null);
  return normalizeCheckinSettings(saved);
};

const saveSettings = async (ctx, next) => {
  const normalized = normalizeCheckinSettings(next);
  await ctx.storage.set(SETTINGS_KEY, normalized).catch(() => undefined);
  return normalized;
};

const fetchUserInfo = async (ctx) => {
  const response = await ctx.kugou.user.getUserInfo();
  const data = response?.data ?? response;
  const userid = data?.userid ?? data?.user_id ?? data?.id;
  const nickname =
    data?.nickname ?? data?.nick_name ?? data?.user_name ?? data?.username ?? "";
  if (!data || (!userid && !nickname)) {
    throw new Error("未登录或登录态失效");
  }
  return { userid, nickname: String(nickname || "已登录") };
};

const fetchVipSummary = async (ctx) => {
  try {
    const response = await ctx.kugou.user.getYouthUnionVip();
    const data = response?.data ?? response;
    const list = Array.isArray(data) ? data : Array.isArray(data?.list) ? data.list : [];
    const active = list.filter((item) => Number(item?.is_vip) === 1);
    if (active.length === 0) return "";
    return active
      .map(
        (item) =>
          `${item?.product_type === "svip" ? "概念版" : "畅听"}至 ${
            item?.vip_end_time || "未知"
          }`,
      )
      .join(" · ");
  } catch {
    return "";
  }
};

const writeResult = async (ctx, result) => {
  await ctx.storage.set(LAST_RESULT_KEY, result).catch(() => undefined);
};

const notifyResult = (ctx, result, manual) => {
  const shouldNotify =
    result?.message &&
    (manual ||
      result.success ||
      String(result.message).includes("风控") ||
      result.already);
  if (!shouldNotify) return;
  const text = [result.message, result.upgrade].filter(Boolean).join("；");
  if (result.success) {
    if (result.already) ctx.toast.info(text);
    else ctx.toast.success(text);
  } else {
    ctx.toast.warning(text);
  }
};

export const runCheckin = async (ctx, options = {}) => {
  const manual = Boolean(options.manual);
  const source = options.source || "manual";
  if (activeRun) {
    return { success: false, message: "正在签到中，请稍候", date: formatDateKey() };
  }

  const settings = await loadSettings(ctx);
  const today = formatDateKey();

  if (!manual) {
    if (!settings.autoCheckin) {
      return { success: false, skipped: true, message: "自动签到已关闭", date: today };
    }
    const lastAttempt = await ctx.storage.get(LAST_ATTEMPT_KEY).catch(() => null);
    if (lastAttempt === today) {
      return { success: false, skipped: true, message: "今天已处理过签到", date: today };
    }
  }

  activeRun = true;
  try {
    let user;
    try {
      user = await fetchUserInfo(ctx);
    } catch {
      const result = {
        success: false,
        login: false,
        message: "未登录或登录态失效",
        date: today,
        at: Date.now(),
        source,
      };
      if (manual) {
        ctx.toast.warning(result.message);
        await writeResult(ctx, result);
      }
      return result;
    }

    let claim = null;
    let result = null;

    try {
      claim = await ctx.kugou.user.claimDayVip(today);
    } catch (error) {
      const code = parseCheckinErrorCode(error);
      if (code === 131001) {
        result = { success: true, already: true, message: describeCheckinCode(code) };
      } else {
        result = { success: false, message: describeCheckinCode(code), code };
      }
    }

    if (!result) {
      const code = Number(claim?.error_code ?? claim?.err_code ?? claim?.errcode ?? 0);
      const status = Number(claim?.status ?? 1);
      if (code === 131001) {
        result = { success: true, already: true, message: describeCheckinCode(code) };
      } else if (code === 20028 || code === 20018) {
        result = { success: false, message: describeCheckinCode(code), code };
      } else if (status === 0 || (code && code !== 0)) {
        result = { success: false, message: describeCheckinCode(code), code };
      } else {
        result = { success: true, message: `签到成功，${describeAward(claim)}` };
      }
    }

    result.date = today;
    result.at = Date.now();
    result.source = source;
    result.user = user.nickname;

    if (result.success && !result.already && settings.autoUpgrade) {
      await sleep(500);
      try {
        const upgrade = await ctx.kugou.user.upgradeDayVip();
        const code = Number(
          upgrade?.error_code ?? upgrade?.err_code ?? upgrade?.errcode ?? 0,
        );
        if (code === 131001) result.upgrade = "概念版今日已升级";
        else if (code === 20028) result.upgrade = "概念版升级风控";
        else if (code) result.upgrade = describeCheckinCode(code);
        else result.upgrade = "概念版 VIP 升级成功";
      } catch (error) {
        const code = parseCheckinErrorCode(error);
        result.upgrade = code ? describeCheckinCode(code) : "概念版升级失败";
      }
    }

    await ctx.storage.set(LAST_ATTEMPT_KEY, today).catch(() => undefined);
    await writeResult(ctx, result);
    notifyResult(ctx, result, manual);
    return result;
  } finally {
    activeRun = false;
  }
};

const startAutoRunner = (ctx) => {
  if (autoRuntime) return;
  const runtime = { startup: null, timer: null };
  runtime.startup = setTimeout(() => {
    void runCheckin(ctx, { manual: false, source: "auto" });
  }, 2500);
  runtime.timer = setInterval(() => {
    void runCheckin(ctx, { manual: false, source: "auto" });
  }, AUTO_CHECK_INTERVAL_MS);
  autoRuntime = runtime;
};

const stopAutoRunner = () => {
  if (!autoRuntime) return;
  clearTimeout(autoRuntime.startup);
  clearInterval(autoRuntime.timer);
  autoRuntime = null;
};

const PLUGIN_CSS = `
.kdc-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 24px;
  max-width: 880px;
  margin: 0 auto;
  color: var(--color-text-main);
}

.kdc-card {
  border: 1px solid var(--color-border);
  border-radius: 14px;
  padding: 18px 20px;
  background: var(--color-bg-elevated, transparent);
}

.kdc-hero {
  background: linear-gradient(135deg, rgba(49, 207, 161, 0.12), transparent 60%);
}

.kdc-title {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.kdc-sub {
  margin-top: 6px;
  color: var(--color-text-secondary);
  font-size: 13px;
  line-height: 1.6;
}

.kdc-status {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  margin-top: 16px;
  font-size: 13px;
  color: var(--color-text-secondary);
}

.kdc-account strong {
  color: var(--color-text-main);
}

.kdc-status-line {
  margin-top: 10px;
  font-size: 14px;
  font-weight: 600;
}

.kdc-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 16px;
}

.kdc-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 0;
}

.kdc-row + .kdc-row {
  border-top: 1px solid var(--color-border);
}

.kdc-copy {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.kdc-label {
  font-size: 13px;
  font-weight: 600;
}

.kdc-hint {
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.kdc-section-title {
  font-size: 14px;
  font-weight: 700;
  margin-bottom: 4px;
}

.kdc-notes p {
  margin: 6px 0 0;
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.6;
}

.kdc-settings {
  display: grid;
  gap: 8px;
  color: var(--color-text-main);
}
`;

const createPageComponent = (ctx) => {
  const { defineComponent, defineAsyncComponent, h, ref, onMounted } = ctx.vue;
  const Button = defineAsyncComponent(ctx.ui.components.Button);
  const Switch = defineAsyncComponent(ctx.ui.components.Switch);

  return defineComponent({
    name: "KugouDailyCheckinPage",
    setup() {
      const settings = ref({ ...DEFAULT_SETTINGS });
      const user = ref("读取中…");
      const vip = ref("");
      const last = ref(null);
      const loading = ref(false);
      const today = formatDateKey();

      const loadStored = async () => {
        settings.value = await loadSettings(ctx);
        const saved = await ctx.storage.get(LAST_RESULT_KEY).catch(() => null);
        if (saved && typeof saved === "object") last.value = saved;
      };

      const refresh = async () => {
        loading.value = true;
        try {
          const info = await fetchUserInfo(ctx);
          user.value = info.nickname;
          vip.value = await fetchVipSummary(ctx);
        } catch {
          user.value = "未登录或登录态失效";
          vip.value = "";
        } finally {
          loading.value = false;
        }
      };

      const save = async (partial) => {
        settings.value = await saveSettings(ctx, { ...settings.value, ...partial });
      };

      const doCheckin = async () => {
        loading.value = true;
        try {
          const result = await runCheckin(ctx, { manual: true, source: "manual" });
          last.value = result;
          if (result?.user) user.value = result.user;
        } finally {
          loading.value = false;
        }
      };

      onMounted(() => {
        void loadStored();
        void refresh();
      });

      const switchRow = (label, hint, control) =>
        h("div", { class: "kdc-row" }, [
          h("div", { class: "kdc-copy" }, [
            h("span", { class: "kdc-label" }, label),
            hint ? h("span", { class: "kdc-hint" }, hint) : null,
          ]),
          control,
        ]);

      return () => {
        const todayResult = last.value?.date === today ? last.value : null;
        const statusText = todayResult
          ? todayResult.message
          : last.value
            ? `上次 ${last.value.date}：${last.value.message}`
            : "今天尚未签到";
        return h("div", { class: "kdc-page" }, [
          h("div", { class: "kdc-card kdc-hero" }, [
            h("div", { class: "kdc-title" }, "酷狗每日签到"),
            h(
              "div",
              { class: "kdc-sub" },
              "每天自动领取畅听 VIP，可选升级概念版；登录态由 EchoMusic 宿主提供。",
            ),
            h("div", { class: "kdc-status" }, [
              h("span", { class: "kdc-account" }, ["账号：", h("strong", user.value)]),
              vip.value ? h("span", `VIP：${vip.value}`) : null,
            ]),
            h("div", { class: "kdc-status-line" }, `今日：${statusText}`),
            todayResult?.upgrade
              ? h("div", { class: "kdc-hint" }, `升级：${todayResult.upgrade}`)
              : null,
            h("div", { class: "kdc-actions" }, [
              h(
                Button,
                {
                  variant: "primary",
                  size: "default",
                  disabled: loading.value,
                  onClick: doCheckin,
                },
                { default: () => (loading.value ? "处理中…" : "立即签到") },
              ),
              h(
                Button,
                {
                  variant: "secondary",
                  size: "default",
                  disabled: loading.value,
                  onClick: refresh,
                },
                { default: () => "刷新状态" },
              ),
            ]),
          ]),
          h("div", { class: "kdc-card" }, [
            h("div", { class: "kdc-section-title" }, "自动签到"),
            switchRow(
              "每天自动签到",
              "应用启动后每天执行一次；当天已尝试过会自动跳过",
              h(Switch, {
                modelValue: settings.value.autoCheckin,
                "onUpdate:modelValue": (value) => save({ autoCheckin: Boolean(value) }),
              }),
            ),
            switchRow(
              "自动升级概念版 VIP",
              "畅听 VIP 领取成功后，尝试升级当天概念版",
              h(Switch, {
                modelValue: settings.value.autoUpgrade,
                "onUpdate:modelValue": (value) => save({ autoUpgrade: Boolean(value) }),
              }),
            ),
            switchRow(
              "结果提示",
              "自动签到成功或风控时弹出应用内提示",
              h(Switch, {
                modelValue: settings.value.notify,
                "onUpdate:modelValue": (value) => save({ notify: Boolean(value) }),
              }),
            ),
          ]),
          h("div", { class: "kdc-card kdc-notes" }, [
            h("div", { class: "kdc-section-title" }, "说明"),
            h("p", "接口：/youth/day/vip + /youth/day/vip/upgrade，鉴权由宿主自动注入。"),
            h("p", "错误码 131001=今日已签到，20028=账号风控，20018=登录过期。"),
            h("p", "升级失败不影响畅听 VIP 领取结果；本插件不保存账号密码或 Cookie。"),
          ]),
        ]);
      };
    },
  });
};

const createSettingsComponent = (ctx) => {
  const { defineComponent, defineAsyncComponent, h, ref } = ctx.vue;
  const Switch = defineAsyncComponent(ctx.ui.components.Switch);
  const Button = defineAsyncComponent(ctx.ui.components.Button);

  return defineComponent({
    name: "KugouDailyCheckinSettings",
    setup() {
      const settings = ref({ ...DEFAULT_SETTINGS });
      const loading = ref(false);

      const load = async () => {
        settings.value = await loadSettings(ctx);
      };
      void load();

      const save = async (partial) => {
        settings.value = await saveSettings(ctx, { ...settings.value, ...partial });
      };

      const runNow = async () => {
        loading.value = true;
        try {
          await runCheckin(ctx, { manual: true, source: "settings" });
        } finally {
          loading.value = false;
        }
      };

      const row = (label, control, hint) =>
        h("div", { class: "kdc-row" }, [
          h("div", { class: "kdc-copy" }, [
            h("span", { class: "kdc-label" }, label),
            hint ? h("span", { class: "kdc-hint" }, hint) : null,
          ]),
          control,
        ]);

      return () =>
        h("div", { class: "kdc-settings" }, [
          row(
            "每天自动签到",
            h(Switch, {
              modelValue: settings.value.autoCheckin,
              "onUpdate:modelValue": (value) => save({ autoCheckin: Boolean(value) }),
            }),
          ),
          row(
            "自动升级概念版 VIP",
            h(Switch, {
              modelValue: settings.value.autoUpgrade,
              "onUpdate:modelValue": (value) => save({ autoUpgrade: Boolean(value) }),
            }),
          ),
          row(
            "结果提示",
            h(Switch, {
              modelValue: settings.value.notify,
              "onUpdate:modelValue": (value) => save({ notify: Boolean(value) }),
            }),
          ),
          h(
            Button,
            {
              variant: "primary",
              size: "sm",
              disabled: loading.value,
              onClick: runNow,
            },
            { default: () => (loading.value ? "处理中…" : "立即签到") },
          ),
          h(
            "div",
            { class: "kdc-hint" },
            "详细状态在侧栏「酷狗签到」页面查看。",
          ),
        ]);
    },
  });
};

export function activate(ctx) {
  ctx.css.inject(PLUGIN_CSS, { id: "kdc-style" });

  ctx.ui.addPage({
    id: "checkin",
    title: "酷狗签到",
    icon: "tabler:calendar-check",
    component: createPageComponent(ctx),
    sidebar: {
      section: "plugins",
      sectionTitle: "插件",
      order: 20,
    },
  });

  ctx.ui.settings.define({
    title: "酷狗签到设置",
    component: createSettingsComponent(ctx),
  });

  startAutoRunner(ctx);
}

export function deactivate() {
  stopAutoRunner();
}