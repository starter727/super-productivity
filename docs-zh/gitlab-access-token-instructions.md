# 如何生成具有权限的 GitLab 访问令牌

## Personal Access Token

要轮询 GitLab Issues，你需要提供访问令牌。

1. 前往 User Settings / Access tokens
2. 添加一个具有 `api` 范围的新令牌

![Personal Token](https://github.com/user-attachments/assets/76fb204e-450a-4516-9d93-897ae2a32f6d)

## Project Access Token

如果你自托管 GitLab 或拥有 Premium/Ultimate 许可证，可以获取项目访问令牌（Project Access Token），其范围限定于一个项目。
其范围与 Personal Access Token 类似，但你还需要设置角色。要了解每个角色可以做什么，请参见<a href="https://docs.gitlab.com/ee/user/permissions.html#project-planning">文档</a>。

![Project Token](https://github.com/user-attachments/assets/f008f114-3d3e-450d-9301-7825222f9812)

有关 GitHub Personal Access Token 说明，请参见 [GitHub Access Token Instructions](./github-access-token-instructions.md)。
