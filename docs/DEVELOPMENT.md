# 开发与发布

使用 Node.js 22+ 与精确锁定的依赖。从最新 main 创建 codex/<task> 分支，执行 npm ci 和 npm run verify，通过 PR 合并。当前不以分支保护阻止维护者操作，CI 与审阅由维护流程落实。

verify 包括类型检查、领域与运行时测试、仓库卫生、安装字段、更新清单、XPI 校验及两个时区下的可重复构建。输出为 dist/zotero-tag-editor-<version>.xpi 和 dist/SHA256SUMS，不提交产物。

src/zotero.ts 负责 Zotero 集成、冻结目标、事务、冲突及撤销；src/editor.ts 负责 XHTML 界面；src/domain/tags.ts 实现标签变换。运行时不向网络发送文献或标签数据。

界面检查使用已有 Playwright 环境：设置 TAG_EDITOR_PLAYWRIGHT_DIR 为模块路径，或让 Node 能解析 playwright，运行 `node tests/editor-ui.cjs`。它使用无头 Edge、实际 XHTML 和模拟桥接，结果在 work/editor-ui/；不属于 CI verify，也不能代替原生 Zotero 验收。原生检查须使用隔离配置与测试库。

## 发布

1. 同步 package.json、package-lock.json、addon/manifest.json 的版本，更新 CHANGELOG 与验收记录，验证后合并 main。
2. 仓库变量 ZOTERO_TAG_EDITOR_RELEASE_ENABLED 设为 true。运行 `node scripts/verify-release-ready.mjs --repository lllaterOn/zotero-tag-editor`，确保主页和更新地址正确。
3. 推送 v<version> 标签。draft-release 只读任务验证并构建，独立写权限任务上传 XPI 与 SHA256SUMS 到 Draft Release。
4. 下载 Draft 原始资产，校验摘要、版本与标签源码，完成适用的隔离 Zotero 验收。验证后发布同一 Draft，不重建或替换资产。本次 v1.0.0 已获维护者授权，按已认可功能及正式包隔离验证完成首发。
5. release:published 触发 publish-update，重新校验资产及标签源码 manifest，再将正式固定版本 URL 与 SHA-256 写入 main 的 updates.json。
6. 确认工作流成功，重新下载正式资产核对更新清单。失败时修复并重跑，不伪造检查记录或覆盖已发布资产。

build 仅 contents:read，Draft 上传和更新清单任务单独获得写权限，Actions 固定提交。首发前 updates.json 为空，发布后由工作流写入；相同版本不可换包。

插件 ID 固定为 zotero-tag-editor@lllateron。正式更新地址为 https://raw.githubusercontent.com/lllaterOn/zotero-tag-editor/main/updates.json 。试用版用户须手动安装一次正式版。

兼容声明为 Zotero 10.0.3 至 10.*；已验证环境为 Windows / Zotero 10.0.3，不能将声明范围视为每个系统与版本均已验收。
