# 如何发布新版本的 Android 应用

1. `npm version patch`（或根据需要 `minor`/`major`）
2. `npm run dist:android:prod`
3. 打开 Android Studio
4. 前往 Build > Generate Signed Bundle / APK
5. 选择密钥库（`sup.jks`）
6. 选择 `playRelease`
7. 选择 APK
8. 选择 `playRelease`
9. 构建完成后找到文件
10. 前往 [Google Play Console](https://play.google.com/console/u/0/developers/?pli=1) 并登录
11. 前往 Release > Production 并点击"Create new release"
12. 从 `$project/app/play/release/release/app-play-release.apk` 上传 APK
13. 添加发布说明并提交审核

---

<details>
<summary>已弃用：旧工作流程（不再使用）</summary>

1. 打开 Android Studio
2. 更新 `app/build.gradle` 中的 `versionCode` 和 `versionName`
   （要触发 F-Droid）添加 `fastlane/metadata/android/<locale>/changelogs/<versionCode>.txt`
3. `git commit`
4. `git tag`（触发 F-Droid），例如：`git tag -a "v21.0" -m "Release 21"`
5. 从上面当前工作流程的步骤 4 继续

</details>
