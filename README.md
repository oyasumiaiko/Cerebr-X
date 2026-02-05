<p align="center">
<img src="./icons/icon128.png">
</p>

<p align="center">
<a href="https://chromewebstore.google.com/detail/cerebr/kjojanemcpiamhohkcpcddpkbnciojkj">
    <img src="https://img.shields.io/chrome-web-store/v/kjojanemcpiamhohkcpcddpkbnciojkj?color=blue&label=Chrome%20Store&logo=google-chrome&logoColor=white" alt="Chrome Web Store">
</a>
</p>

[English](./README.md) | [Simplified Chinese](./README_CN.md)

# 🧠 Cerebr - Intelligent AI Assistant

![screenshot](./statics/image.png)

The name "Cerebr" comes from a Latin root related to "brain" or "cerebrum". This reflects our vision: to integrate powerful AI capabilities and make Cerebr your second brain for deep reading and understanding. Cerebr is a focused AI assistant for Chromium browsers, designed to enhance your work efficiency and learning experience.

Born from a need for a clean, efficient browser AI assistant, Cerebr keeps a minimalist design while delivering strong capabilities for everyday web browsing, reading, and research.

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
