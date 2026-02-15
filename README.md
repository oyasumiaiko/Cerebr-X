<p align="center">
<img src="./icons/icon128.png">
</p>

[English](./README.md) | [Simplified Chinese](./README_CN.md)

# 🧠 Cerebr - Intelligent AI Assistant

## ⚠️ Current Status (Local Load Only)

- This version is **not published** on the Chrome Web Store.
- This is a personal-use project. Features are **not stable** and may change at any time.
- You must clone the repository locally and restore submodules before use:

```bash
git clone <repo-url>
cd Cerebr
git submodule update --init --recursive
```

- Then open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the repository root.

## 📸 Feature Highlights

### Main interface
<p align="center">
  <img src="./statics/readme/readme-main-ui.png" alt="Main interface" width="720" height="848" />
</p>

### One-click web page summary, or one-click YouTube video summary with subtitle extensions
<p align="center">
  <img src="./statics/readme/readme-one-click-summary.png" alt="One-click summary" width="1200" height="515" />
</p>

### Powerful chat history management and fast full-text search
<p align="center">
  <img src="./statics/readme/readme-history-search-1.png" alt="Chat history management 1" width="760" height="894" />
</p>
<p align="center">
  <img src="./statics/readme/readme-history-search-2.png" alt="Chat history management 2" width="620" height="864" />
</p>

### Detailed customizable personalization and color themes
<p align="center">
  <img src="./statics/readme/readme-theme-customization.png" alt="Theme customization" width="520" height="710" />
</p>

### Auto-name conversations with specified APIs and custom prompts, plus custom image export layout, resolution, and appearance
<p align="center">
  <img src="./statics/readme/readme-auto-title-and-export-settings.png" alt="Auto title and export settings" width="560" height="584" />
</p>

### Unified chat history gallery for quickly viewing all images in conversations
<p align="center">
  <img src="./statics/readme/readme-image-gallery.png" alt="Chat image gallery" width="620" height="866" />
</p>

### Fullscreen conversation mode and thread mode for selecting message snippets and quickly explaining them with custom prompts
<p align="center">
  <img src="./statics/readme/readme-fullscreen-thread-mode.png" alt="Fullscreen and thread mode" width="1200" height="626" />
</p>

Explore any rabbit hole you want to explore.

### One-click export messages into custom-sized and custom-layout images for fast sharing
<p align="center">
  <img src="./statics/readme/readme-export-image-1.png" alt="Message export 1" width="840" height="632" />
</p>
<p align="center">
  <img src="./statics/readme/readme-export-image-2.png" alt="Message export 2" width="420" height="1313" />
</p>

## ✨ Core Features

- 🎯 **Sidebar, Dock & Fullscreen** - Open from the toolbar or a custom shortcut; switch between docked sidebar and fullscreen immersion
- 🧠 **Context-Aware Q&A** - Web/PDF extraction, selection threads, quick page/repo summaries, and pure chat mode
- 🖼️ **Multimodal** - Image upload plus page screenshot capture with preview
- 🔄 **Multi-API & Multi-Model** - Multiple configs, favorites, quick switching, custom params/system prompts
- ⚡ **Streaming + Rich Rendering** - Markdown, LaTeX, and code highlighting with real-time output
- 🌗 **Themes & Backgrounds** - Light/dark themes and random background images

## 🛠️ Productivity & Management

- 📚 **History Center** - Search/filter by URL and content, tree branches, image gallery, stats
- 🧩 **Message Tools** - Edit, regenerate, fork conversations, insert messages, copy as text/code/image
- ⌨️ **Slash Commands** - Type `/` for hints: `/summary`, `/temp`, `/model`, `/history`, `/clear`, `/stop`
- 🔧 **Prompt & URL Rules** - System/summary/selection prompts and per-site rules
- 💾 **Backup & Restore** - Export/import conversations, optional image stripping, auto incremental backup

## 🧩 Differences from yym68686/Cerebr

- 🗃️ **Much richer history system** - IndexedDB persistence, URL+content search, tree branches, image gallery, stats, backup/restore
- 🧵 **Selection threads** - Threaded follow‑ups on highlighted text with preview bubble + thread panel
- 🏷️ **Auto conversation titles** - Generate titles for easier history navigation
- 🧭 **More modes** - Sidebar/dock/fullscreen + standalone chat page
- ⚙️ **Deeper API config** - Favorites, drag‑sort, custom params/system prompts, user message preprocessor

## 🎮 User Guide

1. 🔑 **Configure API**
   - Open **API Settings**
   - Fill in API Key, Base URL and model name (multiple keys can be comma-separated)
   - Add multiple configs and pick a favorite for quick switching

2. 💬 **Open the Sidebar / Standalone**
   - Click the extension icon, or set a shortcut at `chrome://extensions/shortcuts`
   - Use **Standalone chat page** or **Fullscreen mode** for a focused workspace

3. 📚 **Ask with Page Context**
   - Ask questions directly; Cerebr will extract webpage/PDF content
   - Use **Quick Summary** or `/summary` for one-click page summaries
   - Switch to **Temp Mode** for pure chat without page context

4. 🖼️ **Images & Screenshots**
   - Upload images, or click the screenshot button to capture the current page
   - Click images to preview and drag to pan

## 📝 Development Notes

This project is built with Chrome Extension Manifest V3 and runs without a build step. Main tech stack:

- Native JavaScript + CSS
- Chrome Extension APIs
- PDF.js, Marked.js, KaTeX, Highlight.js, DOMPurify, dom-to-image

## 🤝 Contribution Guide

Welcome to submit Issues and Pull Requests to help improve the project. Before submitting, please ensure:

- 🔍 You have searched related issues
- ✅ Follow existing code style
- 📝 Provide clear description and reproduction steps

## 📄 License

This project is licensed under the GPLv3 License
