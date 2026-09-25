# Zotero Tag Editor 维护约定

本仓库独立维护 Zotero Tag Editor，采用 MIT 许可证。保持已确认的标签编辑行为，不顺带扩大功能范围。

- 从最新 `main` 创建 `codex/<task>` 分支，修改后运行 `npm run verify`，通过 PR 合并。当前约定由维护流程执行，不声称 GitHub 已强制分支保护。
- 版本同步 package.json、package-lock.json、addon/manifest.json，同时更新 CHANGELOG 与验收记录。依赖精确锁定，Actions 固定提交，使用 Node.js 22+ 与 npm ci。
- 遵循 [开发与发布说明](docs/DEVELOPMENT.md)。work/build/dist/.cache/node_modules 只保存本机或生成内容，不提交文献数据、配置目录、日志、凭证、用户绝对路径或 XPI。
- 使用模拟数据或隔离 Zotero 配置及测试库。验收记录区分自动检查、原生检查和用户反馈，不把浏览器测试等同于 Zotero 实机验收。
- 保存只作用于该次确认的目标，保留未操作标签，保持事务和冲突检查。后台选择变化不隐式重定向保存，只有再次呼出并接受切换才更新目标。
- 默认快捷键 Ctrl+T。插件 ID 固定为 `zotero-tag-editor@lllateron`。
- 标签生成 Draft，验证原始资产后发布同一文件。仅正式发布事件更新 updates.json；不得重写已发布版本的下载地址或摘要。
