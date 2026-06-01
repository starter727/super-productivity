# 如何刷新 Snap Store 凭据

GitHub Actions 用于发布新版本的 Snap Store 凭据会定期过期。凭据过期时，CI 发布步骤将失败。请按照以下步骤生成新凭据并更新 GitHub Actions 密钥。

1. 运行 `snapcraft export-login --snaps superproductivity -`
2. 将输出值复制到 GitHub Actions 设置中的 `SNAPCRAFT_STORE_CREDENTIALS`（Settings > Secrets and variables > Actions）。
