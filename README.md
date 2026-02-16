<p align="center">
<img src="./icons/icon128.png">
</p>

[English](./README_EN.md)

# 🧠 Cerebr - 智能 AI 助手

## ⚠️ 当前状态（仅支持本地加载）

- 当前版本**未发布到 Chrome 插件商店**。
- 这是一个个人自用项目，功能并不稳定，可能随时修改。
- 使用前必须先将仓库 `git clone` 到本地，并还原 submodule：

```bash
git clone <仓库地址>
cd Cerebr
git submodule update --init --recursive
```

- 然后打开 `chrome://extensions`，启用**开发者模式**，点击**加载已解压的扩展程序**并选择仓库根目录。

## 📸 功能预览

### 主界面
<p align="center">
  <img src="./statics/readme/readme-main-ui.png" alt="主界面" width="720" height="848" />
</p>

### 一键总结网页，或配合 YouTube 字幕插件一键总结 YouTube 视频
<p align="center">
  <img src="./statics/readme/readme-one-click-summary.png" alt="一键总结网页与 YouTube 视频" width="1200" height="515" />
</p>

### 强大的聊天记录管理和快速聊天记录全文搜索
<p align="center">
  <img src="./statics/readme/readme-history-search-1.png" alt="聊天记录管理与搜索 1" width="760" height="894" />
</p>
<p align="center">
  <img src="./statics/readme/readme-history-search-2.png" alt="聊天记录管理与搜索 2" width="620" height="864" />
</p>

### 详细的自定义个性化配色设置
<p align="center">
  <img src="./statics/readme/readme-theme-customization.png" alt="个性化配色设置" width="520" height="710" />
</p>

### 使用指定 API 和自定义提示词为对话自动命名，自定义图片导出布局、分辨率和外观格式
<p align="center">
  <img src="./statics/readme/readme-auto-title-and-export-settings.png" alt="自动命名与导出设置" width="560" height="584" />
</p>

### 统一的聊天记录相册，快速查看聊天记录中的所有图片
<p align="center">
  <img src="./statics/readme/readme-image-gallery.png" alt="聊天记录相册" width="620" height="866" />
</p>

### 全屏对话模式与线程模式，允许对聊天记录中的文本片段划词并使用自定义提示词快速解释，并深入对话
<p align="center">
  <img src="./statics/readme/readme-fullscreen-thread-mode.png" alt="全屏对话与线程模式" width="1200" height="626" />
</p>

探索任何一个你想探索的兔子洞。

### 对消息一键导出为自定义大小和布局的图片，方便快速分享
<p align="center">
  <img src="./statics/readme/readme-export-image-1.png" alt="消息导出图片 1" width="840" height="632" />
</p>
<p align="center">
  <img src="./statics/readme/readme-export-image-2.png" alt="消息导出图片 2" width="420" height="1313" />
</p>

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

## 🧩 与 yym68686/Cerebr 的主要差异

- 🗃️ **聊天记录系统大幅增强** - IndexedDB 持久化、URL+内容搜索、树状分支视图、图片相册、统计与备份/恢复
- 🧵 **划词线程与高亮** - 选区线程、气泡预览与线程面板，便于阅读/追问同一段内容
- 🏷️ **自动对话标题** - 支持自动生成标题，便于快速定位历史会话
- 🧭 **多种工作模式** - 侧边栏/停靠/全屏/独立聊天页面，多场景切换更顺手
- ⚙️ **API 配置能力更细** - 收藏与拖拽排序、自定义参数/系统提示词、用户消息预处理模板

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

## 📄 许可证

本项目采用 GPLv3 许可证
