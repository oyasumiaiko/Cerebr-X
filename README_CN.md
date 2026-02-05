<p align="center">
<img src="./icons/icon128.png">
</p>

<p align="center">
<a href="https://chromewebstore.google.com/detail/cerebr/kjojanemcpiamhohkcpcddpkbnciojkj">
    <img src="https://img.shields.io/chrome-web-store/v/kjojanemcpiamhohkcpcddpkbnciojkj?color=blue&label=Chrome%20商店&logo=google-chrome&logoColor=white" alt="Chrome Web Store">
</a>
</p>

[English](./README.md) | [简体中文](./README_CN.md)

# 🧠 Cerebr - 智能 AI 助手

![screenshot](./statics/image.png)

Cerebr 是一款面向 Chromium 浏览器的侧边栏 AI 助手扩展，专注于提升工作效率和学习体验。“Cerebr”源自拉丁语词根，与“大脑/脑”相关，这也体现了我们的愿景：整合强大的 AI 能力，让 Cerebr 成为你的第二大脑，帮助深度阅读与理解。

在尝试了市面上的浏览器 AI 助手后，我们发现它们要么受限于次数，要么界面过于花哨。Cerebr 希望提供一个简洁、高效、无干扰的体验，但同时具备足够强的能力。

## ✨ 核心特性

- 🎯 **侧边栏 / 停靠 / 全屏** - 工具栏或自定义快捷键唤出，可在停靠侧栏与沉浸全屏之间切换
- 🧠 **上下文问答** - 网页/PDF 内容提取、划词线程、页面/仓库快速总结、纯对话模式
- 🖼️ **多模态** - 图片上传 + 页面截图，支持预览与拖拽查看
- 🔄 **多 API / 多模型** - 多配置、收藏、快速切换，支持自定义参数/系统提示词
- ⚡ **流式输出 + 富文本渲染** - Markdown、LaTeX 与代码高亮
- 🌗 **主题与背景** - 浅/深色主题与随机背景图

## 🛠️ 效率与管理

- 📚 **聊天记录中心** - URL/内容搜索筛选、树状分支、图片相册、数据统计
- 🧩 **消息工具** - 编辑、重新生成、创建分支、插入消息、复制文本/代码/图片
- ⌨️ **斜杠命令** - 输入 `/` 查看提示：`/summary`、`/temp`、`/model`、`/history`、`/clear`、`/stop`
- 🔧 **提示词与 URL 规则** - 系统/总结/划词提示词、站点级规则
- 💾 **备份与恢复** - 导出/导入对话，可选移除图片，支持自动增量备份

## 🎮 使用指南

1. 🔑 **配置 API**
   - 打开 **API 设置**
   - 填写 API Key、Base URL 和模型名称（多个 Key 可用逗号分隔）
   - 添加多套配置并收藏常用项

2. 💬 **打开侧边栏 / 独立页面**
   - 点击扩展图标，或在 `chrome://extensions/shortcuts` 设置快捷键
   - 需要专注模式时使用 **独立聊天页面** 或 **全屏模式**

3. 📚 **使用页面上下文**
   - 直接提问，Cerebr 会自动提取网页/PDF 内容
   - 使用 **快速总结** 或 `/summary` 一键总结
   - 切换 **纯对话模式** 进行不依赖页面的对话

4. 🖼️ **图片与截图**
   - 上传图片，或点击截图按钮捕获当前页面
   - 点击图片可预览并拖拽查看

## 📝 开发说明

本项目基于 Chrome Extension Manifest V3，无需构建步骤，主要技术栈：

- 原生 JavaScript + CSS
- Chrome Extension API
- PDF.js、Marked.js、KaTeX、Highlight.js、DOMPurify、dom-to-image

## 🤝 贡献指南

欢迎提交 Issue 和 Pull Request 来帮助改进项目。在提交之前，请确保：

- 🔍 已经搜索过相关的 Issue
- ✅ 遵循现有的代码风格
- 📝 提供清晰的描述和复现步骤

## 📄 许可证

本项目采用 GPLv3 许可证
