# dsh-plugin-test-button

> 会话头部的一个按钮，用来检查你正在写的 DeepSeek Harness 插件。

## 为什么写它

改一行 `client.js`，要安装、刷新、找按钮、点一下，再去翻会话日志看发生了什么。一轮下来几分钟，大部分时间花在点击上。

所以把这一圈缩成一个按钮：点一下，会话里直接出一份报告，写清楚它检查了什么、发现了什么。

## 按钮做什么

按钮在会话头部，点它等于执行命令 `/plugin-test`。命令不走模型，也不碰输入框里的草稿。

报告分两段。

**静态检查**

- `package.json` 能解析，有 `name`、`version`，并且有 `"type": "module"`。
- 声明了 `dsh.bundle` 或 `dsh.client`。
- `files` 里每一项都能找到真实文件，`locale/*.json` 这类通配会展开。
- `dsh.bundle.patch` 存在，引用了包名，报告里会带上配置行 id。
- `exports["./client"]` 指向的文件存在，`dsh.client.platform` 是 `web`。
- `node --check` 能过：Host 入口必查，有 client 入口就一起查。
- 包确实装上了，Web 端能加载到它的 client bundle（`clientModules.clientPath`）。只躺在磁盘上没安装的包，这里会报“未安装或 UI bundle 未注册”。
- 图标不超过 256 KiB，每个 `locale/*.json` 都有 `meta.title`。

**运行测试**（只在静态检查全通过时执行）

- 开一个独立的 `node` 进程，`import` 插件 Host 入口并调用 `apply(mockCtx, {})`。mock ctx 是记录了所有调用的 Proxy，所以报告能写出它实际注册了什么，例如 `commands.register（plugin-test）`；超时 8 秒。
- client 半按文本解析，把每个 `.slots.register({ name, id, order })` 打出来，例如 `conversation.session.header.actions（id=plugin-test-button, order=0）`。

如果插件导出的是 service class 而不是 `apply`，运行测试会降级成一条提醒。

## 它不做什么

运行测试只能证明插件能加载、能注册东西。它不渲染界面，所以按钮好不好看、位置对不对，还得自己看一眼。

client 半改完刷新页面就行；Host 半改完必须重启 Harness。Host 模块不会热重载，旧模块会继续用旧文案回答命令。这一点我们自己踩到过两次。

## 实际输出

```text
🧪 插件自检 · D:\plugins\demo
扫描范围：默认：会话工作区本身 + 直接子目录（depth 1）；可用工作区根的 .dsh-plugin-test.json 声明 roots/depth/exclude

📦 @local/my-plugin @ 0.1.0 · demo
  ✅ files 声明的 6 项全部存在
  ✅ bundle patch 正常（配置行 id=my-plugin）
  ✅ 客户端入口 ./client.js 存在（platform=web）
  ✅ JS 语法检查通过（./index.js, ./client.js）
  ✅ 已安装 · UI bundle 可加载（/plugins/@local/my-plugin/client.js）
  ✅ 图标正常（484 字节）

▶️ 运行测试 · @local/my-plugin
  ✅ Host 入口在独立进程中执行成功（./index.js）
  ✅ 捕获注册：commands ×1
    · commands.register（my-command）
  ✅ UI 注册槽位：conversation.session.header.actions（id=my-button, order=0）

结论：✅ 必检项全部通过
提示：UI 类插件请刷新页面后肉眼确认槽位效果；Host 类插件改动后需要重启 Harness。
```

失败项会带上是哪个文件出的问题：

```text
  ❌ files 中声明的文件不存在：locale/ja.json
  ❌ syntax error → ./index.js → index.js:12
结论：❌ 有 2 项必须修复
```

## 安装

把整个目录放到任意位置，然后让插件管理器 link 它：

```text
plugin_manager install_bundle  target = D:\path\to\dsh-plugin-test-button
```

profile 里的 `package.json` 和 `cordis.patch.yml` 由插件管理器写，不要手改，也不要在 profile 目录里跑 `pnpm`。

装完以后，创造模式会话的头部就有这个按钮。如果你的 Harness 版本没有提供这个插件读取的 preset projection，按钮会一直隐藏，见下面的“显示条件”。

卸载：在插件面板里移除 `@local/dsh-plugin-test-button`，或者用 `plugin_manager remove_bundle`。

## 用法

1. 在创造模式里开一个会话，把正在写的插件放在会话工作区里。
2. 点“测试插件”。
3. 先修 `❌`，`⚠️` 自己判断要不要处理。
4. client 半改动刷新页面，Host 半改动重启 Harness。

## 扫描范围配置

可选。在工作区根放一个 `.dsh-plugin-test.json`：

```json
{
  "roots": ["plugins", "D:\\work\\second-plugin"],
  "depth": 3,
  "exclude": ["old-experiments", "node_modules"]
}
```

- `roots`：要扫描的目录，相对路径按会话工作区解析，默认是工作区自己。
- `depth`：往下找几层，0 到 6，默认 1，也就是工作区本身和它的直接子目录。默认值这么设是因为扫深了会把别人的插件也扫进来。
- `exclude`：要跳过的目录名。

一直生效的跳过列表：`node_modules`、`.git`、`dist`、`build`、`out`、`coverage`、`.cache`、`.turbo`，以及所有点开头的目录。扫描最多收 6 个插件包，最多走 4 层。

配置文件不存在或格式不对时，报告里的“扫描范围”那行会说明，并退回默认范围。

## 显示条件

只有当前会话的 agent preset 是 `cordis`（创造模式）时才渲染。Client 读 `agentPreset` 这个 session projection（会话头里初始化，`agent-preset/selected` 事件更新），读不到就退回去扫会话事件流。两条路都拿不到 preset 时，按钮不渲染。藏起来比到处露脸好解释。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半。注册 `plugin-test` 命令，负责扫描、检查、把报告作为命令文本返回。 |
| `probe.mjs` | 独立运行器。`node probe.mjs <插件目录> <输出 json>` 会 import 插件 Host 入口，用录制的 mock ctx 调 `apply`，把结果写成 JSON。Host 半在子进程里跑它，插件崩了不会带走 Harness。 |
| `client.js` | Web 半。注册头部槽位，点击时调 `session.command('/plugin-test')`；会话绑定没就绪时退回“写草稿 + 提交”。 |
| `cordis.patch.yml` | 把这个包插进 profile 的 Loader 补丁。 |
| `locale/zh.json`、`locale/en.json` | 插件面板里的标题和说明。 |

用到的槽位和服务：槽位 `conversation.session.header.actions`；Host 服务 `commands`、`workingDirectory`、`clientModules`；Client 服务 `sessions`（用 `ctx.get` 读，服务不在时插件也能加载）。

## 开发

```text
node --check index.js client.js probe.mjs
node probe.mjs . out.json          # 对某个插件目录跑一次运行探针
node .dev/selftest.mjs             # 用假 ctx 离线跑一遍（不随包发布）
```

client 改动刷新页面，Host 改动重启 Harness。这两条记住了，能少怀疑人生。

## 许可

MIT。
