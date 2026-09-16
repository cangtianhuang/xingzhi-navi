# AGENTS.md · 行知 Navi 协作约定

面向在本仓库里工作的 AI 研发 Agent。开始动手前请先读完本文件。

## 项目一句话

零依赖的纯静态单页应用：一个人的「状态操作系统」，打开只回答两个问题——**现在卡在哪 / 下一步做什么**。无构建步骤，直接用浏览器打开 `index.html` 即可运行。

## 目录结构

```
xingzhi-navi/
  index.html      # 页面骨架与所有弹窗
  css/app.css     # 全部样式（含深色主题、答案/树两种视图布局）
  js/data.js      # 种子数据：领域/项目/事项、元信息、空图模板
  js/ai.js        # OneAPI / OpenAI 兼容接口封装（NaviAI.suggest / NaviAI.plan）
  js/map.js       # SVG 树布局、状态聚合、依赖计算
  js/app.js       # 主逻辑：渲染、交互、撤销重做、快速记、解卡等
  启动.command / 关闭服务.command   # macOS 本地起服务脚本
```

技术约束：纯原生 JS，**不引入任何依赖、不加构建步骤**。数据存 `localStorage`。样式用 CSS 变量 + `prefers-color-scheme` 适配深色。改动要与周围代码风格一致（命名、注释密度、中文措辞）。

## 提交规范（务必遵守）

- **按功能提交 commit**：一个大的功能点或一处独立修改对应一个 commit，不要把不相关的改动堆进同一个提交。
- **提交信息**用简洁的中文/英文说明「做了什么」，遵循现有历史的风格。
- **不带 co-author**：提交里不要加任何 `Co-authored-by` 尾注，也不要加署名脚注。
- **确保工作区干净**：每次提交后 `git status` 应为 clean（`.popo.json` 已在 `.gitignore` 中忽略）。不要遗留未跟踪或未提交的改动。
- git 目录若不在当前 cwd，用 `git -C <repo-path>` 执行，避免 cwd 漂移导致「not a git repository」。

## 发布规范（务必遵守）

- 页面通过 popo 平台发布：`python3 ~/.claude/skills/popo/scripts/upload.py ...`，线上地址 https://xingzhi-navi.popo.baidu-int.com （slug `xingzhi-navi`，再次发布用 `--previous-slug xingzhi-navi`）。
- **发布前必须先征得用户明确确认**。不要在每次改完代码后主动发布。
- 默认工作流是：改代码 → 本地校验 → 按功能提交 commit → 停下来等用户确认是否发布。发布是一个显式、独立的动作，由用户拍板。

## 本地校验

无网络、无法 `npm install`。改完 JS 至少做到：

- `node --check js/app.js`（以及改到的其它 js 文件）确认语法无误；
- 有条件时用 DOM shim 跑一遍 `boot()`，确认无运行时异常；
- 交互逻辑改动较大时，提示用户在真实浏览器里点一遍验证——环境内只能做静态与启动级校验，如实说明。

## 身份与文案

- 产品已收敛为**单一个人 OS**（固定档案「林予」），不再有多用户/多身份。改动不要重新引入成员名单。
- 界面文案保持**亲切、口语、无黑话**（不用「节点/依赖/挂载/闭环/对齐/抓手」等术语的生硬说法）。
- 种子数据为完全虚构。
