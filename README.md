# dsh-plugin-manager · DSH Web GUI 插件管理器

在 DeepSeek Harness 的 Web GUI 里**方便地安装 / 停用 / 启用 / 更新 / 卸载** GitHub 上的 dsh
自制插件（如 gal-view 这类 bundle 插件）。

> 粘贴别人 README 里的整行安装命令、**GitHub 仓库链接**或裸 spec 即可安装，例如：
> - `dsh plugin --profile web add github:Ayase34/gal-view#main`
> - `https://github.com/Ayase34/gal-view`
> - README 里写 `add <本项目路径>` 占位时，**把仓库链接一起粘进来**也会自动补全安装

## 功能

- **粘贴即装**：把任何 `dsh plugin …` 安装命令（或裸的 `github:owner/repo#分支` / `owner/repo` /
  **`https://github.com/owner/repo` 链接** / npm 包名）粘进「设置 → 插件 → 插件管理」的输入框，点一下安装。
- **README 占位自动替换**：很多插件 README 写 `dsh plugin --profile web add <本项目路径>`（占位符）。
  把这段命令 + 它的 GitHub 链接一起粘进去，管理器会用链接自动顶替占位路径完成安装。
- **已装列表**：展示每个插件的包名 / 版本 / 来源 / 启用状态。
- **停用 / 启用**：停用 = **保留安装但暂不生效**（从 profile 层栈摘出，可一键启用，无需重新下载）。
- **更新 / 卸载**：一键 `pnpm update` / `pnpm remove`，自动按官方规则对账 `dsh.profile.bundles`。
- **自动处理 pnpm 构建拦截**：git 仓库带 `prepare` 脚本时 pnpm 会拦，管理器自动写入
  `pnpm.onlyBuiltDependencies` 并重建。
- **一致的重启提示**：装 / 停用 / 启用 / 更新后都会明确提示"重启 web 后生效"。

本插件本体就是 dsh「bundle 插件」格式（与 gal-view 相同），因此可以用一行命令分发给任何
dsh web 用户。

> 🌟 **想把本项目开源发布到 GitHub？** 新手请看 [发布到 GitHub 保姆级指南](docs/PUBLISH-TO-GITHUB.zh.md)
> （零编程基础，全程网页操作即可完成）。

## 安装（把本管理器装进一个 profile）

```sh
dsh plugin --profile web add github:<owner>/dsh-plugin-manager#main
# 或本仓库本地路径：
#   cd <你的 profile 目录>
#   pnpm add /绝对/路径/dsh-plugin-manager
```

装完**重启 web**。之后打开 **设置 → 插件 → 插件管理** 即可使用。

## 使用

### GUI（设置 → 插件 → 插件管理）

1. **安装**：粘贴安装命令、**GitHub 链接**或仓库地址 → 输入框下方会预览"将安装：…"→ 点「安装 / 更新」。
2. **管理**：在已安装列表里点 停用 / 启用 / 更新 / 卸载。
3. 每次操作后页面显示结果；提示重启 web 时，重启后生效。

### CLI（dshpm，同一引擎）

```sh
dshpm ls                                   # 列出已装插件
dshpm add github:owner/repo#main           # 安装
dshpm rm gal-view                          # 卸载
dshpm up gal-view                          # 更新
dshpm off gal-view                         # 停用（保留依赖）
dshpm on gal-view                          # 启用
```

- 默认 profile：`$DSH_PROFILE` 或 `web`；可用 `--profile <name>` 指定。
- 家目录：`$DSH_HOME`，缺省 `~/.dsh`。
- pnpm 解析顺序：`$DSHPM_PNPM` > PATH 上的 `pnpm` > `corepack pnpm`。
- 也支持把整行 `dsh plugin --profile web add …` 作为唯一参数粘贴给 dshpm。

## 语义说明

- **停用 ≠ 卸载**：停用把插件移出 profile 的层列表（`dsh.profile.bundles`），依赖保留在
  `package.json`，之后「启用」放回即可，无需重新下载。停用后需要重启 web。
- **卸载**：真正 `pnpm remove`，同时从层列表移除。
- **来源 spec**：`github:owner/repo#ref` 会完整保留在 `dependencies` 中，卸载/更新后不丢失来源。

## 实现要点

- 浏览器 half（`.dsh-plugin/client.js`）是官方 `__ModuleLoader__.load` lazy-CJS factory 契约，
  **手写、无构建步骤、零运行时依赖**（仅用平台注入的 `react`），因此仓库本身没有 `prepare`
  脚本 —— 别人安装它时不会被 pnpm 拦构建。
- 宿主 half（`.dsh-plugin/index.mjs`）是一个 loader 行插件，注册自己的 settings 命名空间
  `plugin-manager`；界面 → 宿主之间**只走官方 settings 域通道**（客户端 `settingsScope` ↔
  宿主 `ctx.settings`），不依赖任何私有 Typert/Remote 注册，跨 dsh 小版本相对稳定。
- 执行逻辑全部收敛在 `lib/pm-core.mjs`，CLI 与宿主 half 共用；对账语义与官方 `dsh plugin`
  一致（按已安装状态，而非依赖 diff）。

## 开发

```sh
node --test tests/*.test.mjs     # 纯逻辑单测（临时目录，不碰真实 profile）
node bin/dshpm.mjs ls            # 只读走查
node bin/dshpm.mjs check         # 启动前体检（manifest / 层可解析 / cordis.patch.yml 单文档）
```

改动 `client.js` / `index.mjs` / `lib` 后，本机以 `file:` 方式安装时改动即时可见，重启 web 生效。

## 故障排查：web 启动失败（exit code 1）

dsh 启动阶段会**严格解析** profile 的 `cordis.patch.yml`（loader 补丁层）。最常见的翻车是把
按 README 追加的片段**直接接在模板的 `[]` 后面**——一个文件变成两个 YAML 文档，解析即失败，
于是该 profile 的任何 `dsh` 命令都 exit 1：

```yaml
# ✖ 错误示范：[] 是一个完整文档，下面又接第二段
[]
- id: permission
  ...
```

修正：把片段**合并进同一个列表**（删掉 `[]`，让列表直接成为文件主体）：

```yaml
# ✔ 正确：单个 YAML 文档 = loader patch 条目列表
- id: permission
  name: '@deepseek-ai/dsh-permission-presets'
  config:
    presets:
      ...
```

启动前先跑 `dshpm check --profile <名字>`，它会逐项检查依赖是否装齐、每个层是否可解析并声明
`dsh.bundle`、以及 `cordis.patch.yml` 是否为一个合法文档，出错时给出精确位置。

## 已知限制

- 每个 profile 需要各自安装本插件（它管理"自己所在的 profile"）；默认管理 web profile。
- 安装/更新依赖 dsh 运行时进程能访问 `pnpm`（或 `corepack pnpm`）与 git/网络。
- 浏览器 half 依赖宿主对 `plugin-manager` 命名空间已提供服务：装好后必须重启 web 一次。
- 「界面直接安装」经 settings 域实现 —— 若 dsh 未来改动 settings 域契约需要跟随适配。

## 许可证

MIT
