# 分段精准反击契约

当前技术样本使用原创 TypeScript 关节片段与 Cocos Creator 3.8.8 程序网格。片段及关节制作数据位于 `game/assets/scripts/ParryMotion.ts`，资源引用由同名 `.meta` 的独立 UUID 保存。它用于验证规则与实时动作的连接；正式角色、风格与最终手感仍须在具体运行版本上确认。

## 规则时间与事件

所有时刻都是 Battle 的整数模拟毫秒，与渲染帧、墙钟、Tween、音效和动画完成回调无关。

| 时刻 | 事件与状态 | 伤害 |
|---|---|---|
| 合法防御输入 | `guard` 开始，首个可绘制帧开始抬手，60ms 完成护脸 | 0 |
| 普通掌接触 T，防御年龄 0–79ms | `parry`；actor 是防守者，target 是被挡者；进入 `counter` / `parried` | 0 |
| T+179ms | 双方仍锁定，不能追加攻击或防御 | 0 |
| T+180ms | `counter-hit`；actor/target 与 parry 一致；反击者进入 `counter-recovery`，目标进入普通 `stunned` | `baseDamage`，当前为 1 |
| T+440ms | 反击者恢复可行动 | 0 |

180ms 反击前摇、260ms 接触后收招和60ms抬手是用于试玩的候选参数。精防窗口80ms、普通防御300ms、轻击1、蓄满1200ms后2、480ms普通前摇和60秒局时保持现有设计。防御年龄80–299ms为普通格挡，300ms到期。反击不会继承来掌的蓄力伤害，也不会再检测格挡或产生递归反击。

`FighterState` 的 `counterAtMs`、`counterTargetId`、`parriedBy` 是可空公开数据；普通 `contactAtMs` 仅表示普通出掌。`counter` / `parried` 的 `phaseStartMs` 为精防确认时刻，`phaseEndMs` 为反掌接触时刻；由接触提交统一转换，通用阶段到期不提前解除锁定。反击收招从接触时刻起算。

同刻普通/反掌接触读取同一快照并批结算，再安装新的反击锁。重复 session/actor/sequence 不产生额外效果。60000ms 的接触先于超时；60001ms的接触取消。死亡和终局清全部未发接触及目标锁。暂停清外部待输入和蓄力，保留已确认反击并冻结剩余规则时间；重开使用新身份，旧链无效。

## 可编辑关节片段

`PARRY_CLIPS` 包含三个命名片段：

| 片段 | 职责 |
|---|---|
| `guard_raise_lead` | lead 手抬至本侧脸前 |
| `parry_catch_rise_rear_slap` | lead 留住来掌，身体压低后起身转体，rear 反掌 |
| `counter_rear_recover` | rear 从接触点收回，身体和双手恢复 |

关键帧字段 `t/lower/turn/lean/guard/reach` 分别定义区间比例、身体高度、转体、倾斜、挡手权重和反掌伸展。`t` 使用归一化规则区间，调整姿势不会改变判定时长。

`ParryMotion.consume(state, freshEvents, rules)` 接收完整去重事件批次，按规则时间重建动作；`sample(state, nowMs, anchors, rules)` 输出两人的完整身体、头部与 lead/rear 肩肘腕、掌心位置。输入快照只读，返回值不持有命令、会话或扣血入口。相同规则时间重复采样产生相同姿势。新 session、终局及 `reset()` 清动作链；旧批次不重新播放整掌。

`DEFAULT_ANCHORS` 为两侧分别指定 root、正负朝向与本地脸颊位置。朝向用于计算位置与旋转，角色和关节保持正尺度。lead 是挡手，rear 是反掌手；来掌在精防期间对齐挡手掌心，rear 在规则接触时对齐对方脸颊。肩肘腕和四肢网格消费这些位置，目标头部只在公开受击状态开始后反应。双方分别计算接触，不使用负缩放镜像整个人物。

## 视图消费与验证

Cocos 的 `SlapGame.consume` 先将全部 `fresh` 交给 `ParryMotion`，之后才用 `latestContact` 选择单条文字。正式 `CharacterView` 应保留这一顺序；只消费一条提示事件会丢失低帧批次中的动作。文字按较新时间优先，同刻顺序为 `counter-hit > parry > block > hit`；parry 显示挡住/准备反击，counter-hit 才显示事件的实际伤害。

`tests/parry-motion.test.cjs` 加载 tsconfig.rules.json 编译的真实模块，覆盖双手职责、双方接触、时间边界、整批事件、去重、恢复、暂停同时间和新局/终局清理。`npm test` 验规则和模块；`node tools/check-game.mjs --typecheck` 验已安装引擎声明；`tools/build-game.ps1` 分别构建 Web 与微信。构建和坐标测试不能替代真实连续画面、手机输入或用户对正式视觉的采用。

Web 的显式 `?diagnosticMotion=1` 将有限的只读规则/姿势/实际节点采样写到 canvas 的 `data-slap-motion`。同一开关才注册 `Director.EVENT_AFTER_DRAW`，每局最多捕获抬手、接掌、起身反掌、命中四张真实 canvas JPEG，并将规则时间、HP、阶段、相关事件及图像写到独立的 `data-slap-contact-frames`。新局清缓存，销毁时注销；默认运行不注册捕获、不编码图像。读取失败会保留错误，实际图片仍须查看，黑图不能作为动作证据；诊断运行不替代默认模式体验。
