# 酷狗每日签到

EchoMusic 插件：每天自动领取酷狗畅听 VIP，可选升级当天概念版 VIP；使用 EchoMusic 已登录的酷狗账号，不需要额外填 Cookie 或密码。

## 背景：MoeKoeMusic 怎么做的

MoeKoeMusic 的签到逻辑在 `src/views/Library.vue` 和 `src/components/player/Helpers.js`：

- 手动「签到」（旧接口）：`GET /youth/vip`，返回 `award_vip_hour`，代码已标注“该接口将在未来被移除”。
- 每日 VIP：`GET /youth/day/vip?receive_day=YYYY-MM-DD`，服务端映射到酷狗 `/youth/v1/recharge/receive_vip_listen_song`。
- 概念版升级：`GET /youth/day/vip/upgrade`，映射到 `/youth/v1/listen_song/upgrade_vip_reward`。
- 自动执行：播放器挂载和开始播放时调用 `getVip()`；登录后每天只执行一次，用 `localStorage.lastVipRequestDate` 去重；先领畅听 VIP，500ms 后尝试升级概念版。
- 错误码：`131001` 今日已签到，`20028` 账号风控，`20018` 登录过期。

EchoMusic 已经内置同一套接口（`src/renderer/api/user.ts` 的 `claimDayVip`、`upgradeDayVip`），并且请求会自动注入当前登录态，所以插件只需要调用 `ctx.kugou.user.*`。

## 功能

- 应用启动后自动签到；同一天只自动尝试一次，跨天自动重试。
- 领取成功后可选自动升级概念版 VIP。
- 侧栏「插件 → 酷狗签到」页面：查看账号、VIP 到期时间、今日结果、上次结果，手动补签。
- 插件设置：自动签到、自动升级、结果提示开关。
- 结果通过应用内 toast 提示；错误码翻译为可读文案。

## 安装

1. 将 `kugou-daily-checkin/` 复制到 EchoMusic 插件目录：
   - Windows：`%APPDATA%\echo-music\plugins`
   - 也可以先克隆仓库：`git clone https://github.com/charlisang/kugou-daily-checkin.git`
2. 在插件管理启用「酷狗每日签到」。
3. 默认启用自动签到；可在插件设置中关闭，或在侧栏页面手动「立即签到」。

## 接口与权限

- Manifest 只声明 `kugouApi`，由宿主完成登录鉴权。
- 使用：
  - `ctx.kugou.user.getUserInfo()`
  - `ctx.kugou.user.claimDayVip(day)`
  - `ctx.kugou.user.upgradeDayVip()`
  - `ctx.kugou.user.getYouthUnionVip()`
- 插件不读取、不保存账号密码或 Cookie。
- 签到结果（含当前账号昵称）只写入本机插件存储用于页面展示，不会发送到其他服务。

## 注意事项

- 签到接口属于酷狗非公开接口，可能变更、限流或风控；`20028` 时请前往手机端领取。
- 升级失败不影响已领取的畅听 VIP。
- 旧 `/youth/vip` 接口未接入，官方已提示未来移除。
- 组队领取 VIP 是另一套 `/team/*` 活动，本插件未包含。

## 开发

```bash
npm test
npm run check
```

单文件 ESM，修改 `index.js` 后复制到插件目录并刷新插件列表。

## 相关链接

- 仓库：<https://github.com/charlisang/kugou-daily-checkin>
- 问题反馈：<https://github.com/charlisang/kugou-daily-checkin/issues>

## 许可证

MIT © 2026 charlisang

## 验证记录

- 2026-11-17：在 EchoMusic 2.3.3-beta.3 启用插件，自动签到能正确识别当前登录账号；接口返回 `131001` 时页面显示「你今天已经签到过了」，并跳过概念版升级。
- 测试当天账号已签到，未覆盖“首次领取成功”分支；登录态、错误处理和自动流程已验证。
