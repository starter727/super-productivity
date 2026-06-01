# 文档指南

保持 Super Productivity 文档与代码同步的规则和约定。

## 为什么这很重要

`docs/wiki/` 目录是手动策划、面向人类的文档库，通过 CI 发布到 [GitHub Wiki](https://github.com/super-productivity/super-productivity/wiki)。它与描述代码机制的自动生成 [DeepWiki](https://deepwiki.com/super-productivity/super-productivity) 有意保持分离。Wiki 是用户阅读以了解上下文、设计意图以及功能如何协同工作的内容。

## 何时更新 wiki

**当面向用户的功能发生变化时，在同一个 PR 中更新 `docs/wiki/`。** 常见情况及其目标注释：

| 变更                                                               | 需要编辑的注释                                                                   |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| 新增/更改/删除设置、偏好或配置选项                                  | `3.02-Settings-and-Preferences.md`                                               |
| 新增/删除/更改键盘快捷键                                            | `3.03-Keyboard-Shortcuts.md`                                                     |
| 简短语法新增或更改                                                  | `3.04-Short-Syntax.md`                                                           |
| 新增或更改 REST / 插件 / 同步 API 接口                              | `3.01-API.md`                                                                    |
| 新增问题或同步提供程序，或现有提供程序的行为变更                    | `3.07-Issue-Integration-Comparison.md` / `3.08-Sync-Integration-Comparison.md`   |
| 用户数据结构��存储位置或备份/导入行为变更                          | `3.06-User-Data.md`                                                              |
| 新增主题钩子或主题变量变更                                          | `3.09-Theming.md`                                                                |
| Web 与桌面功能差异                                                  | `3.05-Web-App-vs-Desktop.md`                                                     |

如果变更纯粹是内部的（例如重构、测试、性能、构建），则无需更新 wiki。
某些子系统可能非常特定，代码注释本身就足够了；在这种情况下，除非直接与已写内容矛盾，否则无需更新 wiki。

## 如何编写 wiki 内容

**编辑之前请先阅读 [`docs/wiki/0.00-Wiki-Structure-and-Organization.md`](wiki/0.00-Wiki-Structure-and-Organization.md)。** 它定义了四种注释类别（快速入门、操作指南、参考资料、概念）、编号方案以及每种类别的 [Diátaxis](https://diataxis.fr/) 风格的写作指导。参考资料（Reference notes）准确、全面且一致地描述内容——仅此而已。

## 默认使用参考资料注释（`3.XX`）

参考资料是对现有内容的机制性描述（设置、快捷键、API、数据结构、比较）。它们是代码驱动更新的最安全目标。其他类别更多由人工编写，应谨慎触碰：

- **快速入门（`1.XX`）** — 教学/入门叙述。不要自行改写语气或重组结构。
- **操作指南（`2.XX`）** — 任务配方，具有预设的受众和语气。如果工作流程确实发生了变化，请更新步骤；不要扩展范围。
- **概念（`4.XX`）** — 解释性背景和设计理由。仅在���充分证据的情况下修改；标记而非重写。

如果某项变更明显影响到非参考资料注释（例如操作指南中的步骤因 UI 移动而失效），请进行最小修正并在 PR 描述中指出，以便人工审查措辞。如果不确定要编辑哪个注释，或不确定变更是否需要 wiki 更新，请先询问再编写。

## Wiki 代码检查和质量

Wiki 注释在 CI 中进行检查，然后同步到 GitHub Wiki。关于检查规则和链接检查，请参阅 [`docs/wiki/0.02-Wiki-QA-and-Maintenance.md`](wiki/0.02-Wiki-QA-and-Maintenance.md)；关于 Markdown 和格式约定，请参阅 [`docs/wiki/0.01-Style-Guide.md`](wiki/0.01-Style-Guide.md)。

## 面向开发者的文档

Wiki 既面向终端用户也面向开发者。仍然存在面向开发者的文档（`docs/styling-guide.md`、`docs/sync-and-op-log/`、`docs/plugin-development.md`、`ARCHITECTURE-DECISIONS.md`），这些文档要么太旧，要么太新，尚未考虑整合到 wiki 中。无论如何，当这些注释需要更改时，遵循同样的"随代码更新"规则，并指出何时可以整合到主 wiki 中。未经警告不要将它们重构到新的 wiki 中，因为某些开发者可能正在依赖它们当前的位置。
