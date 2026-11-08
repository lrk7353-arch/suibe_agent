# v0.1 阶段提交

- 团队 let me go；孔令睿（队长）、陈相彤。
- 独立发布目录复测：经贸 41/41；核心流程 72/72、三次一致；API 路由模拟测试通过。
- 修正 API 检索地址使用配置中的 18867，避免误接旧 18767 服务。
- 未测试：真实 DeepSeek API 生成；公开 API 版全链路；正式成员人工复核。
- 参赛申报材料通过独立邮件材料包交付，不纳入代码仓库。
- 历史验收报告保留其当时版本，不代表公开样例的全量能力。
- 全量模型、运行环境、原始抓取资料和日志未上传。
- 未指定统一开源许可证；学校资料与第三方资源仍按原权利条件使用。

## 本次验证命令
```sh
PYTHON=python3 node trade-demo/tests/run-cases.cjs
node trade-demo/tests/run-core-flow.cjs
node app/tests/test-api-provider.cjs
```
Windows 可将 PYTHON 环境变量设置为项目 Python 路径。
