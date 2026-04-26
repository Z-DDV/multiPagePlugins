# Repository Guidelines

## Project Structure & Module Organization

This repository is a Manifest V3 Chrome extension for multi-page OAuth and mailbox automation. `manifest.json` defines permissions, content-script matches, the service worker, and the side panel entry. `background.js` owns orchestration, tab/window management, state, and message routing. Page-specific automation lives in `content/`: shared helpers are in `content/utils.js`; `signup-page.js`, `vps-panel.js`, `qq-mail.js`, `mail-163.js`, `inbucket-mail.js`, and `duck-mail.js` target individual sites. The side panel UI is under `sidepanel/`; static data is in `data/names.js`; icons are in `icons/`.

## Build, Test, and Development Commands

There is no npm package or build step. Develop directly against the unpacked extension:

```txt
chrome://extensions/ -> Developer mode -> Load unpacked -> this repo root
```

After changes, reload the extension, reopen the side panel, and retest the affected workflow. Use `git status --short` before committing. Do not commit generated Playwright MCP artifacts such as `.playwright-mcp/`.

## Coding Style & Naming Conventions

Use plain JavaScript, HTML, and CSS; avoid adding a framework or bundler unless the extension is migrated deliberately. Follow the existing style: two-space indentation, semicolons, `const`/`let`, single-quoted JS strings, camelCase names, and UPPER_SNAKE_CASE constants. Keep content scripts focused on one target page. Put reusable DOM, polling, logging, and stop-flow helpers in `content/utils.js` or shared background helpers.

## Testing Guidelines

No automated test suite is currently configured. Validate changes manually in Chrome with the extension loaded unpacked. For workflow changes, test the relevant step button and the full `Auto` flow when practical. For mailbox changes, verify the target provider path plus timeout, unread-message, and verification-code handling. For UI changes, test light/dark theme and side panel resizing.

## Commit & Pull Request Guidelines

Recent history mostly uses Conventional Commit prefixes such as `feat:` and `fix:`; keep that style, for example `fix: improve 163 verification polling`. Keep commits scoped to one behavior. Pull requests should include a summary, affected workflow steps or files, manual test notes, and screenshots or recordings for side panel changes. Call out permission or host-match changes in `manifest.json`.

## Security & Configuration Tips

Do not commit real emails, passwords, JWTs, mailbox hosts, OAuth links, or production panel URLs. Treat Chrome `debugger`, `<all_urls>`, cookies, local storage, and session storage handling as sensitive; document any permission expansion and keep data clearing limited to the intended origins.
