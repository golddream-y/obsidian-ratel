# 写一份插件档案

1. 只列 5～15 个常改 key；密钥、token、password 进 forbid，不要写进 preset.patch。
2. `when` 写用户场景（如「周一开始」），不要写实现细节。
3. 互斥配置拆成多个 preset，不要挤在同一 patch。
4. 必须过 schema 与语义校验（forbid 与 patch 不相交、range 只认 `*` / `x.y.z` / `>=x.y.z`）。
5. 写入只指向 `configure_plugin`；禁止在 SOP 或档案里贴整份 data.json。
6. 配置文件与该 Skill 的 `SKILL.md` 放在同一目录，文件名用配置自己的 id。`.draft.yaml` 和 `enabled: false` 只用于编写，不参与执行。
