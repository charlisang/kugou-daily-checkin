import test from "node:test";
import assert from "node:assert/strict";
import {
  describeAward,
  describeCheckinCode,
  formatDateKey,
  normalizeCheckinSettings,
  parseCheckinErrorCode,
} from "../index.js";

test("normalizeCheckinSettings 默认全开", () => {
  assert.deepEqual(normalizeCheckinSettings(undefined), {
    autoCheckin: true,
    autoUpgrade: true,
    notify: true,
  });
});

test("normalizeCheckinSettings 保留关闭项", () => {
  assert.deepEqual(
    normalizeCheckinSettings({ autoCheckin: false, autoUpgrade: false, notify: false }),
    { autoCheckin: false, autoUpgrade: false, notify: false },
  );
});

test("formatDateKey 使用本地日期补零", () => {
  assert.equal(formatDateKey(new Date(2026, 10, 7)), "2026-11-07");
});

test("parseCheckinErrorCode 兼容 response.body/data", () => {
  assert.equal(parseCheckinErrorCode({ response: { body: { error_code: 131001 } } }), 131001);
  assert.equal(parseCheckinErrorCode({ response: { data: { err_code: 20028 } } }), 20028);
  assert.equal(parseCheckinErrorCode({ error_code: 20018 }), 20018);
  assert.equal(parseCheckinErrorCode(new Error("x")), 0);
});

test("describeCheckinCode 输出常见错误文案", () => {
  assert.match(describeCheckinCode(131001), /已经签到/);
  assert.match(describeCheckinCode(20028), /风控/);
  assert.match(describeCheckinCode(20018), /登录已过期/);
  assert.match(describeCheckinCode(99999), /99999/);
});

test("describeAward 解析小时/天奖励", () => {
  assert.equal(describeAward({ data: { award_vip_hour: 2 } }), "获得 2 小时畅听VIP");
  assert.equal(describeAward({ data: { award_vip_day: 1 } }), "获得 1 天畅听VIP");
  assert.equal(describeAward({ data: {} }), "签到成功");
});