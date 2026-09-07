# 发布到 GitHub 保姆级指南（零编程基础友好）

这个项目是 **dsh-plugin-manager（DSH 插件管理器）**，一个给 DeepSeek Harness
Web 用的插件。本指南一步一步教你把它的源码发布到 GitHub，让全世界（或你的朋友）
能用一行命令安装它。

> 时间：约 10 分钟。不需要会写代码，只需要会"复制粘贴"和"拖拽文件"。

---

## 先认识几个词（一分钟词典）

| 词 | 是什么意思 | 打个比方 |
|---|---|---|
| 仓库（Repo） | 存放项目所有文件的"文件夹"，带版本历史 | 网盘上的一个项目文件夹 |
| GitHub | 托管仓库的网站 | 存放项目文件夹的"云盘 + 展示台" |
| 分支 main | 仓库里默认的主线版本 | 正式版 |
| 上传 / push | 把你电脑上的文件传到 GitHub | 把文件"提交"到云盘 |
| GitHub Desktop | GitHub 官方图形软件，不用记命令 | 云盘的"上传客户端" |

---

## 第 1 步：在 GitHub 上新建一个空仓库

1. 打开 https://github.com 并登录（没有账号就先注册一个，免费）。
2. 点右上角 **+** → **New repository**。
3. 填写：
   - **Repository name**（仓库名）：输入 `dsh-plugin-manager`
   - 下面选 **Public**（公开，别人才能安装）。
   - **不要**勾选 "Add a README file"、不要建 `.gitignore`、不要选 License
     （避免和我们要上传的文件冲突）。
4. 点 **Create repository**（创建仓库）。

创建后你会进入一个空仓库页面，**先别关**，下一步要用。

---

## 第 2 步：把代码放进去（推荐方式 A，全程网页操作）

### 方式 A：网页直接拖拽上传（最简单，零基础首选）

1. 在你自己电脑上找到项目文件夹：
   `dsh-plugin-manager`（里面有 `.dsh-plugin`、`lib`、`README.zh.md` 等文件）。
2. 在刚创建的空仓库页面，点 **uploading an existing file**（蓝色链接，在
   "Quick setup" 提示里），或点 **Add file → Upload files**。
3. 把整个文件夹里的**内容**拖进虚线框。注意两点：
   - 拖的是**里面的文件**，不是文件夹本身（`.git` 文件夹不需要上传）。
   - ⚠️ **`.dsh-plugin` 文件夹是"隐藏文件夹"**（名字以点开头，属于 dsh 插件的
     命名约定）—— 它里面装着插件真正的代码（`index.mjs` 宿主半 + `client.js`
     浏览器半），**必须上传、不能改名、不能删**。如果你的电脑看不到它，看下面的
     "隐藏文件夹小贴士"。
4. 下方 "Commit changes" 可以直接用默认文字（比如 `first publish`），点
   **Commit changes**。
5. 回到仓库主页，你应该能看到这些文件：`package.json`、`cordis.patch.yml`、
   `.dsh-plugin/`、`lib/`、`README.zh.md` 等 —— 发布完成 ✅

> **隐藏文件夹小贴士（重要）**
> - **Windows**：文件管理器默认能看到 `.dsh-plugin`，直接拖就行。
> - **macOS**：访达默认藏起以点开头的文件夹。按 **⌘ + Shift + .**（三个键一起按）
>   就能显示/隐藏这类文件；显示出来后再拖拽上传。
> - **用 GitHub Desktop（方式 B）**：它自动包含隐藏文件夹，你什么都不用做。
> - 上传完成后，回仓库主页确认存在一个 `.dsh-plugin` 文件夹；如果没有，说明漏传了，
>   补传一次即可。**千万不要把它改名成 `dsh-plugin`** —— 改名后插件将无法工作。

### 方式 B：用 GitHub Desktop（适合以后经常更新）

网页上传以后每次更新都要删旧文件再传，很麻烦。如果你打算长期维护，推荐装一个
**GitHub Desktop**（图形界面、不用记命令）：

1. 下载并安装：https://desktop.github.com
2. 登录你的 GitHub 账号。
3. File → **Clone repository** → 选刚建的 `dsh-plugin-manager` → 选择存放位置。
4. 用文件管理器打开克隆下来的文件夹，把项目文件**拷贝进去覆盖**。
5. 回到 GitHub Desktop，左下角会列出改动 → 写一句说明（如 `v0.2.0`）→
   点 **Commit to main** → 点 **Push origin**。

以后每次想发布新版本：改文件 → GitHub Desktop 里 Commit → Push，两步搞定。

---

## 第 3 步：发布完成后的验证

打开 GitHub 上的仓库页面，点文件 `README.zh.md`，GitHub 会漂亮地渲染说明。
再确认根目录有 `package.json` —— 有它，别人就能用 dsh 安装。

---

## 发布后：别人怎么安装你的插件

只要把你的 GitHub 用户名代入下面命令（`<你的用户名>` 换成真实用户名）：

```sh
dsh plugin --profile web add github:<你的用户名>/dsh-plugin-manager#main
```

或把整行命令发给你的朋友，让他们**粘贴**到 设置 → 插件 → 插件管理 的输入框里点安装。

> 例：如果你的用户名是 `zhangsan`，命令就是
> `dsh plugin --profile web add github:zhangsan/dsh-plugin-manager#main`

---

## 你本机要不要改？

**不用必须改。** 你电脑上已经装好了管理器（目前来自本地源码），能正常用。
如果你想让自己这台机器也"从 GitHub 官方版"走（以后好统一管理），可以这样做：

1. 打开 设置 → 插件 → 插件管理；
2. 在列表里对 `dsh-plugin-manager` 点 **卸载**；
3. 在安装框粘贴 `github:<你的用户名>/dsh-plugin-manager#main`，点安装；
4. 重启 web 生效。

---

## 以后想更新插件版本（给别人升级）时

1. 在 GitHub Desktop 的克隆文件夹里，把新版文件拷进去覆盖；
2. Commit → Push；
3. 别人在插件管理页对 `dsh-plugin-manager` 点一次 **更新**，再重启 web 即可。

---

## 常见问题

- **问：上传时报"文件已存在"？**
  网页上传不能覆盖同名文件。解决：在仓库页面点进旧文件 → 右上角垃圾桶删除 →
  再重新上传新文件。嫌麻烦就用方式 B（GitHub Desktop），以后不用再删。
- **问：`.dsh-plugin` 文件夹看不到 / 拖不动？**
  它是隐藏文件夹（名字以点开头）。macOS 按 **⌘ + Shift + .** 显示后再拖；Windows
  一般直接可见；用 GitHub Desktop 则完全不用管它。见上方"隐藏文件夹小贴士"。
- **问：别人装了我的插件，为什么没生效？**
  装完要**重启 web**，插件才会加载。
- **问：我不想公开可以吗？**
  可以，第 1 步选 **Private**（私有）。但私有仓库别人无法直接安装，只能你自己用。
- **问：怎么把仓库链接发给别人最方便？**
  仓库主页地址形如 `https://github.com/<你的用户名>/dsh-plugin-manager`，
  复制发给别人即可；README 会告诉他们怎么装。

---

祝发布顺利 🎉 有问题随时问。
