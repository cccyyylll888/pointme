# Demo: 教第一次贡献开源的人在 GitHub 提 PR

> 国际化备选 demo。每个评委都体验过新人迷失在 GitHub UI 里的样子。

## 场景设定

用户从未在 GitHub 提过 PR。打开一个开源项目主页问：

> "我想给这个项目改一个 typo，怎么提 PR？"

## 期望 agent 行为

| 步 | 工具调用 | 解释气泡 |
|---|---|---|
| 1 | highlight(Fork 按钮) + annotate | "先 fork 一份到你自己账号" |
| 2 | wait_for_user_action(url_changes contains: 用户名) | — |
| 3 | observe → highlight(具体文件路径下钻) + annotate | "进入要改的那个文件" |
| 4 | highlight(铅笔图标 / 编辑按钮) + annotate | "点这里在线编辑" |
| 5 | wait + observe → 用户改完，highlight(Commit changes 绿钮) + annotate | "改完点这里提交" |
| 6 | observe → 弹出 PR 表单时 highlight(Create pull request) + annotate | "最后一步，提交 PR" |
| 7 | done("已经提完啦，等仓库维护者 review 即可。") | overlay 清空 |

## 路演价值

GitHub 是评委 100% 熟悉但**仍然反直觉**的 UI。比让评委去理解一个陌生中国网站门槛低。
